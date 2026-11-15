/**
 * Pre-audit B1: Splash reads BOTH SpendPolicy layouts.
 *
 * B1 added a field to `splash_spend::spend_policy::SpendPolicy`
 * (`policy_totals`, the policy-wide totals). A published package's struct
 * layouts never change, so B1 only exists in a package published after it:
 * the splash_spend package on testnet (0x59c3…1112, version 1) was published
 * before, its policies have no such field, and its second-approval check
 * counts each payer's own total alone. The app must read those policies too,
 * and say about them what that chain does:
 *
 *   - a policy whose bytes end at `running_totals` parses, with no
 *     policy-wide totals table (and none is asked of the chain);
 *   - a policy whose bytes go on with one more LinkedTable parses as B1;
 *   - bytes that are neither are refused by name;
 *   - the view, a staff member's facts and the owners' alerts count, and
 *     say, what the policy's own package enforces.
 *
 * The layouts here are written out field for field, apart from the app's,
 * and `TESTNET_POLICY` is the contents of a real policy of the testnet
 * package, as the chain returned them on 15 November 2026.
 *
 * Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types
 *        --import ./scripts/alias-hook.mjs --test tests/spend-policy-layouts.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { bcs } from '@mysten/sui/bcs';

import { deriveNearThresholdAlerts } from '../lib/server/near-threshold.ts';
import { readPolicyState } from '../lib/server/spend-policy-read.ts';
import { buildSpendView } from '../lib/server/spend-rules-index.ts';
import { staffFactsFrom } from '../lib/transfer/context.ts';
import { DestinationBcs, LAYOUTS, parseSpendPolicy, RunningKeyBcs, RunningNodeBcs, SpenderBcs } from '../lib/wallet/spend-rules-bcs.ts';

const addr = (n) => '0x' + n.toString(16).padStart(64, '0');
const USDC_1 = 1_000_000n;
const HOUR = 3_600_000n;
const DAY = 86_400_000n;
const t0 = 1_800_000_000_000n;
const NOW = t0 + HOUR;
const THRESHOLD = 1_500n * USDC_1;

/** The splash_spend package on testnet, published before B1. */
const TESTNET_PACKAGE = '0x59c3bac8598d7f15799ab7d741fb33f5ca85ac4c55d5325fd24b1aa47a151112';
/** A package published with B1 in it (any other id). */
const B1_PACKAGE = addr(0xb1);

const POLICY = addr(0x10);
const WALLET = addr(0xa11e7);
const STAFF = '0x' + 'a1'.repeat(32);
const JUNIOR = '0x' + 'b2'.repeat(32);
const SUPPLIER = '0x' + '5a'.repeat(32);
const ZERO = addr(0);
const TABLES = { spenders: addr(0x21), recipients: addr(0x22), beneficiaries: addr(0x23), partnerDeposits: addr(0x24), runningTotals: addr(0x25), policyTotals: addr(0x26) };

/**
 * `SpendPolicy` as the testnet package declares it (its normalized struct,
 * read from the chain on 15 November 2026): twenty-one fields, the last one
 * `running_totals`.
 */
const TESTNET_FIELDS = [
  'id', 'account', 'wallet', 'wallet_epoch', 'asset', 'config', 'fee_config', 'address_registry', 'owners',
  'spenders', 'spender_count', 'recipients', 'recipient_count', 'beneficiaries', 'beneficiary_count', 'partner_deposits',
  'per_payment_max', 'second_approval_threshold', 'generation', 'running_window_ms', 'running_totals',
];

// ─── The two layouts, written out apart from the app's ──────────────────────

const A = bcs.Address;
const Table = bcs.struct('Table', { id: A, size: bcs.u64() });
const Key = bcs.struct('RunningKey', { payer: A, beneficiary: bcs.vector(bcs.u8()), recipient: A });
const LinkedTable = bcs.struct('LinkedTable', { id: A, size: bcs.u64(), head: bcs.option(Key), tail: bcs.option(Key) });
const BEFORE_B1 = {
  id: A,
  account: A,
  wallet: A,
  wallet_epoch: bcs.u64(),
  asset: bcs.string(),
  config: A,
  fee_config: A,
  address_registry: A,
  owners: bcs.vector(A),
  spenders: Table,
  spender_count: bcs.u64(),
  recipients: Table,
  recipient_count: bcs.u64(),
  beneficiaries: Table,
  beneficiary_count: bcs.u64(),
  partner_deposits: Table,
  per_payment_max: bcs.u64(),
  second_approval_threshold: bcs.u64(),
  generation: bcs.u64(),
  running_window_ms: bcs.u64(),
  running_totals: LinkedTable,
};
const PolicyBeforeB1 = bcs.struct('SpendPolicy', BEFORE_B1);
const PolicyWithB1 = bcs.struct('SpendPolicy', { ...BEFORE_B1, policy_totals: LinkedTable });

const keyOf = (payer) => ({ payer, beneficiary: [], recipient: SUPPLIER });
const sharedFields = {
  id: POLICY,
  account: addr(0x11),
  wallet: WALLET,
  wallet_epoch: '1',
  asset: 'usdc',
  config: addr(0x12),
  fee_config: addr(0x13),
  address_registry: addr(0x14),
  owners: [addr(0x15), addr(0x16)],
  spenders: { id: TABLES.spenders, size: '2' },
  spender_count: '2',
  recipients: { id: TABLES.recipients, size: '1' },
  recipient_count: '1',
  beneficiaries: { id: TABLES.beneficiaries, size: '0' },
  beneficiary_count: '0',
  partner_deposits: { id: TABLES.partnerDeposits, size: '0' },
  per_payment_max: String(15_000n * USDC_1),
  second_approval_threshold: String(THRESHOLD),
  generation: '0',
  running_window_ms: String(DAY),
  running_totals: { id: TABLES.runningTotals, size: '2', head: keyOf(STAFF), tail: keyOf(JUNIOR) },
};
const beforeB1Bytes = PolicyBeforeB1.serialize(sharedFields).toBytes();
const b1Bytes = PolicyWithB1.serialize({ ...sharedFields, policy_totals: { id: TABLES.policyTotals, size: '1', head: keyOf(ZERO), tail: keyOf(ZERO) } }).toBytes();

/** The contents of policy 0x36f1…039a of the testnet package, as the chain returned them on 15 November 2026 (762 bytes). */
const TESTNET_POLICY = Uint8Array.from(
  Buffer.from(
    '36f158c11b3f1b6dc0a4eed644bfd15960867d6e43ced69a1ef22463581c039ae466ed9f0dcd2b524499d62869bd4f796645ac760f286a8b59b92e6db1bc58ebde7bed6ea05e3823e1c186c3262a8ff608d98414f30dd3b0afdc881e4bccb771' +
      '01000000000000004c613165633766633030613666343064623936393361643134313564306331393361643339303634393434323863663235323632313033376264373131376532393a3a757364633a3a55534443' +
      'c48e62a5b44b3e6547009113aadcd21ba069d74c05b16808ebac54d1a790f316b36e3e69c03b175f1ab3b4e3f0b137d6b70941275d73bcc486567690cb98924624f31b4f9229e58db56ef96957468f27223e9f6b92e32b0628c8b30cc805470f' +
      '03e3eba790902ddbce91e935cc7b084a9545bf32e787783d262048d3612a42c5ef40266128a31f0286eff5ce2c80b095aee26881ec8d003c7f1629cf50215e26532139a12c38d9772279e24b9ce2aaecc3405345aadc559497de65c62b84482a0a' +
      'ad61f8a7991b1fb9b06315bda169d00bbc35fb72e9c2507f99702ecab0efcf8002000000000000000200000000000000' +
      'e6f539704ce3f5799688f4db465be0b2cb7ac4c8ea1e04be8825152b7bc68c3802000000000000000200000000000000' +
      'd10c2fad9a3de6e48bf0d6aa943ba4b409e4ee90f78c8da235fc8d9cc4989e0500000000000000000000000000000000' +
      '23d717203d192981969160c92cc1ad3b3e94f521186593acdb8e72b84f8a87d10000000000000000' +
      '80841e000000000020a10700000000000000000000000000005c260500000000' +
      'd7421c3a13a283073938e4233a3ef47adedfa5dc2e92f3b133eb77a51a6df2420200000000000000' +
      '01ca404d6dafcc35b88efb309f7cdf70d7662bfc36d7e8578f61aa9787295106a900740273f0e25632f975b33262dc8a342f3fa9d97d99371f1213f563a37089e268' +
      '01b57a729ce249cdaf99545c510efc0b50125b359ae04ae6ca5297e07d007b1cf700740273f0e25632f975b33262dc8a342f3fa9d97d99371f1213f563a37089e268',
    'hex',
  ),
);

// ─── A chain that returns those bytes ───────────────────────────────────────

const field = (name, value) => bcs.struct('Field', { id: A, name, value });
const spenderEntry = (spender, max) => field(A, SpenderBcs).serialize({ id: addr(0xf1), name: spender, value: { role: 1, per_payment_max: String(max) } }).toBytes();
const recipientEntry = (to) => field(DestinationBcs, bcs.u8()).serialize({ id: addr(0xf2), name: { domain: 8, addr: to }, value: 1 }).toBytes();
const totalEntry = (payer, startMs, total) =>
  field(RunningKeyBcs, RunningNodeBcs)
    .serialize({
      id: addr(0xf3),
      name: keyOf(payer),
      value: { prev: null, next: null, value: { window_start_ms: String(startMs), window_end_ms: String(startMs + DAY), last_payment_ms: String(startMs), total: String(total), carried: '0', carried_until_ms: '0' } },
    })
    .toBytes();

/**
 * One policy with two staff who each paid the supplier without an owner's
 * approval, as a chain returns it: of the testnet package (no policy-wide
 * totals table exists there: asking for it fails), or of a package with B1.
 */
function chain({ b1, staffPaid = 800n * USDC_1, juniorPaid = 600n * USDC_1 }) {
  const tables = {
    [TABLES.spenders]: [spenderEntry(STAFF, 15_000n * USDC_1), spenderEntry(JUNIOR, 1_000n * USDC_1)],
    [TABLES.recipients]: [recipientEntry(SUPPLIER)],
    [TABLES.beneficiaries]: [],
    [TABLES.runningTotals]: [totalEntry(STAFF, t0, staffPaid), totalEntry(JUNIOR, t0 + 60_000n, juniorPaid)],
    ...(b1 ? { [TABLES.policyTotals]: [totalEntry(ZERO, t0, staffPaid + juniorPaid)] } : {}),
  };
  const asked = [];
  const source = {
    object: async (id) =>
      id === POLICY
        ? { type: `${b1 ? B1_PACKAGE : TESTNET_PACKAGE}::spend_policy::SpendPolicy`, owner: { $kind: 'Shared', Shared: { initialSharedVersion: '11' } }, content: b1 ? b1Bytes : beforeB1Bytes }
        : null,
    tableEntries: async (tableId) => {
      asked.push(tableId);
      if (!(tableId in tables)) throw new Error(`the chain has no table ${tableId}`);
      return tables[tableId];
    },
  };
  return { asked, source, pkg: b1 ? B1_PACKAGE : TESTNET_PACKAGE };
}

async function viewOf(opts) {
  const c = chain(opts);
  const policy = await readPolicyState(c.source, POLICY, c.pkg);
  return buildSpendView({ now: NOW, wallet: WALLET, walletEpoch: 1n, policy, earlierPolicies: [], allowances: [], spends: [], appName: 'x::splash_spend::SPLASH_SPEND' });
}

const nameOf = (a) => (a === STAFF ? 'Aisha' : a === JUNIOR ? 'Ben' : null);

// ─── 1. Parsing ─────────────────────────────────────────────────────────────

test('the two layouts differ only by what follows running_totals: nothing, or one more LinkedTable', () => {
  assert.deepEqual(Object.keys(BEFORE_B1), TESTNET_FIELDS, "the layout written out here is the testnet package's");
  assert.ok(b1Bytes.length > beforeB1Bytes.length);
  assert.deepEqual(b1Bytes.subarray(0, beforeB1Bytes.length), beforeB1Bytes, 'a B1 policy starts with the same fields');
  assert.deepEqual(LinkedTable.parse(b1Bytes.subarray(beforeB1Bytes.length)).id, TABLES.policyTotals, 'and goes on with policy_totals');
});

test("the app keeps both layouts: the one before B1 is the testnet package's, field for field", () => {
  assert.deepEqual(LAYOUTS.SpendPolicyPreB1, TESTNET_FIELDS);
  assert.deepEqual(LAYOUTS.SpendPolicy, [...TESTNET_FIELDS, 'policy_totals']);
});

test('a policy of a package published before B1 parses, with no policy-wide totals table', () => {
  const head = parseSpendPolicy(beforeB1Bytes);
  assert.equal(head.id, POLICY);
  assert.equal(head.wallet, WALLET);
  assert.deepEqual(head.owners, [addr(0x15), addr(0x16)]);
  assert.equal(head.secondApprovalThreshold, THRESHOLD);
  assert.equal(head.runningWindowMs, DAY);
  assert.equal(head.tables.runningTotals, TABLES.runningTotals);
  assert.equal(head.counts.runningTotals, 2n);
  assert.equal(head.tables.policyTotals, null, 'no such table: the package keeps no policy-wide totals');
  assert.equal(head.counts.policyTotals, 0n);
});

test('a policy of a package with B1 parses, with its policy-wide totals table, and every other field reads the same in both', () => {
  const before = parseSpendPolicy(beforeB1Bytes);
  const b1 = parseSpendPolicy(b1Bytes);
  assert.equal(b1.tables.policyTotals, TABLES.policyTotals);
  assert.equal(b1.counts.policyTotals, 1n);
  assert.deepEqual(
    { ...b1, tables: { ...b1.tables, policyTotals: null }, counts: { ...b1.counts, policyTotals: 0n } },
    before,
    'only the policy-wide totals differ',
  );
});

test('the policy on testnet today parses: real bytes of the package published before B1', () => {
  const head = parseSpendPolicy(TESTNET_POLICY);
  assert.equal(TESTNET_POLICY.length, 762);
  assert.equal(head.id, '0x36f158c11b3f1b6dc0a4eed644bfd15960867d6e43ced69a1ef22463581c039a');
  assert.equal(head.wallet, '0xde7bed6ea05e3823e1c186c3262a8ff608d98414f30dd3b0afdc881e4bccb771');
  assert.equal(head.asset, 'a1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC');
  assert.equal(head.owners.length, 3);
  assert.deepEqual([head.perPaymentMax, head.secondApprovalThreshold, head.runningWindowMs], [2_000_000n, 500_000n, DAY]);
  assert.equal(head.tables.runningTotals, '0xd7421c3a13a283073938e4233a3ef47adedfa5dc2e92f3b133eb77a51a6df242');
  assert.deepEqual([head.counts.spenders, head.counts.recipients, head.counts.runningTotals, head.counts.policyTotals], [2n, 2n, 2n, 0n]);
  assert.equal(head.tables.policyTotals, null);
});

test('bytes that are neither layout are refused by name, never guessed at', () => {
  const plus = (bytes, extra) => Uint8Array.from([...bytes, ...extra]);
  // Too few bytes left for a LinkedTable (an id, a size and two options: 42 at least).
  assert.throws(() => parseSpendPolicy(plus(beforeB1Bytes, [0, 0, 0, 0, 0])), /neither SpendPolicy layout/);
  // A whole LinkedTable and then more.
  assert.throws(() => parseSpendPolicy(plus(b1Bytes, [0])), /neither SpendPolicy layout/);
  // Long enough, but not a LinkedTable: an option tag that is neither none (0) nor some (1).
  assert.throws(() => parseSpendPolicy(plus(beforeB1Bytes, [...new Array(40).fill(0), 2, 0])), /neither SpendPolicy layout/);
  // Not a SpendPolicy at all (cut short inside the shared fields): still an error, never a policy.
  assert.throws(() => parseSpendPolicy(beforeB1Bytes.subarray(0, 100)));
});

// ─── 2. Reading a policy from the chain ─────────────────────────────────────

test('reading a policy of the testnet package asks the chain for its four tables and no policy-wide one', async () => {
  const c = chain({ b1: false });
  const policy = await readPolicyState(c.source, POLICY, c.pkg);
  assert.deepEqual([...c.asked].sort(), [TABLES.spenders, TABLES.recipients, TABLES.beneficiaries, TABLES.runningTotals].sort());
  assert.equal(policy.tables.policyTotals, null);
  assert.deepEqual(policy.policyTotals, [], 'no policy-wide totals: none are kept, which is also what that chain counts');
  assert.deepEqual(policy.spenders.map((s) => s.spender), [STAFF, JUNIOR]);
  assert.deepEqual(policy.runningTotals.map((t) => [t.payer, t.total]), [[STAFF, 800n * USDC_1], [JUNIOR, 600n * USDC_1]]);
  assert.equal(policy.initialSharedVersion, '11');
});

test('reading a policy of a package with B1 reads its policy-wide totals too', async () => {
  const c = chain({ b1: true });
  const policy = await readPolicyState(c.source, POLICY, c.pkg);
  assert.deepEqual([...c.asked].sort(), Object.values(TABLES).filter((t) => t !== TABLES.partnerDeposits).sort());
  assert.deepEqual(policy.policyTotals.map((t) => [t.payer, t.recipient, t.total]), [[ZERO, SUPPLIER, 1_400n * USDC_1]]);
});

// ─── 3. What the app counts, and says, for each ─────────────────────────────

test('testnet package: the view counts each payer alone, as that chain does', async () => {
  const v = await viewOf({ b1: false });
  assert.equal(v.policy.countsAcrossPayers, false);
  assert.deepEqual(v.policy.recipientTotals, []);
  const room = Object.fromEntries(v.rules.map((r) => [r.spender, r.runningTotals[0].beforeApprovalMinor]));
  assert.deepEqual(room, { [STAFF]: String(700n * USDC_1), [JUNIOR]: String(900n * USDC_1) }, 'the threshold less their own total');
  assert.deepEqual(v.rules.map((r) => r.runningTotals[0].nearThreshold), [false, false]);
  // Transfer already judged a payment by every payer's own total added up, before B1: unchanged.
  assert.equal(staffFactsFrom(v, [JUNIOR]).runningTotals[SUPPLIER], String(1_400n * USDC_1));
});

test('package with B1: the view counts what every payer paid, as that chain does', async () => {
  const v = await viewOf({ b1: true });
  assert.equal(v.policy.countsAcrossPayers, true);
  assert.deepEqual(v.policy.recipientTotals.map((t) => [t.recipient, t.countedMinor, t.beforeApprovalMinor]), [[SUPPLIER, String(1_400n * USDC_1), String(100n * USDC_1)]]);
  const room = Object.fromEntries(v.rules.map((r) => [r.spender, r.runningTotals[0].beforeApprovalMinor]));
  assert.deepEqual(room, { [STAFF]: String(100n * USDC_1), [JUNIOR]: String(100n * USDC_1) });
  assert.deepEqual(v.rules.map((r) => r.runningTotals[0].nearThreshold), [true, true]);
  assert.equal(staffFactsFrom(v, [JUNIOR]).runningTotals[SUPPLIER], String(1_400n * USDC_1));
});

test('testnet package: the owners are told a split passed the threshold with no approval, not that the chain counts it together', async () => {
  const [near] = deriveNearThresholdAlerts(await viewOf({ b1: false }), { nameOf });
  assert.deepEqual([near.kind, near.severity, near.countedMinor], ['same_recipient_many_spenders', 'near_threshold', String(1_400n * USDC_1)]);
  assert.equal(near.summary, 'Aisha and Ben have together paid 0x5a5a…5a5a 1,400 USDC, close to the 1,500 USDC that needs a second approval for one person.');

  // 800 each: under the threshold alone, over it together. That chain asked for no approval.
  const [over] = deriveNearThresholdAlerts(await viewOf({ b1: false, juniorPaid: 800n * USDC_1 }), { nameOf });
  assert.deepEqual([over.kind, over.severity, over.countedMinor], ['same_recipient_many_spenders', 'over_threshold', String(1_600n * USDC_1)]);
  assert.equal(
    over.summary,
    'Aisha and Ben have together paid 0x5a5a…5a5a 1,600 USDC, above the 1,500 USDC that needs a second approval for one person. Each stayed under it alone, so no approval was asked for.',
  );
  for (const a of [near, over]) {
    assert.doesNotMatch(`${a.summary} ${a.detail}`, /counts together|counted together/, 'that chain does not count them together: saying so would be a false assurance');
    assert.match(a.detail, /Aisha: 800 USDC; Ben: /);
  }
});

test('package with B1: the owners are told the chain counts the payers together', async () => {
  const [near] = deriveNearThresholdAlerts(await viewOf({ b1: true }), { nameOf });
  assert.deepEqual([near.kind, near.severity, near.countedMinor], ['same_recipient_many_spenders', 'near_threshold', String(1_400n * USDC_1)]);
  assert.equal(
    near.summary,
    "Aisha and Ben have together paid 0x5a5a…5a5a 1,400 USDC, close to the 1,500 USDC that needs a second approval. What anyone pays it without an owner's approval counts together, so any payment to it that would take that above the threshold needs an owner's approval.",
  );
  assert.match(near.detail, /Paid to it without an owner's approval, counted together: 1,400 USDC\./);
});
