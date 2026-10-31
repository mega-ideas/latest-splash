import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { migratedDb } from './helpers/store-db.mjs';

/* v2 brief 5.7, the independent review of Treasury in the business wallet.

   What the review found, and what this file pins:

     1. An order bound no wallet. It recorded no source or recipient address,
        the swap route was given none, and nothing checked the balance: a
        maker could ask for 999,999,999,999 USDC. Now the server resolves the
        business wallet (never the client), records it as both source and
        recipient (a CHECK keeps them equal), records both coin types, and
        refuses an amount above what the wallet holds on Sui.
     2. The overview read any address the caller named and returned the raw
        chain error. Now it reads the org's own wallet and says a fixed thing.
     3. The page offered "Send to owners" to roles the server refuses, and the
        refusal called every one of them a viewer.
     4. A fund-manager account reference could be squatted: the first business
        to type it won, and the holding was read by the reference alone. Now
        the fund manager confirms the reference belongs to the business (by
        its registration number) before anything is stored, the holding read
        names the business, and support can release a link.
     5. Eligibility answers were overwritten, so a "not eligible" declaration
        left no trace. Now every assessment is kept, and the current row
        points at the latest.
     6. Zeke said the owners could sign a swap no server sends to signers.
     7. The custodial Smart Treasury ledger and Zeke's allocation tools came
        back to life with the custody phase on, against D9.
     8. Two slippage defaults, and no ceiling.
     9. A double-click could answer 200 for an order still being prepared,
        which was then deleted.
    10. Copy outside the rules, and a 24px Max button. */

const usdc = (s) => {
  const [w, f = ''] = s.split('.');
  return BigInt(w) * 1_000_000n + BigInt((f + '000000').slice(0, 6));
};
const NAV = { status: 'LIVE', priceMicros: 1_100_000n, asOf: '2026-10-25T00:00:00Z', source: 'test' };
const OWNER = { orgId: 'acme', userId: 'u_owner', role: 'OWNER' };
const MAKER = { orgId: 'acme', userId: 'u_maker', role: 'MAKER' };
const AUDITOR = { orgId: 'acme', userId: 'u_aud', role: 'AUDITOR' };
const DEVELOPER = { orgId: 'acme', userId: 'u_dev', role: 'DEVELOPER' };
const VIEWER = { orgId: 'acme', userId: 'u_viewer', role: 'VIEWER' };
const NW_OWNER = { orgId: 'northwind', userId: 'u_nw', role: 'OWNER' };
const INTENT = '1b4e28ba-2fa1-11d2-883f-0016d3cca427';
const INTENT_2 = '2c5f39cb-3fb2-42e3-994a-1127e4ddb538';
const WALLET = '0x' + 'ab'.repeat(32);
const ATTACKER = '0x' + 'ee'.repeat(32);
const ALL_NO = { malaysia: true, regulated_institution: false, net_assets: false, wholly_owned: false, declaration: true };
const ELIGIBLE = { ...ALL_NO, net_assets: true };

async function source(relative) {
  return readFile(new URL(`../${relative}`, import.meta.url), 'utf8');
}

/** A deep market, an active Malaysian business, and a wallet holding `held` of each coin. */
async function deps(over = {}) {
  const { USDY_COIN_TYPE_SUI } = await import('../lib/payments/treasury-usdy.ts');
  const { SUI_USDC_COIN_TYPE, STABLECOIN_NETWORK } = await import('../lib/payments/stablecoin-lane.ts');
  const held = over.held ?? { [SUI_USDC_COIN_TYPE[STABLECOIN_NETWORK]]: usdc('1000'), [USDY_COIN_TYPE_SUI]: usdc('500') };
  const seen = { balances: [], prepared: [] };
  return {
    seen,
    deps: {
      readNav: async () => NAV,
      apyPct: () => 4,
      readOrg: async () => ({ kyb: 'ACTIVE', country: 'MY' }),
      marketIn: async (amount) => ({ available: true, usdcInMinor: amount, usdyOutMinor: (amount * 1_000_000n) / NAV.priceMicros, providers: ['CETUS'], asOf: NAV.asOf, source: 'cetus-aggregator' }),
      marketOut: async (amount) => ({ available: true, usdyInMinor: amount, usdcOutMinor: (amount * NAV.priceMicros) / 1_000_000n, providers: ['CETUS'], asOf: NAV.asOf, source: 'cetus-aggregator' }),
      // Confirmed: a preview (SANDBOX) quote is never an order (the second 5.7 review).
      issuerEligibilityConfirmed: true,
      slippageBps: 30,
      resolveWallet: async () => ({ ok: true, address: WALLET }),
      readWalletBalance: async (address, coinType) => {
        seen.balances.push([address, coinType]);
        return held[coinType] ?? 0n;
      },
      resolveRoute: () => ({
        ok: true,
        route: { kind: 'sandbox', prepare: async (order) => { seen.prepared.push(order); return { providerRef: `sandbox_${order.id}` }; } },
      }),
      ...over,
    },
  };
}

async function count(client, table = 'treasury_wallet_orders') {
  return (await client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
}

// ─── 1. An order is bound to the business wallet ─────────────────────────

test('an order above what the wallet holds is refused, and nothing is recorded', async () => {
  const { client, db } = await migratedDb();
  const { handleTreasuryOrder } = await import('../lib/server/treasury-wallet.ts');
  const { deps: d, seen } = await deps();
  const huge = await handleTreasuryOrder(db, MAKER, { intentId: INTENT, direction: 'swap', amount: '999999999999', minOutMinor: '1' }, d);
  assert.equal(huge.status, 409, JSON.stringify(huge.body));
  assert.equal(huge.body.code, 'over_balance');
  assert.equal(await count(client), 0);
  assert.equal(seen.prepared.length, 0, 'the signers were not asked');

  // A redemption is checked against the USDY the wallet holds, not its USDC.
  const { USDY_COIN_TYPE_SUI } = await import('../lib/payments/treasury-usdy.ts');
  const redeem = await handleTreasuryOrder(db, OWNER, { intentId: INTENT_2, direction: 'redeem', amount: '600', minOutMinor: '1' }, d);
  assert.equal(redeem.status, 409);
  assert.equal(redeem.body.code, 'over_balance');
  assert.deepEqual(seen.balances.at(-1), [WALLET, USDY_COIN_TYPE_SUI]);
  await client.close();
});

test('a business with no wallet, or a wallet that cannot be read, places no order', async () => {
  const { client, db } = await migratedDb();
  const { handleTreasuryOrder } = await import('../lib/server/treasury-wallet.ts');
  const body = { intentId: INTENT, direction: 'swap', amount: '10', minOutMinor: '1' };
  const none = await deps({ resolveWallet: async () => ({ ok: false, status: 409, code: 'no_wallet', error: 'Your business has no Splash Wallet yet.' }) });
  const refused = await handleTreasuryOrder(db, OWNER, body, none.deps);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'no_wallet');
  const unreadable = await deps({ readWalletBalance: async () => { throw new Error('fullnode said 0xdeadbeef'); } });
  const failed = await handleTreasuryOrder(db, OWNER, body, unreadable.deps);
  assert.equal(failed.status, 502);
  assert.doesNotMatch(JSON.stringify(failed.body), /fullnode|deadbeef/, 'no raw chain error reaches the browser');
  assert.equal(await count(client), 0);
  await client.close();
});

test('the order records the business wallet as both source and recipient, and both coin types, from the server', async () => {
  const { client, db } = await migratedDb();
  const { handleTreasuryOrder } = await import('../lib/server/treasury-wallet.ts');
  const { USDY_COIN_TYPE_SUI } = await import('../lib/payments/treasury-usdy.ts');
  const { SUI_USDC_COIN_TYPE, STABLECOIN_NETWORK } = await import('../lib/payments/stablecoin-lane.ts');
  const USDC_TYPE = SUI_USDC_COIN_TYPE[STABLECOIN_NETWORK];
  const { deps: d, seen } = await deps();
  // A client that names its own recipient or source is not listened to.
  const made = await handleTreasuryOrder(db, OWNER, {
    intentId: INTENT, direction: 'swap', amount: '100', minOutMinor: '1', recipient: ATTACKER, recipientAddress: ATTACKER, sourceAddress: ATTACKER,
  }, d);
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.order.sourceAddress, WALLET);
  assert.equal(made.body.order.recipientAddress, WALLET);
  assert.equal(made.body.order.inCoinType, USDC_TYPE);
  assert.equal(made.body.order.outCoinType, USDY_COIN_TYPE_SUI);
  // The swap route is given the wallet, not left to work it out.
  assert.equal(seen.prepared[0].sourceAddress, WALLET);
  assert.equal(seen.prepared[0].recipientAddress, WALLET);
  assert.equal(seen.prepared[0].inCoinType, USDC_TYPE);
  assert.equal(seen.prepared[0].outCoinType, USDY_COIN_TYPE_SUI);

  const redeem = await handleTreasuryOrder(db, OWNER, { intentId: INTENT_2, direction: 'redeem', amount: '50', minOutMinor: '1' }, d);
  assert.equal(redeem.body.order.inCoinType, USDY_COIN_TYPE_SUI);
  assert.equal(redeem.body.order.outCoinType, USDC_TYPE);

  const { rows } = await client.query('SELECT source_address, recipient_address FROM treasury_wallet_orders');
  for (const row of rows) assert.equal(row.source_address, row.recipient_address);
  // The database refuses an order whose output goes anywhere but its source.
  await assert.rejects(() => client.query(`UPDATE treasury_wallet_orders SET recipient_address = '${ATTACKER}'`));
  await assert.rejects(() => client.query(`UPDATE treasury_wallet_orders SET out_coin_type = in_coin_type`));
  await client.close();
});

test('the live wallet resolver reads the org\'s own BusinessAccount and never takes an address from the request', async () => {
  const text = await source('lib/server/treasury-business-wallet.ts');
  assert.match(text, /suiBusinessAccountId/);
  assert.match(text, /::business_account::BusinessAccount/);
  const deps = await source('lib/server/treasury-deps.ts');
  assert.match(deps, /resolveWallet: \(orgId\) => resolveTreasuryWallet\(orgId\)/);
  for (const route of ['app/api/treasury/wallet/route.ts', 'app/api/treasury/wallet/orders/route.ts']) {
    assert.doesNotMatch(await source(route), /searchParams\.get\('address'\)|body\.address|body\.recipient/, route);
  }
});

// ─── 2. The overview reads the org's wallet ──────────────────────────────

function overviewDeps(over = {}) {
  const seen = { read: [] };
  return {
    seen,
    deps: {
      flags: { walletSwaps: true, fundReferral: false, tokenizedStocks: false, issuerEligibilityConfirmed: false },
      resolveRoute: () => ({ ok: true, route: { kind: 'sandbox', prepare: async () => ({ providerRef: 'sandbox_x' }) } }),
      issuer: 'a tokenized treasury issuer',
      fundManager: 'a fund manager',
      readNav: async () => NAV,
      apyPct: () => 4,
      resolveWallet: async () => ({ ok: true, address: WALLET }),
      readBalances: async (address) => { seen.read.push(address); return { usdcMinor: usdc('12'), usdyMinor: usdc('3') }; },
      listOrders: async () => [],
      ...over,
    },
  };
}

test('the overview reads the business\'s own wallet, and a chain error is a fixed sentence', async () => {
  const { handleTreasuryOverview } = await import('../lib/server/treasury-wallet.ts');
  const ok = overviewDeps();
  const read = await handleTreasuryOverview(OWNER, ok.deps);
  assert.equal(read.status, 200);
  assert.equal(read.body.address, WALLET);
  assert.deepEqual(ok.seen.read, [WALLET]);
  assert.deepEqual(read.body.balances, { usdcMinor: '12000000', usdyMinor: '3000000' });
  assert.equal(read.body.wallet, 'address');

  const broken = overviewDeps({ readBalances: async () => { throw new Error('fullnode said 0xdeadbeef'); } });
  const failed = await handleTreasuryOverview(OWNER, broken.deps);
  assert.equal(failed.status, 200);
  assert.equal(failed.body.balances.error, 'The wallet balance could not be read from Sui just now.');
  assert.doesNotMatch(JSON.stringify(failed.body), /fullnode|deadbeef/);

  const none = overviewDeps({ resolveWallet: async () => ({ ok: false, status: 409, code: 'no_wallet', error: 'x' }) });
  const noWallet = await handleTreasuryOverview(OWNER, none.deps);
  assert.equal(noWallet.body.address, null);
  assert.equal(noWallet.body.wallet, 'none');
  assert.equal(noWallet.body.balances, null);
  assert.deepEqual(none.seen.read, []);
});

// ─── 3. Who may order, said by the server ────────────────────────────────

test('the overview says who may order, and a refusal names the caller\'s role', async () => {
  const { handleTreasuryOverview, handleTreasuryOrder } = await import('../lib/server/treasury-wallet.ts');
  for (const [caller, may] of [[OWNER, true], [MAKER, true], [AUDITOR, false], [DEVELOPER, false], [VIEWER, false]]) {
    const read = await handleTreasuryOverview(caller, overviewDeps().deps);
    assert.equal(read.body.canOrder, may, caller.role);
  }
  const page = await source('app/dashboard/treasury/page.tsx');
  assert.match(page, /const canOrder = overview\?\.canOrder === true;/);
  assert.doesNotMatch(page, /role !== 'VIEWER'/);

  const { deps: d } = await deps();
  const body = { intentId: INTENT, direction: 'swap', amount: '10', minOutMinor: '1' };
  const auditor = await handleTreasuryOrder(null, AUDITOR, body, d);
  assert.equal(auditor.status, 403);
  assert.match(auditor.body.error, /An auditor cannot/);
  assert.doesNotMatch(auditor.body.error, /viewer/i);
  assert.match((await handleTreasuryOrder(null, DEVELOPER, body, d)).body.error, /A developer cannot/);
});

// ─── 4. A fund-manager reference is confirmed, not claimed ───────────────

/** A fund manager that knows whose each reference is, by registration number. */
function fundDeps(over = {}) {
  const owners = { 'ACME-0001': '201901000001', 'NW-0001': '201901000002' };
  const reads = [];
  return {
    reads,
    deps: {
      enabled: true,
      label: 'a fund manager',
      referralUrl: 'https://fund.example/ref',
      resolveHolding: () => ({
        ok: true,
        source: {
          kind: 'sandbox',
          confirmLink: async ({ reference, registrationNumber }) =>
            owners[reference] === registrationNumber
              ? { ok: true }
              : { ok: false, status: 409, code: 'not_this_business', error: 'The fund manager does not hold that account for this business.' },
          read: async (input) => {
            reads.push(input);
            return { ok: true, holding: { reference: input.reference, units: '10.0000', value: '10.32', currency: 'MYR', asOf: NAV.asOf, sandbox: true } };
          },
        },
      }),
      ...over,
    },
  };
}

async function registered(client) {
  await client.query(`UPDATE organizations SET registration_number = '201901000001' WHERE id = 'acme'`);
  await client.query(`UPDATE organizations SET registration_number = '201901000002' WHERE id = 'northwind'`);
}

test('a business cannot link, or read, another business\'s account at the fund manager by typing its reference', async () => {
  const { client, db } = await migratedDb();
  await registered(client);
  const { handleFundReferralRead, handleFundReferralWrite } = await import('../lib/server/treasury-wallet.ts');
  const f = fundDeps();
  await handleFundReferralWrite(db, OWNER, { action: 'assess', answers: ELIGIBLE }, f.deps);
  await handleFundReferralWrite(db, NW_OWNER, { action: 'assess', answers: ELIGIBLE }, f.deps);

  // Northwind gets there first with acme's reference: the fund manager says no.
  const squat = await handleFundReferralWrite(db, NW_OWNER, { action: 'link', reference: 'ACME-0001' }, f.deps);
  assert.equal(squat.status, 409);
  assert.equal(squat.body.code, 'reference_not_confirmed');
  assert.equal((await handleFundReferralRead(db, NW_OWNER, f.deps)).body.holding, null);

  // So acme can still link its own.
  const own = await handleFundReferralWrite(db, OWNER, { action: 'link', reference: 'ACME-0001' }, f.deps);
  assert.equal(own.status, 200, JSON.stringify(own.body));
  assert.equal(own.body.linked, true);
  // The holding read names the business, so the fund manager can refuse it.
  assert.deepEqual(f.reads.at(-1), { reference: 'ACME-0001', orgId: 'acme', registrationNumber: '201901000001' });
  await client.close();
});

test('a business with no registration number links nothing, and production stores nothing it could not confirm', async () => {
  const { client, db } = await migratedDb();
  const { handleFundReferralWrite } = await import('../lib/server/treasury-wallet.ts');
  const f = fundDeps();
  await handleFundReferralWrite(db, OWNER, { action: 'assess', answers: ELIGIBLE }, f.deps);
  const unregistered = await handleFundReferralWrite(db, OWNER, { action: 'link', reference: 'ACME-0001' }, f.deps);
  assert.equal(unregistered.status, 409);
  assert.equal(unregistered.body.code, 'no_registration');

  await registered(client);
  const prod = fundDeps({ resolveHolding: () => ({ ok: false, status: 503, error: 'Holdings from the fund manager are not connected on this server, so no holding is shown.' }) });
  const refused = await handleFundReferralWrite(db, OWNER, { action: 'link', reference: 'ACME-0001' }, prod.deps);
  assert.equal(refused.status, 503);
  const { rows } = await client.query(`SELECT linked_reference FROM treasury_fund_referrals WHERE org_id = 'acme'`);
  assert.equal(rows[0].linked_reference, null);
  await client.close();
});

test('support can release a link, and the release is kept with who and why', async () => {
  const { client, db } = await migratedDb();
  await registered(client);
  const { handleFundReferralWrite } = await import('../lib/server/treasury-wallet.ts');
  const { releaseFundLinkForStaff, listFundReferralHistoryForStaff } = await import('../lib/server/fund-referral-store.ts');
  const f = fundDeps();
  await handleFundReferralWrite(db, OWNER, { action: 'assess', answers: ELIGIBLE }, f.deps);
  await handleFundReferralWrite(db, OWNER, { action: 'link', reference: 'ACME-0001' }, f.deps);
  assert.equal((await releaseFundLinkForStaff(db, { orgId: 'acme', releasedBy: 'staff@splash.finance', reason: '' })).ok, false, 'a reason is required');
  const released = await releaseFundLinkForStaff(db, { orgId: 'acme', releasedBy: 'staff@splash.finance', reason: 'Linked to the wrong account' });
  assert.equal(released.ok, true);
  const { rows } = await client.query(`SELECT linked_reference FROM treasury_fund_referrals WHERE org_id = 'acme'`);
  assert.equal(rows[0].linked_reference, null);
  const history = await listFundReferralHistoryForStaff(db, 'acme');
  assert.deepEqual(history.map((h) => h.kind), ['assessed', 'linked', 'released']);
  assert.equal(history[2].actor, 'staff@splash.finance');
  assert.equal(history[2].reason, 'Linked to the wrong account');
  assert.equal(history[1].reference, 'ACME-0001');

  const route = await source('app/api/admin/treasury/fund-referrals/route.ts');
  assert.match(route, /getAdminSession\(\)/);
  assert.match(route, /ForStaff/);
  await client.close();
});

// ─── 5. Every assessment is kept ─────────────────────────────────────────

test('answering again keeps the earlier declaration: assessments are appended, and the current row points at the latest', async () => {
  const { client, db } = await migratedDb();
  const { handleFundReferralRead, handleFundReferralWrite } = await import('../lib/server/treasury-wallet.ts');
  const f = fundDeps();
  const no = await handleFundReferralWrite(db, OWNER, { action: 'assess', answers: ALL_NO }, f.deps);
  assert.equal(no.body.assessment.outcome, 'not_eligible');
  const yes = await handleFundReferralWrite(db, OWNER, { action: 'assess', answers: ELIGIBLE }, f.deps);
  assert.equal(yes.body.assessment.outcome, 'eligible');

  const { rows } = await client.query(`SELECT outcome, answers, actor FROM treasury_fund_referral_history WHERE org_id = 'acme' AND kind = 'assessed' ORDER BY seq`);
  assert.deepEqual(rows.map((r) => r.outcome), ['not_eligible', 'eligible']);
  assert.equal(rows[0].answers.net_assets, false, 'the first answers are kept as given');
  assert.equal(rows[0].actor, 'u_owner', 'who answered is kept');
  const current = await client.query(`SELECT r.latest_assessment_id, h.outcome FROM treasury_fund_referrals r JOIN treasury_fund_referral_history h ON h.id = r.latest_assessment_id WHERE r.org_id = 'acme'`);
  assert.equal(current.rows[0].outcome, 'eligible');

  // The business sees that it answered before.
  const read = await handleFundReferralRead(db, OWNER, f.deps);
  assert.equal(read.body.assessments.length, 2);
  assert.equal(read.body.assessments[0].outcome, 'eligible', 'newest first');
  assert.equal(read.body.assessments[1].outcome, 'not_eligible');
  await client.close();
});

// ─── 6. Zeke says what this server can do ────────────────────────────────

test('Zeke\'s Treasury answer is the limitation statement, and mentions signing only when a swap route exists', async () => {
  const { treasuryRefusalText } = await import('../lib/agent/zeke-lane-guard.ts');
  const off = treasuryRefusalText({ NODE_ENV: 'development' });
  const on = treasuryRefusalText({ NODE_ENV: 'development', TREASURY_WALLET_SWAPS: 'true' });
  const prod = treasuryRefusalText({ NODE_ENV: 'production', TREASURY_WALLET_SWAPS: 'true' });
  for (const text of [off, on, prod]) {
    assert.match(text, /^I can't prepare, approve or send a Treasury swap\./, text);
    assert.match(text, /own Splash Wallet/);
    assert.match(text, /not Shariah-compliant/);
    assert.doesNotMatch(text, /licen[cs]/i);
  }
  for (const text of [off, prod]) {
    assert.match(text, /You can get a USDY quote on the Treasury page; swaps from the wallet are not switched on yet\./, text);
    assert.doesNotMatch(text, /sign/i, text);
  }
  assert.match(on, /owners sign it there/);
});

// ─── 7. The custodial ledger stays retired ───────────────────────────────

test('the custodial Smart Treasury ledger is retired even with the custody phase on', async () => {
  const { CUSTODIAL_TREASURY_LEDGER_ON, custodialTreasuryRetiredResponse } = await import('../lib/server/custodial-treasury.ts');
  assert.equal(CUSTODIAL_TREASURY_LEDGER_ON, false);
  const res = custodialTreasuryRetiredResponse();
  assert.equal(res.status, 410);
  const body = await res.json();
  assert.equal(body.code, 'treasury_in_business_wallet');
  assert.doesNotMatch(body.error, /licen[cs]/i);

  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
  const route = strip(await source('app/api/treasury/route.ts'));
  for (const handler of ['GET', 'POST']) {
    const at = route.indexOf(`export async function ${handler}`);
    const gate = route.indexOf('if (!CUSTODIAL_TREASURY_LEDGER_ON) return custodialTreasuryRetiredResponse();', at);
    assert.ok(gate > at, `${handler} answers 410`);
    assert.ok(gate < route.indexOf('custodyPhaseEnabled()', at), `${handler}: before the custody phase is even read`);
  }
  const guard = strip(await source('lib/agent/zeke-lane-guard.ts'));
  const fn = guard.slice(guard.indexOf('export function treasuryCustodyRefusal'), guard.indexOf('}', guard.indexOf('export function treasuryCustodyRefusal')));
  assert.doesNotMatch(fn, /custodyPhaseEnabled/, 'Zeke\'s Treasury refusal does not lift with the custody phase');
  const execution = strip(await source('lib/server/approval-execution.ts'));
  const treasuryCase = execution.slice(execution.indexOf("case 'TREASURY_ALLOCATE':"), execution.indexOf('default:', execution.indexOf("case 'TREASURY_ALLOCATE':")));
  assert.doesNotMatch(treasuryCase, /executeTreasuryMove/, 'an approved custodial move is never carried out');
  const { treasuryCustodyRefusal } = await import('../lib/agent/zeke-lane-guard.ts');
  assert.equal(typeof treasuryCustodyRefusal(), 'string');
});

// ─── 8. One slippage setting, with a ceiling ─────────────────────────────

test('swap slippage has one default and a ceiling, read through the env module', async () => {
  const { parseEnv } = await import('../lib/env.ts');
  const { MAX_SWAP_SLIPPAGE_BPS, MAX_MARKET_SHORTFALL_BPS } = await import('../lib/payments/treasury-usdy.ts');
  assert.equal(MAX_SWAP_SLIPPAGE_BPS, MAX_MARKET_SHORTFALL_BPS);
  assert.equal(parseEnv({ NODE_ENV: 'test' }).USDY_SWAP_SLIPPAGE_BPS, 30);
  assert.equal(parseEnv({ NODE_ENV: 'test', USDY_SWAP_SLIPPAGE_BPS: '100' }).USDY_SWAP_SLIPPAGE_BPS, 100);
  assert.throws(() => parseEnv({ NODE_ENV: 'test', USDY_SWAP_SLIPPAGE_BPS: '1000' }), /USDY_SWAP_SLIPPAGE_BPS/);
  assert.throws(() => parseEnv({ NODE_ENV: 'test', USDY_SWAP_SLIPPAGE_BPS: String(MAX_SWAP_SLIPPAGE_BPS + 1) }), /USDY_SWAP_SLIPPAGE_BPS/);
  for (const file of ['lib/server/treasury-deps.ts', 'lib/server/usdy.ts']) {
    const text = await source(file);
    assert.doesNotMatch(text, /process\.env\.USDY_SWAP_SLIPPAGE_BPS/, file);
  }
  assert.match(await source('lib/server/treasury-deps.ts'), /slippageBps: getEnv\(\)\.USDY_SWAP_SLIPPAGE_BPS/);
});

// ─── 9. An order still being prepared is not a success ───────────────────

test('a request that meets an order still being prepared is told so, not given a 200', async () => {
  const { client, db } = await migratedDb();
  const { handleTreasuryOrder } = await import('../lib/server/treasury-wallet.ts');
  const { USDY_COIN_TYPE_SUI } = await import('../lib/payments/treasury-usdy.ts');
  const { SUI_USDC_COIN_TYPE, STABLECOIN_NETWORK } = await import('../lib/payments/stablecoin-lane.ts');
  const { orderRequestHash } = await import('../lib/server/treasury-wallet-orders.ts');
  // Request A has claimed the row and is inside prepare(): no provider ref yet.
  const hash = orderRequestHash({ direction: 'swap', amountInMinor: usdc('10') });
  await client.query(
    `INSERT INTO treasury_wallet_orders (id, org_id, intent_id, direction, amount_in_minor, min_out_minor, quoted_out_minor, price_micros, request_hash, status, sandbox, requested_by, expires_at, source_address, recipient_address, in_coin_type, out_coin_type)
     VALUES ('tro_a', 'acme', '${INTENT}', 'swap', 10000000, 9000000, 9090909, 1100000, '${hash}', 'awaiting_signatures', true, 'u_owner', now() + interval '30 minutes', '${WALLET}', '${WALLET}', '${SUI_USDC_COIN_TYPE[STABLECOIN_NETWORK]}', '${USDY_COIN_TYPE_SUI}')`,
  );
  const { deps: d } = await deps();
  const b = await handleTreasuryOrder(db, OWNER, { intentId: INTENT, direction: 'swap', amount: '10', minOutMinor: '1' }, d);
  assert.equal(b.status, 409);
  assert.equal(b.body.code, 'in_progress');
  await client.close();
});

// ─── 10. Copy and the Max button ─────────────────────────────────────────

test('Settings and the stocks card name no licence and no unsigned partner', async () => {
  // The card's words live in lib/settings-page/about.ts since Settings was rebuilt (v2 brief 5.9).
  const settings = await source('lib/settings-page/about.ts');
  assert.doesNotMatch(settings, /Ondo/);
  assert.doesNotMatch(settings, /Smart Treasury holds customer funds/);
  assert.match(settings, /USDY in your own Splash Wallet/);
  const page = await source('app/dashboard/treasury/page.tsx');
  assert.doesNotMatch(page, /\bCircle\b/, 'Circle is named by role (the icons AlertCircle and CheckCircle2 are not names)');
});

test('the Max button is a full-size target with a name that says what it does', async () => {
  const page = await source('app/dashboard/treasury/page.tsx');
  const at = page.search(/>\r?\n\s*Max\r?\n/);
  assert.ok(at > 0, 'the Max button is there');
  const button = page.slice(page.lastIndexOf('<button', at), at);
  assert.match(button, /min-h-11/);
  assert.match(button, /aria-label=\{`Use the full \$\{unit\.in\} balance`\}/);
});
