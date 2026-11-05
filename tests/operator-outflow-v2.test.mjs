/**
 * The operator-outflow monitor knows the v2 executor path (carried finding,
 * MEDIUM).
 *
 * Its only approved path was `payment_intent::confirm_with_approval`, which
 * v2 core does not have, so every legitimate v2 executor payment would have
 * been flagged. In v2 the operator (the KMS key, an EXECUTOR on a spending
 * rule) pays through `splash_spend::pay_intent`, from the business wallet's
 * allowance, never from its own balance, and the same transaction anchors
 * the receipt (`audit_anchor::anchor`, the only consumer of a SettleReceipt).
 *
 * Pinned here:
 *   * pay_intent in OUR splash_spend package with anchor in OUR core package
 *     is the approved path; the operator pays only gas on it;
 *   * every address that gains value on it must be an approved wallet
 *     beneficiary, an address Splash's registry classifies (a payout
 *     partner's deposit address, a business wallet), or FeeConfig's fee
 *     recipient (the fee leg);
 *   * a look-alike pay_intent or anchor from another package, a pay_intent
 *     without the anchor, value to anyone else, and an operator that pays
 *     from its own balance on that path are flagged;
 *   * confirm_with_approval approves nothing any more;
 *   * the monitor reads the spend package, the fee recipient and the
 *     registry, and fails closed when it cannot.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyOperatorTransactions } from '../lib/server/operator-outflows.ts';

const SUI = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
const USDC = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';
const OPERATOR = '0x' + '0a'.repeat(32);
const WALLET = '0x' + 'b0'.repeat(32);
const SUPPLIER = '0x' + '1b'.repeat(32);
const PARTNER = '0x' + 'cc'.repeat(32);
const FEE_RECIPIENT = '0x' + 'fe'.repeat(32);
const STRANGER = '0x' + 'ee'.repeat(32);
const CORE = '0x' + 'c0'.repeat(32);
const SPEND = '0x' + 'd0'.repeat(32);
const OTHER = '0x' + '99'.repeat(32);

const policy = {
  operator: OPERATOR,
  corePackageIds: [CORE],
  spendPackageIds: [SPEND],
  approvedRecipients: new Set([SUPPLIER]),
  registeredRecipients: new Set([PARTNER]),
  feeRecipient: FEE_RECIPIENT,
};

const PAY = { package: SPEND, module: 'splash_spend', function: 'pay_intent' };
const ANCHOR = { package: CORE, module: 'audit_anchor', function: 'anchor' };

/** A v2 executor payment: the wallet's allowance pays principal and fee; the operator pays gas. */
function executorPayment(digest, { to = SUPPLIER, fee = 2_000_000n, feeTo = FEE_RECIPIENT, calls = [PAY, ANCHOR], operatorPays = 0n } = {}) {
  const principal = 1_000_000_000n;
  const changes = [
    { owner: WALLET, coinType: USDC, amount: -(principal + fee) + (operatorPays > 0n ? principal + fee : 0n) },
    { owner: to, coinType: USDC, amount: principal },
    { owner: OPERATOR, coinType: SUI, amount: -1_200_000n },
  ];
  if (fee > 0n) changes.push({ owner: feeTo, coinType: USDC, amount: fee });
  if (operatorPays > 0n) changes.push({ owner: OPERATOR, coinType: USDC, amount: -operatorPays });
  return { digest, moveCalls: calls, gasMist: 1_200_000n, balanceChanges: changes };
}

test('a v2 executor payment to an approved beneficiary, with its fee leg, is approved', () => {
  const report = classifyOperatorTransactions([executorPayment('GOOD')], policy);
  assert.deepEqual(report.approved, ['GOOD']);
  assert.deepEqual(report.flagged, []);
});

test('a bank payout to a partner deposit address in Splash registry is approved, and so is a fee-free one', () => {
  const report = classifyOperatorTransactions(
    [executorPayment('BANK', { to: PARTNER }), executorPayment('FREE', { fee: 0n })],
    policy,
  );
  assert.deepEqual(report.approved, ['BANK', 'FREE']);
});

test('value to anyone else on the v2 path is flagged, the fee leg included', () => {
  const report = classifyOperatorTransactions(
    [executorPayment('STRANGER', { to: STRANGER }), executorPayment('FEE_ELSEWHERE', { feeTo: STRANGER })],
    policy,
  );
  assert.deepEqual(report.flagged.map((f) => [f.digest, f.reason]), [
    ['STRANGER', 'recipient_not_approved'],
    ['FEE_ELSEWHERE', 'recipient_not_approved'],
  ]);
});

test('a look-alike pay_intent or anchor, or a pay_intent with no anchor, is not the approved path', () => {
  const report = classifyOperatorTransactions(
    [
      executorPayment('SPOOF_PAY', { calls: [{ ...PAY, package: OTHER }, ANCHOR] }),
      executorPayment('SPOOF_ANCHOR', { calls: [PAY, { ...ANCHOR, package: OTHER }] }),
      executorPayment('NO_ANCHOR', { calls: [PAY] }),
      executorPayment('WRONG_MODULE', { calls: [{ ...PAY, module: 'spend_policy' }, ANCHOR] }),
    ],
    policy,
  );
  assert.deepEqual(report.flagged.map((f) => [f.digest, f.reason]), [
    ['SPOOF_PAY', 'not_approved_path'],
    ['SPOOF_ANCHOR', 'not_approved_path'],
    ['NO_ANCHOR', 'not_approved_path'],
    ['WRONG_MODULE', 'not_approved_path'],
  ]);
});

test('an operator that pays from its own balance on the v2 path is flagged', () => {
  const report = classifyOperatorTransactions([executorPayment('OWN', { operatorPays: 1_002_000_000n })], policy);
  assert.deepEqual(report.flagged.map((f) => [f.digest, f.reason]), [['OWN', 'operator_paid_from_own_balance']]);
  assert.equal(report.flagged[0].operatorOutflow[0].amount, '1002000000');
});

test('confirm_with_approval, which v2 core does not have, approves nothing', () => {
  const legacy = {
    digest: 'LEGACY',
    moveCalls: [{ package: CORE, module: 'payment_intent', function: 'confirm_with_approval' }],
    gasMist: 1_000_000n,
    balanceChanges: [
      { owner: OPERATOR, coinType: SUI, amount: -501_000_000n },
      { owner: SUPPLIER, coinType: SUI, amount: 500_000_000n },
    ],
  };
  assert.deepEqual(classifyOperatorTransactions([legacy], policy).flagged.map((f) => f.reason), ['not_approved_path']);
});

test('the audit anchor alone is gas, not an outflow', () => {
  const anchorOnly = {
    digest: 'ANCHOR_ONLY',
    moveCalls: [{ package: CORE, module: 'audit_anchor', function: 'anchor_audit_hash' }],
    gasMist: 1_500_000n,
    balanceChanges: [{ owner: OPERATOR, coinType: SUI, amount: -1_500_000n }],
  };
  assert.deepEqual(classifyOperatorTransactions([anchorOnly], policy).notOutflows, ['ANCHOR_ONLY']);
});

// ─── The monitor's inputs ──────────────────────────────────────────────────

async function withEnv(patch, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(patch)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('the monitor reads the spend package, the fee recipient and the registry, and approves a v2 payment', async () => {
  const { runOperatorOutflowMonitor } = await import('../lib/server/operator-outflow-monitor.ts');
  const alerts = [];
  const asked = [];
  const result = await withEnv(
    { OPERATOR_SUI_ADDRESS: OPERATOR, SPLASH_CORE_PACKAGE_ID: CORE, SPLASH_SPEND_PACKAGE_ID: SPEND },
    () =>
      runOperatorOutflowMonitor({
        readTransactions: async () => [executorPayment('V2', { to: PARTNER }), executorPayment('V2_BAD', { to: STRANGER })],
        readAllowlist: async () => [SUPPLIER],
        readFeeRecipient: async () => FEE_RECIPIENT,
        readRegistered: async (addresses) => {
          asked.push(...addresses);
          return new Set(addresses.filter((a) => a === PARTNER));
        },
        alert: async (a) => {
          alerts.push(a);
        },
      }),
  );
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(result.report.approved, ['V2']);
  assert.deepEqual(result.report.flagged.map((f) => f.digest), ['V2_BAD']);
  assert.deepEqual(alerts.map((a) => a.digest), ['V2_BAD']);
  assert.ok(asked.includes(PARTNER) && asked.includes(STRANGER), 'only addresses the allowlist does not cover are looked up');
  assert.equal(asked.includes(SUPPLIER), false);
});

test('a monitor that cannot read the fee recipient or the registry fails closed', async () => {
  const { runOperatorOutflowMonitor } = await import('../lib/server/operator-outflow-monitor.ts');
  const base = {
    readTransactions: async () => [executorPayment('V2')],
    readAllowlist: async () => [SUPPLIER],
    alert: async () => {},
  };
  await withEnv({ OPERATOR_SUI_ADDRESS: OPERATOR, SPLASH_CORE_PACKAGE_ID: CORE, SPLASH_SPEND_PACKAGE_ID: SPEND }, async () => {
    const noFee = await runOperatorOutflowMonitor({ ...base, readFeeRecipient: async () => { throw new Error('indexer down'); }, readRegistered: async () => new Set() });
    assert.equal(noFee.ok, false);
    assert.match(noFee.reason, /indexer down/);
    const noRegistry = await runOperatorOutflowMonitor({ ...base, readFeeRecipient: async () => FEE_RECIPIENT, readRegistered: async () => { throw new Error('registry unreadable'); } });
    assert.equal(noRegistry.ok, false);
    assert.match(noRegistry.reason, /registry unreadable/);
  });
});

// ─── The registry reader ───────────────────────────────────────────────────

test('the registry reader finds partner deposit addresses and business wallets, and refuses a foreign object', async () => {
  const { graphqlRegistryReader } = await import('../lib/server/address-registry-reader.ts');
  const REGISTRY = '0x' + 'ab'.repeat(32);
  const PARTNER_TABLE = '0x' + '11'.repeat(32);
  const WALLET_TABLE = '0x' + '22'.repeat(32);
  const BUSINESS = '0x' + '33'.repeat(32);
  const b64 = (addr) => Buffer.from(addr.slice(2), 'hex').toString('base64');
  const members = { [PARTNER_TABLE]: new Set([b64(PARTNER)]), [WALLET_TABLE]: new Set([b64(BUSINESS)]) };
  const registry = (repr) => ({
    data: { object: { asMoveObject: { contents: { type: { repr }, json: { partner_addresses: { id: PARTNER_TABLE }, business_wallets: { id: WALLET_TABLE } } } } } },
  });
  const fetcherFor = (repr) => async (_url, init) => {
    const { variables } = JSON.parse(init.body);
    const body = variables.id
      ? registry(repr)
      : { data: { table: { dynamicField: members[variables.table]?.has(variables.name) ? { __typename: 'DynamicField' } : null } } };
    return { ok: true, status: 200, json: async () => body };
  };
  const read = graphqlRegistryReader(REGISTRY, fetcherFor(`${CORE}::address_registry::Registry`), 'https://graphql.example/graphql');
  assert.deepEqual([...(await read([PARTNER, BUSINESS, STRANGER]))].sort(), [PARTNER, BUSINESS].sort());
  assert.deepEqual([...(await read([]))], []);
  const foreign = graphqlRegistryReader(REGISTRY, fetcherFor(`${OTHER}::fake::Registry`), 'https://graphql.example/graphql');
  await assert.rejects(foreign([PARTNER]), /not an address_registry::Registry/);
});
