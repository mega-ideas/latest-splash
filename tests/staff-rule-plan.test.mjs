/**
 * v2 Phase 3, staff payments inside a rule: the rule check that decides
 * whether a staff member pays alone or the owners are asked, as pure rules.
 * The page runs it to say why; the server runs the same function before it
 * builds anything (defence in depth), so what the person was told and what
 * the server enforces cannot drift apart.
 *
 * Sky's rule: anyone can fund the wallet, but they can only spend what the
 * rule allows, and anything outside the rule needs the person in charge.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { approvalPlan, approvalReasonLines, APPROVAL_REASON_TEXT, executableRoute } from '../lib/transfer/plan.ts';
import { staffFactsFrom } from '../lib/transfer/context.ts';

const USDC = (n) => BigInt(Math.round(n * 1_000_000));
const WALLET = `0x${'77'.repeat(32)}`;
const NOW = Date.parse('2026-10-31T08:00:00Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const RULE = {
  status: 'active',
  perPaymentMaxMinor: USDC(5_000).toString(),
  spendableNowMinor: USDC(20_000).toString(),
  startsAtMs: null,
  expiresAtMs: String(NOW + 60 * DAY),
  renewsAtMs: String(NOW + 14 * HOUR),
};
const POLICY = { secondApprovalThresholdMinor: USDC(10_000).toString(), recipients: [{ address: WALLET, tag: 'wallet' }] };
const PAYEE = { kind: 'wallet', wallet: 'self_custody', address: WALLET };

const plan = (over = {}) =>
  approvalPlan({
    role: 'MAKER',
    amountMinor: USDC(1_000),
    feeMinor: USDC(0.25),
    payee: PAYEE,
    rule: RULE,
    policy: POLICY,
    runningTotalMinor: 0n,
    asset: 'USDC',
    nowMs: BigInt(NOW),
    settleByMs: BigInt(NOW + HOUR),
    ...over,
  });

test('a payment that fits the amount, the recipient and the time window is paid by the staff member alone', () => {
  const p = plan();
  assert.equal(p.route, 'staff_rule');
  assert.equal(p.needsOwnerApproval, false);
  assert.deepEqual(p.reasons, []);
});

test('an expired, revoked or not-yet-started rule says which, so the person is not told only that it is "not active"', () => {
  assert.deepEqual(plan({ rule: { ...RULE, status: 'expired' } }).reasons, ['rule_expired']);
  assert.deepEqual(plan({ rule: { ...RULE, status: 'no_allowance' } }).reasons, ['rule_revoked']);
  assert.deepEqual(plan({ rule: { ...RULE, status: 'not_started' } }).reasons, ['rule_not_started']);
  for (const status of ['expired', 'no_allowance', 'not_started']) assert.equal(plan({ rule: { ...RULE, status } }).route, 'ask_owners');
  assert.deepEqual(plan({ rule: { ...RULE, status: 'something_else' } }).reasons, ['rule_not_active'], 'an unknown state is still not paid alone');
});

test('a rule that ends before the payment could be signed is not used for it', () => {
  const p = plan({ rule: { ...RULE, expiresAtMs: String(NOW + 30 * 60_000) }, settleByMs: BigInt(NOW + HOUR) });
  assert.equal(p.route, 'ask_owners');
  assert.deepEqual(p.reasons, ['rule_ends_soon']);
  assert.equal(plan({ rule: { ...RULE, expiresAtMs: String(NOW + HOUR) }, settleByMs: BigInt(NOW + HOUR) }).route, 'staff_rule', 'a rule that lasts exactly to the deadline still covers it');
  assert.equal(plan({ rule: { ...RULE, startsAtMs: String(NOW + 1) } }).route, 'ask_owners', 'a start in the future is not a rule yet, whatever status says');
});

test('a cap window that is used up is named as used up, and one that is only too small is named as too small', () => {
  const used = plan({ rule: { ...RULE, spendableNowMinor: '0' } });
  assert.deepEqual(used.reasons, ['cap_used_up']);
  assert.equal(used.renewsAtMs, RULE.renewsAtMs, 'the plan carries when the cap renews');
  const small = plan({ rule: { ...RULE, spendableNowMinor: USDC(500).toString() } });
  assert.deepEqual(small.reasons, ['over_cap']);
  const exactly = plan({ amountMinor: USDC(1_000), feeMinor: USDC(0.25), rule: { ...RULE, spendableNowMinor: (USDC(1_000) + USDC(0.25)).toString() } });
  assert.equal(exactly.route, 'staff_rule', 'amount plus fee equal to what is left is inside the cap');
  const oneOver = plan({ amountMinor: USDC(1_000), feeMinor: USDC(0.25), rule: { ...RULE, spendableNowMinor: (USDC(1_000) + USDC(0.25) - 1n).toString() } });
  assert.equal(oneOver.route, 'ask_owners');
});

test('payments already on their way count against the cap and the threshold, so two sent together cannot both claim the last of it', () => {
  const rule = { ...RULE, spendableNowMinor: USDC(1_500).toString() };
  assert.equal(plan({ rule, amountMinor: USDC(1_000) }).route, 'staff_rule');
  const second = plan({ rule, amountMinor: USDC(1_000), inFlight: { spenderMinor: USDC(1_000.25), recipientMinor: USDC(1_000) } });
  assert.deepEqual(second.reasons, ['over_cap'], 'what is left after the first is under the second');
  const none = plan({ rule, amountMinor: USDC(1), inFlight: { spenderMinor: USDC(1_500), recipientMinor: 0n } });
  assert.deepEqual(none.reasons, ['cap_used_up']);
  const together = plan({ amountMinor: USDC(5_000), rule: { ...RULE, perPaymentMaxMinor: USDC(9_000).toString(), spendableNowMinor: USDC(100_000).toString() }, runningTotalMinor: USDC(3_000), inFlight: { spenderMinor: 0n, recipientMinor: USDC(3_000) } });
  assert.deepEqual(together.reasons, ['above_threshold'], 'in-flight payments to one recipient count with the running total');
});

test('an unverified recipient, or one verified for another kind of payment, is not paid under the rule', () => {
  assert.deepEqual(plan({ policy: { ...POLICY, recipients: [] } }).reasons, ['recipient_not_on_rule']);
  assert.deepEqual(plan({ payee: { ...PAYEE, address: `0x${'88'.repeat(32)}` } }).reasons, ['recipient_not_on_rule']);
  assert.deepEqual(plan({ payee: { ...PAYEE, address: null } }).reasons, ['recipient_not_on_rule']);
  assert.deepEqual(plan({ policy: null }).reasons, ['policy_unreadable']);
});

test('an exchange account needs its Travel Rule message first, so the owners send it', () => {
  const byPayee = plan({ payee: { kind: 'wallet', wallet: 'exchange', address: WALLET } });
  assert.equal(byPayee.route, 'ask_owners');
  assert.deepEqual(byPayee.reasons, ['exchange_needs_owners']);
  const byTag = plan({ policy: { ...POLICY, recipients: [{ address: WALLET, tag: 'exchange' }] } });
  assert.deepEqual(byTag.reasons, ['exchange_needs_owners']);
});

test('a payment in anything but USDC is refused for everyone, and is not sent to the owners either', () => {
  for (const role of ['OWNER', 'MAKER', 'APPROVER']) {
    const p = plan({ role, asset: 'USDT' });
    assert.equal(p.route, 'blocked', role);
    assert.deepEqual(p.reasons, ['wrong_asset']);
  }
  assert.equal(plan({ role: 'OWNER', asset: 'USDC' }).route, 'owners_sign');
  assert.equal(plan({ asset: undefined }).route, 'staff_rule', 'a page that names no asset means USDC, the only asset a payment moves');
});

test('every reason gets plain words, and each says what it means for the person', () => {
  const all = Object.keys(APPROVAL_REASON_TEXT);
  for (const reason of ['rule_expired', 'rule_revoked', 'rule_not_started', 'rule_ends_soon', 'cap_used_up', 'exchange_needs_owners', 'wrong_asset']) {
    assert.ok(all.includes(reason), reason);
  }
  for (const [reason, text] of Object.entries(APPROVAL_REASON_TEXT)) {
    assert.ok(text.length > 20 && /[.]$/.test(text), `${reason}: a full sentence`);
    assert.ok(!/coming soon|demo|testnet|non-custodial|licen[cs]ed|not wired|not switched on yet/i.test(text), `${reason}: ${text}`);
    assert.ok(!/—/.test(text), `${reason}: no long dashes`);
  }
});

test('the reasons are worded with the numbers: the limit, what is left, and when the cap renews', () => {
  const over = plan({ amountMinor: USDC(6_000) });
  const lines = approvalReasonLines(over, { rule: RULE, policy: POLICY, amountMinor: USDC(6_000), nowMs: NOW });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /more than your rule allows for one payment/i);
  assert.match(lines[0], /5,000\.00 USDC/);
  const used = approvalReasonLines(plan({ rule: { ...RULE, spendableNowMinor: '0' } }), { rule: { ...RULE, spendableNowMinor: '0' }, policy: POLICY, amountMinor: USDC(1_000), nowMs: NOW });
  assert.match(used[0], /used up/i);
  assert.match(used[0], /14 hours/);
  assert.match(used[0], /22:00 UTC on 31 Oct/);
  const small = approvalReasonLines(plan({ rule: { ...RULE, spendableNowMinor: USDC(500).toString() } }), { rule: { ...RULE, spendableNowMinor: USDC(500).toString() }, policy: POLICY, amountMinor: USDC(1_000), nowMs: NOW });
  assert.match(small[0], /500\.00 USDC left/);
  const threshold = approvalReasonLines(
    plan({ amountMinor: USDC(9_000), rule: { ...RULE, perPaymentMaxMinor: USDC(9_000).toString() }, runningTotalMinor: USDC(2_000) }),
    { rule: RULE, policy: POLICY, amountMinor: USDC(9_000), nowMs: NOW },
  );
  assert.match(threshold[0], /10,000\.00 USDC/);
  assert.deepEqual(approvalReasonLines(plan(), { rule: RULE, policy: POLICY, amountMinor: USDC(1_000), nowMs: NOW }), [], 'a payment within the rule has nothing to explain');
});

test('whether the server can carry out a payment under a rule is a fact it reports, not a constant', () => {
  const inRule = plan();
  assert.equal(executableRoute(inRule, true).route, 'staff_rule');
  const off = executableRoute(inRule, false);
  assert.equal(off.route, 'ask_owners');
  assert.deepEqual(off.reasons, ['staff_rule_not_wired']);
  assert.equal(executableRoute(plan({ role: 'OWNER' }), false).route, 'owners_sign', 'the owners never needed it');
  assert.throws(() => executableRoute(inRule), /wired/i, 'no default: the caller must say');
});

test('the rules index gives the plan the rule’s dates and when its cap renews', () => {
  const me = `0x${'a1'.repeat(32)}`;
  const view = {
    policy: { secondApprovalThresholdMinor: USDC(10_000).toString(), recipients: [{ address: WALLET, tag: 'wallet' }] },
    rules: [
      {
        spender: me,
        status: 'active',
        perPaymentMaxMinor: USDC(5_000).toString(),
        allowances: [
          { current: true, state: 'active', spendableNowMinor: USDC(300).toString(), startsAtMs: '5', expiresAtMs: String(NOW + 9 * DAY), window: { endsAtMs: String(NOW + 2 * HOUR) } },
          { current: true, state: 'active', spendableNowMinor: USDC(900).toString(), startsAtMs: null, expiresAtMs: String(NOW + 40 * DAY), window: { endsAtMs: String(NOW + 14 * HOUR) } },
          { current: false, state: 'active', spendableNowMinor: USDC(99_999).toString(), startsAtMs: null, expiresAtMs: null, window: null },
        ],
        runningTotals: [{ recipient: WALLET, countedMinor: USDC(2_000).toString() }],
      },
    ],
  };
  const facts = staffFactsFrom(view, [me]);
  assert.equal(facts.rule.spendableNowMinor, USDC(900).toString(), 'the allowance with the most room that is current and active');
  assert.equal(facts.rule.expiresAtMs, String(NOW + 40 * DAY), 'its dates, not another allowance’s');
  assert.equal(facts.rule.renewsAtMs, String(NOW + 14 * HOUR));
  assert.equal(facts.rule.startsAtMs, null);
  assert.equal(facts.runningTotals[WALLET.toLowerCase()], USDC(2_000).toString());
  assert.equal(staffFactsFrom(view, [`0x${'b2'.repeat(32)}`]).rule, null, 'someone else’s rule is not mine');
});
