import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { migratedDb } from './helpers/store-db.mjs';

/* v2 D9, brief 5.7: Treasury is USDY in the business's own wallet.

   The business swaps USDC for USDY, and redeems it back, from its own Splash
   Wallet; Splash holds nothing and signs nothing, so the page waits on no
   custody. What this file pins:

     1. the redemption quote (USDY to USDC), which no verification or country
        locks, and which a thin Sui market refuses;
     2. the read-only Sui route finder, both ways;
     3. the fund-manager eligibility questions (the Securities Commission
        Malaysia's sophisticated-investor categories for a business);
     4. the adapters: sandbox outside production only, and in production a
        refusal, never a stand-in result;
     5. orders handed to the wallet's signers: idempotent by intent id,
        unique per org, no status regression, and the server's quote, never
        the client's;
     6. the fund referral: owners only, eligible only, one linked reference
        per business, nothing across tenants;
     7. the routes' front door and the page's copy rules.

   Nothing here reaches a network: the price, the market and the chain are
   injected, and the database is PGlite with every migration applied. */

const usdc = (s) => {
  const [w, f = ''] = s.split('.');
  return BigInt(w) * 1_000_000n + BigInt((f + '000000').slice(0, 6));
};
const NAV = { status: 'LIVE', priceMicros: 1_100_000n, asOf: '2026-10-25T00:00:00Z', source: 'test' };
const OWNER = { orgId: 'acme', userId: 'u_owner', role: 'OWNER' };
const MAKER = { orgId: 'acme', userId: 'u_maker', role: 'MAKER' };
const VIEWER = { orgId: 'acme', userId: 'u_viewer', role: 'VIEWER' };
const OTHER_OWNER = { orgId: 'northwind', userId: 'u_nw', role: 'OWNER' };
const INTENT = '1b4e28ba-2fa1-11d2-883f-0016d3cca427';
const INTENT_2 = '2c5f39cb-3fb2-42e3-994a-1127e4ddb538';

async function source(relative) {
  return readFile(new URL(`../${relative}`, import.meta.url), 'utf8');
}

/** Quote deps with a deep market (1:1 at the redemption rate) unless told otherwise. */
function quoteDeps(over = {}) {
  const calls = { in: 0, out: 0 };
  const deps = {
    readNav: async () => NAV,
    apyPct: () => 4,
    readOrg: async () => ({ kyb: 'ACTIVE', country: 'MY' }),
    marketIn: async (amount) => {
      calls.in += 1;
      return { available: true, usdcInMinor: amount, usdyOutMinor: (amount * 1_000_000n) / NAV.priceMicros, providers: ['CETUS'], asOf: NAV.asOf, source: 'cetus-aggregator' };
    },
    marketOut: async (amount) => {
      calls.out += 1;
      return { available: true, usdyInMinor: amount, usdcOutMinor: (amount * NAV.priceMicros) / 1_000_000n, providers: ['CETUS'], asOf: NAV.asOf, source: 'cetus-aggregator' };
    },
    issuerEligibilityConfirmed: false,
    slippageBps: 50,
    ...over,
  };
  return { deps, calls };
}

const sandboxRoute = () => {
  const prepared = [];
  return {
    prepared,
    resolveRoute: () => ({ ok: true, route: { kind: 'sandbox', prepare: async (order) => { prepared.push(order.id); return { providerRef: `sandbox_${order.id}` }; } } }),
  };
};

async function withEnv(vars, fn) {
  const before = {};
  for (const [k, v] of Object.entries(vars)) {
    before[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ─── 1. The redemption quote ─────────────────────────────────────────────

test('a redemption is priced at the redemption rate and on Sui, and is never locked by verification or country', async () => {
  const { treasuryRedeemQuote, minReceived } = await import('../lib/payments/treasury-usdy.ts');
  const q = treasuryRedeemQuote({
    usdyInMinor: usdc('100'),
    nav: NAV,
    ondoEligibilityConfirmed: true,
    market: { usdcOutMinor: usdc('109.80'), providers: ['CETUS'], asOf: NAV.asOf },
  });
  assert.equal(q.allowed, true);
  assert.equal(q.mode, 'LIVE');
  assert.equal(q.usdcAtRedemptionMinor, usdc('110'));
  assert.equal(q.market.shortfallBps, 18);
  assert.equal(q.fillable, true);
  assert.equal(q.minUsdcOutMinor, minReceived(usdc('109.80'), 50));
  // The function takes no verification state and no country: a business that
  // holds USDY can always get out of it.
  assert.equal('state' in q, false);
});

test('a thin market, no price or a placeholder price refuses the redemption, saying which', async () => {
  const { treasuryRedeemQuote } = await import('../lib/payments/treasury-usdy.ts');
  const thin = treasuryRedeemQuote({ usdyInMinor: usdc('1000'), nav: NAV, ondoEligibilityConfirmed: true, market: { usdcOutMinor: usdc('500'), providers: ['CETUS'], asOf: NAV.asOf } });
  assert.equal(thin.fillable, false);
  assert.ok(thin.reasons.some((r) => /not enough liquidity on Sui/.test(r)));

  const none = treasuryRedeemQuote({ usdyInMinor: usdc('10'), nav: { status: 'UNAVAILABLE', priceMicros: null }, ondoEligibilityConfirmed: true });
  assert.equal(none.allowed, false);
  assert.equal(none.usdcAtRedemptionMinor, null);

  const unaged = treasuryRedeemQuote({ usdyInMinor: usdc('10'), nav: { status: 'STALE', priceMicros: 1_000_000n, asOf: null }, ondoEligibilityConfirmed: true });
  assert.equal(unaged.allowed, false);

  const preview = treasuryRedeemQuote({ usdyInMinor: usdc('10'), nav: NAV, ondoEligibilityConfirmed: false });
  assert.equal(preview.mode, 'SANDBOX');
  assert.ok(preview.reasons.some((r) => /Preview only/.test(r)));
});

test('customer-facing quote reasons name no issuer: its role, until its agreement is signed', async () => {
  const { treasuryQuote, treasuryRedeemQuote } = await import('../lib/payments/treasury-usdy.ts');
  const us = treasuryQuote({ state: 'ACTIVE', country: 'US', usdcInMinor: usdc('10'), nav: NAV, apyPct: 4, ondoEligibilityConfirmed: false });
  const preview = treasuryQuote({ state: 'ACTIVE', country: 'MY', usdcInMinor: usdc('10'), nav: NAV, apyPct: 4, ondoEligibilityConfirmed: false });
  const redeem = treasuryRedeemQuote({ usdyInMinor: usdc('10'), nav: NAV, ondoEligibilityConfirmed: false });
  for (const reason of [...us.reasons, ...preview.reasons, ...redeem.reasons]) assert.doesNotMatch(reason, /Ondo/, reason);
});

// ─── 2. The Sui route finder, both ways ──────────────────────────────────

test('the route finder is asked USDY to USDC for a redemption, read-only, and a mismatched answer is refused', async () => {
  const { quoteUsdyToUsdcOnSui, quoteUsdcToUsdyOnSui } = await import('../lib/server/usdy-liquidity.ts');
  const { USDY_COIN_TYPE_SUI } = await import('../lib/payments/treasury-usdy.ts');
  const seen = [];
  const fetcher = async (url) => {
    seen.push(url);
    const amount = new URL(url).searchParams.get('amount');
    return new Response(JSON.stringify({ code: 200, data: { amount_in: Number(amount), amount_out: 1_090_000, routes: [{ path: [{ provider: 'CETUS' }] }] } }), { status: 200 });
  };
  const out = await quoteUsdyToUsdcOnSui(1_000_000n, { fetcher });
  assert.equal(out.available, true);
  assert.equal(out.usdcOutMinor, 1_090_000n);
  const asked = new URL(seen[0]);
  assert.equal(asked.searchParams.get('from'), USDY_COIN_TYPE_SUI);
  assert.match(asked.searchParams.get('target'), /::usdc::USDC$/);

  const swap = await quoteUsdcToUsdyOnSui(1_000_000n, { fetcher });
  assert.equal(swap.available, true);
  assert.equal(swap.usdyOutMinor, 1_090_000n);
  assert.equal(new URL(seen[1]).searchParams.get('target'), USDY_COIN_TYPE_SUI);

  const liar = async () => new Response(JSON.stringify({ code: 200, data: { amount_in: 5, amount_out: 9 } }), { status: 200 });
  assert.equal((await quoteUsdyToUsdcOnSui(1_000_000n, { fetcher: liar })).available, false);
  const noRoute = async () => new Response(JSON.stringify({ code: 400, msg: 'quote deviation error' }), { status: 200 });
  const refused = await quoteUsdyToUsdcOnSui(1_000_000n, { fetcher: noRoute });
  assert.equal(refused.available, false);
  assert.match(refused.reason, /sell this much USDY/);
});

// ─── 3. The fund-manager eligibility questions ──────────────────────────

const ALL_NO = { malaysia: true, regulated_institution: false, net_assets: false, wholly_owned: false, declaration: true };

test('eligibility follows the sophisticated-investor categories a business can meet, and needs the declaration', async () => {
  const { evaluateFundEligibility, FUND_QUESTIONS, FUND_QUESTION_IDS } = await import('../lib/treasury/fund-eligibility.ts');
  assert.deepEqual(FUND_QUESTIONS.map((q) => q.id), [...FUND_QUESTION_IDS]);
  assert.match(FUND_QUESTIONS.map((q) => `${q.question} ${q.help ?? ''}`).join(' '), /RM10 million/);
  assert.match(FUND_QUESTIONS.map((q) => q.help ?? '').join(' '), /RM3 million.*RM300,000.*RM400,000.*RM1 million/);

  assert.equal(evaluateFundEligibility({ ...ALL_NO, net_assets: true }).category, 'net_assets');
  assert.equal(evaluateFundEligibility({ ...ALL_NO, regulated_institution: true }).category, 'regulated_institution');
  assert.equal(evaluateFundEligibility({ ...ALL_NO, wholly_owned: true }).category, 'wholly_owned');
  assert.equal(evaluateFundEligibility(ALL_NO).outcome, 'not_eligible');
  assert.equal(evaluateFundEligibility({ ...ALL_NO, net_assets: true, declaration: false }).outcome, 'not_eligible', 'no declaration, no reliance');
  assert.equal(evaluateFundEligibility({ ...ALL_NO, net_assets: true, malaysia: false }).outcome, 'not_eligible');
});

test('an incomplete or padded form is refused, not read as a no', async () => {
  const { parseFundAnswers } = await import('../lib/treasury/fund-eligibility.ts');
  assert.equal(parseFundAnswers({ ...ALL_NO, net_assets: 'yes' }).ok, false);
  assert.equal(parseFundAnswers({ malaysia: true }).ok, false);
  assert.equal(parseFundAnswers({ ...ALL_NO, is_admin: true }).ok, false);
  assert.equal(parseFundAnswers(null).ok, false);
  assert.equal(parseFundAnswers(ALL_NO).ok, true);
});

test('the question wording makes no licence claim and avoids words the copy rules ban', async () => {
  const { FUND_QUESTIONS } = await import('../lib/treasury/fund-eligibility.ts');
  const { copyViolations } = await import('../scripts/copy-rules.mjs');
  const text = FUND_QUESTIONS.map((q) => `${q.question}\n${q.help ?? ''}`).join('\n');
  assert.deepEqual(copyViolations('app/dashboard/treasury/page.tsx', text), []);
  assert.doesNotMatch(text, /licen[cs]|audited/i);
});

// ─── 4. The adapters fail closed in production ──────────────────────────

test('the swap route: off by default, sandbox only outside production, and in production no stand-in', async () => {
  const { resolveTreasurySwapRoute } = await import('../lib/server/treasury-providers.ts');
  assert.equal(resolveTreasurySwapRoute({ NODE_ENV: 'development' }).ok, false, 'off unless switched on');
  const dev = resolveTreasurySwapRoute({ NODE_ENV: 'development', TREASURY_WALLET_SWAPS: 'true' });
  assert.equal(dev.ok, true);
  assert.equal(dev.route.kind, 'sandbox');
  for (const env of [
    { NODE_ENV: 'production', TREASURY_WALLET_SWAPS: 'true' },
    { NODE_ENV: 'production', TREASURY_WALLET_SWAPS: 'true', USE_MOCK_APIS: 'true', NEXT_PUBLIC_DEMO_MODE: 'true' },
  ]) {
    const prod = resolveTreasurySwapRoute(env);
    assert.equal(prod.ok, false, JSON.stringify(env));
    assert.equal(prod.status, 503);
    assert.match(prod.error, /no live swap route/);
  }
});

test('the fund holding: sandbox (marked) outside production, nothing in production; the referral link is https only', async () => {
  const { resolveFundHoldingSource, fundReferralUrl, treasuryFlags } = await import('../lib/server/treasury-providers.ts');
  const dev = resolveFundHoldingSource({ NODE_ENV: 'development' });
  assert.equal(dev.ok, true);
  const read = await dev.source.read('ACME-0001');
  assert.equal(read.holding.sandbox, true);
  const prod = resolveFundHoldingSource({ NODE_ENV: 'production', USE_MOCK_APIS: 'true' });
  assert.equal(prod.ok, false);
  assert.match(prod.error, /not connected/);

  assert.equal(fundReferralUrl({}), null);
  assert.equal(fundReferralUrl({ FUND_REFERRAL_URL: 'http://fund.example/ref' }), null);
  assert.equal(fundReferralUrl({ FUND_REFERRAL_URL: 'javascript:alert(1)' }), null);
  assert.equal(fundReferralUrl({ FUND_REFERRAL_URL: 'https://fund.example/ref' }), 'https://fund.example/ref');

  assert.deepEqual(treasuryFlags({}), { walletSwaps: false, fundReferral: false, tokenizedStocks: false, issuerEligibilityConfirmed: false });
  assert.equal(treasuryFlags({ FEATURE_ONDO_STOCKS: 'true' }).tokenizedStocks, true);
});

test('the new switches are declared, off by default, and the referral needs its link in production', async () => {
  const { ENV_KEYS, parseEnv } = await import('../lib/env.ts');
  for (const key of ['TREASURY_WALLET_SWAPS', 'FEATURE_FUND_REFERRAL', 'FUND_REFERRAL_URL', 'FEATURE_ONDO_STOCKS']) assert.ok(ENV_KEYS.includes(key), key);
  const parsed = parseEnv({ NODE_ENV: 'development' });
  assert.equal(parsed.TREASURY_WALLET_SWAPS, false);
  assert.equal(parsed.FEATURE_FUND_REFERRAL, false);
  assert.equal(parsed.FEATURE_ONDO_STOCKS, false);
  const env = await source('lib/env.ts');
  assert.match(env, /if \(env\.FEATURE_FUND_REFERRAL\) \{\s*need\('FUND_REFERRAL_URL'/);
});

// ─── 5. Orders for the wallet's signers ─────────────────────────────────

test('an order is made once per intent id: a replay returns it, a reused id with another amount is refused', async () => {
  const { client, db } = await migratedDb();
  const { handleTreasuryOrder } = await import('../lib/server/treasury-wallet.ts');
  const { deps, calls } = quoteDeps();
  const route = sandboxRoute();
  const body = { intentId: INTENT, direction: 'swap', amount: '100', minOutMinor: String(usdc('90')) };

  const first = await handleTreasuryOrder(db, OWNER, body, { ...deps, ...route });
  assert.equal(first.status, 201);
  assert.equal(first.body.order.status, 'awaiting_signatures');
  assert.equal(first.body.order.sandbox, true);

  const again = await handleTreasuryOrder(db, OWNER, body, { ...deps, ...route });
  assert.equal(again.status, 200);
  assert.equal(again.body.replayed, true);
  assert.equal(again.body.order.id, first.body.order.id);
  assert.equal(route.prepared.length, 1, 'the signers were asked once');
  assert.equal(calls.in, 1, 'a replay is not priced again');

  const reused = await handleTreasuryOrder(db, OWNER, { ...body, amount: '200' }, { ...deps, ...route });
  assert.equal(reused.status, 409);
  assert.equal(reused.body.code, 'intent_reused');

  const { rows } = await client.query('SELECT count(*)::int AS n FROM treasury_wallet_orders');
  assert.equal(rows[0].n, 1);
  await client.close();
});

test('two requests racing on one intent id make one order', async () => {
  const { client, db } = await migratedDb();
  const { handleTreasuryOrder } = await import('../lib/server/treasury-wallet.ts');
  const { deps } = quoteDeps();
  const route = sandboxRoute();
  const body = { intentId: INTENT, direction: 'redeem', amount: '50', minOutMinor: String(usdc('50')) };
  const results = await Promise.all([1, 2, 3].map(() => handleTreasuryOrder(db, OWNER, body, { ...deps, ...route })));
  assert.deepEqual(new Set(results.map((r) => r.body.order.id)).size, 1);
  const { rows } = await client.query('SELECT count(*)::int AS n FROM treasury_wallet_orders');
  assert.equal(rows[0].n, 1);
  await client.close();
});

test('orders stay in their org: another business neither reads nor collides with them', async () => {
  const { client, db } = await migratedDb();
  const { handleTreasuryOrder } = await import('../lib/server/treasury-wallet.ts');
  const { listTreasuryOrders, readTreasuryOrderByIntent, closeTreasuryOrder } = await import('../lib/server/treasury-wallet-orders.ts');
  const { deps } = quoteDeps();
  const route = sandboxRoute();
  const body = { intentId: INTENT, direction: 'swap', amount: '100', minOutMinor: String(usdc('90')) };
  const acme = await handleTreasuryOrder(db, OWNER, body, { ...deps, ...route });
  // The same intent id from another business is its own order, not a replay of acme's.
  const nw = await handleTreasuryOrder(db, OTHER_OWNER, { ...body, amount: '7', minOutMinor: '1' }, { ...deps, ...route });
  assert.equal(nw.status, 201);
  assert.notEqual(nw.body.order.id, acme.body.order.id);

  assert.deepEqual((await listTreasuryOrders(db, 'northwind')).map((o) => o.id), [nw.body.order.id]);
  assert.deepEqual((await listTreasuryOrders(db, 'acme')).map((o) => o.id), [acme.body.order.id]);
  assert.equal((await readTreasuryOrderByIntent(db, 'northwind', INTENT)).id, nw.body.order.id);
  assert.equal(await closeTreasuryOrder(db, 'northwind', acme.body.order.id, 'cancelled'), null, 'another org cannot close it');
  assert.equal((await listTreasuryOrders(db, 'acme'))[0].status, 'awaiting_signatures');
  await client.close();
});

test('an order only moves forward: once closed it never changes again, and a lapsed one reads as expired', async () => {
  const { client, db } = await migratedDb();
  const { createTreasuryOrder, closeTreasuryOrder, listTreasuryOrders, ORDER_TTL_MS } = await import('../lib/server/treasury-wallet-orders.ts');
  const made = await createTreasuryOrder(db, {
    orgId: 'acme', intentId: INTENT, direction: 'swap', amountInMinor: usdc('10'), minOutMinor: usdc('9'), quotedOutMinor: usdc('9.09'),
    priceMicros: 1_100_000n, sandbox: true, requestedBy: 'u_owner',
  }, async () => ({ providerRef: 'sandbox_x' }));
  const executed = await closeTreasuryOrder(db, 'acme', made.order.id, 'executed', { txDigest: 'DIGEST1' });
  assert.equal(executed.status, 'executed');
  assert.equal(await closeTreasuryOrder(db, 'acme', made.order.id, 'failed'), null, 'a late failure does not overwrite it');
  assert.equal(await closeTreasuryOrder(db, 'acme', made.order.id, 'executed', { txDigest: 'OTHER' }), null, 'nor a replayed success');
  assert.equal((await listTreasuryOrders(db, 'acme'))[0].txDigest, 'DIGEST1');
  await assert.rejects(() => closeTreasuryOrder(db, 'acme', made.order.id, 'awaiting_signatures'), /not a closed status/);

  const old = await createTreasuryOrder(db, {
    orgId: 'acme', intentId: INTENT_2, direction: 'redeem', amountInMinor: usdc('5'), minOutMinor: usdc('5'), quotedOutMinor: usdc('5.5'),
    priceMicros: 1_100_000n, sandbox: true, requestedBy: 'u_owner', now: new Date(Date.now() - ORDER_TTL_MS - 1000),
  }, async () => ({ providerRef: 'sandbox_y' }));
  const listed = (await listTreasuryOrders(db, 'acme')).find((o) => o.id === old.order.id);
  assert.equal(listed.status, 'expired');

  // The database refuses what the store would never write.
  await assert.rejects(() => client.query(`UPDATE treasury_wallet_orders SET status = 'reopened' WHERE id = '${made.order.id}'`));
  await assert.rejects(() => client.query(`UPDATE treasury_wallet_orders SET min_out_minor = quoted_out_minor + 1 WHERE id = '${made.order.id}'`));
  await client.close();
});

test('a failed hand-off to the signers leaves no order behind', async () => {
  const { client, db } = await migratedDb();
  const { handleTreasuryOrder } = await import('../lib/server/treasury-wallet.ts');
  const { deps } = quoteDeps();
  const failing = { resolveRoute: () => ({ ok: true, route: { kind: 'sandbox', prepare: async () => { throw new Error('signing service down'); } } }) };
  await assert.rejects(() => handleTreasuryOrder(db, OWNER, { intentId: INTENT, direction: 'swap', amount: '10', minOutMinor: '1' }, { ...deps, ...failing }), /signing service down/);
  const { rows } = await client.query('SELECT count(*)::int AS n FROM treasury_wallet_orders');
  assert.equal(rows[0].n, 0);
  await client.close();
});

test('who may order, what is checked, and that production refuses before anything is recorded', async () => {
  const { client, db } = await migratedDb();
  const { handleTreasuryOrder } = await import('../lib/server/treasury-wallet.ts');
  const { resolveTreasurySwapRoute } = await import('../lib/server/treasury-providers.ts');
  const { minReceived } = await import('../lib/payments/treasury-usdy.ts');
  const route = sandboxRoute();
  const { deps } = quoteDeps();
  const ok = { intentId: INTENT, direction: 'swap', amount: '100', minOutMinor: String(usdc('90')) };

  assert.equal((await handleTreasuryOrder(db, VIEWER, ok, { ...deps, ...route })).status, 403, 'a viewer cannot');
  assert.equal((await handleTreasuryOrder(db, OWNER, { ...ok, intentId: 'x' }, { ...deps, ...route })).status, 400);
  assert.equal((await handleTreasuryOrder(db, OWNER, { ...ok, direction: 'buy' }, { ...deps, ...route })).status, 400);
  assert.equal((await handleTreasuryOrder(db, OWNER, { ...ok, amount: '-1' }, { ...deps, ...route })).status, 400);
  assert.equal((await handleTreasuryOrder(db, OWNER, { ...ok, minOutMinor: undefined }, { ...deps, ...route })).status, 400, 'the agreed floor is required');

  // Production, even with mocks on: the real resolver refuses, nothing is recorded.
  const prod = await handleTreasuryOrder(db, OWNER, ok, {
    ...deps,
    resolveRoute: () => resolveTreasurySwapRoute({ NODE_ENV: 'production', TREASURY_WALLET_SWAPS: 'true', USE_MOCK_APIS: 'true' }),
  });
  assert.equal(prod.status, 503);
  assert.equal(prod.body.code, 'swap_route_unavailable');
  // Off on this server.
  const off = await handleTreasuryOrder(db, OWNER, ok, { ...deps, resolveRoute: () => resolveTreasurySwapRoute({ NODE_ENV: 'development' }) });
  assert.equal(off.status, 503);

  // A thin market is not ordered.
  const thin = quoteDeps({ marketIn: async (a) => ({ available: true, usdcInMinor: a, usdyOutMinor: a / 2n, providers: ['CETUS'], asOf: NAV.asOf, source: 'cetus-aggregator' }) });
  const refused = await handleTreasuryOrder(db, OWNER, ok, { ...thin.deps, ...route });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'not_orderable');
  // An unverified business cannot swap in.
  const locked = quoteDeps({ readOrg: async () => ({ kyb: 'REGISTERED', country: 'MY' }) });
  assert.equal((await handleTreasuryOrder(db, OWNER, ok, { ...locked.deps, ...route })).status, 409);
  assert.equal(locked.calls.in, 0, 'and the market is not even asked');
  // The price moved below what the person agreed to.
  const moved = await handleTreasuryOrder(db, OWNER, { ...ok, minOutMinor: String(usdc('95')) }, { ...deps, ...route });
  assert.equal(moved.status, 409);
  assert.equal(moved.body.code, 'price_moved');

  let rows = (await client.query('SELECT count(*)::int AS n FROM treasury_wallet_orders')).rows;
  assert.equal(rows[0].n, 0, 'nothing refused was recorded');

  // A maker (staff) may ask; the floor is the higher of what they agreed and the server's.
  const made = await handleTreasuryOrder(db, MAKER, { ...ok, minOutMinor: '1' }, { ...deps, ...route });
  assert.equal(made.status, 201);
  const quoted = BigInt(made.body.order.quotedOutMinor);
  assert.equal(quoted, (usdc('100') * 1_000_000n) / NAV.priceMicros, 'the server quote, not the client');
  assert.equal(BigInt(made.body.order.minOutMinor), minReceived(quoted, 50));
  rows = (await client.query(`SELECT requested_by FROM treasury_wallet_orders`)).rows;
  assert.equal(rows[0].requested_by, 'u_maker');
  await client.close();
});

test('a quote moves nothing, reads no client figure, and a redemption is open to an unverified business', async () => {
  const { handleTreasuryQuote } = await import('../lib/server/treasury-wallet.ts');
  const locked = quoteDeps({ readOrg: async () => ({ kyb: 'REGISTERED', country: 'US' }) });
  const redeem = await handleTreasuryQuote(OWNER, { direction: 'redeem', amount: '25' }, locked.deps);
  assert.equal(redeem.status, 200);
  assert.equal(redeem.body.allowed, true);
  assert.equal(redeem.body.orderable, true);
  assert.equal(typeof redeem.body.outMinor, 'string');
  const swap = await handleTreasuryQuote(OWNER, { direction: 'swap', amount: '25' }, locked.deps);
  assert.equal(swap.body.allowed, false);
  assert.equal((await handleTreasuryQuote(OWNER, { direction: 'swap', amount: 'abc' }, locked.deps)).status, 400);
  assert.equal((await handleTreasuryQuote(OWNER, { direction: 'mint', amount: '1' }, locked.deps)).status, 400);
});

// ─── 6. The fund referral ────────────────────────────────────────────────

function fundDeps(over = {}) {
  return {
    enabled: true,
    label: 'a fund manager',
    referralUrl: 'https://fund.example/ref',
    resolveHolding: () => ({ ok: true, source: { kind: 'sandbox', read: async (reference) => ({ ok: true, holding: { reference, units: '10.0000', value: '10.32', currency: 'MYR', asOf: NAV.asOf, sandbox: true } }) } }),
    ...over,
  };
}
const ELIGIBLE = { ...ALL_NO, net_assets: true };

test('the referral is off unless switched on: both reads and writes answer not offered', async () => {
  const { handleFundReferralRead, handleFundReferralWrite } = await import('../lib/server/treasury-wallet.ts');
  assert.equal((await handleFundReferralRead(null, OWNER, fundDeps({ enabled: false }))).status, 404);
  assert.equal((await handleFundReferralWrite(null, OWNER, { action: 'assess', answers: ELIGIBLE }, fundDeps({ enabled: false }))).status, 404);
});

test('only an owner answers; an eligible business gets the link, one that is not never does', async () => {
  const { client, db } = await migratedDb();
  const { handleFundReferralRead, handleFundReferralWrite } = await import('../lib/server/treasury-wallet.ts');
  assert.equal((await handleFundReferralWrite(db, MAKER, { action: 'assess', answers: ELIGIBLE }, fundDeps())).status, 403);

  const no = await handleFundReferralWrite(db, OWNER, { action: 'assess', answers: ALL_NO }, fundDeps());
  assert.equal(no.status, 200);
  assert.equal(no.body.assessment.outcome, 'not_eligible');
  assert.equal(no.body.referralUrl, null);
  assert.equal((await handleFundReferralWrite(db, OWNER, { action: 'opened' }, fundDeps())).status, 409);
  assert.equal((await handleFundReferralWrite(db, OWNER, { action: 'link', reference: 'ACME-0001' }, fundDeps())).status, 409, 'not eligible, no link');

  const yes = await handleFundReferralWrite(db, OWNER, { action: 'assess', answers: ELIGIBLE }, fundDeps());
  assert.equal(yes.body.assessment.outcome, 'eligible');
  assert.equal(yes.body.assessment.category, 'net_assets');
  assert.equal(yes.body.referralUrl, 'https://fund.example/ref');
  assert.equal((await handleFundReferralWrite(db, OWNER, { action: 'opened' }, fundDeps({ referralUrl: null }))).status, 503, 'no link set up, nothing to open');
  assert.equal((await handleFundReferralWrite(db, OWNER, { action: 'opened' }, fundDeps())).status, 200);

  assert.equal((await handleFundReferralWrite(db, OWNER, { action: 'assess', answers: { malaysia: true } }, fundDeps())).status, 400);
  assert.equal((await handleFundReferralWrite(db, OWNER, { action: 'nope' }, fundDeps())).status, 400);
  const read = await handleFundReferralRead(db, VIEWER, fundDeps());
  assert.equal(read.body.assessment.outcome, 'eligible', 'anyone in the business may read it');
  await client.close();
});

test('a linked account is read-only, one per business, and never another business\'s', async () => {
  const { client, db } = await migratedDb();
  const { handleFundReferralRead, handleFundReferralWrite } = await import('../lib/server/treasury-wallet.ts');
  await handleFundReferralWrite(db, OWNER, { action: 'assess', answers: ELIGIBLE }, fundDeps());
  await handleFundReferralWrite(db, OTHER_OWNER, { action: 'assess', answers: ELIGIBLE }, fundDeps());

  assert.equal((await handleFundReferralWrite(db, OWNER, { action: 'link', reference: 'x' }, fundDeps())).status, 400);
  const linked = await handleFundReferralWrite(db, OWNER, { action: 'link', reference: 'ACME-0001' }, fundDeps());
  assert.equal(linked.status, 200);
  assert.equal(linked.body.linked, true);
  assert.equal(linked.body.holding.sandbox, true);
  assert.equal(linked.body.holding.reference, 'ACME-0001');

  const stolen = await handleFundReferralWrite(db, OTHER_OWNER, { action: 'link', reference: 'ACME-0001' }, fundDeps());
  assert.equal(stolen.status, 409);
  assert.equal(stolen.body.code, 'reference_taken');
  const nwRead = await handleFundReferralRead(db, OTHER_OWNER, fundDeps());
  assert.equal(nwRead.body.linked, false);
  assert.equal(nwRead.body.holding, null, 'northwind reads no holding');

  assert.equal((await handleFundReferralWrite(db, OWNER, { action: 'link', reference: 'ACME-0002' }, fundDeps())).status, 409, 'linked once');
  const reassess = await handleFundReferralWrite(db, OWNER, { action: 'assess', answers: ALL_NO }, fundDeps());
  assert.equal(reassess.status, 409, 'a linked business keeps the answers it gave');
  assert.equal(reassess.body.code, 'already_linked');

  // Production: the holding is not read, and no figure stands in for it.
  const prod = await handleFundReferralRead(db, OWNER, fundDeps({
    resolveHolding: () => ({ ok: false, status: 503, error: 'Holdings from the fund manager are not connected on this server, so no holding is shown.' }),
  }));
  assert.deepEqual(Object.keys(prod.body.holding), ['unavailable']);
  await assert.rejects(() => client.query(`UPDATE treasury_fund_referrals SET outcome = 'not_eligible', category = NULL WHERE org_id = 'acme'`), 'a linked row cannot become not eligible');
  await client.close();
});

// ─── 7. The routes and the page ──────────────────────────────────────────

test('every Treasury route goes through the session front door: membership, org from the session, launch scope', async () => {
  const door = await source('lib/server/treasury-route.ts');
  assert.match(door, /requireSessionAccount\(auth\.session\)/);
  assert.match(door, /resolveAuthorityForSession\(auth\.session\)/);
  assert.match(door, /refuseOutsideLaunchScope\(\)/);
  assert.match(door, /orgId: accountCheck\.account\.orgId/);
  for (const route of ['app/api/treasury/wallet/route.ts', 'app/api/treasury/wallet/quote/route.ts', 'app/api/treasury/wallet/orders/route.ts', 'app/api/treasury/fund-referral/route.ts']) {
    const text = await source(route);
    const handlers = text.match(/export async function (GET|POST)/g) ?? [];
    const gates = text.match(/await treasuryCaller\(request\)/g) ?? [];
    assert.ok(handlers.length > 0, route);
    assert.equal(gates.length, handlers.length, `${route}: every handler is gated`);
    assert.doesNotMatch(text, /body\.orgId|searchParams\.get\('orgId'\)/, `${route} takes no org from the request`);
    assert.doesNotMatch(text, /custodyPhase/, `${route} waits on no custody`);
  }
});

test('the Treasury page: no custody gate, USDY labelled not Shariah, partners by role, stocks hidden unless flagged', async () => {
  const page = await source('app/dashboard/treasury/page.tsx');
  assert.match(page, /\/api\/treasury\/wallet/);
  assert.doesNotMatch(page, /custody_not_licensed|custodyOn/);
  assert.match(page, /Not Shariah-compliant/);
  assert.doesNotMatch(page, /Halogen|\bOndo\b/, 'partner names come from the server, by role unless signed');
  assert.match(page, /flags\.tokenizedStocks &&/, 'tokenized stocks render only behind the flag');
  assert.match(page, /flags\.fundReferral &&/, 'the fund section renders only behind its flag');
  assert.doesNotMatch(page, /DAILY_BARS|SEED_HISTORY/, 'no seeded yield series');
  assert.doesNotMatch(page, /Coming soon|\bDemo\b|\bDEMO\b|testnet|E39774|coral|licen[cs]e|non-custodial/i);
  const { copyViolations } = await import('../scripts/copy-rules.mjs');
  assert.deepEqual(copyViolations('app/dashboard/treasury/page.tsx', page), []);
});

test('Zeke names no licence for Treasury: it points to the wallet and the Treasury page', async () => {
  const { TREASURY_CUSTODY_REFUSAL } = await import('../lib/agent/zeke-lane-guard.ts');
  assert.doesNotMatch(TREASURY_CUSTODY_REFUSAL, /licen[cs]|Phase 2/i);
  assert.match(TREASURY_CUSTODY_REFUSAL, /own Splash Wallet/);
  assert.match(TREASURY_CUSTODY_REFUSAL, /Treasury page/);
  assert.match(TREASURY_CUSTODY_REFUSAL, /not Shariah-compliant/);
});
