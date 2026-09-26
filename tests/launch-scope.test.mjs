import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { EnvValidationError, parseEnv } from '../lib/env.ts';
import { kindInScope, laneInScope, LAUNCH_SCOPE_CODE, LAUNCH_SCOPE_REASON, parseLaunchScope } from '../lib/launch-scope-rules.ts';
import { launchScope, refuseOutsideLaunchScope } from '../lib/server/launch-scope.ts';
import { checkLaunchScope } from '../lib/server/go-live-checks.ts';

// LAUNCH_SCOPE=stablecoin: USDC on Sui only (lib/launch-scope-rules.ts).

const withScope = async (value, fn) => {
  const previous = process.env.LAUNCH_SCOPE;
  if (value === undefined) delete process.env.LAUNCH_SCOPE;
  else process.env.LAUNCH_SCOPE = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.LAUNCH_SCOPE;
    else process.env.LAUNCH_SCOPE = previous;
  }
};

// ─── The rules ──────────────────────────────────────────────────────────────

test('the stablecoin scope opens the USDC lane and x402, and nothing else', () => {
  for (const lane of ['FIAT_IN_USD', 'FIAT_OUT_LOCAL', 'TREASURY']) {
    assert.equal(laneInScope(lane, 'stablecoin'), false, lane);
    assert.equal(laneInScope(lane, 'full'), true, lane);
  }
  for (const lane of ['STABLECOIN_WALLET', 'X402']) assert.equal(laneInScope(lane, 'stablecoin'), true, lane);

  for (const kind of ['PAYMENT', 'INTERNAL_TRANSFER', 'FX_CONVERT', 'TREASURY_ALLOCATE', 'TREASURY_REDEEM', 'BATCH_PAYOUT', 'NETTING_SETTLE']) {
    assert.equal(kindInScope(kind, 'stablecoin'), false, kind);
    assert.equal(kindInScope(kind, 'full'), true, kind);
  }
  assert.equal(kindInScope('X402_PAYMENT', 'stablecoin'), true, 'the business wallet settles x402');
  assert.equal(kindInScope('SOMETHING_NEW', 'stablecoin'), false, 'an unknown kind is refused');
});

test('only "stablecoin" narrows the scope; anything else is full', () => {
  assert.equal(parseLaunchScope('stablecoin'), 'stablecoin');
  assert.equal(parseLaunchScope(' Stablecoin '), 'stablecoin');
  for (const raw of [undefined, null, '', 'full', 'usdc']) assert.equal(parseLaunchScope(raw), 'full');
});

test('the guard answers 403 not_in_launch_scope in the stablecoin scope, and nothing in the full one', async () => {
  await withScope(undefined, () => {
    assert.equal(launchScope(), 'full');
    assert.equal(refuseOutsideLaunchScope(), null);
  });
  await withScope('stablecoin', async () => {
    assert.equal(launchScope(), 'stablecoin');
    const res = refuseOutsideLaunchScope();
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = await res.json();
    assert.deepEqual(body, { error: LAUNCH_SCOPE_REASON, code: LAUNCH_SCOPE_CODE, scope: 'stablecoin' });
  });
});

test('the refusal says what is open and what to do', () => {
  assert.match(LAUNCH_SCOPE_REASON, /USDC on Sui/);
  assert.match(LAUNCH_SCOPE_REASON, /Nothing was sent or recorded/);
  assert.match(LAUNCH_SCOPE_REASON, /Send USDC/);
});

// ─── Boot ───────────────────────────────────────────────────────────────────

const OBJ = '0x' + 'ab'.repeat(32);
const KEY = 'suiprivkey1' + 'q'.repeat(58);
const LIVE = {
  NODE_ENV: 'production',
  CUSTOMER_SESSION_SECRET: 's'.repeat(32),
  ADMIN_SESSION_SECRET: 'a'.repeat(32),
  CRON_SECRET: 'c'.repeat(32),
  DATABASE_URL: 'postgresql://user:pw@db.example/splash?sslmode=verify-full',
  SPLASH_PACKAGE_ID: OBJ,
  NEXT_PUBLIC_APP_URL: 'https://v1.splashz.xyz',
  USDC_TYPE: `${OBJ}::usdc::USDC`,
  ADMIN_PASSWORD: 'not-the-demo-value-either',
  EMAIL_TRANSPORT: 'resend',
  EMAIL_API_KEY: 're_test_key',
  EMAIL_FROM: 'no-reply@splash.example',
  // Real money posture: mocks off, demo off, settlement 'auto'.
  USE_MOCK_APIS: 'false',
  NEXT_PUBLIC_DEMO_MODE: 'false',
};
// The settlement signer: the stablecoin scope still needs it to verify businesses.
const SIGNER = { OPERATOR_SUI_PRIVATE_KEY: KEY, OPERATOR_SUI_ADDRESS: OBJ };

const keysOf = (raw) => {
  try {
    parseEnv(raw);
    return [];
  } catch (e) {
    assert.ok(e instanceof EnvValidationError, e?.message);
    return e.issues.map((i) => i.key);
  }
};

test('boot: the full scope with mocks off still demands every vendor and the settlement signer', () => {
  const keys = keysOf(LIVE);
  for (const k of ['PDAX_API_KEY', 'WALRUS_PUBLISHER_URL', 'WALRUS_AGGREGATOR_URL', 'STRIPE_SECRET_KEY', 'AIRWALLEX_API_KEY', 'OPERATOR_SUI_PRIVATE_KEY', 'SPLASH_TREASURY_ID']) {
    assert.ok(keys.includes(k), `${k} is named in the full scope`);
  }
});

test('boot: the stablecoin scope starts with mocks off and none of the keys only fiat and settlement use', () => {
  assert.deepEqual(keysOf({ ...LIVE, ...SIGNER, LAUNCH_SCOPE: 'stablecoin' }), []);
  // The signer stays required: approving a business's verification records it on Sui.
  assert.deepEqual(keysOf({ ...LIVE, LAUNCH_SCOPE: 'stablecoin' }).sort(), ['OPERATOR_SUI_ADDRESS', 'OPERATOR_SUI_PRIVATE_KEY']);
  const env = parseEnv({ ...LIVE, ...SIGNER, LAUNCH_SCOPE: 'stablecoin' });
  assert.equal(env.LAUNCH_SCOPE, 'stablecoin');
});

test('boot: the stablecoin scope refuses anything that would fake or open what it leaves out', () => {
  const scoped = { ...LIVE, ...SIGNER, LAUNCH_SCOPE: 'stablecoin' };
  assert.ok(keysOf({ ...scoped, USE_MOCK_APIS: 'true' }).includes('USE_MOCK_APIS'));
  assert.ok(keysOf({ ...scoped, NEXT_PUBLIC_DEMO_MODE: 'true' }).includes('NEXT_PUBLIC_DEMO_MODE'));
  assert.ok(keysOf({ ...scoped, CARD_FUNDING_ENABLED: 'true' }).includes('CARD_FUNDING_ENABLED'));
  assert.ok(keysOf({ ...scoped, TREASURY_EXECUTION_ENABLED: 'true' }).includes('TREASURY_EXECUTION_ENABLED'));
  assert.ok(keysOf({ ...scoped, SUI_SETTLEMENT_MODE: 'live' }).includes('SUI_SETTLEMENT_MODE'));
  // The KYB gate works in the scope, with its Sumsub keys.
  assert.deepEqual(keysOf({ ...scoped, FEATURE_KYB_GATE: 'true', SUMSUB_APP_TOKEN: 't', SUMSUB_SECRET_KEY: 'k' }), []);
  // The rules every deployment needs still hold.
  assert.ok(keysOf({ ...scoped, EMAIL_TRANSPORT: 'console' }).includes('EMAIL_TRANSPORT'));
  assert.ok(keysOf({ ...scoped, USDC_TYPE: '0x2::sui::SUI' }).includes('USDC_TYPE'));
});

test('boot: an unknown scope is refused by name', () => {
  assert.ok(keysOf({ ...LIVE, LAUNCH_SCOPE: 'usdc' }).includes('LAUNCH_SCOPE'));
});

// ─── Health ─────────────────────────────────────────────────────────────────

test('the health report names the scope and never fails on it', () => {
  const scoped = checkLaunchScope({ LAUNCH_SCOPE: 'stablecoin' });
  assert.equal(scoped.status, 'ok');
  assert.match(scoped.detail, /USDC on Sui only/);
  assert.match(scoped.detail, /not_in_launch_scope/);
  const full = checkLaunchScope({});
  assert.equal(full.status, 'ok');
  assert.match(full.detail, /^full/);
});

// ─── Zeke ───────────────────────────────────────────────────────────────────

test('Zeke: in the stablecoin scope it offers no fiat, batch or treasury drafting tool, and refuses one called anyway', async () => {
  const oxwal = await import('../lib/agent/oxwal.ts');
  const names = (defs) => defs.map((d) => d.name);
  await withScope(undefined, () => {
    const all = names(oxwal.anthropicToolDefinitions());
    for (const t of ['proposePayment', 'proposeBatchPayout', 'proposeTreasuryAllocation']) assert.ok(all.includes(t), t);
  });
  await withScope('stablecoin', async () => {
    const scoped = names(oxwal.anthropicToolDefinitions());
    for (const t of ['proposePayment', 'proposeInternalTransfer', 'proposeFxConvert', 'proposeTreasuryAllocation', 'proposeTreasuryRedeem', 'proposeNettingSettlement', 'proposeBatchPayout']) {
      assert.ok(!scoped.includes(t), `${t} is not offered`);
    }
    assert.ok(scoped.includes('prepareUsdcTransfer'), 'the USDC handoff stays');
    await assert.rejects(
      () => oxwal.executeOxwalTool('proposePayment', { orgId: 'acme', counterpartyId: 'cp_x', amountUsd: 100 }),
      (e) => e.name === 'ZekeLaneRefusal' && e.message.includes(LAUNCH_SCOPE_REASON),
    );
    // Called directly (the local planner does), the tool refuses before reading anything.
    await assert.rejects(
      () => oxwal.proposeBatchPayout({ orgId: 'acme', corridor: 'USD-USDC', payouts: [{ amountUsd: 5, currency: 'USDC' }] }),
      (e) => e.name === 'ZekeLaneRefusal',
    );
  });
});

test('Zeke: a request for fiat or a payout run is refused before the model, in the scope\'s words', async () => {
  const { runOxwalAgent } = await import('../lib/agent/oxwal.ts');
  const ask = async (message) => {
    let said = '';
    for await (const event of runOxwalAgent({ forceLocal: true, orgId: 'acme', message })) if (event.type === 'delta') said += event.text;
    return said;
  };
  await withScope('stablecoin', async () => {
    for (const message of ['pay Maria 50,000 PHP', 'run the payroll batch for October', 'allocate idle cash to treasury']) {
      const said = await ask(message);
      assert.match(said, /open for USDC on Sui only/, message);
    }
  });
});

// ─── Every fiat or settlement route carries the guard ───────────────────────

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const routeFiles = (dir) => readdirSync(dir).flatMap((name) => {
  const full = path.join(dir, name);
  return statSync(full).isDirectory() ? routeFiles(full) : name === 'route.ts' ? [full] : [];
});
const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/');

/** What moves, credits or settles fiat money, or runs Splash's own settlement. */
const MONEY = /\b(convertUsdToUsdc|executeComposedPayment|recordBatchSettlementOnSui|ingestStablecoinDeposit|confirmUsdProviderDeposit|createRateHold|refreshPegOnSui|buildDailyAuditBatch|settleDueWithdrawals|accrueDailyYield|createFundingSession|executeApprovedProposal|settleFullyApprovedProposal|proposeForApproval)\b/;

/** Routes that reach a money symbol but are closed another way, and why. */
const COVERED_ELSEWHERE = {
  'app/api/proposals/[id]/submit/route.ts': 'refuses out-of-scope kinds before any vote (kindInScope)',
  'app/api/approvals/code/route.ts': 'releases through approval-settle, whose checkReleaser refuses out-of-scope kinds',
  'app/api/webhooks/whatsapp/route.ts': 'records a vote only; nothing is released without a signed-in releaser',
};

test('every route that reaches fiat money or settlement refuses outside the launch scope', () => {
  const files = routeFiles(path.join(ROOT, 'app', 'api'));
  assert.ok(files.length > 50, `found ${files.length} routes`);
  const unguarded = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    if (!MONEY.test(source)) continue;
    const name = rel(file);
    if (source.includes('refuseOutsideLaunchScope(')) continue;
    if (COVERED_ELSEWHERE[name]) continue;
    unguarded.push(name);
  }
  assert.deepEqual(unguarded, [], 'add refuseOutsideLaunchScope() after authentication, or list the route with a reason');
  // The ones said to be covered really are.
  assert.match(readFileSync(path.join(ROOT, 'app/api/proposals/[id]/submit/route.ts'), 'utf8'), /kindInScope\(proposal\.kind, launchScope\(\)\)/);
  assert.match(readFileSync(path.join(ROOT, 'lib/server/approval-settle.ts'), 'utf8'), /kindInScope\(proposal\.kind, launchScope\(\)\)/);
  assert.match(readFileSync(path.join(ROOT, 'lib/server/approval-execution.ts'), 'utf8'), /kindInScope\(proposal\.kind, launchScope\(\)\)/);
});

test('the named fiat routes carry the guard', () => {
  for (const route of [
    'transfers/authorize', 'batches/authorize', 'treasury', 'funding/sessions', 'funding/sessions/[id]',
    'funding/deposits', 'funding/usd-deposits', 'rate-holds', 'pay/[slug]',
    'cron/accrue-yield', 'cron/settle-withdrawals', 'cron/update-peg', 'cron/audit-batch', 'recipients',
    'stablecoin/treasury-quote',
  ]) {
    const source = readFileSync(path.join(ROOT, 'app/api', route, 'route.ts'), 'utf8');
    assert.ok(source.includes('refuseOutsideLaunchScope('), route);
  }
  // The USDC lane itself never is.
  for (const route of ['stablecoin/quote', 'stablecoin/submit', 'x402/pay', 'pay/[slug]/usdc']) {
    const source = readFileSync(path.join(ROOT, 'app/api', route, 'route.ts'), 'utf8');
    assert.ok(!source.includes('refuseOutsideLaunchScope('), `${route} stays open`);
  }
});

test("pay links never show Splash's collection account in the stablecoin scope, custody or not", async () => {
  const { payLinkBankInstructions } = await import('../lib/server/pay-link.ts');
  const custody = { custodyPackageId: '0x' + '1'.repeat(64) };
  await withScope(undefined, () => assert.ok(payLinkBankInstructions(custody), 'full scope with custody shows it'));
  await withScope('stablecoin', () => assert.equal(payLinkBankInstructions(custody), null));
});

test('Zeke: the capabilities answer lists only what this launch prepares', async () => {
  const { runOxwalAgent } = await import('../lib/agent/oxwal.ts');
  const ask = async () => {
    let said = '';
    for await (const event of runOxwalAgent({ forceLocal: true, message: 'what can you do?' })) if (event.type === 'delta') said += event.text;
    return said;
  };
  await withScope(undefined, async () => assert.match(await ask(), /batch payouts/));
  await withScope('stablecoin', async () => {
    const said = await ask();
    assert.match(said, /USDC transfer/);
    assert.match(said, /do not draft fiat payouts/);
  });
});
