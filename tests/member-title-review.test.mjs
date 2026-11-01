/**
 * The independent review of the job title (v2 Phase 3, p3-member-title), as tests.
 *
 *   1. A viewer cannot flood the owners' Recent changes with title edits and push real
 *      changes (a removal, a role change) off the list; own-title edits have a tight
 *      per-person limit of their own.
 *   2. The owner keeps seeing the authoritative role beside a self-chosen title wherever
 *      an owner decides who holds authority, and a person cannot call themselves a role.
 *   3. Cleaning a title no longer leaves a dangling "of", an ampersand inside a short
 *      word (R&D, P&L) is kept, and the person is told what was left out.
 *   4. The form follows the title when someone else changes it, and the field carries
 *      its error and its counter to a screen reader; a long title wraps in the team list.
 *   5. The "In charge" line shows the title; the trail's sentences deliberately do not.
 *
 * PGlite with every migration for the store half; source checks for the wiring.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

import { migratedDb } from './helpers/store-db.mjs';
import * as schema from '../lib/db/schema.ts';
import { enforceRateLimit, RATE_LIMITS } from '../lib/server/rate-limit.ts';
import { listAuthorityEvents } from '../lib/server/wallet-authority.ts';
import { listTeamActivity, removeTeamMember, setMemberTitle } from '../lib/server/team-admin.ts';
import { plainTitle } from '../lib/team/declined-by.ts';
import * as titles from '../lib/team/member-title.ts';

const { titleFromInput, TITLE_HELP } = titles;

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const T0 = new Date('2026-11-02T09:00:00Z');
const VERIFIED = new Date('2026-10-01T00:00:00Z');
const base = { orgId: 'acme', now: () => T0 };

async function seeded() {
  const { client, db } = await migratedDb();
  const people = [
    ['u-owner', 'Asha', 'admin'],
    ['u-lead', 'Lena', 'checker'],
    ['u-maker', 'Maya', 'maker'],
    ['u-viewer', 'Vera', 'viewer'],
    ['u-gone', 'Gabe', 'maker'],
  ];
  for (const [id, name, role] of people) {
    await db.insert(schema.users).values({ id, email: `${id}@example.test`, name, emailVerifiedAt: VERIFIED });
    await db.insert(schema.memberships).values({ id: `m-${id}`, userId: id, orgId: 'acme', role });
  }
  return { client, db };
}

// ─── 1. Flooding the owners' list ───────────────────────────────────────────

test('a viewer who edits their own title 55 times does not push a removal off the owners’ Recent changes', async () => {
  const { client, db } = await seeded();
  assert.equal((await removeTeamMember(db, { ...base, actorUserId: 'u-owner', userId: 'u-gone' })).ok, true);
  for (let i = 0; i < 55; i += 1) {
    const r = await setMemberTitle(db, { ...base, actorUserId: 'u-viewer', userId: 'u-viewer', title: i % 2 === 0 ? 'Analyst' : 'Auditor' });
    assert.equal(r.ok, true);
  }
  const lines = (await listAuthorityEvents(db, 'acme')).filter((e) => e.action === 'member_title_changed');
  assert.equal(lines.length, 55, 'the append-only trail keeps every one of them');
  const seen = await listTeamActivity(db, 'acme');
  assert.ok(seen.some((a) => a.action === 'member_removed'), 'the removal is still on the screen owners watch');
  const titleLines = seen.filter((a) => a.action === 'member_title_changed');
  assert.equal(titleLines.length, 1, 'one person’s many title edits read as one line: their latest');
  assert.match(titleLines[0].summary, /^Vera set their own title to (Analyst|Auditor)\.$/);
  await client.close();
});

test('title lines never fill the list: other actions keep their whole 50, title lines are added after', async () => {
  const { client, db } = await seeded();
  assert.equal((await removeTeamMember(db, { ...base, actorUserId: 'u-owner', userId: 'u-gone' })).ok, true);
  for (let i = 0; i < 12; i += 1) {
    const person = `u-x${i}`;
    await db.insert(schema.users).values({ id: person, email: `${person}@example.test`, name: `Extra ${String.fromCharCode(97 + i)}`, emailVerifiedAt: VERIFIED });
    await db.insert(schema.memberships).values({ id: `m-${person}`, userId: person, orgId: 'acme', role: 'viewer' });
    await setMemberTitle(db, { ...base, actorUserId: person, userId: person, title: `Role ${String.fromCharCode(97 + i)}` });
  }
  const seen = await listTeamActivity(db, 'acme', 5);
  assert.ok(seen.some((a) => a.action === 'member_removed'), 'a limit of 5 still shows the removal: it is counted among the other actions');
  assert.ok(seen.filter((a) => a.action === 'member_title_changed').length <= 10, 'title lines are capped on their own');
  await client.close();
});

test('an own-title change has its own tight per-person limit, applied before the general team limit', async () => {
  assert.ok(RATE_LIMITS.memberTitleSelf, 'a rule exists');
  assert.ok(RATE_LIMITS.memberTitleSelf.limit <= 6, 'a handful an hour');
  assert.ok(RATE_LIMITS.memberTitleSelf.limit < RATE_LIMITS.teamChangeUser.limit);
  const { client, db } = await migratedDb();
  let refused = 0;
  for (let i = 0; i < RATE_LIMITS.memberTitleSelf.limit + 2; i += 1) {
    const limited = await enforceRateLimit({ rule: RATE_LIMITS.memberTitleSelf, key: 'u-viewer', db, now: T0 });
    if (limited) refused += 1;
  }
  assert.equal(refused, 2, 'the seventh and eighth are turned away');
  assert.equal(await enforceRateLimit({ rule: RATE_LIMITS.memberTitleSelf, key: 'u-other', db, now: T0 }), null, 'per person');
  await client.close();

  const route = code(read('app/api/team/members/[userId]/title/route.ts'));
  assert.match(route, /limitOwnTitleChanges\(gate\.route, userId\)/, 'the route applies it when the change is the person’s own');
  assert.ok(route.indexOf('limitOwnTitleChanges') < route.indexOf('limitTeamChanges'), 'before the general limit');
  const gate = code(read('lib/server/team-route.ts'));
  assert.match(gate, /RATE_LIMITS\.memberTitleSelf/);
});

// ─── 2. The role stays visible, and nobody calls themselves a role ───────────

test('where an owner decides authority, a self-chosen title is shown beside the role, never in place of it', () => {
  assert.deepEqual(titles.titleAndRole({ title: 'CFO', role: 'maker' }), { title: 'CFO', role: 'Staff' });
  assert.deepEqual(titles.titleAndRole({ title: 'Owner', role: 'maker' }), { title: 'Owner', role: 'Staff' }, 'a maker who typed Owner is still shown as Staff');
  assert.deepEqual(titles.titleAndRole({ title: 'Staff', role: 'maker' }), { title: 'Staff', role: null }, 'a title that is the role word adds nothing to say twice');
  assert.deepEqual(titles.titleAndRole({ title: null, role: 'checker' }), { title: 'Approver', role: null }, 'no title: the role word is the title, as before');
  assert.deepEqual(titles.titleAndRole({ title: null, role: 'checker', financeLead: true }), { title: 'Finance lead', role: 'Approver' });
  const migration = code(read('components/wallet/Migration.tsx'));
  assert.match(migration, /titleAndRole\(m\)/, 'the person in charge, and the people to choose from, read it');
  assert.doesNotMatch(migration, /\(\{memberTitle\(m\)\}\)/, 'no longer the title alone');
});

test('a person cannot give themselves a role’s name as a title: only an owner can', async () => {
  const { client, db } = await seeded();
  for (const word of ['Owner', 'owner', ' OWNER ', 'Approver', 'Staff', 'Viewer', 'Finance lead', 'finance   Lead', 'Administrator', 'Member']) {
    const r = await setMemberTitle(db, { ...base, actorUserId: 'u-maker', userId: 'u-maker', title: word });
    assert.equal(r.ok, false, word);
    assert.equal(r.status, 400, word);
    assert.equal(r.code, 'title_is_a_role', word);
    assert.match(r.error, /role/i);
  }
  assert.equal((await setMemberTitle(db, { ...base, actorUserId: 'u-maker', userId: 'u-maker', title: 'Owner’s assistant' })).ok, true, 'a real title that merely contains a role word is fine');
  assert.equal((await setMemberTitle(db, { ...base, actorUserId: 'u-maker', userId: 'u-maker', title: 'Operations' })).ok, true);
  // An owner may use any word for anyone, themselves included.
  assert.equal((await setMemberTitle(db, { ...base, actorUserId: 'u-owner', userId: 'u-owner', title: 'Owner' })).ok, true);
  assert.equal((await setMemberTitle(db, { ...base, actorUserId: 'u-owner', userId: 'u-maker', title: 'Staff' })).ok, true);
  const lines = (await listAuthorityEvents(db, 'acme')).filter((e) => e.action === 'member_title_changed');
  assert.equal(lines.length, 4, 'a refused title writes nothing: only the four that were accepted');
  await client.close();
});

// ─── 3. Cleaning ────────────────────────────────────────────────────────────

test('a short word with an ampersand inside it (R&D, P&L) is kept; a spaced ampersand and “and” still end the title', () => {
  assert.equal(plainTitle('Head of R&D'), 'Head of R&D');
  assert.equal(plainTitle('P&L owner'), 'P&L owner');
  assert.equal(plainTitle('M&A'), 'M&A');
  assert.equal(plainTitle('R&D'), 'R&D');
  assert.equal(plainTitle('Sales & Marketing lead'), 'Sales');
  assert.equal(plainTitle('Sales and Marketing lead'), 'Sales');
  // Not a way to put a second person in a title.
  assert.equal(plainTitle('CFO&Ben Owner'), null, 'a long word with an ampersand is not a word');
  assert.equal(plainTitle('&R'), null);
  assert.equal(plainTitle('R&'), null);
  assert.equal(plainTitle('R&&D'), null);
  assert.equal(plainTitle('Head of R&D'), plainTitle(plainTitle('Head of R&D')), 'cleaning a clean title changes nothing');
});

test('a title cut at a word that is not plain does not end in a dangling connector', () => {
  assert.equal(plainTitle('Head of 3 teams'), 'Head');
  assert.equal(plainTitle('Head of Operations and Finance'), 'Head of Operations');
  assert.equal(plainTitle('Head of Finance: Declined'), 'Head');
  assert.equal(plainTitle('Director of the 2nd floor'), 'Director');
  assert.equal(plainTitle('Level 2 Support'), 'Level');
  assert.equal(plainTitle('Co-founder / CEO'), 'Co-founder');
  assert.equal(plainTitle('of 3'), null, 'nothing but a connector is left: no title');
  // A person who typed a plain "Head of" keeps what they typed; only a cut is tidied.
  assert.equal(plainTitle('Head of'), 'Head of');
  for (const typed of ['Head of 3 teams', 'Head of Operations and Finance', 'Head of Finance: Declined', 'Level 2 Support']) {
    assert.equal(plainTitle(plainTitle(typed)), plainTitle(typed), typed);
  }
});

test('typing a title says where it stopped, so the person is told what was left out', () => {
  assert.deepEqual(titleFromInput('Level 2 Support'), { ok: true, title: 'Level', leftOut: '2' });
  assert.deepEqual(titleFromInput('Sales and Marketing lead'), { ok: true, title: 'Sales', leftOut: 'and' });
  assert.deepEqual(titleFromInput('Head of Finance: Declined'), { ok: true, title: 'Head', leftOut: 'Finance:' });
  assert.deepEqual(titleFromInput('Co-founder / CEO'), { ok: true, title: 'Co-founder', leftOut: '/' });
  assert.deepEqual(titleFromInput('Head of Operations'), { ok: true, title: 'Head of Operations' });
  assert.deepEqual(titleFromInput(''), { ok: true, title: null });
  // What was left out is the person’s own word, shown back to them: short, and only the one word.
  const long = titleFromInput(`Chef ${'x1'.repeat(50)}`);
  assert.equal(long.title, 'Chef');
  assert.ok(Array.from(long.leftOut).length <= 20);
  // A link is refused outright, as before.
  assert.equal(titleFromInput('https://evil.example').ok, false);
});

test('the answer to a save says what was kept, and what was left out and why', () => {
  const kept = titles.savedTitleMessage({ whose: 'Your', kept: 'Head of Operations', leftOut: null, roleWord: 'Staff' });
  assert.equal(kept, 'Your title is Head of Operations.');
  const cut = titles.savedTitleMessage({ whose: 'Your', kept: 'Level', leftOut: '2', roleWord: 'Staff' });
  assert.match(cut, /^Your title is Level\./);
  assert.match(cut, /“2” and everything after it were left out/);
  assert.match(cut, /plain words/);
  assert.equal(titles.savedTitleMessage({ whose: 'Ben’s', kept: '', leftOut: null, roleWord: 'Staff' }), 'Title cleared. Staff is used instead.');
  assert.ok(!cut.includes('—') && !cut.includes('–'), 'no long dashes');
  assert.match(TITLE_HELP, /ampersand|R&D/i, 'the help says an ampersand inside a short word is fine');
});

// ─── 4. The form and the list ───────────────────────────────────────────────

test('the form follows the title when someone else changes it, and carries its error and counter to a screen reader', () => {
  const form = code(read('components/team/TitleForm.tsx'));
  assert.match(form, /previous/i, 'it notices that the title it was given changed');
  assert.match(form, /aria-invalid=\{error \? true : undefined\}/);
  assert.match(form, /aria-describedby=\{`\$\{id\}-help \$\{id\}-count/, 'the help and the counter are read with the field');
  assert.match(form, /errorId=\{`\$\{id\}-error`\}/, 'the error is linked to the input through the field');
  assert.match(form, /hintId=\{`\$\{id\}-count`\}/);
  assert.match(form, /savedTitleMessage\(/, 'the message about what was kept');
  assert.match(form, /leftOut/);
  const ui = code(read('components/transfer/ui.tsx'));
  assert.match(ui, /errorId\?: string/);
  assert.match(ui, /hintId\?: string/);
});

test('in the team list a long title wraps instead of being cut off', () => {
  const card = read('components/settings/TeamCard.tsx');
  const open = card.match(/<span className="([^"]*)">\s*\{m\.name\}/);
  assert.ok(open, 'the name and title share one span');
  assert.doesNotMatch(open[1], /truncate/, 'the name and title are not cut off');
  assert.match(open[1], /break-words/);
});

// ─── 5. In charge, and the trail ────────────────────────────────────────────

test('the “In charge” line shows each person with their title when they have one, and never leaks a role', () => {
  const route = code(read('app/api/wallet/persons-in-charge/route.ts'));
  assert.match(route, /title: member\?\.title \?\? null/, 'the persons in charge carry their own title (not their role)');
  assert.doesNotMatch(route.slice(route.indexOf('const named'), route.indexOf('const keys')), /role/, 'no role word goes to someone who is not an owner');
  const card = code(read('components/settings/TeamCard.tsx'));
  assert.match(card, /In charge: \{charge\.data\.personsInCharge\.map\(\(p\) => p\.title \? `\$\{p\.name\} \(\$\{p\.title\}\)` : p\.name\)/);
  assert.match(code(read('components/wallet/Migration.tsx')), /title\?: string \| null/);
});

test('the trail’s sentences name people as they were, not by a title that may have changed since; the docs say so', () => {
  const docs = read('docs/v2/phase3-team-roles.md');
  assert.match(docs, /Recent changes[\s\S]{0,400}names only/i, 'a deliberate exception: names only in Recent changes');
  assert.match(docs, /one line per person/i, 'a person’s many own-title edits are one line in Recent changes');
  assert.match(docs, /kept for good|cannot be erased|append-only/i);
  assert.ok(existsSync(new URL('docs/v2/phase3-team-roles.md', root)));
});
