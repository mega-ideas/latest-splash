/**
 * v2 Phase 3, scheduled batches: every check an automatic run must pass before
 * Splash pays it with no one present. One pure function over facts the server
 * has just read; the first thing that fails is the answer, in the owner's words.
 *
 * It passes only if ALL of it holds, for the whole run: paused or not, an
 * owner's schedule, the payer and the sponsor there, the allowance readable and
 * running, every payee unchanged, paid before, cleared, a Splash business or a
 * wallet, on the verified list, under the per-payment limit and the
 * second-approval line (counting what was paid already), the run within what is
 * left of the allowance (each payment counted against the next), inside the
 * daily limit, at a fee no higher than the one shown, and the wallet holding
 * enough.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateAutoRun, fallbackFor } from '../lib/schedule/auto-check.ts';
import { FALLBACK_TEXT } from '../lib/schedule/rules.ts';

const U = (n) => BigInt(Math.round(n * 1_000_000));
const NOW = Date.parse('2026-11-03T16:00:00Z');
const A = '0x' + '71'.repeat(32);
const B = '0x' + '72'.repeat(32);
const C = '0x' + '73'.repeat(32);

const fee = (amount) => (amount * 2n) / 10_000n > U(0.25) ? (amount * 2n) / 10_000n : U(0.25);

const rule = (over = {}) => ({ status: 'active', perPaymentMaxMinor: U(2_000).toString(), spendableNowMinor: U(10_000).toString(), startsAtMs: null, expiresAtMs: String(NOW + 90 * 86_400_000), renewsAtMs: String(NOW + 20 * 86_400_000), ...over });
const policy = (over = {}) => ({ secondApprovalThresholdMinor: U(10_000).toString(), recipients: [A, B, C].map((address) => ({ address, tag: 'wallet' })), ...over });

const facts = (over = {}) => ({
  nowMs: NOW,
  settleWindowMs: 15 * 60_000,
  paused: false,
  ownerCreated: true,
  payerReady: true,
  sponsorReady: true,
  ruleReadable: true,
  rule: rule(),
  policy: policy(),
  runningTotals: {},
  dailyCapMinor: U(5_000),
  dailyUsedMinor: 0n,
  walletBalanceMinor: U(50_000),
  ...over,
});

const item = (position, address, usdc, over = {}) => {
  const amountMinor = U(usdc);
  return {
    position,
    name: `Payee ${position}`,
    saved: { address, amountMinor, feeMinor: fee(amountMinor), feeKind: 1 },
    now: { address, kind: 1 },
    paidBefore: true,
    cleared: true,
    currentFeeMinor: fee(amountMinor),
    ...over,
  };
};

test('a run that passes every check is paid whole, each payment with the fee that was shown', () => {
  const v = evaluateAutoRun(facts(), [item(1, A, 500), item(2, B, 750.5)]);
  assert.equal(v.ok, true, String(v.text));
  assert.equal(v.rows.length, 2);
  assert.equal(v.totalMinor, U(1_250.5));
  assert.equal(v.feeMinor, fee(U(500)) + fee(U(750.5)));
  assert.deepEqual(v.rows.map((r) => r.position), [1, 2]);
});

test('the kill switch, a schedule not made by a current owner, and a missing payer or sponsor hand the run back', () => {
  const run = [item(1, A, 100)];
  assert.equal(evaluateAutoRun(facts({ paused: true }), run).code, 'auto_paused');
  assert.equal(evaluateAutoRun(facts({ ownerCreated: false }), run).code, 'not_owner_created');
  assert.equal(evaluateAutoRun(facts({ payerReady: false }), run).code, 'payer_unavailable');
  assert.equal(evaluateAutoRun(facts({ sponsorReady: false }), run).code, 'payer_unavailable');
  assert.equal(evaluateAutoRun(facts({ paused: true, ownerCreated: false }), run).code, 'auto_paused', 'the switch is looked at first');
});

test('an allowance that cannot be read, is missing, ended, not begun or ends too soon hands the run back', () => {
  const run = [item(1, A, 100)];
  assert.equal(evaluateAutoRun(facts({ ruleReadable: false }), run).code, 'rule_unreadable');
  assert.equal(evaluateAutoRun(facts({ policy: null }), run).code, 'policy_unreadable');
  assert.equal(evaluateAutoRun(facts({ rule: null }), run).code, 'no_allowance');
  assert.equal(evaluateAutoRun(facts({ rule: rule({ status: 'expired' }) }), run).code, 'allowance_ended');
  assert.equal(evaluateAutoRun(facts({ rule: rule({ status: 'no_allowance' }) }), run).code, 'allowance_ended', 'taken back by the owners');
  assert.equal(evaluateAutoRun(facts({ rule: rule({ status: 'not_started', startsAtMs: String(NOW + 1) }) }), run).code, 'allowance_not_started');
  assert.equal(evaluateAutoRun(facts({ rule: rule({ expiresAtMs: String(NOW + 60_000) }) }), run).code, 'allowance_ends_soon', 'it must still be running when the payment is signed');
});

test('a first payment to a new recipient is never automatic', () => {
  const v = evaluateAutoRun(facts(), [item(1, A, 100), item(2, B, 100, { paidBefore: false })]);
  assert.equal(v.ok, false);
  assert.equal(v.code, 'new_recipient');
  assert.equal(v.position, 2);
  assert.match(v.text, /^Payee 2: /);
  assert.match(v.text, /first payment is never automatic/);
});

test('a recipient who changed, who is an exchange or a bank, or who is not cleared hands the run back', () => {
  assert.equal(evaluateAutoRun(facts(), [item(1, A, 100, { now: null })]).code, 'recipient_changed');
  assert.equal(evaluateAutoRun(facts(), [item(1, A, 100, { now: { address: B, kind: 1 } })]).code, 'recipient_changed', 'a different address');
  assert.equal(evaluateAutoRun(facts(), [item(1, A, 100, { now: { address: A, kind: 0 } })]).code, 'recipient_changed', 'a different kind');
  assert.equal(evaluateAutoRun(facts(), [item(1, A, 100, { saved: { address: A, amountMinor: U(100), feeMinor: fee(U(100)), feeKind: 2 }, now: { address: A, kind: 2 } })]).code, 'exchange_or_bank');
  assert.equal(evaluateAutoRun(facts(), [item(1, A, 100, { now: { address: A, kind: 4 }, saved: { address: A, amountMinor: U(100), feeMinor: 0n, feeKind: 4 } })]).code, 'exchange_or_bank');
  assert.equal(evaluateAutoRun(facts(), [item(1, A, 100, { cleared: false })]).code, 'recipient_not_cleared');
  assert.equal(evaluateAutoRun(facts(), [item(1, A.toUpperCase().replace('0X', '0x'), 100)]).ok, true, 'an address is compared in one case');
});

test('a recipient not on the verified list hands the run back', () => {
  const v = evaluateAutoRun(facts({ policy: policy({ recipients: [{ address: A, tag: 'wallet' }] }) }), [item(1, A, 100), item(2, B, 100)]);
  assert.equal(v.code, 'recipient_not_verified');
  assert.equal(v.position, 2);
});

test('a fee higher than the one shown hands the run back; a lower one is paid at the lower fee', () => {
  assert.equal(evaluateAutoRun(facts(), [item(1, A, 1_000, { currentFeeMinor: fee(U(1_000)) + 1n })]).code, 'fee_changed');
  const lower = evaluateAutoRun(facts(), [item(1, A, 1_000, { currentFeeMinor: fee(U(1_000)) - 1n })]);
  assert.equal(lower.ok, true);
  assert.equal(lower.rows[0].feeMinor, fee(U(1_000)) - 1n, 'the fee that is paid is the current one, which is no more than the one shown');
});

test('one payment over the allowance’s per-payment limit hands the whole run back', () => {
  const v = evaluateAutoRun(facts(), [item(1, A, 100), item(2, B, 2_000.01)]);
  assert.equal(v.code, 'over_payment_limit');
  assert.equal(v.position, 2);
});

test('the run must fit what is left of the allowance, each payment counted against the next', () => {
  const small = facts({ rule: rule({ spendableNowMinor: U(1_000).toString() }) });
  assert.equal(evaluateAutoRun(small, [item(1, A, 400), item(2, B, 400)]).ok, true);
  const v = evaluateAutoRun(small, [item(1, A, 400), item(2, B, 400), item(3, C, 400)]);
  assert.equal(v.code, 'over_window', 'three payments of 400 and their fees do not fit 1,000');
  assert.equal(v.position, 3, 'the third is the one that does not fit');
  assert.equal(evaluateAutoRun(facts({ rule: rule({ spendableNowMinor: '0' }) }), [item(1, A, 1)]).code, 'over_window');
});

test('a payment under the per-payment limit still hands back when it takes a recipient past the second-approval line', () => {
  const near = facts({ runningTotals: { [A]: U(9_900).toString() } });
  assert.equal(evaluateAutoRun(near, [item(1, A, 99)]).ok, true);
  const v = evaluateAutoRun(near, [item(1, A, 101)]);
  assert.equal(v.code, 'above_approval_line');
  // The same recipient twice in one run counts together.
  const twice = evaluateAutoRun(facts({ rule: rule({ perPaymentMaxMinor: U(9_000).toString(), spendableNowMinor: U(40_000).toString() }), policy: policy({ secondApprovalThresholdMinor: U(10_000).toString() }) }), [item(1, A, 6_000), item(2, A, 6_000, { saved: { address: A, amountMinor: U(6_000), feeMinor: fee(U(6_000)), feeKind: 1 } })]);
  assert.equal(twice.code, 'above_approval_line');
});

test('one payment above the second-approval line is an owner’s even if the allowance would let it through', () => {
  const wide = facts({ rule: rule({ perPaymentMaxMinor: U(50_000).toString(), spendableNowMinor: U(50_000).toString() }), dailyCapMinor: U(50_000) });
  assert.equal(evaluateAutoRun(wide, [item(1, A, 10_000.01)]).code, 'above_approval_line');
  assert.equal(evaluateAutoRun(wide, [item(1, A, 10_000)]).ok, true, 'at the line is under it');
});

test('the day’s automatic payments, this run included, stay inside the daily limit', () => {
  const v = evaluateAutoRun(facts({ dailyCapMinor: U(1_000), dailyUsedMinor: U(600) }), [item(1, A, 400)]);
  assert.equal(v.code, 'daily_cap');
  const fits = evaluateAutoRun(facts({ dailyCapMinor: U(1_000), dailyUsedMinor: U(500) }), [item(1, A, 400)]);
  assert.equal(fits.ok, true, 'amount and fee together are inside what is left');
  assert.equal(evaluateAutoRun(facts({ dailyCapMinor: U(1_000), dailyUsedMinor: U(600) }), [item(1, A, 399.99)]).ok, false, 'the fee counts toward the limit');
});

test('a wallet that holds too little hands the run back, and an unreadable balance does not block it', () => {
  assert.equal(evaluateAutoRun(facts({ walletBalanceMinor: U(100) }), [item(1, A, 400)]).code, 'balance_short');
  assert.equal(evaluateAutoRun(facts({ walletBalanceMinor: null }), [item(1, A, 400)]).ok, true);
});

test('an empty run is never paid', () => {
  assert.equal(evaluateAutoRun(facts(), []).ok, false);
});

test('every reason the plan can give maps to a reason an owner reads, and none of them is silent', () => {
  for (const r of ['no_rule', 'rule_expired', 'rule_revoked', 'rule_not_active', 'rule_not_started', 'rule_ends_soon', 'over_payment_max', 'cap_used_up', 'over_cap', 'recipient_not_on_rule', 'above_threshold', 'owners_pay_this_kind', 'exchange_needs_owners', 'wrong_asset', 'policy_unreadable', 'too_many_open', 'staff_gas_share_used', 'staff_rule_not_wired', 'viewer', 'rule_needs_passkey']) {
    assert.ok(FALLBACK_TEXT[fallbackFor(r)], r);
  }
});

test('no check passes by default: a missing fact is a refusal', () => {
  const run = [item(1, A, 100)];
  for (const key of ['rule', 'policy']) assert.equal(evaluateAutoRun(facts({ [key]: null }), run).ok, false, key);
  for (const key of ['payerReady', 'sponsorReady', 'ownerCreated', 'ruleReadable']) assert.equal(evaluateAutoRun(facts({ [key]: false }), run).ok, false, key);
});
