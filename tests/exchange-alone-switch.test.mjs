/**
 * v2 Phase 3, "Can pay exchange accounts alone": the owner's switch, per
 * person (Sky's decision).
 *
 *   - Default OFF for everyone; nothing is backfilled for people already on
 *     the team.
 *   - Only an OWNER turns it on or off, and the change is instant: no
 *     cooldown, no notice, no second signature (an owner's own change).
 *   - It is kept per member, in `wallet_member_access` beside Add funds and
 *     Withdraw, and every change is a line in the append-only trail.
 *   - It is read from the database every time (`exchangeAloneOf`), for the
 *     person's own business, and grants nothing to a viewer, an owner (who
 *     does not pay alone), a stranger or another business's member.
 *
 * PGlite with every migration. The same functions the routes call.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

import { and, eq, isNull } from 'drizzle-orm';

import { migratedDb } from './helpers/store-db.mjs';
import * as schema from '../lib/db/schema.ts';
import { listAuthorityEvents } from '../lib/server/wallet-authority.ts';
import { appointFinanceLead, changeTeamMemberRole, fundsAccessOf, listTeam, listTeamActivity, removeTeamMember, setMemberAccess } from '../lib/server/team-admin.ts';
import { exchangeAloneOf } from '../lib/server/exchange-alone.ts';
import { activitySummary, EXCHANGE_ALONE_LABEL, EXCHANGE_ALONE_WORDS, rowControls } from '../lib/team/view.ts';

const T0 = new Date('2026-10-30T09:00:00Z');
const VERIFIED = new Date('2026-10-01T00:00:00Z');
const KIND = 'pay_exchange_alone';

async function seeded() {
  const { client, db } = await migratedDb();
  const people = [
    ['u-owner', 'acme', 'admin'],
    ['u-lead', 'acme', 'checker'],
    ['u-appr', 'acme', 'checker'],
    ['u-maker', 'acme', 'maker'],
    ['u-viewer', 'acme', 'viewer'],
    ['u-n-owner', 'northwind', 'admin'],
    ['u-n-maker', 'northwind', 'maker'],
  ];
  for (const [id, org, role] of people) {
    await db.insert(schema.users).values({ id, email: `${id}@example.test`, name: id, emailVerifiedAt: VERIFIED });
    await db.insert(schema.memberships).values({ id: `m-${id}`, userId: id, orgId: org, role });
  }
  return { client, db };
}

const owner = { orgId: 'acme', actorUserId: 'u-owner', now: () => T0 };
const set = (db, userId, allowed, who = owner) => setMemberAccess(db, { ...who, userId, access: KIND, allowed });
const trail = async (db) => (await listAuthorityEvents(db, 'acme')).filter((e) => e.action.startsWith('member_access'));

test('it is off for everyone by default, and no migration gives it to anyone', async () => {
  const { client, db } = await seeded();
  for (const id of ['u-owner', 'u-lead', 'u-appr', 'u-maker', 'u-viewer']) assert.equal(await exchangeAloneOf(db, 'acme', id), false, id);
  assert.equal((await db.select().from(schema.walletMemberAccess)).length, 0, 'nothing is granted for the people already on the team');
  const dir = new URL('../drizzle/', import.meta.url);
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql'))) {
    const sql = readFileSync(new URL(file, dir), 'utf8').replace(/--.*$/gm, '');
    assert.doesNotMatch(sql, /insert\s+into\s+"?wallet_member_access"?/i, `${file} must not backfill access`);
  }
  await client.close();
});

test('an owner turns it on for staff and for an approver; it is read back, kept per person, and a replay changes nothing and writes no second line', async () => {
  const { client, db } = await seeded();
  const first = await set(db, 'u-maker', true);
  assert.deepEqual([first.ok, first.changed], [true, true], JSON.stringify(first));
  assert.equal(await exchangeAloneOf(db, 'acme', 'u-maker'), true);
  assert.equal(await exchangeAloneOf(db, 'acme', 'u-appr'), false, 'another person is not affected');
  const again = await set(db, 'u-maker', true);
  assert.deepEqual([again.ok, again.changed], [true, false]);
  assert.equal((await set(db, 'u-appr', true)).changed, true);
  const lines = await trail(db);
  assert.deepEqual(lines.map((e) => [e.action, e.actorUserId, e.subjectUserId, e.detail.access]), [
    ['member_access_granted', 'u-owner', 'u-maker', KIND],
    ['member_access_granted', 'u-owner', 'u-appr', KIND],
  ]);
  await client.close();
});

test('it is a separate switch: Add funds and Withdraw do not give it, and it does not give them', async () => {
  const { client, db } = await seeded();
  await setMemberAccess(db, { ...owner, userId: 'u-maker', access: 'add_funds', allowed: true });
  await setMemberAccess(db, { ...owner, userId: 'u-maker', access: 'withdraw', allowed: true });
  assert.equal(await exchangeAloneOf(db, 'acme', 'u-maker'), false);
  await set(db, 'u-appr', true);
  assert.deepEqual(await fundsAccessOf(db, 'acme', 'u-appr'), { addFunds: false, withdraw: false });
  await client.close();
});

test('an owner takes it back at any time: at once, with no cooldown, the same second it was given', async () => {
  const { client, db } = await seeded();
  await set(db, 'u-maker', true);
  const off = await set(db, 'u-maker', false);
  assert.deepEqual([off.ok, off.changed], [true, true]);
  assert.equal(await exchangeAloneOf(db, 'acme', 'u-maker'), false, 'off the moment the owner says so');
  const [closed] = await db.select().from(schema.walletMemberAccess).where(eq(schema.walletMemberAccess.userId, 'u-maker'));
  assert.equal(closed.grantedAt.getTime(), closed.revokedAt.getTime(), 'no waiting period between granting and taking back');
  assert.equal((await set(db, 'u-maker', false)).changed, false, 'taking back what is not given writes nothing');
  assert.deepEqual((await trail(db)).map((e) => [e.action, e.detail.access]), [['member_access_granted', KIND], ['member_access_revoked', KIND]]);
  const on = await set(db, 'u-maker', true);
  assert.equal(on.changed, true, 'and it can be given again straight away');
  assert.equal(await exchangeAloneOf(db, 'acme', 'u-maker'), true);
  await client.close();
});

test('only an owner can change it: not the Finance lead, not the person themselves, not an approver, not another business', async () => {
  const { client, db } = await seeded();
  assert.equal((await appointFinanceLead(db, { ...owner, userId: 'u-lead' })).ok, true);
  const refusals = [
    ['the Finance lead', { orgId: 'acme', actorUserId: 'u-lead', now: () => T0 }, 'u-maker'],
    ['the Finance lead for themselves', { orgId: 'acme', actorUserId: 'u-lead', now: () => T0 }, 'u-lead'],
    ['the person themselves', { orgId: 'acme', actorUserId: 'u-maker', now: () => T0 }, 'u-maker'],
    ['an approver', { orgId: 'acme', actorUserId: 'u-appr', now: () => T0 }, 'u-maker'],
    ['a viewer', { orgId: 'acme', actorUserId: 'u-viewer', now: () => T0 }, 'u-maker'],
  ];
  for (const [who, actor, userId] of refusals) {
    const r = await set(db, userId, true, actor);
    assert.deepEqual([r.ok, r.status], [false, 403], who);
  }
  // Another business's owner cannot reach this business's people, and this business's owner cannot reach theirs.
  const north = await set(db, 'u-maker', true, { orgId: 'northwind', actorUserId: 'u-n-owner', now: () => T0 });
  assert.deepEqual([north.ok, north.status, north.code], [false, 404, 'not_a_member']);
  const south = await set(db, 'u-n-maker', true);
  assert.deepEqual([south.ok, south.status, south.code], [false, 404, 'not_a_member']);
  assert.equal((await db.select().from(schema.walletMemberAccess)).length, 0);
  assert.equal(await exchangeAloneOf(db, 'northwind', 'u-n-maker'), false);
  await client.close();
});

test('it is for staff and approvers only: a viewer cannot hold it, an owner has no use for it, and a stranger is not a member', async () => {
  const { client, db } = await seeded();
  const cases = [['u-viewer', 409, 'cannot_hold_access'], ['u-owner', 409, 'not_needed'], ['u-n-maker', 404, 'not_a_member'], ['u-nobody', 404, 'not_a_member']];
  for (const [userId, status, code] of cases) {
    const r = await set(db, userId, true);
    assert.deepEqual([r.ok, r.status, r.code], [false, status, code], userId);
  }
  assert.equal((await db.select().from(schema.walletMemberAccess)).length, 0);
  await client.close();
});

test('a row left behind grants nothing to a person who is now a viewer, an owner, or in another business', async () => {
  const { client, db } = await seeded();
  const row = (userId, orgId = 'acme') => db.insert(schema.walletMemberAccess).values({ id: `wma_${userId}`, orgId, userId, access: KIND, grantedBy: 'u-owner', grantedAt: T0 });
  await row('u-viewer');
  await row('u-owner');
  await row('u-n-maker', 'acme');
  for (const id of ['u-viewer', 'u-owner', 'u-n-maker']) assert.equal(await exchangeAloneOf(db, 'acme', id), false, id);
  await client.close();
});

test('moving the person to viewer, or removing them, ends it and says so on the trail', async () => {
  const { client, db } = await seeded();
  await set(db, 'u-maker', true);
  await set(db, 'u-appr', true);
  assert.equal((await changeTeamMemberRole(db, { ...owner, userId: 'u-maker', role: 'viewer' })).ok, true);
  assert.equal((await removeTeamMember(db, { ...owner, userId: 'u-appr' })).ok, true);
  assert.equal(await exchangeAloneOf(db, 'acme', 'u-maker'), false);
  assert.equal(await exchangeAloneOf(db, 'acme', 'u-appr'), false);
  assert.equal((await db.select().from(schema.walletMemberAccess).where(and(eq(schema.walletMemberAccess.access, KIND), isNull(schema.walletMemberAccess.revokedAt)))).length, 0);
  const revoked = (await trail(db)).filter((e) => e.action === 'member_access_revoked');
  assert.deepEqual(revoked.map((e) => [e.subjectUserId, e.detail.access]).sort(), [['u-appr', KIND], ['u-maker', KIND]]);
  await client.close();
});

test('staff to approver keeps the switch (the person is still someone who pays), and the Finance lead cannot move a person who holds it', async () => {
  const { client, db } = await seeded();
  await set(db, 'u-maker', true);
  assert.equal((await changeTeamMemberRole(db, { ...owner, userId: 'u-maker', role: 'checker' })).ok, true);
  assert.equal(await exchangeAloneOf(db, 'acme', 'u-maker'), true);
  await appointFinanceLead(db, { ...owner, userId: 'u-lead' });
  const lead = { orgId: 'acme', actorUserId: 'u-lead', now: () => T0 };
  const moved = await changeTeamMemberRole(db, { ...lead, userId: 'u-maker', role: 'viewer' });
  assert.deepEqual([moved.ok, moved.status], [false, 403], 'an owner granted this, so only an owner moves the person');
  const removed = await removeTeamMember(db, { ...lead, userId: 'u-maker' });
  assert.deepEqual([removed.ok, removed.status], [false, 403]);
  await client.close();
});

test('the team list shows who holds it, and only staff and approvers can', async () => {
  const { client, db } = await seeded();
  await set(db, 'u-maker', true);
  const list = await listTeam(db, 'acme');
  assert.deepEqual(list.filter((m) => m.payExchangeAlone).map((m) => m.userId), ['u-maker']);
  assert.ok(list.every((m) => typeof m.payExchangeAlone === 'boolean'));
  const activity = await listTeamActivity(db, 'acme');
  assert.match(activity.at(-1).summary, /u-owner .*u-maker.*exchange accounts/i);
  await client.close();
});

test('the words: plain, owner-only, and the control is offered to an owner on staff and approvers only', () => {
  assert.equal(EXCHANGE_ALONE_LABEL, 'Can pay exchange accounts alone');
  assert.match(EXCHANGE_ALONE_WORDS.join(' '), /rule/i);
  assert.match(EXCHANGE_ALONE_WORDS.join(' '), /Travel Rule|shared with the exchange/i);
  assert.match(EXCHANGE_ALONE_WORDS.join(' '), /any time/i);
  assert.doesNotMatch(EXCHANGE_ALONE_WORDS.join(' ') + EXCHANGE_ALONE_LABEL, /coming soon|demo|testnet|non-custodial/i);
  const row = (role, over = {}) => ({ userId: 'u-x', role, financeLead: false, inCharge: false, addFunds: false, withdraw: false, payExchangeAlone: false, ...over });
  assert.equal(rowControls({ manager: 'owner', youUserId: 'u-me' }, row('maker')).exchangeAlone, true);
  assert.equal(rowControls({ manager: 'owner', youUserId: 'u-me' }, row('checker')).exchangeAlone, true);
  for (const role of ['viewer', 'admin']) assert.equal(rowControls({ manager: 'owner', youUserId: 'u-me' }, row(role)).exchangeAlone, false, role);
  assert.equal(rowControls({ manager: 'finance_lead', youUserId: 'u-me' }, row('maker')).exchangeAlone, false);
  assert.equal(rowControls({ manager: 'finance_lead', youUserId: 'u-me' }, row('maker', { payExchangeAlone: true })).remove, false, 'a person who holds it is the owners to change');
  assert.match(activitySummary({ action: 'member_access_granted', detail: { access: KIND }, actorName: 'Asha', subjectName: 'Ben' }), /Asha let Ben pay exchange accounts alone\./);
  assert.match(activitySummary({ action: 'member_access_revoked', detail: { access: KIND }, actorName: 'Asha', subjectName: 'Ben' }), /Asha stopped Ben paying exchange accounts alone\./);
});

test('the database itself refuses an access kind it does not know', async () => {
  const { client, db } = await seeded();
  await assert.rejects(() => db.insert(schema.walletMemberAccess).values({ id: 'wma_bad', orgId: 'acme', userId: 'u-maker', access: 'bogus', grantedBy: 'u-owner', grantedAt: T0 }));
  await db.insert(schema.walletMemberAccess).values({ id: 'wma_ok', orgId: 'acme', userId: 'u-maker', access: KIND, grantedBy: 'u-owner', grantedAt: T0 });
  await client.close();
});
