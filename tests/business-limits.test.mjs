/**
 * A business's limits and asking Splash for higher ones (v2 Phase 3, Sky's
 * decision): the service the routes call, against a real database (PGlite with
 * every migration), with an injected clock.
 *
 *   ask        owners only; the same key is the same request; one open request
 *              per limit; a figure above the limit, inside the sanity maximum, with a
 *              reason; nothing changes by asking
 *   decide     compliance and operations staff approve, approve a smaller
 *              figure, or decline with a reason; support is refused; deciding
 *              twice the same way decides once
 *   24 hours   an approval starts the notice; one millisecond before it ends
 *              nothing has changed, at the moment it ends the limit is higher
 *   cancel     an owner cancels until it starts, never after; twice cancels once
 *   lower      an owner lowers at once and nothing is asked; a request still
 *              open for that limit is cancelled
 *   sanity     a figure past the sanity maximum (a typo guard, not a ceiling) is refused when asked, refused when decided, clamped if ever stored
 *
 * These businesses are ones that existed before the starting figures: migration 0086 gives them rows at the old
 * 2,000 / 5,000 / 20,000 USDC and 90 days (tests/helpers/limits-legacy.mjs). How a new business starts is
 * tests/limits-start-answers.test.mjs.
 *   tenants    every read and write is the session's business only
 *   audit      every action is a line on the trail with who did it
 *   notices    the owners are told once when it is approved, declined and started
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { and, eq } from 'drizzle-orm';

import { migratedDb } from './helpers/store-db.mjs';
import { LEGACY_LIMITS, pinLegacyLimits } from './helpers/limits-legacy.mjs';
import * as schema from '../lib/db/schema.ts';
import {
  cancelLimitRequest,
  currentLimits,
  decideLimitRequestForStaff,
  listLimitRequestsForStaff,
  lowerLimit,
  readLimitsView,
  requestHigherLimit,
  runLimitChangesForCron,
  sendLimitNotices,
} from '../lib/server/business-limits.ts';
import { appointFinanceLead } from '../lib/server/team-admin.ts';
import { listAuthorityEvents } from '../lib/server/wallet-authority.ts';
import { DEFAULT_LIMITS, LIMIT_NOTICE_MS, LIMIT_SANITY_MAX, effectiveAtMs } from '../lib/limits/rules.ts';

const U = (usdc) => BigInt(Math.round(usdc * 1_000_000));
const T0 = new Date('2026-11-02T09:00:00Z');
const at = (ms) => () => new Date(ms);
const H = 3_600_000;
const VERIFIED = new Date('2026-10-01T00:00:00Z');
const REASON = 'We now pay six suppliers on the first of each month.';
const COMPLIANCE = { email: 'Mariam@Splash.test', role: 'compliance' };
const OPERATIONS = { email: 'ops@splash.test', role: 'operations' };
const SUPPORT = { email: 'help@splash.test', role: 'support' };

async function seeded() {
  const { client, db } = await migratedDb();
  const people = [
    ['u-owner', 'owner@acme.test', 'acme', 'admin'],
    ['u-owner2', 'owner2@acme.test', 'acme', 'admin'],
    ['u-lead', 'lead@acme.test', 'acme', 'checker'],
    ['u-appr', 'approver@acme.test', 'acme', 'checker'],
    ['u-maker', 'maker@acme.test', 'acme', 'maker'],
    ['u-viewer', 'viewer@acme.test', 'acme', 'viewer'],
    ['u-n-owner', 'owner@northwind.test', 'northwind', 'admin'],
    ['u-stranger', 'stranger@example.test', null, null],
  ];
  for (const [id, email, org, role] of people) {
    await db.insert(schema.users).values({ id, email, name: id, emailVerifiedAt: VERIFIED });
    if (org) await db.insert(schema.memberships).values({ id: `m-${id}`, userId: id, orgId: org, role });
  }
  const appointed = await appointFinanceLead(db, { orgId: 'acme', actorUserId: 'u-owner', userId: 'u-lead', now: () => T0 });
  assert.equal(appointed.ok, true, JSON.stringify(appointed));
  // Acme and Northwind existed before the starting figures: they run on what they ran on.
  await pinLegacyLimits(db, ['acme', 'northwind']);
  return { client, db };
}

let seq = 0;
const key = () => `limit-key-${String(++seq).padStart(6, '0')}`;
const ask = (db, over = {}) => requestHigherLimit(db, { orgId: 'acme', actorUserId: 'u-owner', kind: 'daily', requested: '8,000', reason: REASON, requestKey: key(), now: at(T0.getTime()), ...over });
const decide = (db, id, over = {}) => decideLimitRequestForStaff(db, { requestId: id, staff: COMPLIANCE, action: 'approve', now: at(T0.getTime() + H), ...over });
const trail = async (db, orgId = 'acme') => listAuthorityEvents(db, orgId);
const actions = async (db, orgId = 'acme') => (await trail(db, orgId)).map((e) => e.action);
const rowOf = async (db, id) => (await db.select().from(schema.businessLimitRequests).where(eq(schema.businessLimitRequests.id, id)))[0];

// ─── Asking ───────────────────────────────────────────────────────────────

test('an owner asks for a higher limit: it is recorded as pending, and nothing about the limit changes', async () => {
  const { db } = await seeded();
  const made = await ask(db);
  assert.equal(made.ok, true, JSON.stringify(made));
  assert.equal(made.replayed, false);
  assert.equal(made.request.phase, 'asked');
  assert.equal(made.request.requestedWords, '8,000 USDC');
  assert.match(made.request.says, /Splash is reviewing it, and your limit stays 5,000 USDC until it answers/);
  assert.deepEqual({ ...(await currentLimits(db, 'acme', at(T0.getTime()))) }, { ...LEGACY_LIMITS }, 'a pending request changes nothing');
  const [event] = (await trail(db)).filter((e) => e.action === 'limit_raise_requested');
  assert.equal(event.actorUserId, 'u-owner', 'the trail names who asked');
  assert.equal(event.ref, made.request.id);
  assert.equal(event.detail.requested, U(8_000).toString());
  assert.equal(event.detail.reason, REASON);
});

test('asking twice with one key asks once; the same key for a different request is refused', async () => {
  const { db } = await seeded();
  const k = key();
  const first = await ask(db, { requestKey: k });
  const again = await ask(db, { requestKey: k });
  assert.equal(again.ok, true);
  assert.equal(again.replayed, true);
  assert.equal(again.request.id, first.request.id);
  const rows = await db.select().from(schema.businessLimitRequests);
  assert.equal(rows.length, 1);
  assert.equal((await actions(db)).filter((a) => a === 'limit_raise_requested').length, 1, 'and the trail has one line');
  const different = await ask(db, { requestKey: k, requested: '9,000' });
  assert.equal(different.ok, false);
  assert.equal(different.status, 409);
  assert.equal(different.code, 'key_reused');
  // Two clicks at the same moment are the same call.
  const k2 = key();
  const both = await Promise.all([ask(db, { requestKey: k2, kind: 'monthly', requested: '30000' }), ask(db, { requestKey: k2, kind: 'monthly', requested: '30000' })]);
  assert.deepEqual(both.map((r) => r.ok), [true, true]);
  assert.equal(both[0].request.id, both[1].request.id);
  assert.equal((await db.select().from(schema.businessLimitRequests)).filter((r) => r.kind === 'monthly').length, 1);
});

test('one request is open for a limit at a time; another limit is its own', async () => {
  const { db } = await seeded();
  assert.equal((await ask(db)).ok, true);
  const second = await ask(db, { requested: '9,000' });
  assert.equal(second.ok, false);
  assert.equal(second.status, 409);
  assert.equal(second.code, 'already_open');
  assert.match(second.error, /request open for this limit \(In a day\)/);
  assert.equal((await ask(db, { kind: 'monthly', requested: '25000' })).ok, true, 'a different limit is a different request');
});

test('only an owner may ask: the Finance lead sees but cannot ask, and nobody else can', async () => {
  const { db } = await seeded();
  for (const [who, code] of [['u-lead', 'owner_only'], ['u-appr', 'not_allowed'], ['u-maker', 'not_allowed'], ['u-viewer', 'not_allowed'], ['u-stranger', 'not_allowed'], ['u-n-owner', 'not_allowed']]) {
    const r = await ask(db, { actorUserId: who });
    assert.equal(r.ok, false, who);
    assert.equal(r.status, 403, who);
    assert.equal(r.code, code, who);
  }
  assert.equal((await db.select().from(schema.businessLimitRequests)).length, 0, 'nothing was recorded');
  assert.equal(await actions(db).then((a) => a.includes('limit_raise_requested')), false);
  const lead = await ask(db, { actorUserId: 'u-lead' });
  assert.match(lead.error, /Only an owner can ask Splash for a higher limit\. You can see the limits/);
});

test('a figure that is not higher, is past the sanity maximum, has no reason or no key is refused with the reason in plain words', async () => {
  const { db } = await seeded();
  const same = await ask(db, { requested: '5000' });
  assert.equal(same.status, 400);
  assert.match(same.error, /not higher than your limit of 5,000 USDC/);
  const lower = await ask(db, { requested: '4000' });
  assert.match(lower.error, /not higher/);
  const above = await ask(db, { requested: '10,000,001' });
  assert.equal(above.status, 400);
  assert.match(above.error, /does not offer more than 10,000,000 USDC/);
  assert.equal((await ask(db, { requested: '10,000,000' })).ok, true, 'exactly the maximum is asked for');
  const days = await ask(db, { kind: 'days', requested: '400' });
  assert.match(days.error, /at most 366 days/);
  assert.equal((await ask(db, { kind: 'days', requested: '1.5' })).code, 'bad_figure');
  assert.equal((await ask(db, { kind: 'rent', requested: '5' })).code, 'bad_limit');
  assert.equal((await ask(db, { kind: 'monthly', requested: 'lots' })).code, 'bad_figure');
  assert.equal((await ask(db, { kind: 'monthly', requested: '30000', reason: 'please' })).code, 'bad_reason');
  assert.equal((await ask(db, { kind: 'monthly', requested: '30000', reason: '' })).code, 'bad_reason');
  assert.equal((await ask(db, { kind: 'monthly', requested: '30000', requestKey: 'short' })).code, 'bad_key');
  assert.equal((await ask(db, { kind: 'monthly', requested: '30000', requestKey: undefined })).code, 'bad_key');
});

test('a limit can be asked for above the old ceilings, and a request past the sanity maximum cannot be approved as asked', async () => {
  const { db } = await seeded();
  // Round three refused a per-payment limit above 10,000: the starting figures are 50,000, so that is no longer a limit on what can be asked for.
  const over = await ask(db, { kind: 'per_payment', requested: '10,000.01' });
  assert.equal(over.ok, true, JSON.stringify(over));
  // A request that somehow holds more than the sanity maximum (written by hand) cannot be approved as asked.
  await db.insert(schema.businessLimitRequests).values({ id: 'blr_over', orgId: 'acme', kind: 'monthly', requestedValue: LIMIT_SANITY_MAX.monthly + U(1), currentValue: U(20_000), reason: REASON, requestKey: 'hand-written-key', requestedBy: 'u-owner', requestedAt: new Date(T0.getTime()), status: 'pending' });
  const refused = await decide(db, 'blr_over');
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 400);
  assert.match(refused.error, /does not offer more than 100,000,000 USDC/);
  assert.equal((await rowOf(db, 'blr_over')).status, 'pending', 'and it stays pending');
  const smaller = await decide(db, 'blr_over', { action: 'approve_smaller', granted: '1,000,000' });
  assert.equal(smaller.ok, true, JSON.stringify(smaller));
  assert.equal(smaller.request.granted, U(1_000_000).toString(), 'a figure inside the maximum can be granted');
});

test('a stored figure past the sanity maximum is never believed, and an approved one past it is clamped when it starts', async () => {
  const { db } = await seeded();
  await db.delete(schema.businessLimits).where(and(eq(schema.businessLimits.orgId, 'acme'), eq(schema.businessLimits.kind, 'days')));
  await db.insert(schema.businessLimits).values({ orgId: 'acme', kind: 'days', value: 9_999n, heldMax: 9_999n, source: 'raised', changedBy: 'u-owner' });
  assert.equal((await currentLimits(db, 'acme', at(T0.getTime()))).days, 366n);
  const decidedAt = new Date(T0.getTime() - 2 * LIMIT_NOTICE_MS);
  await db.insert(schema.businessLimitRequests).values({
    id: 'blr_clamp', orgId: 'acme', kind: 'daily', requestedValue: LIMIT_SANITY_MAX.daily + U(5_000), currentValue: U(5_000), reason: REASON, requestKey: 'clamp-key-000001', requestedBy: 'u-owner', requestedAt: decidedAt,
    status: 'approved', grantedValue: LIMIT_SANITY_MAX.daily + U(5_000), decidedBy: 'operator:x@splash.test', decidedRole: 'operations', decidedAt, effectiveAt: new Date(decidedAt.getTime() + LIMIT_NOTICE_MS),
    // A grant this large was approved by two people, as the database requires.
    firstApprovedBy: 'operator:y@splash.test', firstApproverRole: 'compliance', firstApprovedAt: decidedAt, firstGrantedValue: LIMIT_SANITY_MAX.daily + U(5_000),
  });
  assert.equal((await currentLimits(db, 'acme', at(T0.getTime()))).daily, LIMIT_SANITY_MAX.daily, 'never past the maximum');
});

// ─── The 24 hour notice ───────────────────────────────────────────────────

test('an approval starts a 24 hour notice: nothing changes one millisecond before it ends, the limit is higher the moment it ends', async () => {
  const { db } = await seeded();
  const made = await ask(db);
  const approvedAt = T0.getTime() + H;
  const approved = await decide(db, made.request.id, { now: at(approvedAt) });
  assert.equal(approved.ok, true, JSON.stringify(approved));
  assert.equal(approved.request.phase, 'waiting');
  assert.equal(approved.request.effectiveAt, new Date(effectiveAtMs(approvedAt)).toISOString(), 'it starts 24 hours after the decision');
  assert.match(approved.request.says, /Splash approved 8,000 USDC\. It starts 10:00 UTC on 3 Nov, after a 24 hour notice/);
  const effective = effectiveAtMs(approvedAt);
  for (const when of [approvedAt, approvedAt + 12 * H, effective - 1]) {
    assert.equal((await currentLimits(db, 'acme', at(when))).daily, U(5_000), `still 5,000 at ${new Date(when).toISOString()}`);
  }
  assert.equal((await rowOf(db, made.request.id)).status, 'approved');
  assert.equal((await currentLimits(db, 'acme', at(effective))).daily, U(8_000), 'at the moment the notice ends');
  const row = await rowOf(db, made.request.id);
  assert.equal(row.status, 'applied');
  assert.equal(row.appliedAt.getTime(), effective);
  assert.equal((await currentLimits(db, 'acme', at(effective + H))).daily, U(8_000), 'and it stays');
  const [stored] = await db.select().from(schema.businessLimits).where(and(eq(schema.businessLimits.orgId, 'acme'), eq(schema.businessLimits.kind, 'daily')));
  assert.deepEqual([stored.kind, stored.value, stored.source, stored.changedBy, stored.requestId], ['daily', U(8_000), 'raised', 'system:limits', made.request.id]);
  const applied = (await trail(db)).filter((e) => e.action === 'limit_change_applied');
  assert.equal(applied.length, 1, 'once, however often it is read');
  assert.equal(applied[0].actorUserId, 'system:limits');
  assert.equal(applied[0].detail.before, U(5_000).toString());
  assert.equal(applied[0].detail.after, U(8_000).toString());
  assert.equal(applied[0].detail.approvedBy, 'operator:mariam@splash.test');
  // The limits other businesses have are theirs.
  assert.equal((await currentLimits(db, 'northwind', at(effective + H))).daily, U(5_000));
});

test('the database itself refuses an approval whose notice is shorter than 24 hours', async () => {
  const { db } = await seeded();
  await assert.rejects(
    db.insert(schema.businessLimitRequests).values({
      id: 'blr_fast', orgId: 'acme', kind: 'daily', requestedValue: U(8_000), currentValue: U(5_000), reason: REASON, requestKey: 'fast-key-000001', requestedBy: 'u-owner', requestedAt: T0,
      status: 'approved', grantedValue: U(8_000), decidedBy: 'operator:x@splash.test', decidedAt: T0, effectiveAt: new Date(T0.getTime() + 23 * H),
    }),
  );
});

test('a read by the owner shows the request waiting out its notice, and the limit that holds in the meantime', async () => {
  const { db } = await seeded();
  const made = await ask(db);
  const approvedAt = T0.getTime() + H;
  await decide(db, made.request.id, { now: at(approvedAt) });
  const view = await readLimitsView(db, { orgId: 'acme', userId: 'u-owner', now: at(approvedAt + H) });
  assert.equal(view.ok, true);
  assert.equal(view.view.canAsk, true);
  const daily = view.view.limits.find((l) => l.kind === 'daily');
  assert.equal(daily.currentWords, '5,000 USDC');
  assert.equal(daily.open.phase, 'waiting');
  assert.equal(daily.open.cancellable, true);
  assert.match(daily.open.says, /Until then your limit stays 5,000 USDC\. You can cancel before it starts/);
  const after = await readLimitsView(db, { orgId: 'acme', userId: 'u-owner', now: at(effectiveAtMs(approvedAt)) });
  const started = after.view.limits.find((l) => l.kind === 'daily');
  assert.equal(started.currentWords, '8,000 USDC');
  assert.equal(started.source, 'raised');
  assert.match(started.why, /Splash approved a higher limit on 3 Nov 2026/);
  assert.equal(started.open, null);
  assert.equal(started.last.phase, 'in_force');
});

// ─── Deciding ─────────────────────────────────────────────────────────────

test('staff approve a smaller figure: that figure starts after the notice, and the owner is told it is less', async () => {
  const { db } = await seeded();
  const made = await ask(db, { requested: '10,000' });
  const smaller = await decide(db, made.request.id, { action: 'approve_smaller', granted: '7,000' });
  assert.equal(smaller.ok, true, JSON.stringify(smaller));
  assert.equal(smaller.request.grantedWords, '7,000 USDC');
  assert.match(smaller.request.says, /approved 7,000 USDC, less than the 10,000 USDC you asked for/);
  const later = T0.getTime() + H + LIMIT_NOTICE_MS;
  assert.equal((await currentLimits(db, 'acme', at(later))).daily, U(7_000));
  const [event] = (await trail(db)).filter((e) => e.action === 'limit_request_approved');
  assert.equal(event.detail.smaller, true);
  assert.equal(event.detail.granted, U(7_000).toString());
});

test('a smaller figure must be smaller than the ask, and above the limit', async () => {
  const { db } = await seeded();
  const made = await ask(db, { requested: '10,000' });
  for (const [granted, code, pattern] of [['10,000', 'not_smaller', /must be less than the 10,000 USDC asked for/], ['12,000', 'not_smaller', /less than/], ['5,000', 'bad_figure', /must be higher than the business’s limit of 5,000 USDC/], ['4,000', 'bad_figure', /higher than/], ['lots', 'bad_figure', /smaller amount/], [undefined, 'bad_figure', /smaller amount/]]) {
    const r = await decide(db, made.request.id, { action: 'approve_smaller', granted });
    assert.equal(r.ok, false, String(granted));
    assert.equal(r.code, code, String(granted));
    assert.match(r.error, pattern, String(granted));
  }
  assert.equal((await rowOf(db, made.request.id)).status, 'pending', 'none of them decided it');
});

test('staff decline with a reason in plain words: the limit stays, the owner reads why, and can ask again', async () => {
  const { db } = await seeded();
  const made = await ask(db);
  const noReason = await decide(db, made.request.id, { action: 'decline' });
  assert.equal(noReason.ok, false);
  assert.equal(noReason.code, 'bad_reason');
  assert.equal((await decide(db, made.request.id, { action: 'decline', reason: 'no' })).code, 'bad_reason');
  const declined = await decide(db, made.request.id, { action: 'decline', reason: '  We need   two more months of payment history first.  ' });
  assert.equal(declined.ok, true, JSON.stringify(declined));
  assert.equal(declined.request.phase, 'declined');
  assert.equal(declined.request.declineReason, 'We need two more months of payment history first.');
  assert.equal((await currentLimits(db, 'acme', at(T0.getTime() + 3 * LIMIT_NOTICE_MS))).daily, U(5_000), 'declined: nothing ever changes');
  const view = await readLimitsView(db, { orgId: 'acme', userId: 'u-owner', now: at(T0.getTime() + 2 * H) });
  const daily = view.view.limits.find((l) => l.kind === 'daily');
  assert.equal(daily.open, null);
  assert.match(daily.last.says, /Splash declined the request for 8,000 USDC\. We need two more months of payment history first\./);
  const again = await ask(db, { requested: '6,000', now: at(T0.getTime() + 2 * H) });
  assert.equal(again.ok, true, 'a declined request does not block a new one');
  const [event] = (await trail(db)).filter((e) => e.action === 'limit_request_declined');
  assert.equal(event.actorUserId, 'operator:mariam@splash.test');
  assert.equal(event.detail.reason, 'We need two more months of payment history first.');
});

test('deciding twice the same way decides once; a different second decision is refused and rewrites nothing', async () => {
  const { db } = await seeded();
  const made = await ask(db);
  const first = await decide(db, made.request.id);
  const again = await decide(db, made.request.id, { now: at(T0.getTime() + 5 * H) });
  assert.equal(again.ok, true);
  assert.equal(again.replayed, true);
  assert.equal(again.request.effectiveAt, first.request.effectiveAt, 'the notice does not restart');
  assert.equal((await trail(db)).filter((e) => e.action === 'limit_request_approved').length, 1);
  const flip = await decide(db, made.request.id, { action: 'decline', reason: 'Changed my mind about this one.' });
  assert.equal(flip.ok, false);
  assert.equal(flip.status, 409);
  assert.equal(flip.code, 'already_decided');
  assert.equal((await rowOf(db, made.request.id)).status, 'approved');
  // Another staff member's different decision is refused too.
  const other = await decide(db, made.request.id, { staff: OPERATIONS });
  assert.equal(other.code, 'already_decided');
  // Two staff at the same moment: one decision.
  const m2 = await ask(db, { kind: 'monthly', requested: '30,000' });
  const raced = await Promise.all([decide(db, m2.request.id, { staff: COMPLIANCE }), decide(db, m2.request.id, { staff: OPERATIONS })]);
  assert.equal(raced.filter((r) => r.ok && !r.replayed).length, 1, JSON.stringify(raced.map((r) => r.code ?? 'ok')));
  assert.equal((await trail(db)).filter((e) => e.action === 'limit_request_approved').length, 2, 'one line per request');
});

test('only compliance and operations staff decide; support is refused, and the queue is closed to it too', async () => {
  const { db } = await seeded();
  const made = await ask(db);
  const refused = await decide(db, made.request.id, { staff: SUPPORT });
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 403);
  assert.equal(refused.code, 'role_not_allowed');
  assert.equal((await decide(db, made.request.id, { staff: { email: 'x@y.test', role: 'owner' } })).status, 403, 'a role the console does not have');
  assert.equal((await decide(db, made.request.id, { staff: { email: 'x@y.test', role: undefined } })).status, 403);
  assert.equal((await listLimitRequestsForStaff(db, SUPPORT)).status, 403);
  assert.equal((await rowOf(db, made.request.id)).status, 'pending');
  assert.equal((await decide(db, made.request.id, { staff: OPERATIONS })).ok, true, 'operations may');
  const m = await ask(db, { kind: 'monthly', requested: '30,000' });
  assert.equal((await decide(db, m.request.id, { staff: COMPLIANCE })).ok, true, 'compliance may');
  assert.equal((await decide(db, 'blr_nope')).status, 404);
  assert.equal((await decide(db, m.request.id, { action: 'maybe' })).code, 'bad_action');
});

test('the staff queue reads every business’s open requests, oldest first, with the figures and who asked', async () => {
  const { db } = await seeded();
  const a = await ask(db, { now: at(T0.getTime()) });
  const b = await requestHigherLimit(db, { orgId: 'northwind', actorUserId: 'u-n-owner', kind: 'per_payment', requested: '4,000', reason: 'Our freight invoices are larger than that.', requestKey: key(), now: at(T0.getTime() + H) });
  assert.equal(b.ok, true, JSON.stringify(b));
  const queue = await listLimitRequestsForStaff(db, OPERATIONS, at(T0.getTime() + 2 * H));
  assert.equal(queue.ok, true);
  assert.deepEqual(queue.open.map((r) => r.id), [a.request.id, b.request.id]);
  assert.deepEqual(queue.open.map((r) => r.org.name), ['Acme Trading', 'Northwind']);
  assert.equal(queue.open[0].requestedBy, 'u-owner');
  assert.equal(queue.open[0].currentWords, '5,000 USDC');
  assert.equal(queue.open[1].currentWords, '2,000 USDC');
  await decide(db, a.request.id, { now: at(T0.getTime() + 3 * H) });
  const after = await listLimitRequestsForStaff(db, COMPLIANCE, at(T0.getTime() + 4 * H));
  assert.deepEqual(after.open.map((r) => r.id), [b.request.id]);
  assert.deepEqual(after.recent.map((r) => [r.id, r.phase, r.decidedBy]), [[a.request.id, 'waiting', 'operator:mariam@splash.test']]);
});

// ─── Cancelling ───────────────────────────────────────────────────────────

test('an owner cancels a request before it is decided, and before the higher limit starts', async () => {
  const { db } = await seeded();
  const pending = await ask(db);
  const gone = await cancelLimitRequest(db, { orgId: 'acme', actorUserId: 'u-owner2', requestId: pending.request.id, now: at(T0.getTime() + H) });
  assert.equal(gone.ok, true, 'any owner, not only the one who asked');
  assert.equal((await rowOf(db, pending.request.id)).status, 'cancelled');
  const staff = await decide(db, pending.request.id);
  assert.equal(staff.code, 'already_decided', 'staff cannot approve what the owner cancelled');
  assert.match(staff.error, /owner cancelled/);

  const made = await ask(db, { kind: 'monthly', requested: '30,000' });
  const approvedAt = T0.getTime() + 2 * H;
  await decide(db, made.request.id, { now: at(approvedAt) });
  const effective = effectiveAtMs(approvedAt);
  const cancelled = await cancelLimitRequest(db, { orgId: 'acme', actorUserId: 'u-owner', requestId: made.request.id, now: at(effective - 1) });
  assert.equal(cancelled.ok, true, 'one millisecond before it starts');
  assert.equal((await currentLimits(db, 'acme', at(effective + 10 * H))).monthly, U(20_000), 'and it never starts');
  assert.equal((await db.select().from(schema.businessLimits)).length, 8, 'only the rows the two businesses already had: nothing was written');
  assert.equal((await trail(db)).filter((e) => e.action === 'limit_request_cancelled').length, 2);
  const [event] = (await trail(db)).filter((e) => e.action === 'limit_request_cancelled' && e.ref === made.request.id);
  assert.equal(event.actorUserId, 'u-owner');
  assert.equal(event.detail.was, 'approved');
});

test('cancelling twice cancels once; cancelling after it started, or after a decline, is refused', async () => {
  const { db } = await seeded();
  const made = await ask(db);
  assert.equal((await cancelLimitRequest(db, { orgId: 'acme', actorUserId: 'u-owner', requestId: made.request.id, now: at(T0.getTime() + H) })).replayed, false);
  const again = await cancelLimitRequest(db, { orgId: 'acme', actorUserId: 'u-owner', requestId: made.request.id, now: at(T0.getTime() + 2 * H) });
  assert.equal(again.ok, true);
  assert.equal(again.replayed, true);
  assert.equal((await trail(db)).filter((e) => e.action === 'limit_request_cancelled').length, 1);

  const started = await ask(db, { kind: 'monthly', requested: '30,000' });
  const approvedAt = T0.getTime() + 3 * H;
  await decide(db, started.request.id, { now: at(approvedAt) });
  const late = await cancelLimitRequest(db, { orgId: 'acme', actorUserId: 'u-owner', requestId: started.request.id, now: at(effectiveAtMs(approvedAt)) });
  assert.equal(late.ok, false);
  assert.equal(late.status, 409);
  assert.equal(late.code, 'already_started');
  assert.match(late.error, /To go back, lower the limit/);
  assert.equal((await currentLimits(db, 'acme', at(effectiveAtMs(approvedAt)))).monthly, U(30_000), 'the cancel did not undo it');

  const no = await ask(db, { kind: 'days', requested: '180', now: at(approvedAt + 30 * H) });
  await decide(db, no.request.id, { action: 'decline', reason: 'Please give the 90 days a full run first.', now: at(approvedAt + 31 * H) });
  const declined = await cancelLimitRequest(db, { orgId: 'acme', actorUserId: 'u-owner', requestId: no.request.id, now: at(approvedAt + 32 * H) });
  assert.equal(declined.code, 'already_decided');
});

test('only an owner cancels, and only their own business’s request: a foreign id reads as absent', async () => {
  const { db } = await seeded();
  const made = await ask(db);
  for (const [who, org, status, code] of [['u-lead', 'acme', 403, 'owner_only'], ['u-appr', 'acme', 403, 'not_allowed'], ['u-maker', 'acme', 403, 'not_allowed'], ['u-viewer', 'acme', 403, 'not_allowed'], ['u-n-owner', 'acme', 403, 'not_allowed'], ['u-n-owner', 'northwind', 404, 'not_found']]) {
    const r = await cancelLimitRequest(db, { orgId: org, actorUserId: who, requestId: made.request.id, now: at(T0.getTime() + H) });
    assert.equal(r.ok, false, `${who} in ${org}`);
    assert.equal(r.status, status, `${who} in ${org}`);
    assert.equal(r.code, code, `${who} in ${org}`);
  }
  assert.equal((await rowOf(db, made.request.id)).status, 'pending', 'nobody cancelled it');
  const missing = await cancelLimitRequest(db, { orgId: 'acme', actorUserId: 'u-owner', requestId: 'blr_nope', now: at(T0.getTime()) });
  assert.equal(missing.status, 404);
});

// ─── Lowering ─────────────────────────────────────────────────────────────

test('an owner lowers a limit at once and nothing is asked', async () => {
  const { db } = await seeded();
  const lowered = await lowerLimit(db, { orgId: 'acme', actorUserId: 'u-owner', kind: 'daily', value: '1,500', now: at(T0.getTime()) });
  assert.equal(lowered.ok, true, JSON.stringify(lowered));
  assert.equal(lowered.current, U(1_500).toString());
  assert.equal((await currentLimits(db, 'acme', at(T0.getTime()))).daily, U(1_500), 'the same instant, no notice, no staff');
  assert.equal((await db.select().from(schema.businessLimitRequests)).length, 0, 'no request exists');
  const [event] = (await trail(db)).filter((e) => e.action === 'limit_lowered');
  assert.equal(event.actorUserId, 'u-owner');
  assert.equal(event.detail.before, U(5_000).toString());
  assert.equal(event.detail.after, U(1_500).toString());
  const view = await readLimitsView(db, { orgId: 'acme', userId: 'u-owner2', now: at(T0.getTime()) });
  const daily = view.view.limits.find((l) => l.kind === 'daily');
  assert.equal(daily.source, 'lowered');
  assert.match(daily.why, /An owner of your business lowered it on 2 Nov 2026\. You can put it back to 5,000 USDC/);
  // Lowering again to the same figure is the same call, not an error and not a second line.
  const same = await lowerLimit(db, { orgId: 'acme', actorUserId: 'u-owner', kind: 'daily', value: '1,500', now: at(T0.getTime() + H) });
  assert.equal(same.ok, true);
  assert.equal(same.unchanged, true);
  assert.equal((await trail(db)).filter((e) => e.action === 'limit_lowered').length, 1);
});

test('lowering is refused for a figure that is not lower, for the Finance lead, for anyone who is not an owner and across businesses', async () => {
  const { db } = await seeded();
  assert.match((await lowerLimit(db, { orgId: 'acme', actorUserId: 'u-owner', kind: 'daily', value: '5,000' })).error, /not lower than your limit/);
  assert.match((await lowerLimit(db, { orgId: 'acme', actorUserId: 'u-owner', kind: 'daily', value: '9,000' })).error, /ask Splash for one/);
  assert.equal((await lowerLimit(db, { orgId: 'acme', actorUserId: 'u-owner', kind: 'daily', value: '0' })).code, 'bad_figure');
  assert.equal((await lowerLimit(db, { orgId: 'acme', actorUserId: 'u-owner', kind: 'nope', value: '1' })).code, 'bad_limit');
  for (const who of ['u-lead', 'u-appr', 'u-maker', 'u-viewer', 'u-n-owner', 'u-stranger']) {
    const r = await lowerLimit(db, { orgId: 'acme', actorUserId: who, kind: 'daily', value: '1,000' });
    assert.equal(r.status, 403, who);
  }
  assert.equal((await currentLimits(db, 'acme', at(T0.getTime()))).daily, U(5_000));
  assert.equal((await currentLimits(db, 'northwind', at(T0.getTime()))).daily, U(5_000), 'and the other business is untouched');
});

test('lowering a limit cancels a request still open for it, so it is not raised again behind the owner’s back', async () => {
  const { db } = await seeded();
  const made = await ask(db);
  const approvedAt = T0.getTime() + H;
  await decide(db, made.request.id, { now: at(approvedAt) });
  const lowered = await lowerLimit(db, { orgId: 'acme', actorUserId: 'u-owner2', kind: 'daily', value: '3,000', now: at(approvedAt + 2 * H) });
  assert.equal(lowered.ok, true);
  assert.equal((await rowOf(db, made.request.id)).status, 'cancelled');
  assert.equal((await currentLimits(db, 'acme', at(effectiveAtMs(approvedAt) + 10 * H))).daily, U(3_000), 'the approved 8,000 never starts');
  const [event] = (await trail(db)).filter((e) => e.action === 'limit_request_cancelled');
  assert.equal(event.actorUserId, 'u-owner2');
  assert.match(event.detail.because, /lowered/);
  // Another limit's request is not touched.
  const m = await ask(db, { kind: 'monthly', requested: '30,000', now: at(approvedAt + 3 * H) });
  await lowerLimit(db, { orgId: 'acme', actorUserId: 'u-owner', kind: 'daily', value: '2,000', now: at(approvedAt + 4 * H) });
  assert.equal((await rowOf(db, m.request.id)).status, 'pending');
});

test('a lowered limit goes back up to what the business held by Restore, and above that only by asking Splash, from the lowered figure', async () => {
  const { db } = await seeded();
  await lowerLimit(db, { orgId: 'acme', actorUserId: 'u-owner', kind: 'daily', value: '1,000', now: at(T0.getTime()) });
  const above = await ask(db, { requested: '1,000' });
  assert.match(above.error, /not higher than your limit of 1,000 USDC/);
  const back = await ask(db, { requested: '4,000' });
  assert.equal(back.code, 'restore_instead', 'back to a figure the business held is its own to put back (tests/limits-keep-restore.test.mjs)');
  const made = await ask(db, { requested: '6,000' });
  assert.equal(made.ok, true, 'more than the business ever held is asked for like any other higher limit');
  assert.equal((await rowOf(db, made.request.id)).currentValue, U(1_000));
});

// ─── Who sees what ────────────────────────────────────────────────────────

test('owners and the Finance lead see the limits; the Finance lead cannot ask; nobody else sees them', async () => {
  const { db } = await seeded();
  const owner = await readLimitsView(db, { orgId: 'acme', userId: 'u-owner', now: at(T0.getTime()) });
  assert.equal(owner.ok, true);
  assert.equal(owner.view.canAsk, true);
  assert.equal(owner.view.manager, 'owner');
  assert.deepEqual(owner.view.limits.map((l) => l.kind), ['per_payment', 'daily', 'monthly', 'days']);
  assert.deepEqual(owner.view.limits.map((l) => l.currentWords), ['2,000 USDC', '5,000 USDC', '20,000 USDC', '90 days']);
  assert.deepEqual(owner.view.limits.map((l) => l.ceilingWords), [null, null, null, '366 days'], 'only the length of an allowance has a ceiling');
  for (const l of owner.view.limits) assert.match(l.why, /^Your business already ran on this before the new starting figures, so it keeps it\. A new business starts at /);
  const lead = await readLimitsView(db, { orgId: 'acme', userId: 'u-lead', now: at(T0.getTime()) });
  assert.equal(lead.ok, true);
  assert.equal(lead.view.canAsk, false);
  assert.equal(lead.view.manager, 'finance_lead');
  for (const who of ['u-appr', 'u-maker', 'u-viewer', 'u-stranger', 'u-n-owner']) {
    const r = await readLimitsView(db, { orgId: 'acme', userId: who, now: at(T0.getTime()) });
    assert.equal(r.ok, false, who);
    assert.equal(r.status, 403, who);
  }
});

test('one business never sees another’s requests or limits', async () => {
  const { db } = await seeded();
  await ask(db);
  await lowerLimit(db, { orgId: 'acme', actorUserId: 'u-owner', kind: 'monthly', value: '10,000', now: at(T0.getTime()) });
  const north = await readLimitsView(db, { orgId: 'northwind', userId: 'u-n-owner', now: at(T0.getTime()) });
  assert.equal(north.ok, true);
  for (const l of north.view.limits) {
    assert.equal(l.open, null);
    assert.equal(l.last, null);
    assert.equal(l.source, 'kept', 'northwind’s own limits, untouched by acme lowering its monthly');
  }
  assert.equal(north.view.limits.find((l) => l.kind === 'monthly').currentWords, '20,000 USDC');
  // Asking in northwind with acme's key is a new request there, not acme's.
  const [acmeRow] = await db.select().from(schema.businessLimitRequests).where(eq(schema.businessLimitRequests.orgId, 'acme'));
  const theirs = await requestHigherLimit(db, { orgId: 'northwind', actorUserId: 'u-n-owner', kind: 'daily', requested: '8,000', reason: REASON, requestKey: acmeRow.requestKey, now: at(T0.getTime()) });
  assert.equal(theirs.ok, true);
  assert.notEqual(theirs.request.id, acmeRow.id);
  assert.equal(theirs.replayed, false);
  // A decision on one business's request writes to that business's trail only.
  await decide(db, acmeRow.id, { now: at(T0.getTime() + H) });
  assert.equal((await actions(db, 'northwind')).includes('limit_request_approved'), false);
  assert.equal((await actions(db, 'acme')).includes('limit_request_approved'), true);
});

// ─── The trail ────────────────────────────────────────────────────────────

test('every action leaves a line on the trail with who did it', async () => {
  const { db } = await seeded();
  const a = await ask(db);
  const b = await ask(db, { kind: 'monthly', requested: '30,000' });
  const c = await ask(db, { kind: 'days', requested: '180' });
  await decide(db, a.request.id, { staff: OPERATIONS, now: at(T0.getTime() + H) });
  await decide(db, b.request.id, { action: 'decline', reason: 'The monthly figure is too far above what you have paid.', now: at(T0.getTime() + H) });
  await cancelLimitRequest(db, { orgId: 'acme', actorUserId: 'u-owner2', requestId: c.request.id, now: at(T0.getTime() + 2 * H) });
  await lowerLimit(db, { orgId: 'acme', actorUserId: 'u-owner', kind: 'per_payment', value: '1,000', now: at(T0.getTime() + 3 * H) });
  await currentLimits(db, 'acme', at(effectiveAtMs(T0.getTime() + H) + 1));
  const lines = (await trail(db)).filter((e) => e.action.startsWith('limit_')).map((e) => [e.action, e.actorUserId]);
  assert.deepEqual(lines, [
    ['limit_raise_requested', 'u-owner'],
    ['limit_raise_requested', 'u-owner'],
    ['limit_raise_requested', 'u-owner'],
    ['limit_request_approved', 'operator:ops@splash.test'],
    ['limit_request_declined', 'operator:mariam@splash.test'],
    ['limit_request_cancelled', 'u-owner2'],
    ['limit_lowered', 'u-owner'],
    ['limit_change_applied', 'system:limits'],
  ]);
  assert.equal((await actions(db, 'northwind')).filter((x) => x.startsWith('limit_')).length, 0);
});

test('the trail still refuses to be rewritten', async () => {
  const { db } = await seeded();
  await ask(db);
  await assert.rejects(db.update(schema.walletAuthorityEvents).set({ actorUserId: 'someone-else' }).where(eq(schema.walletAuthorityEvents.orgId, 'acme')));
});

// ─── Telling the owners ───────────────────────────────────────────────────

function notifier(reach = 1) {
  const sent = [];
  return { sent, notify: async (orgId, notice) => { sent.push({ orgId, ...notice }); return typeof reach === 'function' ? reach() : reach; } };
}

test('the owners are told once when it is approved, once when it is declined and once when it starts', async () => {
  const { db } = await seeded();
  const a = await ask(db);
  const b = await ask(db, { kind: 'monthly', requested: '30,000' });
  const approvedAt = T0.getTime() + H;
  await decide(db, a.request.id, { now: at(approvedAt) });
  await decide(db, b.request.id, { action: 'decline', reason: 'Not yet: we need more history.', now: at(approvedAt) });
  const n = notifier();
  const first = await sendLimitNotices(db, { notify: n.notify, now: at(approvedAt + 60_000) });
  assert.deepEqual(first, { sent: 2, failed: 0 });
  assert.deepEqual(n.sent.map((s) => [s.orgId, s.subject]), [['acme', 'Splash approved a higher limit'], ['acme', 'Splash declined a higher limit']]);
  assert.match(n.sent[0].text, /8,000 USDC, up from 5,000 USDC/);
  assert.match(n.sent[0].text, /starts 10:00 UTC on 3 Nov, after a 24 hour notice/);
  assert.match(n.sent[0].text, /Any owner can cancel it before it starts/);
  assert.match(n.sent[1].text, /Not yet: we need more history\./);
  assert.equal(n.sent[0].path, '/dashboard/settings#limits');
  const second = await sendLimitNotices(db, { notify: n.notify, now: at(approvedAt + 120_000) });
  assert.deepEqual(second, { sent: 0, failed: 0 }, 'told once');
  assert.equal(n.sent.length, 2);
  // The notice runs out: the cron starts the limit and tells them it started, once.
  const cron = await runLimitChangesForCron(db, { notify: n.notify, now: at(effectiveAtMs(approvedAt)) });
  assert.deepEqual(cron, { applied: 1, sent: 1, failed: 0 });
  assert.equal(n.sent[2].subject, 'Your higher limit has started');
  assert.match(n.sent[2].text, /now 8,000 USDC, up from 5,000 USDC/);
  const again = await runLimitChangesForCron(db, { notify: n.notify, now: at(effectiveAtMs(approvedAt) + H) });
  assert.deepEqual(again, { applied: 0, sent: 0, failed: 0 }, 'the cron is idempotent');
  assert.equal(n.sent.length, 3);
});

test('a notice that reached nobody is tried again, and one that threw does not stop the rest', async () => {
  const { db } = await seeded();
  const a = await ask(db);
  await decide(db, a.request.id, { now: at(T0.getTime() + H) });
  const nobody = notifier(0);
  assert.deepEqual(await sendLimitNotices(db, { notify: nobody.notify, now: at(T0.getTime() + 2 * H) }), { sent: 0, failed: 1 });
  const row = await rowOf(db, a.request.id);
  assert.equal(row.approvedNotifiedAt, null, 'not recorded as told');
  const ok = notifier(1);
  assert.deepEqual(await sendLimitNotices(db, { notify: ok.notify, now: at(T0.getTime() + 3 * H) }), { sent: 1, failed: 0 });
  assert.notEqual((await rowOf(db, a.request.id)).approvedNotifiedAt, null);
  const b = await ask(db, { kind: 'monthly', requested: '30,000', now: at(T0.getTime() + 4 * H) });
  await decide(db, b.request.id, { action: 'decline', reason: 'We would rather wait a month.', now: at(T0.getTime() + 5 * H) });
  const boom = { notify: async () => { throw new Error('the mail provider is down'); } };
  assert.deepEqual(await sendLimitNotices(db, { notify: boom.notify, now: at(T0.getTime() + 6 * H) }), { sent: 0, failed: 1 });
  assert.equal((await rowOf(db, b.request.id)).declinedNotifiedAt, null);
});

test('notices go to the business of the request, and only to it', async () => {
  const { db } = await seeded();
  const a = await ask(db);
  const b = await requestHigherLimit(db, { orgId: 'northwind', actorUserId: 'u-n-owner', kind: 'daily', requested: '9,000', reason: REASON, requestKey: key(), now: at(T0.getTime()) });
  await decide(db, a.request.id, { now: at(T0.getTime() + H) });
  await decide(db, b.request.id, { action: 'decline', reason: 'Please wait for your first month to finish.', now: at(T0.getTime() + H) });
  const n = notifier();
  await sendLimitNotices(db, { notify: n.notify, now: at(T0.getTime() + 2 * H) });
  assert.deepEqual(n.sent.map((s) => [s.orgId, s.subject]).sort(), [['acme', 'Splash approved a higher limit'], ['northwind', 'Splash declined a higher limit']]);
  assert.doesNotMatch(n.sent.find((s) => s.orgId === 'northwind').text, /8,000/);
  const scoped = notifier();
  const c = await ask(db, { kind: 'days', requested: '120', now: at(T0.getTime() + 3 * H) });
  await decide(db, c.request.id, { action: 'decline', reason: 'We would rather wait a month.', now: at(T0.getTime() + 4 * H) });
  assert.deepEqual(await sendLimitNotices(db, { notify: scoped.notify, orgId: 'northwind', now: at(T0.getTime() + 5 * H) }), { sent: 0, failed: 0 }, 'a run for one business reads that business only');
  assert.equal(scoped.sent.length, 0);
});

test('a request never needs a fresh read to be correct: reads apply what is due, from any entry point', async () => {
  const { db } = await seeded();
  const a = await ask(db);
  const approvedAt = T0.getTime() + H;
  await decide(db, a.request.id, { now: at(approvedAt) });
  const effective = effectiveAtMs(approvedAt);
  // The first thing to touch the business after the notice is a request for another limit, not a read of this one.
  const next = await requestHigherLimit(db, { orgId: 'acme', actorUserId: 'u-owner', kind: 'daily', requested: '9,000', reason: REASON, requestKey: key(), now: at(effective + 1) });
  assert.equal(next.ok, true, 'the first request no longer blocks the next');
  assert.equal((await rowOf(db, next.request.id)).currentValue, U(8_000), 'and it is asked from the new figure');
  const gone = await db.select().from(schema.businessLimitRequests).where(and(eq(schema.businessLimitRequests.orgId, 'acme'), eq(schema.businessLimitRequests.status, 'applied')));
  assert.equal(gone.length, 1);
});
