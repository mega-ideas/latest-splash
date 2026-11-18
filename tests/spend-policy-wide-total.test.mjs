/**
 * Pre-audit B1: the policy-wide running total, as Splash reads it.
 *
 * On chain, `splash_spend`'s draw compares the second-approval threshold
 * with the larger of the payer's own total to a recipient and what EVERY
 * payer paid that recipient without an owner's approval
 * (`spend_policy::policy_threshold_total`, kept in `policy_totals`). The
 * policy-wide total keeps counting until a window length after its LAST
 * part, whoever paid it, so it can count more than the payers' own totals
 * added up. What Transfer and the scheduled runner judge a payment by must
 * not count less than the chain will, or a payment they call "no approval
 * needed" is refused on chain.
 *
 * Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types
 *        --import ./scripts/alias-hook.mjs --test tests/spend-policy-wide-total.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSpendView } from '../lib/server/spend-rules-index.ts';
import { staffFactsFrom } from '../lib/transfer/context.ts';
import { parseSpendPolicy, SpendPolicyBcs } from '../lib/wallet/spend-rules-bcs.ts';

const addr = (n) => '0x' + n.toString(16).padStart(64, '0');
const USDC_1 = 1_000_000n;
const DAY = 86_400_000n;
const t0 = 1_800_000_000_000n;
const WALLET = addr(0xa11e7);
const STAFF = addr(0x57aff);
const JUNIOR = addr(0x7a1);
const SUPPLIER = addr(0x5099);
const ZERO = addr(0);
const THRESHOLD = 1_500n * USDC_1;

const entry = (payer, startMs, lastMs, total) => ({
  payer,
  beneficiary: '',
  recipient: SUPPLIER,
  windowStartMs: startMs,
  windowEndMs: startMs + DAY,
  lastPaymentMs: lastMs,
  total,
  carried: 0n,
  carriedUntilMs: 0n,
});

/**
 * STAFF paid 500 at t0 and JUNIOR 500 a millisecond before the day ended,
 * neither with an approval. A day and a millisecond after t0, STAFF's own
 * total has stopped counting (a window length after its last payment), but
 * the policy-wide total counts both parts until a day after JUNIOR's.
 */
function policyAfterASplit() {
  return {
    id: addr(0x9011c7),
    account: addr(0xacc),
    wallet: WALLET,
    walletEpoch: 1n,
    asset: 'usdc',
    owners: [],
    tables: { spenders: addr(1), recipients: addr(2), beneficiaries: addr(3), partnerDeposits: addr(4), runningTotals: addr(5), policyTotals: addr(6) },
    counts: { spenders: 2n, recipients: 1n, beneficiaries: 0n, runningTotals: 2n, policyTotals: 1n },
    perPaymentMax: 15_000n * USDC_1,
    secondApprovalThreshold: THRESHOLD,
    generation: 0n,
    runningWindowMs: DAY,
    initialSharedVersion: '11',
    spenders: [
      { spender: STAFF, role: 1, perPaymentMax: 15_000n * USDC_1 },
      { spender: JUNIOR, role: 1, perPaymentMax: 1_000n * USDC_1 },
    ],
    recipients: [{ domain: 8, address: SUPPLIER, kind: 1 }],
    beneficiaries: [],
    runningTotals: [entry(STAFF, t0, t0, 500n * USDC_1), entry(JUNIOR, t0 + DAY - 1n, t0 + DAY - 1n, 500n * USDC_1)],
    policyTotals: [entry(ZERO, t0, t0 + DAY - 1n, 1_000n * USDC_1)],
  };
}

const NOW = t0 + DAY + 1n;
const view = () =>
  buildSpendView({ now: NOW, wallet: WALLET, walletEpoch: 1n, policy: policyAfterASplit(), earlierPolicies: [], allowances: [], spends: [], appName: 'x::splash_spend::SPLASH_SPEND' });

test('the spend view shows the policy-wide total per recipient, counted as policy_threshold_total counts it', () => {
  const v = view();
  const own = v.rules.flatMap((r) => r.runningTotals).reduce((n, t) => n + BigInt(t.countedMinor), 0n);
  assert.equal(own, 500n * USDC_1, "the payers' own totals add up to JUNIOR's 500 only");
  const totals = v.policy?.recipientTotals ?? [];
  assert.equal(totals.length, 1, 'one policy-wide total, to the supplier');
  const [t] = totals;
  assert.deepEqual(
    [t.recipient, t.beneficiary, t.countedMinor, t.countsUntilMs, t.beforeApprovalMinor],
    [SUPPLIER, null, String(1_000n * USDC_1), String(t0 + 2n * DAY - 1n), String(500n * USDC_1)],
  );
});

test("a staff member's facts count the larger of the payers' own totals added up and the policy-wide total", () => {
  const facts = staffFactsFrom(view(), [STAFF]);
  assert.equal(facts.runningTotals[SUPPLIER], String(1_000n * USDC_1), 'what the chain will count, not the 500 the own totals add up to');
});

test("the payers' own totals added up still count when they are the larger", () => {
  // An approved payment counts only in its payer's own total, so the own
  // totals can add up to more than the policy-wide one.
  const p = policyAfterASplit();
  p.runningTotals = [entry(STAFF, NOW - 10n, NOW - 10n, 1_200n * USDC_1), entry(JUNIOR, NOW - 5n, NOW - 5n, 100n * USDC_1)];
  p.policyTotals = [entry(ZERO, NOW - 5n, NOW - 5n, 100n * USDC_1)];
  const v = buildSpendView({ now: NOW, wallet: WALLET, walletEpoch: 1n, policy: p, earlierPolicies: [], allowances: [], spends: [], appName: 'x' });
  assert.equal(staffFactsFrom(v, [JUNIOR]).runningTotals[SUPPLIER], String(1_300n * USDC_1));
});

test('a SpendPolicy read from the chain carries its policy-wide totals table', () => {
  const t = (id, size) => ({ id, size: String(size), head: null, tail: null });
  const tab = (id, size) => ({ id, size: String(size) });
  const bytes = SpendPolicyBcs.serialize({
    id: addr(0x10),
    account: addr(0x11),
    wallet: WALLET,
    wallet_epoch: '1',
    asset: 'usdc',
    config: addr(0x12),
    fee_config: addr(0x13),
    address_registry: addr(0x14),
    owners: [addr(0x15)],
    spenders: tab(addr(0x21), 2),
    spender_count: '2',
    recipients: tab(addr(0x22), 1),
    recipient_count: '1',
    beneficiaries: tab(addr(0x23), 0),
    beneficiary_count: '0',
    partner_deposits: tab(addr(0x24), 0),
    per_payment_max: '1',
    second_approval_threshold: String(THRESHOLD),
    generation: '0',
    running_window_ms: String(DAY),
    running_totals: t(addr(0x25), 2),
    policy_totals: t(addr(0x26), 1),
  }).toBytes();
  const head = parseSpendPolicy(bytes);
  assert.equal(head.tables.runningTotals, addr(0x25));
  assert.equal(head.tables.policyTotals, addr(0x26));
  assert.deepEqual([head.counts.runningTotals, head.counts.policyTotals], [2n, 1n]);
});

test("a payer's running total is near the threshold, and has less room before an approval, by the policy-wide total when it is the larger", () => {
  // JUNIOR's own 500 is a third of the 1,500 threshold, but the chain counts
  // the 1,300 every payer paid the supplier without an approval: 200 more
  // and the next payment needs an owner.
  const p = policyAfterASplit();
  p.policyTotals = [entry(ZERO, t0, t0 + DAY - 1n, 1_300n * USDC_1)];
  const v = buildSpendView({ now: NOW, wallet: WALLET, walletEpoch: 1n, policy: p, earlierPolicies: [], allowances: [], spends: [], appName: 'x' });
  const [t] = v.rules.find((r) => r.spender === JUNIOR).runningTotals;
  assert.deepEqual([t.countedMinor, t.beforeApprovalMinor, t.nearThreshold], [String(500n * USDC_1), String(200n * USDC_1), true], 'countedMinor stays the payer\'s own; the room and the flag are the chain\'s');
});
