/**
 * A member's job title on a real database (v2 Phase 3, p3-member-title).
 *
 *   - Empty by default; then the role word is used, as before.
 *   - An owner sets anyone's title in their own business; a person sets their own;
 *     nobody else sets another person's (the Finance lead included).
 *   - Cleaned as plain words (no link, markup, control or hidden character, spaces
 *     collapsed, 40 characters with an ellipsis, brackets and commas turned to
 *     spaces); a title that is not words is refused, not silently dropped.
 *   - Every change that changes something is a line on the append-only trail; a
 *     repeat writes none; two owners at once make one change.
 *   - Another business reads and writes nothing: absent (404) or refused (403).
 *   - The live card, the team list and the decline snapshot read it.
 *
 * PGlite with every migration. The same functions the routes call.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { and, eq } from 'drizzle-orm';

import { migratedDb } from './helpers/store-db.mjs';
import * as schema from '../lib/db/schema.ts';
import { listAuthorityEvents } from '../lib/server/wallet-authority.ts';
import { addTeamMember, appointFinanceLead, listTeam, listTeamActivity, removeTeamMember, setMemberTitle, titleOf } from '../lib/server/team-admin.ts';
import { declineSnapshot, memberLabelOf } from '../lib/server/wallet-signing-store.ts';

const T0 = new Date('2026-11-02T09:00:00Z');
const VERIFIED = new Date('2026-10-01T00:00:00Z');
const base = { orgId: 'acme', now: () => T0 };

async function seeded() {
  const { client, db } = await migratedDb();
  const people = [
    ['u-owner', 'Asha', 'acme', 'admin'],
    ['u-owner2', 'Omar', 'acme', 'admin'],
    ['u-lead', 'Lena', 'acme', 'checker'],
    ['u-appr', 'Aziz', 'acme', 'checker'],
    ['u-maker', 'Maya', 'acme', 'maker'],
    ['u-viewer', 'Vera', 'acme', 'viewer'],
    ['u-n-owner', 'Nadia', 'northwind', 'admin'],
    ['u-n-maker', 'Noor', 'northwind', 'maker'],
    ['u-free', 'Faris', null, null],
  ];
  for (const [id, name, org, role] of people) {
    await db.insert(schema.users).values({ id, email: `${id}@example.test`, name, emailVerifiedAt: VERIFIED });
    if (org) await db.insert(schema.memberships).values({ id: `m-${id}`, userId: id, orgId: org, role });
  }
  return { client, db };
}

const rawTitle = async (db, orgId, userId) => (await db.select({ t: schema.memberships.title }).from(schema.memberships).where(and(eq(schema.memberships.orgId, orgId), eq(schema.memberships.userId, userId))))[0]?.t;
const titleLines = async (db, orgId = 'acme') => (await listAuthorityEvents(db, orgId)).filter((e) => e.action === 'member_title_changed');

test('a member has no title until one is set: the column is empty, and the team list says so', async () => {
  const { client, db } = await seeded();
  assert.equal(await rawTitle(db, 'acme', 'u-owner'), null);
  assert.equal(await titleOf(db, 'acme', 'u-owner'), null);
  const team = await listTeam(db, 'acme');
  assert.equal(team.length, 6);
  for (const m of team) assert.equal(m.title, null, m.userId);
  assert.equal(await memberLabelOf(db, 'acme', 'u-owner').then((l) => l.label), 'Asha (Owner)', 'no title: the role word, as before');
  assert.equal(await memberLabelOf(db, 'acme', 'u-maker').then((l) => l.label), 'Maya (Staff)');
  await client.close();
});

test('an owner sets another member’s title; it is stored cleaned, shown in the team list and the label, and written to the trail', async () => {
  const { client, db } = await seeded();
  const r = await setMemberTitle(db, { ...base, actorUserId: 'u-owner', userId: 'u-appr', title: '  Head  of   Finance ' });
  assert.deepEqual(r, { ok: true, changed: true, title: 'Head of Finance' });
  assert.equal(await rawTitle(db, 'acme', 'u-appr'), 'Head of Finance');
  assert.equal((await listTeam(db, 'acme')).find((m) => m.userId === 'u-appr').title, 'Head of Finance');
  assert.equal((await memberLabelOf(db, 'acme', 'u-appr')).label, 'Aziz (Head of Finance)');
  const [line, ...rest] = await titleLines(db);
  assert.equal(rest.length, 0);
  assert.equal(line.actorUserId, 'u-owner');
  assert.equal(line.subjectUserId, 'u-appr');
  assert.deepEqual(line.detail, { by: 'owner', from: null, to: 'Head of Finance' });
  assert.equal(line.createdAt.getTime(), T0.getTime());
  const said = (await listTeamActivity(db, 'acme')).find((a) => a.action === 'member_title_changed');
  assert.equal(said.summary, 'Asha set Aziz’s title to Head of Finance.');
  // Changed, then cleared.
  assert.deepEqual(await setMemberTitle(db, { ...base, actorUserId: 'u-owner2', userId: 'u-appr', title: 'Controller' }), { ok: true, changed: true, title: 'Controller' });
  assert.deepEqual(await setMemberTitle(db, { ...base, actorUserId: 'u-owner', userId: 'u-appr', title: '' }), { ok: true, changed: true, title: null });
  assert.equal(await rawTitle(db, 'acme', 'u-appr'), null, 'empty clears it: the role word is used again');
  assert.equal((await memberLabelOf(db, 'acme', 'u-appr')).label, 'Aziz (Approver)');
  assert.deepEqual((await titleLines(db)).map((l) => l.detail), [
    { by: 'owner', from: null, to: 'Head of Finance' },
    { by: 'owner', from: 'Head of Finance', to: 'Controller' },
    { by: 'owner', from: 'Controller', to: null },
  ]);
  await client.close();
});

test('an owner may set their own title, and another owner’s', async () => {
  const { client, db } = await seeded();
  assert.equal((await setMemberTitle(db, { ...base, actorUserId: 'u-owner', userId: 'u-owner', title: 'CEO' })).ok, true);
  assert.equal((await setMemberTitle(db, { ...base, actorUserId: 'u-owner', userId: 'u-owner2', title: 'COO' })).ok, true);
  assert.deepEqual((await titleLines(db)).map((l) => [l.subjectUserId, l.detail.by]), [['u-owner', 'self'], ['u-owner2', 'owner']]);
  await client.close();
});

test('a person sets their own title, whatever their role, and it is on the trail as their own', async () => {
  const { client, db } = await seeded();
  for (const [userId, title] of [['u-viewer', 'Analyst'], ['u-maker', 'Operations'], ['u-appr', 'CFO'], ['u-lead', 'Finance lead']]) {
    const r = await setMemberTitle(db, { ...base, actorUserId: userId, userId, title });
    assert.deepEqual(r, { ok: true, changed: true, title }, userId);
  }
  assert.equal((await memberLabelOf(db, 'acme', 'u-viewer')).label, 'Vera (Analyst)');
  const lines = await titleLines(db);
  assert.equal(lines.length, 4);
  assert.ok(lines.every((l) => l.detail.by === 'self' && l.actorUserId === l.subjectUserId));
  assert.equal((await listTeamActivity(db, 'acme')).find((a) => a.action === 'member_title_changed' && a.actorName === 'Vera').summary, 'Vera set their own title to Analyst.');
  await client.close();
});

test('nobody but an owner sets another person’s title: staff, approvers, viewers and the Finance lead are refused and nothing is written', async () => {
  const { client, db } = await seeded();
  assert.equal((await appointFinanceLead(db, { ...base, actorUserId: 'u-owner', userId: 'u-lead' })).ok, true);
  const refusals = [
    ['u-lead', 'u-maker', 'owner_only'],
    ['u-lead', 'u-viewer', 'owner_only'],
    ['u-lead', 'u-owner', 'owner_only'],
    ['u-appr', 'u-maker', 'not_allowed'],
    ['u-maker', 'u-owner', 'not_allowed'],
    ['u-viewer', 'u-maker', 'not_allowed'],
  ];
  for (const [actorUserId, userId, code] of refusals) {
    const r = await setMemberTitle(db, { ...base, actorUserId, userId, title: 'CEO' });
    assert.equal(r.ok, false, `${actorUserId} -> ${userId}`);
    assert.equal(r.status, 403);
    assert.equal(r.code, code, `${actorUserId} -> ${userId}`);
  }
  for (const id of ['u-maker', 'u-viewer', 'u-owner']) assert.equal(await rawTitle(db, 'acme', id), null);
  assert.equal((await titleLines(db)).length, 0, 'a refusal writes no line');
  // The Finance lead may still set their own.
  assert.equal((await setMemberTitle(db, { ...base, actorUserId: 'u-lead', userId: 'u-lead', title: 'Treasurer' })).ok, true);
  await client.close();
});

test('a title is plain words: links, markup and hidden characters never get in; brackets and commas become spaces', async () => {
  const { client, db } = await seeded();
  const set = (title) => setMemberTitle(db, { ...base, actorUserId: 'u-owner', userId: 'u-maker', title });
  assert.deepEqual(await set('CFO (Finance), Ops'), { ok: true, changed: true, title: 'CFO Finance Ops' });
  assert.deepEqual(await set('Ops​ lead‮'), { ok: true, changed: true, title: 'Ops lead' });
  assert.deepEqual(await set('Lead https://evil.example/pay'), { ok: true, changed: true, title: 'Lead' });
  for (const bad of ['https://evil.example', '<script>alert(1)</script>', '<b>CFO</b>', '1234', '[x](https://evil.example)x']) {
    const r = await set(bad);
    if (bad.startsWith('[x]')) {
      assert.equal(r.ok, true, 'a plain word before the link is kept');
      assert.doesNotMatch(String(r.title), /evil|https|\[|\]|\(|\)/);
      continue;
    }
    assert.equal(r.ok, false, bad);
    assert.equal(r.status, 400);
    assert.equal(r.code, 'bad_title');
  }
  assert.doesNotMatch(String(await rawTitle(db, 'acme', 'u-maker')), /evil|<|>|\(|\)|,/);
  for (const nonString of [42, {}, ['CFO'], true]) {
    const r = await set(nonString);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'bad_title');
  }
  const long = await set('Senior Vice President of Global Treasury Finance Operations');
  assert.equal(long.ok, true);
  assert.ok(Array.from(long.title).length <= 40 && long.title.endsWith('…'), long.title);
  assert.ok(Array.from(await rawTitle(db, 'acme', 'u-maker')).length <= 40, 'the database holds at most 40 characters');
  await client.close();
});

test('the database itself refuses a title over 40 characters', async () => {
  const { client, db } = await seeded();
  await assert.rejects(() => client.exec(`UPDATE memberships SET title = '${'x'.repeat(41)}' WHERE user_id = 'u-maker'`), /memberships_title_length|violates check/);
  await client.exec(`UPDATE memberships SET title = '${'x'.repeat(40)}' WHERE user_id = 'u-maker'`);
  assert.equal((await rawTitle(db, 'acme', 'u-maker')).length, 40);
  await client.close();
});

test('the same title again changes nothing and writes no second line; two owners at once make one change', async () => {
  const { client, db } = await seeded();
  const first = await setMemberTitle(db, { ...base, actorUserId: 'u-owner', userId: 'u-maker', title: 'Operations' });
  assert.deepEqual(first, { ok: true, changed: true, title: 'Operations' });
  const again = await setMemberTitle(db, { ...base, actorUserId: 'u-owner2', userId: 'u-maker', title: ' Operations ' });
  assert.deepEqual(again, { ok: true, changed: false, title: 'Operations' });
  assert.equal((await titleLines(db)).length, 1);
  assert.deepEqual(await setMemberTitle(db, { ...base, actorUserId: 'u-owner', userId: 'u-viewer', title: '' }), { ok: true, changed: false, title: null }, 'clearing what is empty is a no-op');
  const both = await Promise.all([
    setMemberTitle(db, { ...base, actorUserId: 'u-owner', userId: 'u-appr', title: 'Controller' }),
    setMemberTitle(db, { ...base, actorUserId: 'u-owner2', userId: 'u-appr', title: 'Controller' }),
  ]);
  assert.deepEqual(both.map((r) => r.ok), [true, true]);
  assert.equal(both.filter((r) => r.changed).length, 1, 'exactly one of them made the change');
  assert.equal((await titleLines(db)).filter((l) => l.subjectUserId === 'u-appr').length, 1);
  await client.close();
});

test('another business reads and writes nothing: an owner of Northwind cannot touch Acme’s people, and Acme’s owner cannot touch Northwind’s', async () => {
  const { client, db } = await seeded();
  await setMemberTitle(db, { orgId: 'northwind', actorUserId: 'u-n-owner', userId: 'u-n-maker', title: 'Buyer', now: () => T0 });
  // A Northwind owner acting in Northwind on an Acme member: absent.
  const a = await setMemberTitle(db, { orgId: 'northwind', actorUserId: 'u-n-owner', userId: 'u-appr', title: 'Spy' });
  assert.equal(a.ok, false);
  assert.equal(a.status, 404);
  assert.equal(a.code, 'not_a_member');
  // A Northwind owner naming Acme as the business: they are not a member there.
  const b = await setMemberTitle(db, { ...base, actorUserId: 'u-n-owner', userId: 'u-appr', title: 'Spy' });
  assert.equal(b.ok, false);
  assert.equal(b.status, 403);
  // Acme's owner naming a Northwind person: absent, and the Northwind title is untouched.
  const c = await setMemberTitle(db, { ...base, actorUserId: 'u-owner', userId: 'u-n-maker', title: 'Spy' });
  assert.equal(c.ok, false);
  assert.equal(c.status, 404);
  assert.equal(await rawTitle(db, 'northwind', 'u-n-maker'), 'Buyer');
  assert.equal(await rawTitle(db, 'acme', 'u-appr'), null);
  // The title of another business is not readable through the label or the team list either.
  assert.equal(await memberLabelOf(db, 'acme', 'u-n-maker'), null);
  assert.equal((await listTeam(db, 'acme')).some((m) => m.title === 'Buyer'), false);
  assert.equal(await titleOf(db, 'acme', 'u-n-maker'), null);
  // Someone who is no member at all, and a person who does not exist.
  assert.equal((await setMemberTitle(db, { ...base, actorUserId: 'u-free', userId: 'u-free', title: 'CEO' })).status, 403);
  assert.equal((await setMemberTitle(db, { ...base, actorUserId: 'u-owner', userId: 'u-nobody', title: 'CEO' })).status, 404);
  // The trail of one business holds none of the other's lines.
  assert.equal((await titleLines(db, 'acme')).length, 0);
  assert.equal((await titleLines(db, 'northwind')).length, 1);
  await client.close();
});

test('a person who is removed takes their title with them, and someone added later starts with none', async () => {
  const { client, db } = await seeded();
  await setMemberTitle(db, { ...base, actorUserId: 'u-owner', userId: 'u-maker', title: 'Operations' });
  assert.equal((await removeTeamMember(db, { ...base, actorUserId: 'u-owner', userId: 'u-maker' })).ok, true);
  assert.equal(await rawTitle(db, 'acme', 'u-maker'), undefined);
  assert.equal(await memberLabelOf(db, 'acme', 'u-maker'), null, 'a former member has no live card');
  const added = await addTeamMember(db, { ...base, actorUserId: 'u-owner', email: 'u-maker@example.test', role: 'maker' });
  assert.equal(added.ok, true, JSON.stringify(added));
  assert.equal(await rawTitle(db, 'acme', 'u-maker'), null);
  await client.close();
});

test('the decline snapshot is the name and the title as they are at that moment: the person’s own title, else the Finance lead, else the role word', async () => {
  const { client, db } = await seeded();
  assert.deepEqual(await declineSnapshot(db, 'acme', 'u-owner'), { name: 'Asha', title: 'Owner' });
  await setMemberTitle(db, { ...base, actorUserId: 'u-owner', userId: 'u-owner', title: 'CEO' });
  assert.deepEqual(await declineSnapshot(db, 'acme', 'u-owner'), { name: 'Asha', title: 'CEO' });
  await appointFinanceLead(db, { ...base, actorUserId: 'u-owner', userId: 'u-lead' });
  assert.deepEqual(await declineSnapshot(db, 'acme', 'u-lead'), { name: 'Lena', title: 'Finance lead' });
  await setMemberTitle(db, { ...base, actorUserId: 'u-lead', userId: 'u-lead', title: 'Treasurer' });
  assert.deepEqual(await declineSnapshot(db, 'acme', 'u-lead'), { name: 'Lena', title: 'Treasurer' });
  // A 40-character title is kept whole in the snapshot (the snapshot is not cut at the name's 30).
  await setMemberTitle(db, { ...base, actorUserId: 'u-owner', userId: 'u-appr', title: 'Senior Treasury Operations Lead Europe XY' });
  const kept = (await declineSnapshot(db, 'acme', 'u-appr')).title;
  assert.ok(Array.from(kept).length > 30 && Array.from(kept).length <= 40, kept);
  // Not a member of this business: the plainest title, never another business's.
  assert.deepEqual(await declineSnapshot(db, 'acme', 'u-n-owner'), { name: 'Nadia', title: 'Member' });
  await client.close();
});

test('a stored title that is not words (written some other way) is still said as plain words', async () => {
  const { client, db } = await seeded();
  await client.exec(`UPDATE memberships SET title = 'CFO https://evil.example' WHERE user_id = 'u-owner'`);
  await client.exec(`UPDATE memberships SET title = '<b>x</b>' WHERE user_id = 'u-owner2'`);
  const team = await listTeam(db, 'acme');
  assert.equal(team.find((m) => m.userId === 'u-owner').title, 'CFO');
  assert.equal(team.find((m) => m.userId === 'u-owner2').title, null);
  assert.equal((await memberLabelOf(db, 'acme', 'u-owner')).label, 'Asha (CFO)');
  assert.equal((await memberLabelOf(db, 'acme', 'u-owner2')).label, 'Omar (Owner)');
  assert.deepEqual(await declineSnapshot(db, 'acme', 'u-owner2'), { name: 'Omar', title: 'Owner' });
  await client.close();
});
