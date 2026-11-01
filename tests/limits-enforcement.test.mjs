/**
 * The business's limits hold wherever a limit already applies (v2 Phase 3):
 *
 *   an allowance      asked for above a limit is refused, in the same sentences the
 *                     page shows; a limit Splash raised (after its 24 hour notice)
 *                     lets it through; one the owners lowered stops what fitted
 *   an automatic run  a payment above the business's limit for one automatic
 *                     payment hands the whole run back, whatever the allowance on
 *                     the network says; the daily limit never exceeds the business's
 *   pending           a request that is pending, or approved and inside its notice,
 *                     changes none of this
 *   the form          the Automatic panel is given the limits to hold itself to
 *
 * PGlite with the staff-rule world's model chain; nothing reaches a network.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { evaluateAutoRun } from '../lib/schedule/auto-check.ts';
import { ALLOWANCE_DEFAULTS } from '../lib/schedule/rules.ts';
import { currentLimits, decideLimitRequestForStaff, lowerLimit, requestHigherLimit } from '../lib/server/business-limits.ts';
import * as S from '../lib/server/scheduled-payments.ts';
import { runScheduledPayments } from '../lib/server/scheduled-runner.ts';
import { listRuns, saveSettings } from '../lib/server/scheduled-store.ts';
import { effectiveAtMs } from '../lib/limits/rules.ts';
import { DAY, OWNER_ACTOR, U, sched, scheduleWorld, t0 } from './fixtures/schedule-world.mjs';

const HOUR = 3_600_000;
const FIRST = new Date(Number(t0) + 2 * Number(DAY));
const at = (ms) => new Date(Number(ms));
const STAFF = { email: 'mariam@splash.test', role: 'compliance' };
const ok = (r) => {
  assert.equal(r.ok, true, JSON.stringify(r, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
  return r;
};
const runner = (t) => ({ db: t.w.db, now: () => t.w.signing.now(), depsFor: async (orgId) => (orgId === 'acme' ? t.sdeps() : null), env: { NODE_ENV: 'test' } });

// ─── The pure check ───────────────────────────────────────────────────────

const NOW = Date.parse('2026-11-03T16:00:00Z');
const A = '0x' + '71'.repeat(32);
const fee = (amount) => (amount * 2n) / 10_000n > U(0.25) ? (amount * 2n) / 10_000n : U(0.25);
const rule = () => ({ status: 'active', perPaymentMaxMinor: U(2_000).toString(), spendableNowMinor: U(10_000).toString(), startsAtMs: null, expiresAtMs: String(NOW + 90 * 86_400_000), renewsAtMs: String(NOW + 20 * 86_400_000) });
const facts = (over = {}) => ({
  nowMs: NOW, settleWindowMs: 15 * 60_000, paused: false, ownerCreated: true, payerReady: true, sponsorReady: true, ruleReadable: true,
  rule: rule(), policy: { secondApprovalThresholdMinor: U(10_000).toString(), recipients: [{ address: A, tag: 'wallet' }] },
  runningTotals: {}, dailyCapMinor: U(5_000), perPaymentLimitMinor: U(2_000), monthlyLimitMinor: U(20_000), dailyUsedMinor: 0n, monthlyUsedMinor: 0n, walletBalanceMinor: U(50_000), ...over,
});
const item = (usdc) => {
  const amountMinor = U(usdc);
  return { position: 1, name: 'Santos Supplies Inc', saved: { address: A, amountMinor, feeMinor: fee(amountMinor), feeKind: 1 }, now: { address: A, kind: 1 }, paidBefore: true, cleared: true, currentFeeMinor: fee(amountMinor) };
};

test('a payment above the business’s limit for one automatic payment hands the run back, even when the allowance would take it', () => {
  const run = [item(1_200)];
  assert.equal(evaluateAutoRun(facts({ perPaymentLimitMinor: U(2_000) }), run).ok, true, 'a payment inside the limit is paid');
  const lowered = evaluateAutoRun(facts({ perPaymentLimitMinor: U(1_000) }), run);
  assert.equal(lowered.ok, false);
  assert.equal(lowered.code, 'over_payment_limit');
  assert.match(lowered.text, /Santos Supplies Inc: One payment is more than the limit for a single automatic payment/);
  assert.equal(evaluateAutoRun(facts({ perPaymentLimitMinor: U(1_200) }), run).ok, true, 'exactly the limit is paid');
  assert.equal(evaluateAutoRun(facts({ perPaymentLimitMinor: U(1_200) - 1n }), run).code, 'over_payment_limit', 'one micro-USDC over is not');
});

// ─── The allowance ────────────────────────────────────────────────────────

const form = (over = {}) => ({ perPaymentUsdc: '2000', dailyUsdc: '5000', monthlyUsdc: '20000', expiresInDays: 90, ...over });
const askAllowance = async (t, input) => S.requestAllowance(t.sdeps(), OWNER_ACTOR, await t.confirmed(input));

test('an allowance above the business’s limits is refused with the reason, and one inside them is asked', async () => {
  const t = await scheduleWorld();
  for (const [field, value, pattern] of [
    ['perPaymentUsdc', '3000', /one payment cannot be more than your business’s limit of 2,000 USDC/],
    ['dailyUsdc', '6000', /daily limit cannot be more than your business’s limit of 5,000 USDC/],
    ['monthlyUsdc', '25000', /monthly limit cannot be more than your business’s limit of 20,000 USDC/],
    ['expiresInDays', 120, /cannot last more than your business’s limit of 90 days/],
  ]) {
    const refused = await askAllowance(t, form({ [field]: value }));
    assert.equal(refused.ok, false, field);
    assert.equal(refused.status, 400, field);
    assert.equal(refused.code, 'above_limit', field);
    assert.match(refused.error, pattern, field);
    assert.match(refused.error, /ask Splash for a higher limit in Settings, Limits/, field);
  }
  ok(await askAllowance(t, form({ perPaymentUsdc: '1500', dailyUsdc: '4000', monthlyUsdc: '16000', expiresInDays: 60 })));
});

test('a request for a higher limit changes nothing until its notice has passed; then the same allowance goes through', async () => {
  const t = await scheduleWorld();
  const { db } = t.w;
  const wide = form({ perPaymentUsdc: '3000', dailyUsdc: '6000' });
  const made = ok(await requestHigherLimit(db, { orgId: 'acme', actorUserId: 'u-founder', kind: 'per_payment', requested: '3,000', reason: 'Our two largest suppliers invoice about 2,800 a month.', requestKey: 'raise-per-payment-1', now: () => at(t0) }));
  ok(await requestHigherLimit(db, { orgId: 'acme', actorUserId: 'u-founder', kind: 'daily', requested: '6,000', reason: 'The same suppliers are paid on the same day.', requestKey: 'raise-daily-000001', now: () => at(t0) }));
  assert.equal((await askAllowance(t, wide)).code, 'above_limit', 'pending');
  const approvedAt = Number(t0) + HOUR;
  const first = ok(await decideLimitRequestForStaff(db, { requestId: made.request.id, staff: STAFF, action: 'approve', now: () => at(approvedAt) }));
  assert.equal(first.request.phase, 'waiting');
  assert.equal((await askAllowance(t, wide)).code, 'above_limit', 'approved but inside the 24 hour notice');
  assert.equal((await currentLimits(db, 'acme', () => at(effectiveAtMs(approvedAt) - 1))).per_payment, U(2_000));
  // Move the world's clock past the notice. The per-payment limit is now 3,000; the daily one was never approved.
  await t.clock(at(effectiveAtMs(approvedAt) + 1));
  const stillDaily = await askAllowance(t, wide);
  assert.equal(stillDaily.code, 'above_limit');
  assert.doesNotMatch(stillDaily.error, /one payment cannot be more/, 'the per-payment limit now lets it through');
  assert.match(stillDaily.error, /daily limit cannot be more than your business’s limit of 5,000 USDC/);
  ok(await askAllowance(t, form({ perPaymentUsdc: '3000' })));
});

test('an allowance the owners lowered their limit under is refused, and the form is told the limits to hold itself to', async () => {
  const t = await scheduleWorld();
  ok(await lowerLimit(t.w.db, { orgId: 'acme', actorUserId: 'u-founder', kind: 'monthly', value: '10,000', now: () => at(t0) }));
  const refused = await askAllowance(t, form());
  assert.equal(refused.code, 'above_limit');
  assert.match(refused.error, /monthly limit cannot be more than your business’s limit of 10,000 USDC/);
  ok(await askAllowance(t, form({ monthlyUsdc: '10000' })));
  const status = await S.automaticStatus(t.sdeps());
  assert.deepEqual(status.limits, { perPaymentMinor: U(2_000).toString(), dailyMinor: U(5_000).toString(), monthlyMinor: U(10_000).toString(), days: 90 });
  assert.deepEqual({ ...status.defaults }, { ...ALLOWANCE_DEFAULTS }, 'the starting figures are unchanged');
});

test('the Automatic panel holds itself to the same limits, with the same sentences', () => {
  const panel = readFileSync(new URL('../components/schedule/AutomaticPanel.tsx', import.meta.url), 'utf8');
  assert.match(panel, /allowanceLimitProblems\(form, business\)/);
  assert.match(panel, /status\.limits\.perPaymentMinor/);
  assert.match(panel, /status\.limits\.days/);
});

// ─── An automatic run ─────────────────────────────────────────────────────

async function ready() {
  const t = await scheduleWorld();
  await t.allowance();
  await t.payBefore(t.ids.a, 1);
  await t.payBefore(t.ids.b, 1);
  const made = ok(await S.createSchedule(t.sdeps(), OWNER_ACTOR, sched(t.ids, { mode: 'auto', firstDueAt: FIRST.toISOString() })));
  t.schedule = made.schedule;
  await saveSettings(t.w.db, 'acme', { graceMinutes: 0 }, new Date());
  return t;
}

test('lowering the limit for one automatic payment hands the next automatic run back to “ask me first”, with nothing paid', async () => {
  const t = await ready();
  ok(await lowerLimit(t.w.db, { orgId: 'acme', actorUserId: 'u-founder', kind: 'per_payment', value: '600', now: () => at(t0) }));
  await t.clock(at(FIRST.getTime() - 20 * HOUR));
  await runScheduledPayments(runner(t));
  await t.clock(FIRST);
  await runScheduledPayments(runner(t));
  const [run] = await listRuns(t.w.db, 'acme');
  assert.equal(run.status, 'waiting_approval');
  assert.equal(run.reasonCode, 'over_payment_limit');
  assert.match(run.reason, /Santos Supplies Inc: One payment is more than the limit for a single automatic payment/);
  assert.equal(t.spent(), 0, 'nothing was paid');
  assert.equal(t.signed.length, 0, 'the scheduled payer signed nothing');
});

test('the same run is paid automatically when the limit is not lowered', async () => {
  const t = await ready();
  await t.clock(at(FIRST.getTime() - 20 * HOUR));
  await runScheduledPayments(runner(t));
  await t.clock(FIRST);
  await runScheduledPayments(runner(t));
  const [run] = await listRuns(t.w.db, 'acme');
  assert.notEqual(run.reasonCode, 'over_payment_limit');
  assert.ok(t.spent() > 0, 'paid inside the limit');
});

test('the business’s daily limit holds even when the owners’ own daily limit is higher, and a run that fits is paid', async () => {
  const t = await ready();
  // The owners' own daily limit says 50,000; the business's limit says 1,000.
  await saveSettings(t.w.db, 'acme', { dailyCapMinor: U(50_000) }, new Date());
  ok(await lowerLimit(t.w.db, { orgId: 'acme', actorUserId: 'u-founder', kind: 'daily', value: '1,000', now: () => at(t0) }));
  const status = await S.automaticStatus(t.sdeps());
  assert.equal(status.dailyCapMinor, U(1_000).toString(), 'the figure shown is the figure enforced');
  await t.clock(at(FIRST.getTime() - 20 * HOUR));
  await runScheduledPayments(runner(t));
  await t.clock(FIRST);
  await runScheduledPayments(runner(t));
  const [run] = await listRuns(t.w.db, 'acme');
  assert.equal(run.status, 'waiting_approval');
  assert.equal(run.reasonCode, 'daily_cap', '500 + 750.50 and their fees are over 1,000');
  assert.equal(t.spent(), 0);
});
