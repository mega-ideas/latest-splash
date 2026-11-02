/**
 * Two people for a large grant (v2 Phase 3, Sky's decision). A raise that takes the daily limit above 250,000 USDC or the
 * monthly limit above 2,500,000 USDC needs TWO different Splash staff approvals, one from compliance and one from
 * operations. One person can never approve twice. The first approval is recorded and starts nothing; the 24 hour
 * notice starts only after the second. A raise inside those amounts needs one approval, as it always did. The trail
 * names both approvers.
 *
 * Against a real database (PGlite with every migration), with an injected clock.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { eq } from 'drizzle-orm';

import { migratedDb } from './helpers/store-db.mjs';
import { LEGACY_LIMITS, pinLegacyLimits } from './helpers/limits-legacy.mjs';
import * as schema from '../lib/db/schema.ts';
import { LIMIT_NOTICE_MS, LARGE_GRANT_LINES, effectiveAtMs } from '../lib/limits/rules.ts';
import {
  cancelLimitRequest,
  currentLimits,
  decideLimitRequestForStaff,
  listLimitRequestsForStaff,
  readLimitsView,
  requestHigherLimit,
  sendLimitNotices,
} from '../lib/server/business-limits.ts';
import { listAuthorityEvents } from '../lib/server/wallet-authority.ts';

const U = (usdc) => BigInt(Math.round(usdc * 1_000_000));
const T0 = new Date('2026-11-02T09:00:00Z');
const H = 3_600_000;
const at = (ms) => () => new Date(ms);
const VERIFIED = new Date('2026-10-01T00:00:00Z');
const REASON = 'We now pay four hundred suppliers every week.';
const COMPLIANCE = { email: 'Mariam@Splash.test', role: 'compliance' };
const COMPLIANCE_2 = { email: 'sofia@splash.test', role: 'compliance' };
const OPERATIONS = { email: 'ops@splash.test', role: 'operations' };
const OPERATIONS_2 = { email: 'raj@splash.test', role: 'operations' };
const SUPPORT = { email: 'help@splash.test', role: 'support' };

async function seeded() {
  const { client, db } = await migratedDb();
  for (const [id, email, org] of [['u-owner', 'owner@acme.test', 'acme'], ['u-n-owner', 'owner@northwind.test', 'northwind']]) {
    await db.insert(schema.users).values({ id, email, name: id, emailVerifiedAt: VERIFIED });
    await db.insert(schema.memberships).values({ id: `m-${id}`, userId: id, orgId: org, role: 'admin' });
  }
  await pinLegacyLimits(db, ['acme', 'northwind']);
  return { client, db };
}

let seq = 0;
const key = () => `two-key-${String(++seq).padStart(6, '0')}`;
const ask = (db, over = {}) => requestHigherLimit(db, { orgId: 'acme', actorUserId: 'u-owner', kind: 'daily', requested: '300,000', reason: REASON, requestKey: key(), now: at(T0.getTime()), ...over });
const decide = (db, id, staff, over = {}) => decideLimitRequestForStaff(db, { requestId: id, staff, action: 'approve', now: at(T0.getTime() + H), ...over });
const rowOf = async (db, id) => (await db.select().from(schema.businessLimitRequests).where(eq(schema.businessLimitRequests.id, id)))[0];
const actions = async (db, orgId = 'acme') => (await listAuthorityEvents(db, orgId)).map((e) => e.action);

// ─── Inside the lines: one approval, as before ───────────────────────────────

test('a raise to exactly the lines needs one approval; one unit above needs two', async () => {
  const { db } = await seeded();
  const day = await ask(db, { requested: '250,000' });
  assert.equal(day.ok, true, JSON.stringify(day));
  const one = await decide(db, day.request.id, COMPLIANCE);
  assert.equal(one.ok, true, JSON.stringify(one));
  assert.equal(one.stage, 'decided');
  assert.equal(one.request.phase, 'waiting', 'a single approval starts the 24 hour notice at once');
  assert.equal((await rowOf(db, day.request.id)).firstApprovedBy, null);

  const month = await ask(db, { kind: 'monthly', requested: '2,500,000' });
  assert.equal((await decide(db, month.request.id, OPERATIONS)).stage, 'decided');

  const over = await ask(db, { orgId: 'northwind', actorUserId: 'u-n-owner', requested: '250,000.000001' });
  assert.equal(over.ok, true, JSON.stringify(over));
  const first = await decide(db, over.request.id, COMPLIANCE);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.stage, 'first_approval', 'one unit above the line is two people');
});

test('approving a smaller figure inside the lines is one approval, even when the owner asked for more', async () => {
  const { db } = await seeded();
  const made = await ask(db, { requested: '400,000' });
  const out = await decide(db, made.request.id, COMPLIANCE, { action: 'approve_smaller', granted: '200,000' });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.stage, 'decided');
  assert.equal(out.request.granted, U(200_000).toString());
});

// ─── The first approval: recorded, and nothing starts ────────────────────────

test('the first approval is recorded and starts nothing: no notice, no effective time, no limit change, no word to the owners', async () => {
  const { db } = await seeded();
  const made = await ask(db);
  const first = await decide(db, made.request.id, COMPLIANCE);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.stage, 'first_approval');
  assert.equal(first.replayed, false);
  const row = await rowOf(db, made.request.id);
  assert.equal(row.status, 'pending', 'still waiting');
  assert.equal(row.effectiveAt, null, 'no clock started');
  assert.equal(row.decidedBy, null);
  assert.equal(row.grantedValue, null);
  assert.equal(row.firstApprovedBy, 'operator:mariam@splash.test', 'named, lower-case');
  assert.equal(row.firstApproverRole, 'compliance');
  assert.equal(row.firstGrantedValue, U(300_000));
  assert.equal(row.firstApprovedAt.getTime(), T0.getTime() + H);
  assert.equal(first.request.phase, 'asked', 'the owner’s page still says Splash is reviewing it');
  assert.doesNotMatch(first.request.says, /mariam|compliance/i, 'the owner is not shown who');
  // 24 hours and a month after the first approval: still nothing.
  for (const later of [LIMIT_NOTICE_MS, 30 * LIMIT_NOTICE_MS]) {
    assert.equal((await currentLimits(db, 'acme', at(T0.getTime() + H + later))).daily, LEGACY_LIMITS.daily, 'the limit is where it was');
  }
  const told = [];
  const sent = await sendLimitNotices(db, { notify: async (orgId, notice) => (told.push([orgId, notice.subject]), 1), now: at(T0.getTime() + 2 * H) });
  assert.deepEqual(told, []);
  assert.deepEqual(sent, { sent: 0, failed: 0 });
  assert.deepEqual(await actions(db), ['limit_raise_requested', 'limit_request_first_approved']);
  const line = (await listAuthorityEvents(db, 'acme')).at(-1);
  assert.equal(line.actorUserId, 'operator:mariam@splash.test');
  assert.equal(line.detail.role, 'compliance');
  assert.equal(line.detail.granted, U(300_000).toString());
  assert.equal(line.detail.needsSecondFrom, 'operations');
});

test('the same person cannot approve twice, however they spell their address or choose their words', async () => {
  const { db } = await seeded();
  const made = await ask(db);
  assert.equal((await decide(db, made.request.id, COMPLIANCE)).stage, 'first_approval');
  const again = await decide(db, made.request.id, { email: ' MARIAM@splash.test ', role: 'compliance' });
  assert.equal(again.ok, true, 'a double click is a replay, not an error');
  assert.equal(again.replayed, true);
  assert.equal(again.stage, 'first_approval');
  // The same person with the other role (a test login, a changed role) is still the same person.
  const asOps = await decide(db, made.request.id, { email: 'mariam@splash.test', role: 'operations' });
  assert.equal(asOps.stage, 'first_approval');
  assert.equal(asOps.replayed, true);
  assert.equal((await rowOf(db, made.request.id)).status, 'pending');
  assert.equal((await rowOf(db, made.request.id)).decidedBy, null);
  // A different figure from the same person is refused, not taken as a second approval.
  const other = await decide(db, made.request.id, COMPLIANCE, { action: 'approve_smaller', granted: '280,000' });
  assert.equal(other.ok, false);
  assert.equal(other.code, 'figure_differs');
  assert.deepEqual((await actions(db)).filter((a) => a === 'limit_request_first_approved'), ['limit_request_first_approved'], 'one line for one approval');
});

test('the second approval must come from the other role: a second compliance login, or support, is refused', async () => {
  const { db } = await seeded();
  const made = await ask(db);
  assert.equal((await decide(db, made.request.id, COMPLIANCE)).stage, 'first_approval');
  const sameRole = await decide(db, made.request.id, COMPLIANCE_2);
  assert.equal(sameRole.ok, false);
  assert.equal(sameRole.status, 403);
  assert.equal(sameRole.code, 'second_approver_role');
  assert.match(sameRole.error, /operations/i, 'says who is needed');
  const support = await decide(db, made.request.id, SUPPORT);
  assert.equal(support.code, 'role_not_allowed');
  assert.equal((await rowOf(db, made.request.id)).status, 'pending');
  // And the other way round.
  const back = await ask(db, { orgId: 'northwind', actorUserId: 'u-n-owner' });
  assert.equal((await decide(db, back.request.id, OPERATIONS)).stage, 'first_approval');
  const wrong = await decide(db, back.request.id, OPERATIONS_2);
  assert.equal(wrong.code, 'second_approver_role');
  assert.match(wrong.error, /compliance/i);
  assert.equal((await decide(db, back.request.id, COMPLIANCE)).stage, 'decided');
});

// ─── The second approval: the notice starts now, and both are named ──────────

test('the second approval starts the 24 hour notice from the second, and the trail names both approvers', async () => {
  const { db } = await seeded();
  const made = await ask(db);
  assert.equal((await decide(db, made.request.id, COMPLIANCE)).stage, 'first_approval');
  const secondAt = T0.getTime() + 5 * H;
  const second = await decide(db, made.request.id, OPERATIONS, { now: at(secondAt) });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.stage, 'decided');
  assert.equal(second.replayed, false);
  assert.equal(second.request.phase, 'waiting');
  const row = await rowOf(db, made.request.id);
  assert.equal(row.status, 'approved');
  assert.equal(row.firstApprovedBy, 'operator:mariam@splash.test');
  assert.equal(row.decidedBy, 'operator:ops@splash.test');
  assert.equal(row.decidedRole, 'operations');
  assert.equal(row.grantedValue, U(300_000));
  assert.equal(row.decidedAt.getTime(), secondAt);
  assert.equal(row.effectiveAt.getTime(), effectiveAtMs(secondAt), 'the notice runs from the second approval');
  assert.ok(row.effectiveAt.getTime() > effectiveAtMs(T0.getTime() + H), 'and not from the first');

  const trail = await listAuthorityEvents(db, 'acme');
  assert.deepEqual(trail.map((e) => e.action), ['limit_raise_requested', 'limit_request_first_approved', 'limit_request_approved']);
  const approved = trail.at(-1);
  assert.equal(approved.actorUserId, 'operator:ops@splash.test');
  assert.deepEqual(approved.detail.approvers, [
    { by: 'operator:mariam@splash.test', role: 'compliance', at: new Date(T0.getTime() + H).toISOString() },
    { by: 'operator:ops@splash.test', role: 'operations', at: new Date(secondAt).toISOString() },
  ]);
  assert.equal(approved.detail.twoApprovals, true);

  // Nothing changes until the notice ends; then it does.
  assert.equal((await currentLimits(db, 'acme', at(effectiveAtMs(secondAt) - 1))).daily, LEGACY_LIMITS.daily);
  assert.equal((await currentLimits(db, 'acme', at(effectiveAtMs(secondAt)))).daily, U(300_000));
  const applied = (await listAuthorityEvents(db, 'acme')).at(-1);
  assert.equal(applied.action, 'limit_change_applied');
  assert.equal(applied.detail.approvedBy, 'operator:ops@splash.test');
  assert.equal(applied.detail.firstApprovedBy, 'operator:mariam@splash.test', 'the line that makes it real names the first approver too');
  // The owners are told once, as for any approval.
  const told = [];
  await sendLimitNotices(db, { notify: async (orgId, notice) => (told.push([orgId, notice.subject]), 1), now: at(effectiveAtMs(secondAt) + H) });
  assert.equal(told.length, 1, 'the approved-and-started notice, once');
});

test('the second approval is for the figure the first approved: a different figure is refused, agreeing is not', async () => {
  const { db } = await seeded();
  const made = await ask(db, { requested: '400,000' });
  assert.equal((await decide(db, made.request.id, COMPLIANCE, { action: 'approve_smaller', granted: '320,000' })).stage, 'first_approval');
  const differs = await decide(db, made.request.id, OPERATIONS);
  assert.equal(differs.ok, false);
  assert.equal(differs.code, 'figure_differs');
  assert.match(differs.error, /320,000 USDC/);
  const smaller = await decide(db, made.request.id, OPERATIONS, { action: 'approve_smaller', granted: '300,000' });
  assert.equal(smaller.code, 'figure_differs');
  const agree = await decide(db, made.request.id, OPERATIONS, { action: 'approve_smaller', granted: '320,000' });
  assert.equal(agree.ok, true, JSON.stringify(agree));
  assert.equal(agree.request.granted, U(320_000).toString());
});

test('double-clicking the second approval, from two tabs, approves once', async () => {
  const { db } = await seeded();
  const made = await ask(db);
  await decide(db, made.request.id, COMPLIANCE);
  const results = await Promise.all([decide(db, made.request.id, OPERATIONS), decide(db, made.request.id, OPERATIONS), decide(db, made.request.id, OPERATIONS)]);
  assert.ok(results.every((r) => r.ok), JSON.stringify(results));
  assert.equal(results.filter((r) => !r.replayed).length, 1);
  assert.deepEqual((await actions(db)).filter((a) => a === 'limit_request_approved'), ['limit_request_approved']);
  // The first approver clicking again afterwards is a replay too, not a third approval.
  const late = await decide(db, made.request.id, COMPLIANCE);
  assert.equal(late.ok, true);
  assert.equal(late.replayed, true);
  assert.equal((await rowOf(db, made.request.id)).decidedBy, 'operator:ops@splash.test');
  // A different second approver arriving after the request is decided is refused and rewrites nothing.
  const third = await decide(db, made.request.id, OPERATIONS_2);
  assert.equal(third.ok, false);
  assert.equal(third.code, 'already_decided');
  assert.equal((await rowOf(db, made.request.id)).decidedBy, 'operator:ops@splash.test');
});

test('two people approving at the very same moment end with one first and one second', async () => {
  const { db } = await seeded();
  const made = await ask(db);
  const [a, b] = await Promise.all([decide(db, made.request.id, COMPLIANCE), decide(db, made.request.id, OPERATIONS)]);
  assert.ok(a.ok && b.ok, JSON.stringify([a, b]));
  assert.deepEqual([a.stage, b.stage].sort(), ['decided', 'first_approval']);
  const row = await rowOf(db, made.request.id);
  assert.equal(row.status, 'approved');
  assert.notEqual(row.firstApprovedBy, row.decidedBy);
  assert.notEqual(row.firstApproverRole, row.decidedRole);
});

// ─── Other ways a request can end ────────────────────────────────────────────

test('either approver can decline after a first approval, and the owner can cancel; a second approval after that is refused', async () => {
  const { db } = await seeded();
  const declined = await ask(db);
  await decide(db, declined.request.id, COMPLIANCE);
  const no = await decide(db, declined.request.id, OPERATIONS, { action: 'decline', reason: 'The volume does not match what we can see.' });
  assert.equal(no.ok, true, JSON.stringify(no));
  assert.equal(no.request.phase, 'declined');
  assert.equal((await decide(db, declined.request.id, COMPLIANCE)).code, 'already_decided');

  const selfDecline = await ask(db, { orgId: 'northwind', actorUserId: 'u-n-owner' });
  await decide(db, selfDecline.request.id, COMPLIANCE);
  const changed = await decide(db, selfDecline.request.id, COMPLIANCE, { action: 'decline', reason: 'I looked again and it is too high.' });
  assert.equal(changed.ok, true, 'the first approver may think again and decline');

  const cancelled = await ask(db, { kind: 'monthly', requested: '3,000,000' });
  await decide(db, cancelled.request.id, COMPLIANCE);
  assert.equal((await cancelLimitRequest(db, { orgId: 'acme', actorUserId: 'u-owner', requestId: cancelled.request.id, now: at(T0.getTime() + 2 * H) })).ok, true);
  const after = await decide(db, cancelled.request.id, OPERATIONS);
  assert.equal(after.ok, false);
  assert.equal(after.code, 'already_decided');
  assert.equal((await currentLimits(db, 'acme', at(T0.getTime() + 100 * H))).monthly, LEGACY_LIMITS.monthly);
});

test('another business’s owner cannot see or cancel a request waiting for its second approval', async () => {
  const { db } = await seeded();
  const made = await ask(db);
  await decide(db, made.request.id, COMPLIANCE);
  const cancel = await cancelLimitRequest(db, { orgId: 'northwind', actorUserId: 'u-n-owner', requestId: made.request.id, now: at(T0.getTime() + 2 * H) });
  assert.equal(cancel.ok, false);
  assert.equal(cancel.status, 404);
  const theirs = (await readLimitsView(db, { orgId: 'northwind', userId: 'u-n-owner', now: at(T0.getTime() + 2 * H) })).view;
  assert.equal(theirs.limits.find((l) => l.kind === 'daily').open, null);
  assert.equal((await rowOf(db, made.request.id)).status, 'pending');
});

test('the owner’s page shows the request as waiting for Splash, with nothing about who approved', async () => {
  const { db } = await seeded();
  const made = await ask(db);
  await decide(db, made.request.id, COMPLIANCE);
  const view = (await readLimitsView(db, { orgId: 'acme', userId: 'u-owner', now: at(T0.getTime() + 2 * H) })).view;
  const open = view.limits.find((l) => l.kind === 'daily').open;
  assert.equal(open.phase, 'asked');
  assert.equal(open.cancellable, true);
  assert.doesNotMatch(JSON.stringify(view), /mariam|operator:|compliance/i);
});

// ─── The queue ───────────────────────────────────────────────────────────────

test('the queue card says one or two approvals, who gave the first, and who is needed next', async () => {
  const { db } = await seeded();
  const small = await ask(db, { kind: 'monthly', requested: '30,000' });
  const large = await ask(db);
  const before = await listLimitRequestsForStaff(db, OPERATIONS, at(T0.getTime()));
  const cards = Object.fromEntries(before.open.map((c) => [c.id, c]));
  assert.equal(cards[small.request.id].approvals.needed, 1);
  assert.equal(cards[large.request.id].approvals.needed, 2);
  assert.equal(cards[large.request.id].approvals.first, null);
  assert.equal(cards[large.request.id].approvals.waitingFor, null);
  assert.equal(cards[large.request.id].approvals.lines.daily, LARGE_GRANT_LINES.daily.toString());

  await decide(db, large.request.id, COMPLIANCE);
  const mine = (await listLimitRequestsForStaff(db, COMPLIANCE, at(T0.getTime()))).open.find((c) => c.id === large.request.id);
  assert.equal(mine.approvals.first.by, 'mariam@splash.test');
  assert.equal(mine.approvals.first.role, 'compliance');
  assert.equal(mine.approvals.waitingFor, 'operations');
  assert.equal(mine.approvals.youApprovedFirst, true, 'the first approver is told they cannot approve it again');
  const theirs = (await listLimitRequestsForStaff(db, OPERATIONS, at(T0.getTime()))).open.find((c) => c.id === large.request.id);
  assert.equal(theirs.approvals.youApprovedFirst, false);
  assert.equal(theirs.approvals.waitingFor, 'operations');
  const support = await listLimitRequestsForStaff(db, SUPPORT, at(T0.getTime()));
  assert.equal(support.ok, false);
});

// ─── The database holds the rule too ─────────────────────────────────────────

test('a large grant cannot be written as approved by one person, even by a statement that skips the service', async () => {
  const { db, client } = await seeded();
  const made = await ask(db);
  await assert.rejects(
    client.exec(`UPDATE business_limit_requests SET status = 'approved', granted_value = ${U(300_000)}, decided_by = 'operator:x@splash.test', decided_at = now(), effective_at = now() + interval '25 hours' WHERE id = '${made.request.id}'`),
    /business_limit_requests_large|check/i,
  );
  assert.equal((await rowOf(db, made.request.id)).status, 'pending');
});
