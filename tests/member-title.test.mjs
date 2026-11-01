/**
 * A member's job title (v2 Phase 3, p3-member-title; Sky's round-four request that
 * people always show with their title, "Aisha (CFO)").
 *
 * This file is the pure half and the wiring: how a title is cleaned, the label it
 * makes, the words on the trail, who is offered the field, and that every place
 * that builds a "Name (Title)" reads the title. What the service does on a real
 * database (owner, self, everyone else, cross-tenant, replay, the trail, the
 * decline snapshot) is tests/member-title-store.test.mjs and the end of
 * tests/declined-by-history.test.mjs.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

import { declinerLabel, plainName, plainTitle } from '../lib/team/declined-by.ts';
import { memberLabel, memberTitle, titleFromInput, TITLE_HELP, TITLE_MAX } from '../lib/team/member-title.ts';
import { TEAM_ACTIONS, activitySummary, titleEditor } from '../lib/team/view.ts';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ─── Cleaning ───────────────────────────────────────────────────────────────

test('a title is plain words: the ones people really write come through unchanged', () => {
  assert.equal(TITLE_MAX, 40);
  for (const title of ['CFO', 'Finance lead', 'Operations', 'Co-founder', 'Head of Operations', 'VP Finance', 'Controller']) {
    assert.equal(plainTitle(title), title);
  }
  assert.equal(plainTitle('  Head   of    Operations \n'), 'Head of Operations', 'spaces and line breaks are collapsed');
  // The words are the name's words: "and" and symbols end the title there (round four's guard: one account never reads as two people).
  assert.equal(plainTitle('Sales and Marketing lead'), 'Sales');
  assert.equal(plainTitle('Sales & Marketing lead'), 'Sales');
  assert.equal(plainTitle('Chef de cuisine'), 'Chef de cuisine');
});

test('a title has no link, markup, control or hidden character, and no bracket or comma', () => {
  assert.equal(plainTitle('CFO (Finance), Ops'), 'CFO Finance Ops', 'brackets and commas inside the field become spaces');
  assert.equal(plainTitle('CFO，Ops'), 'CFO Ops');
  assert.equal(plainTitle('C​F‮O'), 'CFO', 'zero-width and direction characters are removed');
  assert.equal(plainTitle('CFO https://evil.example/pay'), 'CFO', 'kept up to the first word that is not plain');
  assert.equal(plainTitle('https://evil.example CFO'), null, 'a title that starts with a link is no title');
  assert.equal(plainTitle('evil.example'), null);
  assert.equal(plainTitle('<b>CFO</b>'), null);
  assert.equal(plainTitle('R&amp;D'), null, 'an entity is not a word');
  assert.equal(plainTitle('R&D lead'), null, 'a symbol inside a word is not a plain word');
  assert.equal(plainTitle('javascript:alert'), null);
  assert.equal(plainTitle('1234'), null);
  assert.equal(plainTitle('Declined'), null, 'a word that would read as a second sentence is not a title');
  assert.equal(plainTitle(''), null);
  assert.equal(plainTitle(null), null);
  assert.equal(plainTitle(42), null);
  assert.equal(plainTitle({ toString: () => 'CFO' }), null, 'only a string is a title');
});

test('a title is at most 40 characters including the one ellipsis, cut at a word, and cutting a cut title changes nothing', () => {
  const exact = 'A'.repeat(40);
  assert.equal(plainTitle(exact), exact, 'forty characters fit');
  const over = plainTitle('A'.repeat(41));
  assert.equal(over, `${'A'.repeat(39)}…`);
  assert.equal(Array.from(over).length, 40);
  const long = plainTitle('Senior Vice President of Global Treasury Finance Operations');
  assert.ok(long && Array.from(long).length <= 40, `${long}`);
  assert.ok(long.endsWith('…'));
  assert.ok(/^Senior Vice President of Global( Treasury)?…$/.test(long), `cut at a word: ${long}`);
  for (const sample of ['B'.repeat(500), 'Senior Vice President of Global Treasury Finance Operations', 'A'.repeat(41), `${'word '.repeat(30)}`]) {
    const once = plainTitle(sample);
    assert.equal(plainTitle(once), once, `idempotent: ${sample.slice(0, 20)}`);
    assert.ok(Array.from(once).length <= TITLE_MAX);
  }
  assert.equal(plainName('A'.repeat(500)).length, 31, 'a name keeps its own cap of 30 and the ellipsis');
});

test('typing a title: empty clears it, plain words are kept as cleaned, and what is not words is refused (not silently dropped)', () => {
  assert.deepEqual(titleFromInput('CFO'), { ok: true, title: 'CFO' });
  assert.deepEqual(titleFromInput('  Head  of   Ops '), { ok: true, title: 'Head of Ops' });
  assert.deepEqual(titleFromInput('CFO (Finance)'), { ok: true, title: 'CFO Finance' });
  for (const empty of ['', '   ', null, undefined, '​', '\n\t']) assert.deepEqual(titleFromInput(empty), { ok: true, title: null }, JSON.stringify(empty));
  for (const bad of ['https://evil.example', '<b>', '1234', '(((', 42, {}, ['CFO'], true]) {
    const r = titleFromInput(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.match(r.error, /plain words/i);
  }
  assert.ok(titleFromInput('x'.repeat(100_000)).ok, 'a huge paste is cut, not a crash');
});

// ─── The label ──────────────────────────────────────────────────────────────

test('the title a person carries: their own when set, else "Finance lead" for the appointed approver, else the role word', () => {
  assert.equal(memberTitle({ title: 'CFO', role: 'admin' }), 'CFO');
  assert.equal(memberTitle({ title: null, role: 'admin' }), 'Owner');
  assert.equal(memberTitle({ title: undefined, role: 'maker' }), 'Staff');
  assert.equal(memberTitle({ title: '', role: 'checker', financeLead: true }), 'Finance lead');
  assert.equal(memberTitle({ title: 'Controller', role: 'checker', financeLead: true }), 'Controller', 'their own title wins over the appointment');
  assert.equal(memberTitle({ title: 'https://evil.example', role: 'viewer' }), 'Viewer', 'a title that is not words falls back to the role');
  assert.equal(memberTitle({}), 'Member');
  assert.equal(memberTitle({ title: 'B'.repeat(500), role: 'admin' }), `${'B'.repeat(39)}…`);
});

test('"Name (Title)" is made the same way everywhere, each part cleaned on its own', () => {
  assert.equal(memberLabel({ name: 'Aisha', title: 'CFO', role: 'admin' }), 'Aisha (CFO)');
  assert.equal(memberLabel({ name: 'Aisha', title: null, role: 'admin' }), 'Aisha (Owner)');
  assert.equal(memberLabel({ name: 'Ben', role: 'checker', financeLead: true }), 'Ben (Finance lead)');
  assert.equal(memberLabel({ name: 'Aisha (CFO), Ben', title: 'Owner), Ben (Owner', role: 'admin' }), 'Aisha CFO Ben (Owner Ben Owner)');
  assert.equal(memberLabel({ name: '<<>>', title: 'CFO', role: 'admin' }), 'CFO');
  assert.equal(memberLabel({ name: 'Aisha', title: 'Sales and Marketing' }), 'Aisha (Sales)');
  assert.equal(memberLabel({ name: 'Aisha' }), 'Aisha (Member)');
  assert.equal(declinerLabel({ name: 'Aisha', title: 'Head of Operations' }), 'Aisha (Head of Operations)', 'a decline snapshot is cleaned with the same title rules');
  assert.equal(declinerLabel({ name: 'Aisha', title: 'B'.repeat(500) }), `Aisha (${'B'.repeat(39)}…)`);
});

// ─── The trail, and who is offered the field ───────────────────────────────

test('a title change is a line on the team trail, in plain words', () => {
  assert.ok(TEAM_ACTIONS.includes('member_title_changed'));
  const line = (detail, actorName, subjectName) => activitySummary({ action: 'member_title_changed', detail, actorName, subjectName });
  assert.equal(line({ by: 'owner', from: null, to: 'CFO' }, 'Asha', 'Ben'), 'Asha set Ben’s title to CFO.');
  assert.equal(line({ by: 'owner', from: 'CFO', to: null }, 'Asha', 'Ben'), 'Asha cleared Ben’s title.');
  assert.equal(line({ by: 'self', from: null, to: 'CFO' }, 'Ben', 'Ben'), 'Ben set their own title to CFO.');
  assert.equal(line({ by: 'self', from: 'CFO', to: null }, 'Ben', 'Ben'), 'Ben cleared their own title.');
  assert.equal(line({ by: 'owner', from: null, to: 'https://evil.example' }, 'Asha', 'Ben'), 'Asha cleared Ben’s title.', 'a title in the trail is read as plain words again');
  assert.doesNotMatch(line({ by: 'owner', to: '<b>x</b>' }, 'Asha', 'Ben'), /<|>/);
});

test('an owner is offered the title of anyone, and every member is offered their own: nobody else is offered another person’s', () => {
  assert.equal(titleEditor({ manager: 'owner', youUserId: 'a' }, 'b'), 'owner');
  assert.equal(titleEditor({ manager: 'owner', youUserId: 'a' }, 'a'), 'self');
  assert.equal(titleEditor({ manager: 'finance_lead', youUserId: 'a' }, 'b'), null);
  assert.equal(titleEditor({ manager: 'finance_lead', youUserId: 'a' }, 'a'), 'self');
  assert.equal(titleEditor({ manager: null, youUserId: 'a' }, 'b'), null);
  assert.equal(titleEditor({ manager: null, youUserId: 'a' }, 'a'), 'self');
});

test('the words that explain the field follow the copy rules', () => {
  assert.match(TITLE_HELP, /40 characters/);
  assert.match(TITLE_HELP, /CFO/);
  assert.doesNotMatch(TITLE_HELP, /—|–|coral|coming soon|demo|testnet|non-custodial/i);
});

// ─── Wiring ─────────────────────────────────────────────────────────────────

test('the route is the owner’s and the person’s own, through the one team gate, rate limited, in the session’s business', () => {
  const path = 'app/api/team/members/[userId]/title/route.ts';
  assert.ok(existsSync(new URL(path, root)), path);
  const text = code(read(path));
  assert.match(text, /export async function PUT/);
  assert.match(text, /await teamRoute\(request\)/);
  assert.match(text, /await limitTeamChanges\(gate\.route\)/);
  assert.match(text, /setMemberTitle\(gate\.route\.db, \{[^}]*orgId: gate\.route\.orgId/);
  assert.match(text, /actorUserId: gate\.route\.authority\.userId/);
  assert.doesNotMatch(text, /body\.(orgId|actorUserId|org|actor)\b/);
});

test('every place that builds "Name (Title)" reads the title: the live card, the team list, Settings, the person in charge', () => {
  const store = read('lib/server/wallet-signing-store.ts');
  assert.match(store, /memberships\.title/, 'the live card reads the membership’s title');
  assert.match(store, /memberTitle\(\{ title:/, 'and gives it to memberTitle');
  assert.match(store, /export async function memberLabelOf/, 'one helper for any text built later (the exchange confirmation reads it)');
  assert.match(read('lib/server/team-admin.ts'), /title: .*plainTitle|plainTitle\(r\.title\)/, 'the team list carries each title');
  assert.match(read('lib/server/org-member-names.ts'), /memberships\.title/, 'the people to put in charge carry their titles');
  assert.doesNotMatch(code(read('components/wallet/Migration.tsx')), /roleLabel\(m\.role\)/, 'the person in charge is named with a title, not only the role word');
  assert.match(read('components/wallet/Migration.tsx'), /memberTitle\(m\)/);
  const card = read('components/settings/TeamCard.tsx');
  assert.match(card, /OwnTitle/, 'every member can set their own title in Settings');
  assert.match(read('components/team/MemberDialog.tsx'), /md-title/, 'an owner sets another person’s title under Manage');
  assert.ok(existsSync(new URL('components/team/OwnTitle.tsx', root)));
});

test('the invitation email names no title (the inviter is a name), so it needs nothing from this field', () => {
  const email = code(read('lib/team/invitation-email.ts'));
  assert.doesNotMatch(email, /memberTitle|memberLabel|declinerLabel/);
});

// ─── The migration ──────────────────────────────────────────────────────────

test('migration 0083 adds the title column and the trail line, re-lists the whole check, and is in the journal in order', () => {
  const sql = read('drizzle/0083_member_title.sql');
  assert.match(sql, /ALTER TABLE "memberships" ADD COLUMN IF NOT EXISTS "title" text/);
  assert.match(sql, /memberships_title_length/);
  assert.match(sql, /char_length\("title"\) <= 40/);
  const listed = (text) => [...(text.match(/wallet_authority_events_action_check" CHECK \("action" IN \(([\s\S]*?)\)\);/)?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  const before = listed(read('drizzle/0079_limits_kept_and_restore.sql'));
  const after = listed(sql);
  assert.ok(before.length > 40, 'the previous list was read');
  for (const action of before) assert.ok(after.includes(action), `${action} stays on the list`);
  assert.ok(after.includes('member_title_changed'));
  const types = read('lib/server/wallet-authority.ts');
  for (const action of after) assert.ok(types.includes(`'${action}'`), `${action} is in AuthorityAction`);
  const journal = JSON.parse(read('drizzle/meta/_journal.json'));
  const tags = journal.entries.map((e) => e.tag);
  const at = tags.indexOf('0083_member_title');
  assert.ok(at > 0 && tags[at - 1] === '0082_invitation_email', 'right after 0082');
  assert.equal(journal.entries[at].idx, at);
  assert.ok(journal.entries[at].when > journal.entries[at - 1].when);
  assert.doesNotMatch(sql, /wallet_member_access/, 'nothing is granted');
  assert.doesNotMatch(sql, /UPDATE\s+"?memberships/i, 'no member is given a title: empty by default');
});
