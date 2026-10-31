/**
 * v2 Phase 3, scheduled batches: the review's smaller findings, as pure checks.
 *
 *   the ceiling   an automatic payment is held to 10,000 USDC whatever the
 *                 business's own second-approval line says, and an allowance
 *                 cannot offer more than that for one payment
 *   the words     the notice sent as a run starts promises nothing that cannot
 *                 happen; History does not say an unfinished run was paid
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateAutoRun } from '../lib/schedule/auto-check.ts';
import { noticeText } from '../lib/schedule/notice.ts';
import { allowanceProblems } from '../lib/schedule/rules.ts';
import { buildHistory } from '../lib/history-page/entries.ts';

const U = (n) => BigInt(Math.round(n * 1_000_000));
const NOW = Date.parse('2026-11-03T16:00:00Z');
const A = '0x' + '71'.repeat(32);
const fee = (amount) => (amount * 2n) / 10_000n > U(0.25) ? (amount * 2n) / 10_000n : U(0.25);

const facts = (over = {}) => ({
  nowMs: NOW,
  settleWindowMs: 15 * 60_000,
  paused: false,
  ownerCreated: true,
  payerReady: true,
  sponsorReady: true,
  ruleReadable: true,
  rule: { status: 'active', perPaymentMaxMinor: U(50_000).toString(), spendableNowMinor: U(50_000).toString(), startsAtMs: null, expiresAtMs: String(NOW + 90 * 86_400_000), renewsAtMs: String(NOW + 20 * 86_400_000) },
  policy: { secondApprovalThresholdMinor: U(50_000).toString(), recipients: [{ address: A, tag: 'wallet' }] },
  runningTotals: {},
  dailyCapMinor: U(50_000),
  dailyUsedMinor: 0n,
  walletBalanceMinor: U(90_000),
  ...over,
});

const item = (usdc) => {
  const amountMinor = U(usdc);
  return { position: 1, name: 'Payee', saved: { address: A, amountMinor, feeMinor: fee(amountMinor), feeKind: 1 }, now: { address: A, kind: 1 }, paidBefore: true, cleared: true, currentFeeMinor: fee(amountMinor) };
};

test('a business policy that sets the second-approval line higher cannot lift the 10,000 USDC ceiling for an automatic payment', () => {
  assert.equal(evaluateAutoRun(facts(), [item(20_000)]).code, 'above_approval_line', 'one payment over 10,000 is an owner’s whatever the policy says');
  assert.equal(evaluateAutoRun(facts({ runningTotals: { [A]: U(9_900).toString() } }), [item(200)]).code, 'above_approval_line', 'counting what was already paid the recipient');
  assert.equal(evaluateAutoRun(facts(), [item(9_000)]).ok, true, 'under the line is still paid');
});

test('an allowance cannot offer more than 10,000 USDC for one payment, the amount an owner must always approve', () => {
  const form = { perPaymentMinor: 10_000_000_001n, dailyMinor: 50_000_000_000n, monthlyMinor: 90_000_000_000n, expiresInDays: 30 };
  assert.ok(allowanceProblems(form).some((p) => /cannot be more than 10,000\.00 USDC, the amount an owner must always approve/.test(p)), allowanceProblems(form).join(' | '));
  assert.deepEqual(allowanceProblems({ ...form, perPaymentMinor: 10_000_000_000n }), []);
});

test('the notice sent as an automatic run starts does not promise a Skip that can no longer happen', () => {
  const base = { orgId: 'acme', businessName: 'Acme Trading Sdn Bhd', scheduleId: 'psc_1', scheduleName: 'Monthly suppliers', runId: 'psr_1', mode: 'auto', dueAtMs: NOW, totalMinor: '1250000000', feeMinor: '250000', itemCount: 3, reason: null, by: null, path: '/dashboard/transfer?view=scheduled' };
  const { text } = noticeText({ ...base, kind: 'running' });
  assert.doesNotMatch(text, /You can still skip/);
  assert.match(text, /pause them in the Scheduled tab/);
});

test('an automatic run still being paid is not said to be paid', () => {
  const none = { transfers: [], batches: [], withdrawals: [], earlier: [] };
  const run = { id: 'psr_1', scheduleId: 'psc_1', scheduleName: 'Monthly suppliers', dueAt: '2026-11-03T16:00:00.000Z', mode: 'auto', ranAs: 'auto', status: 'approved', reason: null, fallback: false, itemCount: 2, totalMinor: '1250500000', feeMinor: '250000', batchId: null, receiptPath: null, createdAt: '2026-11-03T16:00:00.000Z', updatedAt: '2026-11-03T16:00:00.000Z' };
  const going = buildHistory({ ...none, scheduled: [run] })[0];
  assert.match(going.detail, /Being paid automatically within your limits/);
  assert.doesNotMatch(going.detail, /Paid automatically/);
});
