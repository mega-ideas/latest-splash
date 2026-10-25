import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { migratedDb } from './helpers/store-db.mjs';

/* v2 brief 5.7, the second independent review of Treasury in the business
   wallet. What it found, and what this file pins:

     1. A SANDBOX quote ("Preview only ... nothing is swapped") was accepted
        as an order on the sandbox route, and the page said it was sent to the
        owners to sign. The sandbox route notifies nobody. Now a SANDBOX quote
        is never an order, and a sandbox-route order is labelled as one all
        the way to the toast.
     2. The page decided whether swaps reach signers from the raw env flag.
        Now the overview carries the server's own route answer.
     3. Replaying a lapsed order reported it as still awaiting signatures.
     4. A swap in could be ordered on a STALE price that the quote itself
        said not to act on.
     5. A "not eligible" fund answer was described as final when it is not.
     6. The BusinessAccount type check did not pin the splash_core package.
     7. Treasury read balances on mainnet for a wallet resolved on another
        network, without saying so.
     8. Quote reasons broke the copy rules (an em dash, an env-var name).
     9. The projection chart was mouse-only, and the floating Zeke button
        covered the end of the page at phone width. */

const usdc = (s) => {
  const [w, f = ''] = s.split('.');
  return BigInt(w) * 1_000_000n + BigInt((f + '000000').slice(0, 6));
};
const NAV = { status: 'LIVE', priceMicros: 1_100_000n, asOf: '2026-10-25T00:00:00Z', source: 'test' };
const OWNER = { orgId: 'acme', userId: 'u_owner', role: 'OWNER' };
const INTENT = '1b4e28ba-2fa1-11d2-883f-0016d3cca427';
const WALLET = '0x' + 'ab'.repeat(32);
const CORE = '0x' + '12'.repeat(32);
const FOREIGN = '0x' + '66'.repeat(32);

async function source(relative) {
  return readFile(new URL(`../${relative}`, import.meta.url), 'utf8');
}

function orderDeps(over = {}) {
  const seen = { prepared: [] };
  return {
    seen,
    deps: {
      readNav: async () => NAV,
      apyPct: () => 4,
      readOrg: async () => ({ kyb: 'ACTIVE', country: 'MY' }),
      marketIn: async (amount) => ({ available: true, usdcInMinor: amount, usdyOutMinor: (amount * 1_000_000n) / NAV.priceMicros, providers: ['CETUS'], asOf: NAV.asOf, source: 'cetus-aggregator' }),
      marketOut: async (amount) => ({ available: true, usdyInMinor: amount, usdcOutMinor: (amount * NAV.priceMicros) / 1_000_000n, providers: ['CETUS'], asOf: NAV.asOf, source: 'cetus-aggregator' }),
      issuerEligibilityConfirmed: true,
      slippageBps: 50,
      resolveWallet: async () => ({ ok: true, address: WALLET }),
      readWalletBalance: async () => usdc('1000000'),
      resolveRoute: () => ({ ok: true, route: { kind: 'sandbox', prepare: async (order) => { seen.prepared.push(order.id); return { providerRef: `sandbox_${order.id}` }; } } }),
      ...over,
    },
  };
}

async function count(client) {
  return (await client.query('SELECT count(*)::int AS n FROM treasury_wallet_orders')).rows[0].n;
}

// ─── 1. A preview quote is never an order ────────────────────────────────

test('a SANDBOX (preview) quote is refused as an order on every route, and nothing is recorded', async () => {
  const { client, db } = await migratedDb();
  const { handleTreasuryOrder } = await import('../lib/server/treasury-wallet.ts');
  for (const direction of ['swap', 'redeem']) {
    const { deps, seen } = orderDeps({ issuerEligibilityConfirmed: false });
    const res = await handleTreasuryOrder(db, OWNER, { intentId: INTENT, direction, amount: '100', minOutMinor: '1' }, deps);
    assert.equal(res.status, 409, `${direction}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.code, 'issuer_unconfirmed');
    assert.doesNotMatch(res.body.error, /sent to your (owners|signers) to sign/i);
    assert.equal(seen.prepared.length, 0, 'the route was not asked');
  }
  assert.equal(await count(client), 0);
  await client.close();
});

test('the page never says a sandbox order went to the owners, and a preview quote cannot be sent', async () => {
  const page = await source('app/dashboard/treasury/page.tsx');
  assert.match(page, /Recorded in the sandbox\. Nothing was sent to your owners\./);
  assert.match(page, /Record a sandbox order/);
  // The toast is chosen from the order the server returned, not assumed.
  assert.match(page, /order\?\.sandbox/);
  // A preview quote disables the send button with its own reason.
  assert.match(page, /quote\.mode === 'SANDBOX'/);
});

// ─── 2. The page reads the server's route, not the flag ──────────────────

test('the overview says whether a swap route exists and which kind, from the same resolver the order uses', async () => {
  const { handleTreasuryOverview } = await import('../lib/server/treasury-wallet.ts');
  const base = {
    flags: { walletSwaps: true, fundReferral: false, tokenizedStocks: false, issuerEligibilityConfirmed: true },
    issuer: 'a tokenized treasury issuer',
    fundManager: 'a fund manager',
    readNav: async () => NAV,
    apyPct: () => 4,
    resolveWallet: async () => ({ ok: true, address: WALLET }),
    readBalances: async () => ({ usdcMinor: 1n, usdyMinor: 1n }),
    listOrders: async () => [],
  };
  // Production with the flag on: no live route, so the overview says so.
  const prod = await handleTreasuryOverview(OWNER, {
    ...base,
    resolveRoute: () => ({ ok: false, status: 503, error: 'This server has no live swap route for the business wallet yet, so nothing is sent to your signers.' }),
  });
  assert.equal(prod.body.swapRoute.ok, false);
  assert.match(prod.body.swapRoute.reason, /no live swap route/);
  const sandbox = await handleTreasuryOverview(OWNER, { ...base, resolveRoute: () => ({ ok: true, route: { kind: 'sandbox', prepare: async () => ({ providerRef: 'x' }) } }) });
  assert.deepEqual({ ok: sandbox.body.swapRoute.ok, kind: sandbox.body.swapRoute.kind }, { ok: true, kind: 'sandbox' });

  const deps = await source('lib/server/treasury-deps.ts');
  assert.match(deps, /liveOverviewDeps[\s\S]*resolveRoute: \(\) => resolveTreasurySwapRoute\(\)/);
  const page = await source('app/dashboard/treasury/page.tsx');
  assert.match(page, /overview\.swapRoute/);
  assert.doesNotMatch(page, /flags\.walletSwaps/, 'the page does not decide from the raw flag');
});

// ─── 3. A replay of a lapsed order says it lapsed ────────────────────────

test('replaying an order past its expiry returns it as expired, as the list does', async () => {
  const { client, db } = await migratedDb();
  const { handleTreasuryOrder } = await import('../lib/server/treasury-wallet.ts');
  const { ORDER_TTL_MS, listTreasuryOrders } = await import('../lib/server/treasury-wallet-orders.ts');
  const body = { intentId: INTENT, direction: 'swap', amount: '100', minOutMinor: '1' };
  const made = await orderDeps({ now: () => new Date(Date.now() - ORDER_TTL_MS - 60_000) });
  const first = await handleTreasuryOrder(db, OWNER, body, made.deps);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const replay = await handleTreasuryOrder(db, OWNER, body, orderDeps().deps);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.order.status, 'expired');
  assert.equal((await listTreasuryOrders(db, 'acme'))[0].status, 'expired');
  await client.close();
});

// ─── 4. A stale price ────────────────────────────────────────────────────

test('a swap in on a STALE price is not orderable; a redemption stays open, and no reason says not to act on it', async () => {
  const { client, db } = await migratedDb();
  const { handleTreasuryOrder, quoteTreasury } = await import('../lib/server/treasury-wallet.ts');
  const stale = { ...NAV, status: 'STALE' };
  const { deps } = orderDeps({ readNav: async () => stale });
  const swapQuote = await quoteTreasury('acme', 'swap', usdc('100'), deps);
  assert.equal(swapQuote.orderable, false);
  const swap = await handleTreasuryOrder(db, OWNER, { intentId: INTENT, direction: 'swap', amount: '100', minOutMinor: '1' }, deps);
  assert.equal(swap.status, 409);
  assert.equal(await count(client), 0);

  const redeemQuote = await quoteTreasury('acme', 'redeem', usdc('100'), deps);
  assert.equal(redeemQuote.orderable, true, 'a business can always get out');
  for (const r of [...swapQuote.reasons, ...redeemQuote.reasons]) assert.doesNotMatch(r, /not a quote to act on/);
  await client.close();
});

// ─── 5. Fund eligibility does not promise finality ───────────────────────

test('the eligibility module does not call a not-eligible answer final', async () => {
  const text = await source('lib/treasury/fund-eligibility.ts');
  assert.doesNotMatch(text.replace(/\s*\*\s*/g, ' '), /is final for these answers/);
});

// ─── 6. The BusinessAccount is splash_core's ─────────────────────────────

test('a BusinessAccount of another package is refused; splash_core\'s is read', async () => {
  const { businessAccountWallet } = await import('../lib/server/treasury-business-wallet.ts');
  const json = { wallet: WALLET };
  assert.throws(() => businessAccountWallet(`${FOREIGN}::business_account::BusinessAccount`, json, [CORE]), /another/);
  assert.throws(() => businessAccountWallet(`${CORE}::business_account::BusinessAccount`, json, []), /not configured/);
  assert.equal(businessAccountWallet(`${CORE}::business_account::BusinessAccount`, json, [CORE]), WALLET);
  // Short and long spellings of the same id are the same package.
  assert.equal(businessAccountWallet(`0x${'12'.repeat(32)}::business_account::BusinessAccount`, json, [CORE.toUpperCase().replace('0X', '0x')]), WALLET);
});

// ─── 7. One network for the wallet and its balances ──────────────────────

test('when the wallet network is not the network USDY is read on, Treasury refuses and says why', async () => {
  const { treasuryNetworkRefusal, handleTreasuryOverview } = await import('../lib/server/treasury-wallet.ts');
  assert.equal(treasuryNetworkRefusal('mainnet'), null);
  const refusal = treasuryNetworkRefusal('testnet');
  assert.equal(refusal.ok, false);
  assert.equal(refusal.code, 'network_mismatch');
  assert.doesNotMatch(refusal.error, /testnet/i, 'customer copy names no test network');
  const read = await handleTreasuryOverview(OWNER, {
    flags: { walletSwaps: true, fundReferral: false, tokenizedStocks: false, issuerEligibilityConfirmed: true },
    issuer: 'i', fundManager: 'f', readNav: async () => NAV, apyPct: () => 4,
    resolveWallet: async () => refusal, readBalances: async () => { throw new Error('not read'); }, listOrders: async () => [],
    resolveRoute: () => ({ ok: false, status: 503, error: 'x' }),
  });
  assert.equal(read.body.wallet, 'network');
  const wallet = await source('lib/server/treasury-business-wallet.ts');
  assert.match(wallet, /treasuryNetworkRefusal\(SUI_NETWORK\)/);
  const page = await source('app/dashboard/treasury/page.tsx');
  assert.match(page, /network:/);
});

// ─── 8. Quote copy ───────────────────────────────────────────────────────

test('no quote reason has an em dash or an operator setting in it', async () => {
  const { treasuryQuote, treasuryRedeemQuote } = await import('../lib/payments/treasury-usdy.ts');
  const reasons = [];
  for (const nav of [NAV, { ...NAV, status: 'STALE' }, { ...NAV, asOf: null }, { status: 'UNAVAILABLE', priceMicros: null }]) {
    for (const confirmed of [true, false]) {
      reasons.push(...treasuryQuote({ state: 'ACTIVE', country: 'MY', usdcInMinor: usdc('10'), nav, apyPct: 4, ondoEligibilityConfirmed: confirmed }).reasons);
      reasons.push(...treasuryRedeemQuote({ usdyInMinor: usdc('10'), nav, ondoEligibilityConfirmed: confirmed }).reasons);
    }
  }
  assert.ok(reasons.length > 5);
  for (const r of reasons) {
    assert.doesNotMatch(r, /[—–]/, r);
    assert.doesNotMatch(r, /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/, r);
  }
});

// ─── 9. The chart and the page at phone width ────────────────────────────

test('the projection is reachable by keyboard, and the page leaves room for the floating button', async () => {
  const page = await source('app/dashboard/treasury/page.tsx');
  assert.match(page, /tabIndex=\{0\}/);
  assert.match(page, /ArrowRight'[\s\S]{0,200}ArrowLeft'|ArrowLeft'[\s\S]{0,200}ArrowRight'/);
  assert.match(page, /onFocus=/);
  assert.match(page, /pb-24 sm:pb-0|pb-28 sm:pb-0/);
});
