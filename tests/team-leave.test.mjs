/**
 * Leaving the team needs an owner's approval (v2 Phase 3, Sky's decision of 1 Nov):
 *
 *   - A member can ask to leave from their own settings. The request goes to
 *     the owners and NOTHING changes until one approves: the person keeps their
 *     access, their rule and their place in charge.
 *   - Approving ends access, clears what the person held (place in charge, the
 *     Finance lead role, Add funds and Withdraw, sign-offs) and records their
 *     addresses so the spending-rules revoke path takes their rule back.
 *   - The last owner cannot leave; an owner leaving needs another owner.
 *   - A declined request says so in words. Every step is a trail line, every
 *     read and write is the session's own business, and a repeat changes nothing.
 *
 * PGlite with every migration. The same functions the routes call.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { and, eq, isNull } from 'drizzle-orm';

import { migratedDb } from './helpers/store-db.mjs';
import * as schema from '../lib/db/schema.ts';
import { appointPersonInCharge, listAuthorityEvents } from '../lib/server/wallet-authority.ts';
import { appointFinanceLead, changeTeamMemberRole, fundsAccessOf, listTeamActivity, removeTeamMember, setMemberAccess } from '../lib/server/team-admin.ts';
import {
  approveLeaveRequest,
  declineLeaveRequest,
  leaveStatusOf,
  listLeaveRequests,
  requestToLeave,
  withdrawLeaveRequest,
} from '../lib/server/team-leave.ts';

const T0 = new Date('2026-11-02T09:00:00Z');
const VERIFIED = new Date('2026-10-01T00:00:00Z');
const base = { orgId: 'acme', now: () => T0 };

async function seeded() {
  const { client, db } = await migratedDb();
  const people = [
    ['u-owner', 'owner@acme.test', 'acme', 'admin'],
    ['u-owner2', 'owner2@acme.test', 'acme', 'admin'],
    ['u-lead', 'lead@acme.test', 'acme', 'checker'],
    ['u-appr', 'approver@acme.test', 'acme', 'checker'],
    ['u-maker', 'maker@acme.test', 'acme', 'maker'],
    ['u-maker2', 'maker2@acme.test', 'acme', 'maker'],
    ['u-viewer', 'viewer@acme.test', 'acme', 'viewer'],
    ['u-n-owner', 'owner@northwind.test', 'northwind', 'admin'],
    ['u-n-maker', 'maker@northwind.test', 'northwind', 'maker'],
  ];
  for (const [id, email, org, role] of people) {
    await db.insert(schema.users).values({ id, email, name: id, emailVerifiedAt: VERIFIED });
    await db.insert(schema.memberships).values({ id: `m-${id}`, userId: id, orgId: org, role });
  }
  assert.equal((await appointFinanceLead(db, { ...base, actorUserId: 'u-owner', userId: 'u-lead' })).ok, true);
  return { client, db };
}

const roleOf = async (db, orgId, userId) => (await db.select({ r: schema.memberships.role }).from(schema.memberships).where(and(eq(schema.memberships.orgId, orgId), eq(schema.memberships.userId, userId))))[0]?.r ?? null;
const trail = async (db, orgId = 'acme') => (await listAuthorityEvents(db, orgId)).map((e) => e.action);
const requests = (db, orgId = 'acme') => db.select().from(schema.teamLeaveRequests).where(eq(schema.teamLeaveRequests.orgId, orgId));
const ask = (db, userId, over = {}) => requestToLeave(db, { ...base, actorUserId: userId, ...over });
const approve = (db, actorUserId, requestId, over = {}) => approveLeaveRequest(db, { ...base, actorUserId, requestId, ...over });

test('a member asks to leave: the request goes to the owners and nothing about them changes', async () => {
  const { client, db } = await seeded();
  assert.equal((await setMemberAccess(db, { ...base, actorUserId: 'u-owner', userId: 'u-appr', access: 'add_funds', allowed: true })).ok, true);
  assert.equal((await appointPersonInCharge(db, { ...base, actorUserId: 'u-owner', userId: 'u-appr' })).ok, true);
  const before = await trail(db);
  const r = await ask(db, 'u-appr');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.created, true);
  assert.equal(await roleOf(db, 'acme', 'u-appr'), 'checker', 'still on the team');
  assert.equal((await fundsAccessOf(db, 'acme', 'u-appr')).addFunds, true, 'still holds what an owner gave');
  const charge = await db.select().from(schema.walletPersonsInCharge).where(and(eq(schema.walletPersonsInCharge.userId, 'u-appr'), isNull(schema.walletPersonsInCharge.revokedAt)));
  assert.equal(charge.length, 1, 'still in charge until an owner approves');
  assert.deepEqual((await trail(db)).slice(before.length), ['leave_requested']);
  const [row] = await requests(db);
  assert.equal(row.status, 'pending');
  assert.equal(row.userId, 'u-appr');
  const status = await leaveStatusOf(db, { orgId: 'acme', userId: 'u-appr' });
  assert.equal(status.state, 'pending');
  assert.match(status.message, /keep your access/i);
  await client.close();
});

test('every role can ask; a stranger and a person of another business cannot ask into this one', async () => {
  const { client, db } = await seeded();
  for (const userId of ['u-viewer', 'u-maker', 'u-lead', 'u-owner2']) assert.equal((await ask(db, userId)).ok, true, userId);
  for (const userId of ['u-n-maker', 'nobody']) {
    const r = await ask(db, userId);
    assert.equal(r.ok, false, userId);
    assert.equal(r.status, 403, userId);
  }
  assert.equal((await requests(db)).length, 4);
  assert.equal((await requests(db, 'northwind')).length, 0);
  await client.close();
});

test('asking twice is one request and one trail line (replay)', async () => {
  const { client, db } = await seeded();
  const first = await ask(db, 'u-maker');
  const again = await ask(db, 'u-maker');
  assert.equal(again.ok, true);
  assert.equal(again.created, false);
  assert.equal(again.request.id, first.request.id);
  assert.equal((await requests(db)).length, 1);
  assert.equal((await trail(db)).filter((a) => a === 'leave_requested').length, 1);
  await client.close();
});

test('the last owner cannot ask to leave, in words; an owner can when another owner remains', async () => {
  const { client, db } = await seeded();
  const sole = await requestToLeave(db, { orgId: 'northwind', actorUserId: 'u-n-owner', now: base.now });
  assert.equal(sole.ok, false);
  assert.equal(sole.status, 409);
  assert.equal(sole.code, 'last_owner');
  assert.match(sole.error, /only owner/i);
  assert.equal((await requests(db, 'northwind')).length, 0);
  const status = await leaveStatusOf(db, { orgId: 'northwind', userId: 'u-n-owner' });
  assert.equal(status.state, 'none');
  assert.equal(status.canRequest, false);
  assert.match(status.message, /only owner/i);
  assert.equal((await ask(db, 'u-owner2')).ok, true);
  await client.close();
});

test('an owner’s leaving needs ANOTHER owner: they cannot approve their own, the Finance lead and everyone else cannot approve it', async () => {
  const { client, db } = await seeded();
  const r = await ask(db, 'u-owner2');
  const own = await approve(db, 'u-owner2', r.request.id);
  assert.equal(own.ok, false);
  assert.equal(own.code, 'own_request');
  for (const [actor, code] of [['u-lead', 'owner_only'], ['u-appr', 'not_allowed'], ['u-maker', 'not_allowed'], ['u-viewer', 'not_allowed']]) {
    const x = await approve(db, actor, r.request.id);
    assert.equal(x.ok, false, actor);
    assert.equal(x.status, 403, actor);
    assert.equal(x.code, code, actor);
  }
  assert.equal(await roleOf(db, 'acme', 'u-owner2'), 'admin');
  const ok = await approve(db, 'u-owner', r.request.id);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(await roleOf(db, 'acme', 'u-owner2'), null);
  await client.close();
});

test('approving ends access, clears every hold, voids sign-offs, records addresses for the rule revoke, and writes the trail', async () => {
  const { client, db } = await seeded();
  await db.insert(schema.passkeyCredentials).values({ id: 'pk-1', userId: 'u-appr', credentialId: 'cred-1', publicKey: 'AAAA', suiAddress: '0x' + 'ab'.repeat(32), rpId: 'localhost' });
  assert.equal((await setMemberAccess(db, { ...base, actorUserId: 'u-owner', userId: 'u-appr', access: 'withdraw', allowed: true })).ok, true);
  assert.equal((await appointPersonInCharge(db, { ...base, actorUserId: 'u-owner', userId: 'u-appr' })).ok, true);
  const r = await ask(db, 'u-appr');
  const done = await approve(db, 'u-owner', r.request.id, { now: () => new Date(T0.getTime() + 60_000) });
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(done.changed, true);
  assert.deepEqual(done.leaver.addresses, ['0x' + 'ab'.repeat(32)]);
  assert.equal(done.leaver.role, 'checker');
  assert.equal(await roleOf(db, 'acme', 'u-appr'), null, 'no access');
  assert.equal((await fundsAccessOf(db, 'acme', 'u-appr')).withdraw, false);
  const charge = await db.select().from(schema.walletPersonsInCharge).where(and(eq(schema.walletPersonsInCharge.userId, 'u-appr'), isNull(schema.walletPersonsInCharge.revokedAt)));
  assert.equal(charge.length, 0, 'approver status cleared');
  const orphaned = await db.select().from(schema.walletOffboardedSpenders).where(eq(schema.walletOffboardedSpenders.userId, 'u-appr'));
  assert.equal(orphaned.length, 1, 'their address is recorded, so the revoke path finds their rule');
  assert.equal(orphaned[0].offboardedBy, 'u-owner');
  const [row] = await requests(db);
  assert.equal(row.status, 'approved');
  assert.equal(row.decidedBy, 'u-owner');
  const actions = await trail(db);
  for (const a of ['leave_requested', 'leave_approved', 'member_removed', 'member_offboarded', 'person_in_charge_revoked', 'member_access_revoked']) assert.ok(actions.includes(a), `${a} in ${actions.join(',')}`);
  const removed = (await listAuthorityEvents(db, 'acme')).find((e) => e.action === 'member_removed');
  assert.equal(removed.detail.reason, 'left');
  await client.close();
});

test('approving the same request again changes nothing and adds no trail line; a declined or withdrawn one cannot be approved', async () => {
  const { client, db } = await seeded();
  const r = await ask(db, 'u-maker');
  assert.equal((await approve(db, 'u-owner', r.request.id)).ok, true);
  const n = (await trail(db)).length;
  const again = await approve(db, 'u-owner2', r.request.id);
  assert.equal(again.ok, true);
  assert.equal(again.changed, false);
  assert.equal((await trail(db)).length, n);
  const r2 = await ask(db, 'u-maker2');
  assert.equal((await declineLeaveRequest(db, { ...base, actorUserId: 'u-owner', requestId: r2.request.id })).ok, true);
  const late = await approve(db, 'u-owner', r2.request.id);
  assert.equal(late.ok, false);
  assert.equal(late.status, 409);
  assert.equal(late.code, 'not_pending');
  assert.equal(await roleOf(db, 'acme', 'u-maker2'), 'maker');
  await client.close();
});

test('two owners approving at once make one removal and one set of trail lines', async () => {
  const { client, db } = await seeded();
  const r = await ask(db, 'u-maker');
  const results = await Promise.all([approve(db, 'u-owner', r.request.id), approve(db, 'u-owner2', r.request.id)]);
  assert.ok(results.every((x) => x.ok), JSON.stringify(results));
  assert.equal(results.filter((x) => x.changed).length, 1);
  assert.equal((await trail(db)).filter((a) => a === 'leave_approved').length, 1);
  assert.equal((await trail(db)).filter((a) => a === 'member_removed').length, 1);
  await client.close();
});

test('only an owner decides a request to leave: the Finance lead is refused for every request, plain staff included, and nothing changes', async () => {
  const { client, db } = await seeded();
  assert.equal((await appointPersonInCharge(db, { ...base, actorUserId: 'u-owner', userId: 'u-appr' })).ok, true);
  assert.equal((await setMemberAccess(db, { ...base, actorUserId: 'u-owner', userId: 'u-maker2', access: 'add_funds', allowed: true })).ok, true);
  const plain = await ask(db, 'u-maker');
  const inCharge = await ask(db, 'u-appr');
  const granted = await ask(db, 'u-maker2');
  const owner = await ask(db, 'u-owner2');
  for (const r of [plain, inCharge, granted, owner]) {
    const x = await approve(db, 'u-lead', r.request.id);
    assert.equal(x.ok, false);
    assert.equal(x.status, 403);
    assert.equal(x.code, 'owner_only');
    const d = await declineLeaveRequest(db, { ...base, actorUserId: 'u-lead', requestId: r.request.id });
    assert.equal(d.code, 'owner_only', 'nor can the lead decline it');
  }
  assert.equal(await roleOf(db, 'acme', 'u-maker'), 'maker', 'the lead’s approval would have ended access and left the on-chain rule live');
  assert.equal(await roleOf(db, 'acme', 'u-appr'), 'checker');
  assert.equal(await roleOf(db, 'acme', 'u-maker2'), 'maker');
  assert.equal((await requests(db)).filter((r) => r.status === 'pending').length, 4);
  assert.equal((await trail(db)).filter((a) => a === 'leave_approved' || a === 'member_removed').length, 0);
  // The lead’s own request is an owner’s to decide.
  const own = await ask(db, 'u-lead');
  assert.equal((await approve(db, 'u-lead', own.request.id)).code, 'own_request');
  assert.equal((await approve(db, 'u-owner', own.request.id)).ok, true);
  await client.close();
});

test('a person who is not an owner or the lead cannot decide anything, and a missing request is absent', async () => {
  const { client, db } = await seeded();
  const r = await ask(db, 'u-maker');
  for (const actorUserId of ['u-appr', 'u-maker2', 'u-viewer', 'u-maker']) {
    assert.equal((await approve(db, actorUserId, r.request.id)).status, 403, actorUserId);
    assert.equal((await declineLeaveRequest(db, { ...base, actorUserId, requestId: r.request.id })).status, 403, actorUserId);
  }
  const missing = await approve(db, 'u-owner', 'lvr_00000000-0000-0000-0000-000000000000');
  assert.equal(missing.status, 404);
  assert.equal(missing.code, 'not_found');
  await client.close();
});

test('cross-tenant: another business’s owner cannot see, approve or decline this business’s request, and this business’s owner cannot reach theirs', async () => {
  const { client, db } = await seeded();
  const mine = await ask(db, 'u-maker');
  const theirs = await requestToLeave(db, { orgId: 'northwind', actorUserId: 'u-n-maker', now: base.now });
  const x = await approveLeaveRequest(db, { orgId: 'northwind', actorUserId: 'u-n-owner', requestId: mine.request.id, now: base.now });
  assert.equal(x.status, 404);
  assert.equal(x.code, 'not_found');
  const d = await declineLeaveRequest(db, { orgId: 'northwind', actorUserId: 'u-n-owner', requestId: mine.request.id, now: base.now });
  assert.equal(d.status, 404);
  const y = await approve(db, 'u-owner', theirs.request.id);
  assert.equal(y.status, 404);
  const asNobody = await approveLeaveRequest(db, { orgId: 'northwind', actorUserId: 'u-owner', requestId: theirs.request.id, now: base.now });
  assert.equal(asNobody.status, 403, 'an acme owner is no one in northwind');
  assert.equal(await roleOf(db, 'acme', 'u-maker'), 'maker');
  assert.equal(await roleOf(db, 'northwind', 'u-n-maker'), 'maker');
  assert.deepEqual((await listLeaveRequests(db, { orgId: 'acme', actorUserId: 'u-owner' })).map((r) => r.userId), ['u-maker']);
  assert.deepEqual((await listLeaveRequests(db, { orgId: 'northwind', actorUserId: 'u-n-owner' })).map((r) => r.userId), ['u-n-maker']);
  assert.deepEqual(await listLeaveRequests(db, { orgId: 'acme', actorUserId: 'u-maker2' }), [], 'someone who manages nothing sees nothing');
  await client.close();
});

test('declining keeps the person on the team and says so in words; they can ask again; the decliner is on the trail', async () => {
  const { client, db } = await seeded();
  const r = await ask(db, 'u-maker');
  const declined = await declineLeaveRequest(db, { orgId: 'acme', actorUserId: 'u-owner', requestId: r.request.id, now: () => new Date(T0.getTime() + 5000) });
  assert.equal(declined.ok, true);
  assert.equal(declined.changed, true);
  assert.equal(await roleOf(db, 'acme', 'u-maker'), 'maker');
  const status = await leaveStatusOf(db, { orgId: 'acme', userId: 'u-maker' });
  assert.equal(status.state, 'declined');
  assert.equal(status.canRequest, true);
  assert.match(status.message, /declined your request to leave/i);
  assert.match(status.message, /still on the team/i);
  assert.equal(status.decidedByName, 'u-owner');
  const [event] = (await listAuthorityEvents(db, 'acme')).filter((e) => e.action === 'leave_declined');
  assert.equal(event.actorUserId, 'u-owner');
  assert.equal(event.subjectUserId, 'u-maker');
  assert.equal((await declineLeaveRequest(db, { ...base, actorUserId: 'u-owner', requestId: r.request.id })).changed, false, 'a repeat is harmless');
  assert.equal((await trail(db)).filter((a) => a === 'leave_declined').length, 1);
  const again = await ask(db, 'u-maker');
  assert.equal(again.ok, true);
  assert.equal(again.created, true, 'a new request after a decline');
  assert.equal((await leaveStatusOf(db, { orgId: 'acme', userId: 'u-maker' })).state, 'pending');
  await client.close();
});

test('the person can withdraw their request; then there is nothing to approve', async () => {
  const { client, db } = await seeded();
  const r = await ask(db, 'u-maker');
  const w = await withdrawLeaveRequest(db, { ...base, actorUserId: 'u-maker' });
  assert.equal(w.ok, true);
  assert.equal((await requests(db))[0].status, 'withdrawn');
  const none = await withdrawLeaveRequest(db, { ...base, actorUserId: 'u-maker' });
  assert.equal(none.ok, false);
  assert.equal(none.status, 404);
  assert.equal((await approve(db, 'u-owner', r.request.id)).code, 'not_pending');
  assert.equal((await trail(db)).filter((a) => a === 'leave_withdrawn').length, 1);
  assert.equal((await leaveStatusOf(db, { orgId: 'acme', userId: 'u-maker' })).state, 'none');
  await client.close();
});

test('an owner removing the person, or their role changing, does not leave a request that could be approved later', async () => {
  const { client, db } = await seeded();
  const r = await ask(db, 'u-maker');
  assert.equal((await removeTeamMember(db, { ...base, actorUserId: 'u-owner', userId: 'u-maker' })).ok, true);
  assert.equal((await requests(db))[0].status, 'closed');
  const late = await approve(db, 'u-owner', r.request.id);
  assert.equal(late.ok, false);
  assert.equal(late.code, 'not_pending');
  const q = await ask(db, 'u-viewer');
  assert.equal((await changeTeamMemberRole(db, { ...base, actorUserId: 'u-owner', userId: 'u-viewer', role: 'maker' })).ok, true);
  assert.equal((await requests(db)).find((x) => x.id === q.request.id).status, 'pending', 'a role change is not a removal; the request stands');
  await client.close();
});

test('who sees the open requests, in order, with whether the viewer may decide each', async () => {
  const { client, db } = await seeded();
  await appointPersonInCharge(db, { ...base, actorUserId: 'u-owner', userId: 'u-appr' });
  await ask(db, 'u-maker', { now: () => T0 });
  await ask(db, 'u-appr', { now: () => new Date(T0.getTime() + 1000) });
  await ask(db, 'u-owner2', { now: () => new Date(T0.getTime() + 2000) });
  const owner = await listLeaveRequests(db, { orgId: 'acme', actorUserId: 'u-owner' });
  assert.deepEqual(owner.map((r) => [r.userId, r.canDecide]), [['u-maker', true], ['u-appr', true], ['u-owner2', true]]);
  assert.equal(owner[0].name, 'u-maker');
  assert.equal(owner[0].email, 'maker@acme.test');
  const lead = await listLeaveRequests(db, { orgId: 'acme', actorUserId: 'u-lead' });
  assert.deepEqual(lead.map((r) => [r.userId, r.canDecide]), [['u-maker', false], ['u-appr', false], ['u-owner2', false]], 'the lead sees every request and decides none');
  assert.ok(lead.every((r) => /owner/i.test(r.whyNot)), 'each says an owner decides');
  const own = await listLeaveRequests(db, { orgId: 'acme', actorUserId: 'u-owner2' });
  assert.equal(own.find((r) => r.userId === 'u-owner2').canDecide, false, 'not their own');
  await client.close();
});

test('each step reads as a sentence in the team’s recent changes', async () => {
  const { client, db } = await seeded();
  const a = await ask(db, 'u-maker');
  const b = await ask(db, 'u-maker2');
  await approve(db, 'u-owner', a.request.id);
  await declineLeaveRequest(db, { ...base, actorUserId: 'u-owner', requestId: b.request.id });
  await withdrawLeaveRequest(db, { ...base, actorUserId: 'u-viewer' }).catch(() => null);
  const lines = (await listTeamActivity(db, 'acme')).map((x) => x.summary);
  assert.ok(lines.some((l) => /u-maker asked to leave the team/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => /u-owner approved u-maker’s request to leave/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => /u-owner declined u-maker2’s request to leave/.test(l) && /still on the team/.test(l)), lines.join('\n'));
  await client.close();
});
