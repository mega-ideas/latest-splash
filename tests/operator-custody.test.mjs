import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { EnvValidationError, parseEnv } from '../lib/env.ts';
import { getOperatorSigner } from '../lib/server/operator-signer.ts';
import { assertOperatorCanPay, OperatorTopUpNeededError } from '../lib/server/operator-balance.ts';
import { classifyOperatorTransactions } from '../lib/server/operator-outflows.ts';

/* WS4 — operator custody, the code half.

   Nothing here reaches AWS or a fullnode. The KMS signer is built by an
   injected factory, the balance by an injected reader, and the monitor's
   classifier is a pure function over transactions shaped like the ones the
   cron reads. */

const OBJ = '0x' + 'ab'.repeat(32);
const KEY = 'suiprivkey1' + 'q'.repeat(58);
const KMS_KEY = 'arn:aws:kms:ap-southeast-1:111122223333:key/0b5e7f8a-1c2d-4e3f-9a0b-1c2d3e4f5a6b';

const PROD_OK = {
  NODE_ENV: 'production',
  CUSTOMER_SESSION_SECRET: 's'.repeat(32),
  ADMIN_SESSION_SECRET: 'a'.repeat(32),
  CRON_SECRET: 'c'.repeat(32),
  DATABASE_URL: 'postgresql://user:pw@db.example/splash?sslmode=require',
  SPLASH_PACKAGE_ID: OBJ,
  NEXT_PUBLIC_APP_URL: 'https://v1.splashz.xyz',
  USDC_TYPE: `${OBJ}::usdc::USDC`,
  ADMIN_PASSWORD: 'not-the-demo-value-either',
  USE_MOCK_APIS: 'true',
  NEXT_PUBLIC_DEMO_MODE: 'true',
  SUI_SETTLEMENT_MODE: 'simulate',
  EMAIL_TRANSPORT: 'resend',
  EMAIL_API_KEY: 're_test_key',
  EMAIL_FROM: 'no-reply@splash.example',
};
const LIVE_SETTLEMENT = { SUI_SETTLEMENT_MODE: 'live', OPERATOR_SUI_ADDRESS: OBJ, SPLASH_TREASURY_ID: OBJ };
const KMS = { OPERATOR_KMS_KEY_ID: KMS_KEY, AWS_REGION: 'ap-southeast-1', OPERATOR_HOT_BALANCE_CEILING_MICRO: '5000000000' };

const keysOf = (raw) => {
  try {
    parseEnv(raw);
    return [];
  } catch (e) {
    assert.ok(e instanceof EnvValidationError, e?.message);
    return e.issues.map((i) => i.key);
  }
};

// ─── 1. The signer: production refuses a raw operator key ──────────────────

test('config: production refuses a raw operator key, even alongside a KMS key', () => {
  const raw = keysOf({ ...PROD_OK, ...LIVE_SETTLEMENT, OPERATOR_SUI_PRIVATE_KEY: KEY });
  assert.ok(raw.includes('OPERATOR_SUI_PRIVATE_KEY'), `the raw key is named; got ${raw.join(', ')}`);

  // A KMS key next to the raw one does not make the raw one acceptable: a key
  // in the environment is a key in the process, whichever signer is used.
  const both = keysOf({ ...PROD_OK, ...LIVE_SETTLEMENT, ...KMS, OPERATOR_SUI_PRIVATE_KEY: KEY });
  assert.deepEqual(both, ['OPERATOR_SUI_PRIVATE_KEY']);

  // The sponsor key was a second spelling of the same fallback.
  const sponsor = keysOf({ ...PROD_OK, ...LIVE_SETTLEMENT, ...KMS, SUI_SPONSOR_PRIVATE_KEY: KEY });
  assert.deepEqual(sponsor, ['SUI_SPONSOR_PRIVATE_KEY']);

  // Refused in simulate mode too: an unused raw key is still a raw key.
  assert.ok(keysOf({ ...PROD_OK, OPERATOR_SUI_PRIVATE_KEY: KEY }).includes('OPERATOR_SUI_PRIVATE_KEY'));
});

test('config: live settlement in production requires the KMS key, its region, and the hot-balance ceiling', () => {
  const keys = keysOf({ ...PROD_OK, ...LIVE_SETTLEMENT });
  for (const k of ['OPERATOR_KMS_KEY_ID', 'AWS_REGION', 'OPERATOR_HOT_BALANCE_CEILING_MICRO']) {
    assert.ok(keys.includes(k), `${k} is required; got ${keys.join(', ')}`);
  }
  assert.ok(!keys.includes('OPERATOR_SUI_PRIVATE_KEY'), 'the raw key is no longer what production asks for');
  assert.deepEqual(keysOf({ ...PROD_OK, ...LIVE_SETTLEMENT, ...KMS }), []);
});

test('config: static AWS keys are an explicit choice, and then both halves are required', () => {
  // Role credentials are the default: nothing static is demanded.
  assert.deepEqual(keysOf({ ...PROD_OK, ...LIVE_SETTLEMENT, ...KMS }), []);
  const staticKeys = keysOf({ ...PROD_OK, ...LIVE_SETTLEMENT, ...KMS, OPERATOR_KMS_CREDENTIALS: 'static' });
  assert.deepEqual(staticKeys.sort(), ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']);
});

test('config: development still signs with a raw key, so testnet smoke tests keep working', () => {
  const env = parseEnv({ NODE_ENV: 'development', OPERATOR_SUI_PRIVATE_KEY: KEY });
  assert.equal(env.OPERATOR_SUI_PRIVATE_KEY, KEY);
  assert.equal(env.OPERATOR_HOT_BALANCE_CEILING_MICRO, undefined);
});

test('signer: with OPERATOR_KMS_KEY_ID set, the KMS signer is used and the raw key is never decoded', async () => {
  const fakeSigner = { toSuiAddress: () => OBJ, kind: 'kms' };
  const calls = [];
  const signer = await getOperatorSigner({
    env: { NODE_ENV: 'development', ...KMS, OPERATOR_SUI_PRIVATE_KEY: 'not-a-key-at-all' },
    expectedAddress: OBJ,
    kmsFactory: async (keyId, options) => {
      calls.push({ keyId, region: options.region, hasProvider: typeof options.credentials === 'function' });
      return fakeSigner;
    },
  });
  assert.equal(signer, fakeSigner);
  // An undecodable raw key would have thrown if anything had read it.
  assert.deepEqual(calls, [{ keyId: KMS_KEY, region: 'ap-southeast-1', hasProvider: true }]);
});

test('signer: production with no KMS key refuses the raw key at runtime as well as at boot', async () => {
  await assert.rejects(
    () => getOperatorSigner({ env: { NODE_ENV: 'production', OPERATOR_SUI_PRIVATE_KEY: KEY }, expectedAddress: '' }),
    /raw operator key/i,
  );
  assert.equal(await getOperatorSigner({ env: { NODE_ENV: 'production' }, expectedAddress: '' }), null);
});

test('signer: a KMS key whose address is not OPERATOR_SUI_ADDRESS is refused', async () => {
  await assert.rejects(
    () => getOperatorSigner({
      env: { NODE_ENV: 'production', ...KMS },
      expectedAddress: '0x' + 'cd'.repeat(32),
      kmsFactory: async () => ({ toSuiAddress: () => OBJ }),
    }),
    /does not match OPERATOR_SUI_ADDRESS/,
  );
});

// ─── 2. The hot-balance ceiling ────────────────────────────────────────────

const SUI = '0x2::sui::SUI';
const USDC = `${OBJ}::usdc::USDC`;
const balances = (map) => async (_owner, coinType) => map[coinType] ?? 0n;

test('settlement refuses when the hot balance is below the payout, and pays nothing', async () => {
  const alerts = [];
  await assert.rejects(
    () => assertOperatorCanPay(2_000_000n, {
      coinType: USDC,
      owner: OBJ,
      readBalance: balances({ [USDC]: 1_999_999n }),
      ceilingMicro: 5_000_000_000n,
      ceilingCoinType: USDC,
      alert: async (a) => { alerts.push(a); },
    }),
    (error) => {
      assert.ok(error instanceof OperatorTopUpNeededError);
      assert.equal(error.state, 'top-up-needed');
      assert.equal(error.code, 'operator_top_up_needed');
      assert.equal(error.balance, 1_999_999n);
      assert.equal(error.required, 2_000_000n);
      assert.equal(error.shortfall, 1n);
      assert.match(error.message, /top-up needed/i);
      return true;
    },
  );
  assert.deepEqual(alerts.map((a) => a.kind), ['operator_top_up_needed']);
});

test('settlement proceeds when the balance covers the payout exactly', async () => {
  const result = await assertOperatorCanPay(2_000_000n, {
    coinType: USDC, owner: OBJ, readBalance: balances({ [USDC]: 2_000_000n }), ceilingMicro: null, ceilingCoinType: USDC, alert: async () => {},
  });
  assert.equal(result.balance, 2_000_000n);
  assert.equal(result.aboveCeiling, false);
});

test('a hot balance above the ceiling alerts with the excess to sweep, and does not block the payout', async () => {
  const alerts = [];
  const result = await assertOperatorCanPay(1_000_000_000n, {
    coinType: SUI,
    owner: OBJ,
    readBalance: balances({ [SUI]: 9_000_000_000n, [USDC]: 7_500_000_000n }),
    ceilingMicro: 5_000_000_000n,
    ceilingCoinType: USDC,
    alert: async (a) => { alerts.push(a); },
  });
  assert.equal(result.aboveCeiling, true);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, 'operator_above_ceiling');
  assert.equal(alerts[0].excessMinor, '2500000000');
});

test('the payout check is integer arithmetic: a non-bigint amount is a programming error', async () => {
  await assert.rejects(() => assertOperatorCanPay(1.5, { coinType: USDC, owner: OBJ, readBalance: balances({}), ceilingMicro: null, alert: async () => {} }), TypeError);
});

// ─── 3. The outflow monitor ────────────────────────────────────────────────

const OPERATOR = '0x' + '0a'.repeat(32);
const APPROVED = '0x' + '1b'.repeat(32);
const STRANGER = '0x' + 'ee'.repeat(32);
const CORE = '0x' + 'c0'.repeat(32);
const SPEND = '0x' + 'd0'.repeat(32);
const WALLET = '0x' + 'b0'.repeat(32);

const policy = {
  operator: OPERATOR,
  corePackageIds: [CORE],
  spendPackageIds: [SPEND],
  approvedRecipients: new Set([APPROVED]),
  registeredRecipients: new Set(),
  feeRecipient: null,
};
// The v2 executor path: splash_spend::pay_intent, its receipt anchored in core.
const V2_CALLS = [
  { package: SPEND, module: 'splash_spend', function: 'pay_intent' },
  { package: CORE, module: 'audit_anchor', function: 'anchor' },
];
const gasOnly = (digest) => ({
  digest,
  moveCalls: [{ package: CORE, module: 'audit_anchor', function: 'anchor_audit_hash' }],
  gasMist: 1_500_000n,
  balanceChanges: [{ owner: OPERATOR, coinType: SUI, amount: -1_500_000n }],
});

test('the monitor flags a synthetic unapproved outflow', () => {
  const drained = {
    digest: 'DRAIN',
    moveCalls: [],
    gasMist: 1_000_000n,
    balanceChanges: [
      { owner: OPERATOR, coinType: USDC, amount: -900_000_000n },
      { owner: STRANGER, coinType: USDC, amount: 900_000_000n },
      { owner: OPERATOR, coinType: SUI, amount: -1_000_000n },
    ],
  };
  const report = classifyOperatorTransactions([drained, gasOnly('ANCHOR')], policy);
  assert.equal(report.flagged.length, 1);
  assert.equal(report.flagged[0].digest, 'DRAIN');
  assert.equal(report.flagged[0].reason, 'not_approved_path');
  assert.deepEqual(report.flagged[0].recipients, [{ address: STRANGER, coinType: USDC, amount: '900000000' }]);
  assert.deepEqual(report.notOutflows, ['ANCHOR'], 'gas alone is not an outflow');
});

test('a v2 executor payment to an approved recipient passes; to anyone else it is flagged', () => {
  const pay = (digest, to) => ({
    digest,
    moveCalls: V2_CALLS,
    gasMist: 1_000_000n,
    balanceChanges: [
      { owner: WALLET, coinType: USDC, amount: -500_000_000n },
      { owner: to, coinType: USDC, amount: 500_000_000n },
      { owner: OPERATOR, coinType: SUI, amount: -1_000_000n },
    ],
  });
  const report = classifyOperatorTransactions([pay('GOOD', APPROVED), pay('BAD', STRANGER)], policy);
  assert.deepEqual(report.approved, ['GOOD']);
  assert.deepEqual(report.flagged.map((f) => [f.digest, f.reason]), [['BAD', 'recipient_not_approved']]);
});

test('pay_intent from a package that is not ours is flagged', () => {
  const spoof = {
    digest: 'SPOOF',
    moveCalls: [{ ...V2_CALLS[0], package: '0x' + '99'.repeat(32) }, V2_CALLS[1]],
    gasMist: 0n,
    balanceChanges: [
      { owner: OPERATOR, coinType: USDC, amount: -10n },
      { owner: APPROVED, coinType: USDC, amount: 10n },
    ],
  };
  assert.equal(classifyOperatorTransactions([spoof], policy).flagged[0].reason, 'not_approved_path');
});

test('value that leaves for an object, not an address, is flagged', () => {
  // The operator's own SUI into an object: not the approved path at all.
  const fromOperator = {
    digest: 'OBJ',
    moveCalls: [{ package: CORE, module: 'payment_intent', function: 'confirm_with_approval' }],
    gasMist: 1_000_000n,
    balanceChanges: [{ owner: OPERATOR, coinType: SUI, amount: -301_000_000n }],
  };
  const report = classifyOperatorTransactions([fromOperator], policy);
  assert.equal(report.flagged[0].reason, 'not_approved_path');
  assert.equal(report.flagged[0].operatorOutflow[0].amount, '300000000');
  // The wallet's USDC into an object on the v2 path: no address received it.
  const fromWallet = {
    digest: 'OBJ_V2',
    moveCalls: V2_CALLS,
    gasMist: 1_000_000n,
    balanceChanges: [
      { owner: WALLET, coinType: USDC, amount: -300_000_000n },
      { owner: OPERATOR, coinType: SUI, amount: -1_000_000n },
    ],
  };
  assert.equal(classifyOperatorTransactions([fromWallet], policy).flagged[0].reason, 'outflow_without_recipient');
});

// ─── 5. D-0004: the operator key never enters 0xWal or an agent tool ───────

test('D-0004: no agent, 0xWal or copilot module reaches the operator signer', () => {
  const roots = ['lib/agent', 'lib/oxwal', 'lib/ai', 'lib/chain', 'app/api/oxwal', 'app/api/copilot', 'app/api/agent'];
  const files = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx|mjs)$/.test(name)) files.push(full);
    }
  };
  roots.forEach(walk);
  assert.ok(files.length > 0, 'the agent code was found');
  const forbidden = /operator-signer|sui-settlement|OPERATOR_SUI_PRIVATE_KEY|OPERATOR_KMS_KEY_ID|SUI_SPONSOR_PRIVATE_KEY|AWS_SECRET_ACCESS_KEY/;
  const offenders = files.filter((f) => forbidden.test(readFileSync(f, 'utf8')));
  assert.deepEqual(offenders, []);
});
