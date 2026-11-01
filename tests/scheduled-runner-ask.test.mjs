/**
 * v2 Phase 3, scheduled batches, Mode A “Ask me first”: what the runner does at
 * the due time.
 *
 *   - it PREPARES the batch as Batch payouts do and asks the owners through the
 *     existing signing request (their phones, WhatsApp, the app). No partner is
 *     called and no money moves: the owners' passkeys sign it first;
 *   - the states read in plain words: scheduled, waiting for approval, approved,
 *     paid, skipped, failed; a request nobody approved in time lapses, with no
 *     fee and no penalty;
 *   - running it twice is running it once (a run per schedule and due date, a
 *     batch per run), tested with an injected clock;
 *   - a schedule stopped, skipped or changed since is not run; a run Splash
 *     could not start within a day of its time is not run late;
 *   - one business's trouble never stops another's, and a runner holding one
 *     business's context touches nothing of another's.
 *
 * PGlite with every migration, the staff-rule world's model chain, software
 * passkeys and a controlled clock. Nothing reaches a network.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { eq } from 'drizzle-orm';

import * as schema from '../lib/db/schema.ts';
import { LAPSED_REASON, NOT_STARTED_REASON } from '../lib/schedule/rules.ts';
import { runScheduledPayments } from '../lib/server/scheduled-runner.ts';
import * as S from '../lib/server/scheduled-payments.ts';
import { listRuns } from '../lib/server/scheduled-store.ts';
import { declineSigningRequest, readRequestForSigner } from '../lib/server/wallet-signing.ts';
import { signBy } from './fixtures/staff-rule-world.mjs';
import { DAY, FINANCE_LEAD, OWNER_ACTOR, U, feeFor, sched, scheduleWorld, t0 } from './fixtures/schedule-world.mjs';

const HOUR = 3_600_000;
const FIRST = new Date(Number(t0) + 2 * Number(DAY));
const at = (ms) => new Date(ms);
const runner = (t, over = {}) => ({ db: t.w.db, now: () => t.w.signing.now(), depsFor: async (orgId) => (orgId === 'acme' ? t.sdeps() : null), env: { NODE_ENV: 'test' }, ...over });

async function ready(opts = {}) {
  const t = await scheduleWorld(opts);
  const made = await S.createSchedule(t.sdeps(), OWNER_ACTOR, sched(t.ids, { firstDueAt: FIRST.toISOString() }));
  assert.equal(made.ok, true, JSON.stringify(made));
  t.schedule = made.schedule;
  t.noticeKinds = () => t.notices.map((n) => n.kind);
  return t;
}
const runs = (t) => listRuns(t.w.db, 'acme');
const batches = (t) => t.w.db.select().from(schema.walletBatches).where(eq(schema.walletBatches.orgId, 'acme'));

test('before the due day nothing is made, and an “ask me first” run sends no day-before notice', async () => {
  const t = await ready();
  const none = await runScheduledPayments(runner(t));
  assert.equal(none.schedules, 0);
  assert.deepEqual(await runs(t), []);
  await t.clock(at(FIRST.getTime() - 2 * HOUR));
  const made = await runScheduledPayments(runner(t));
  assert.equal(made.runsMade, 1);
  const [run] = await runs(t);
  assert.equal(run.status, 'scheduled');
  assert.equal(run.dueDate, '2026-10-27');
  assert.deepEqual(t.noticeKinds(), [], 'the approval request is the notice for an “ask me first” run');
  assert.equal((await batches(t)).length, 0, 'nothing is prepared before the due time');
});

test('at the due time the batch is prepared and the owners are asked; nothing moves until they sign', async () => {
  const t = await ready();
  const before = t.w.balances.get(t.wallet.address).addressBalanceMinor;
  await t.clock(FIRST);
  const result = await runScheduledPayments(runner(t));
  assert.equal(result.started, 1);
  assert.deepEqual(result.errors, []);
  const [run] = await runs(t);
  assert.equal(run.status, 'waiting_approval');
  assert.equal(run.ranAs, 'ask');
  assert.equal(run.fallback, false);
  assert.equal(run.reason, null);
  assert.equal(run.itemCount, 2);
  assert.equal(run.totalMinor, U(1_250.5));
  const [batch] = await batches(t);
  assert.equal(run.batchId, batch.id);
  assert.equal(batch.requestedBy, 'u-founder', 'the system acts as an owner, the schedule’s own');
  assert.match(batch.clientKey, /^sch-[A-Za-z0-9]+-2026-10-27$/, 'the batch’s intent id is made from the schedule and the due date');

  const request = (await t.w.db.select().from(schema.walletSigningRequests)).find((r) => r.purpose === 'wallet_batch');
  assert.equal(request.purpose, 'wallet_batch');
  assert.equal(request.status, 'collecting');
  assert.deepEqual(request.expiresAt, at(FIRST.getTime() + 24 * HOUR), 'the owners have the signing layer’s longest window, 24 hours');
  const asked = t.w.notices.filter((n) => n.request.purpose === 'wallet_batch');
  assert.equal(asked.length, 1, 'the existing channels carry the approval request');
  assert.deepEqual([...asked[0].userIds].sort(), ['u-founder', 'u-three', 'u-two']);
  assert.deepEqual(t.noticeKinds(), ['approval_ready']);
  assert.equal(t.notices[0].reason, null, 'a plain “ask me first” run has no fallback to explain');
  assert.equal(t.w.balances.get(t.wallet.address).addressBalanceMinor, before, 'no money moved');
  assert.equal(t.w.executed.filter((e) => e.bytes).length, t.w.executed.length);
  const executedPayments = t.w.executed.length;
  assert.equal(executedPayments > 0, true, 'the wallet’s own registration ran earlier');
  const sch = await S.getScheduleView(t.sdeps(), OWNER_ACTOR, t.schedule.id);
  assert.equal(sch.nextDueAt, '2026-11-27T08:00:00.000Z', 'the schedule moved on to its next time');
});

test('the owners sign and the run is paid, once; the receipt notice goes out once', async () => {
  const t = await ready();
  await t.clock(FIRST);
  await runScheduledPayments(runner(t));
  const [run] = await runs(t);
  const [batch] = await batches(t);
  const view = await readRequestForSigner(t.w.signing, { orgId: 'acme', userId: 'u-founder', id: batch.signingRequestId });
  assert.equal(view.ok, true);
  assert.equal((await signBy(t.w, view.request, ['two', 'three'])).status, 'executed');

  const first = await runScheduledPayments(runner(t));
  assert.equal(first.followed, 1);
  const [paid] = await runs(t);
  assert.equal(paid.id, run.id);
  assert.equal(paid.status, 'paid');
  assert.deepEqual(t.noticeKinds(), ['approval_ready', 'paid']);
  await runScheduledPayments(runner(t));
  await runScheduledPayments(runner(t));
  assert.deepEqual(t.noticeKinds(), ['approval_ready', 'paid'], 'the receipt is sent once, however often the runner passes');
  assert.equal((await runs(t)).length, 1);
  const view2 = (await S.listRunViews(t.sdeps()))[0];
  assert.equal(view2.status, 'paid');
  assert.equal(view2.receiptPath, `/dashboard/history/batch/${batch.id}`, 'the receipt is the batch’s own');
});

test('running the runner twice at the same moment makes one run, one batch and one request', async () => {
  const t = await ready();
  await t.clock(FIRST);
  const both = await Promise.all([runScheduledPayments(runner(t)), runScheduledPayments(runner(t))]);
  assert.ok(both.every((r) => r.ok));
  assert.equal((await runs(t)).length, 1);
  assert.equal((await batches(t)).length, 1);
  const requests = await t.w.db.select().from(schema.walletSigningRequests);
  assert.equal(requests.filter((r) => r.purpose === 'wallet_batch').length, 1);
  assert.equal(t.noticeKinds().filter((k) => k === 'approval_ready').length, 1);
  await runScheduledPayments(runner(t));
  assert.equal((await batches(t)).length, 1, 'a third pass changes nothing');
});

test('a request nobody approves before it ends lapses, in plain words, with nothing paid and no late fee', async () => {
  const t = await ready();
  await t.clock(FIRST);
  await runScheduledPayments(runner(t));
  await t.clock(at(FIRST.getTime() + 23 * HOUR));
  await runScheduledPayments(runner(t));
  assert.equal((await runs(t))[0].status, 'waiting_approval', 'still open inside its 24 hours');
  await t.clock(at(FIRST.getTime() + 24 * HOUR + 60_000));
  await runScheduledPayments(runner(t));
  const [run] = await runs(t);
  assert.equal(run.status, 'lapsed');
  assert.equal(run.reason, LAPSED_REASON);
  assert.match(run.reason, /Nothing was paid/);
  assert.match(run.reason, /no late fee or penalty/i);
  assert.ok(t.noticeKinds().includes('lapsed'));
  const [batch] = await batches(t);
  const view = await readRequestForSigner(t.w.signing, { orgId: 'acme', userId: 'u-founder', id: batch.signingRequestId });
  assert.notEqual(view.request.status, 'executed');
  const late = await (await import('../lib/server/wallet-signing.ts')).submitPartialSignature(t.w.signing, { orgId: 'acme', userId: 'u-two', id: batch.signingRequestId, signature: 'x', digest: view.request.digest });
  assert.equal(late.ok, false, 'a late signature is refused');
  // The lapse does not spoil the next one.
  await t.clock(at(Date.parse('2026-11-26T09:00:00Z')));
  await runScheduledPayments(runner(t));
  const all = await runs(t);
  assert.equal(all.length, 2);
  assert.equal(all.find((r) => r.dueDate === '2026-11-27').status, 'scheduled');
});

test('an owner who declines ends the run as skipped, and an owner who skips withdraws the request', async () => {
  const t = await ready();
  await t.clock(FIRST);
  await runScheduledPayments(runner(t));
  const [batch] = await batches(t);
  assert.equal((await declineSigningRequest(t.w.signing, { orgId: 'acme', userId: 'u-two', id: batch.signingRequestId })).ok, true);
  assert.equal((await declineSigningRequest(t.w.signing, { orgId: 'acme', userId: 'u-three', id: batch.signingRequestId })).ok, true);
  await runScheduledPayments(runner(t));
  const [declined] = await runs(t);
  assert.equal(declined.status, 'skipped');
  assert.equal(declined.reasonCode, 'declined');
  assert.match(declined.reason, /Nothing was paid/);
  // The run's reason says who declined it, like the batch it points to. Both declined at the one instant of the test clock, so either order is the order they declined in.
  assert.match(declined.reason, /^Declined by (u-two \(Owner\) and u-three \(Owner\)|u-three \(Owner\) and u-two \(Owner\))\. Nothing was paid\.$/);

  const t2 = await ready();
  await t2.clock(FIRST);
  await runScheduledPayments(runner(t2));
  const [run2] = await runs(t2);
  const skipped = await S.skipRun(t2.sdeps(), OWNER_ACTOR, t2.schedule.id, { runId: run2.id });
  assert.equal(skipped.ok, true, JSON.stringify(skipped));
  assert.equal(skipped.run.status, 'skipped');
  const [batch2] = await batches(t2);
  const req = await readRequestForSigner(t2.w.signing, { orgId: 'acme', userId: 'u-founder', id: batch2.signingRequestId });
  assert.equal(req.request.status, 'cancelled', 'the owners are no longer asked');
  await runScheduledPayments(runner(t2));
  assert.equal((await runs(t2))[0].status, 'skipped');
});

test('a run Splash could not start within a day of its time is not run late', async () => {
  const t = await ready();
  await t.clock(at(FIRST.getTime() + 25 * HOUR));
  const result = await runScheduledPayments(runner(t));
  assert.deepEqual(result.errors, []);
  const [run] = await runs(t);
  assert.equal(run.status, 'lapsed');
  assert.equal(run.reason, NOT_STARTED_REASON);
  assert.equal((await batches(t)).length, 0, 'no batch was prepared and nobody was asked');
  assert.ok(t.noticeKinds().includes('lapsed'));
});

test('a schedule stopped or deleted before its time is not run', async () => {
  const t = await ready();
  await t.clock(at(FIRST.getTime() - HOUR));
  await runScheduledPayments(runner(t));
  await S.stopSchedule(t.sdeps(), OWNER_ACTOR, t.schedule.id);
  await t.clock(FIRST);
  await runScheduledPayments(runner(t));
  const [run] = await runs(t);
  assert.equal(run.status, 'skipped');
  assert.match(run.reason, /stopped/);
  assert.equal((await batches(t)).length, 0);
  assert.deepEqual(t.noticeKinds(), []);
});

test('a skip made before the run exists keeps the run from ever being made', async () => {
  const t = await ready();
  const skipped = await S.skipRun(t.sdeps(), OWNER_ACTOR, t.schedule.id);
  assert.equal(skipped.ok, true);
  await t.clock(FIRST);
  await runScheduledPayments(runner(t));
  const all = await runs(t);
  assert.equal(all.length, 1, 'only the skipped run exists for that day');
  assert.equal(all[0].status, 'skipped');
  assert.equal((await batches(t)).length, 0);
});

test('a once schedule runs once and is then complete', async () => {
  const t = await scheduleWorld();
  const made = await S.createSchedule(t.sdeps(), OWNER_ACTOR, sched(t.ids, { cadence: 'once', firstDueAt: FIRST.toISOString() }));
  await t.clock(FIRST);
  await runScheduledPayments(runner(t));
  await runScheduledPayments(runner(t));
  const view = await S.getScheduleView(t.sdeps(), OWNER_ACTOR, made.schedule.id);
  assert.equal(view.status, 'completed');
  assert.equal(view.nextDueAt, null);
  await t.clock(at(FIRST.getTime() + 40 * DAY_N));
  await runScheduledPayments(runner(t));
  assert.equal((await runs(t)).length, 1);
});
const DAY_N = 86_400_000;

test('a recipient that changed since the schedule was set up fails the run in words; nothing is prepared', async () => {
  const t = await ready();
  await t.w.db.update(schema.suppliers).set({ walletAddress: `0x${'66'.repeat(32)}` }).where(eq(schema.suppliers.id, t.ids.b));
  await t.clock(FIRST);
  await runScheduledPayments(runner(t));
  const [run] = await runs(t);
  assert.equal(run.status, 'failed');
  assert.match(run.reason, /Santos Supplies Inc/);
  assert.equal((await batches(t)).length, 0);
  assert.ok(t.noticeKinds().includes('failed'));
});

test('a wallet that holds too little fails the run in words, and nobody is asked to sign a payment that cannot go', async () => {
  const t = await ready();
  t.state.balance = U(100);
  await t.clock(FIRST);
  await runScheduledPayments(runner(t));
  const [run] = await runs(t);
  assert.equal(run.status, 'failed');
  assert.match(run.reason, /does not hold enough/);
  assert.equal((await t.w.db.select().from(schema.walletSigningRequests)).filter((r) => r.purpose === 'wallet_batch').length, 0);
});

test('a schedule the Finance lead set up is prepared as an owner’s batch, and the owners are the ones asked', async () => {
  const t = await scheduleWorld();
  const made = await S.createSchedule(t.sdeps(), FINANCE_LEAD, sched(t.ids, { firstDueAt: FIRST.toISOString() }));
  assert.equal(made.ok, true, JSON.stringify(made));
  await t.clock(FIRST);
  await runScheduledPayments(runner(t));
  const [run] = await runs(t);
  assert.equal(run.status, 'waiting_approval');
  const [batch] = await batches(t);
  assert.equal(batch.requestedBy, 'u-founder', 'an owner starts it; the lead cannot sign it');
  assert.equal(made.schedule.createdAs, 'finance_lead');
});

test('a business that cannot be worked on, or whose work fails, never stops another’s', async () => {
  const t = await ready();
  const now = t.w.signing.now();
  await t.w.db.insert(schema.paymentSchedules).values({
    id: 'psc_north', orgId: 'northwind', clientKey: 'north_key_000001', name: 'North', mode: 'ask', cadence: 'weekly', firstDueAt: now, nextDueAt: now, status: 'active', createdBy: 'u-north', createdAs: 'owner',
    items: [], itemCount: 1, totalMinor: 1n, feeMinor: 0n, createdAt: now, updatedAt: now,
  });
  await t.clock(FIRST);
  const result = await runScheduledPayments(runner(t, { depsFor: async (orgId) => { if (orgId === 'northwind') throw new Error('northwind could not be opened'); return t.sdeps(); } }));
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].orgId, 'northwind');
  assert.match(result.errors[0].error, /could not be opened/);
  assert.equal((await runs(t))[0].status, 'waiting_approval', 'ours went ahead');
  const skip = await runScheduledPayments(runner(t, { depsFor: async () => null }));
  assert.deepEqual(skip.errors, []);
});

test('a runner holding another business’s context touches nothing of this business’s', async () => {
  const t = await ready();
  await t.clock(FIRST);
  const result = await runScheduledPayments(runner(t, { depsFor: async () => t.sdeps('northwind') }));
  assert.equal(result.ok, true);
  assert.deepEqual(await runs(t), [], 'acme’s schedule was not run with northwind’s context');
  assert.equal((await batches(t)).length, 0);
  // And a run of this business followed with another’s context does not move.
  await runScheduledPayments(runner(t));
  const [run] = await runs(t);
  await runScheduledPayments(runner(t, { depsFor: async () => t.sdeps('northwind') }));
  assert.equal((await runs(t)).find((r) => r.id === run.id).status, 'waiting_approval');
});

test('the fee of a prepared run is the schedule’s fee at the due time', async () => {
  const t = await ready();
  await t.clock(FIRST);
  await runScheduledPayments(runner(t));
  const [run] = await runs(t);
  assert.equal(run.feeMinor, feeFor(U(500)) + feeFor(U(750.5)));
});
