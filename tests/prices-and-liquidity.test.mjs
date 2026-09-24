import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { getPegStatus } from '../lib/server/peg.ts';
import { NO_DOLLAR_PRICE_REASON, resolvePegAttestation } from '../lib/server/peg-attestation.ts';
import { getUsdyRedemptionPrice } from '../lib/server/usdy.ts';
import { quoteUsdcToUsdyOnSui } from '../lib/server/usdy-liquidity.ts';
import { MAX_MARKET_SHORTFALL_BPS, treasuryQuote, usdcValueOfUsdy } from '../lib/payments/treasury-usdy.ts';
import { parseUsdcMinor } from '../lib/payments/stablecoin-lane.ts';

/**
 * Prices that are measured or absent, never invented.
 *
 * Pyth Hermes has required a paid API key since 26 August 2026, and its
 * adapter used to turn the 401 into a mock $1.00, so the peg check and the
 * on-chain peg refresher ran on made-up prices. Splash now reads DeepBook
 * alone: free, on chain, and no reading means no peg. And USDY on Sui
 * has very little DEX liquidity, so a treasury quote must say what the market
 * can actually fill, not only what the USDC is worth at the redemption rate.
 */

const usdc = (s) => parseUsdcMinor(s);
const realFetch = globalThis.fetch;

/** Route fetch by URL; record every call. */
function stubFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    calls.push({ url: href, headers: init.headers ?? {} });
    for (const [match, respond] of routes) {
      if (href.includes(match)) return respond(href, init);
    }
    return new Response('no route in test', { status: 599 });
  };
  return calls;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const deepbookPegged = [{ trading_pairs: 'USDT_USDC', base_currency: 'USDT', quote_currency: 'USDC', last_price: 1.0, highest_bid: 0.9999, lowest_ask: 1.0001, base_volume: 50_000 }];

test.afterEach(() => {
  globalThis.fetch = realFetch;
});

// ─── The peg decision: DeepBook alone ───────────────────────────────────────

test('no DeepBook reading: the peg is unverified, and unverified is not pegged', async () => {
  stubFetch([['/summary', () => new Response('down', { status: 503 })]]);
  const peg = await getPegStatus({});
  assert.equal(peg.pegged, false, 'this used to pass on a mock $1.00');
  assert.equal(peg.primary, 'none');
  assert.equal(peg.deepbook, null);
});

test('DeepBook decides, and nothing asks Pyth', async () => {
  const calls = stubFetch([['/summary', () => json(deepbookPegged)]]);
  const peg = await getPegStatus({});
  assert.equal(peg.pegged, true);
  assert.equal(peg.primary, 'deepbook');
  assert.equal(peg.deepbook.pair, 'USDT_USDC');
  assert.equal(peg.deepbook.midPrice, 1);
  assert.equal(peg.deepbook.deviationBps, 0);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^https:\/\/deepbook-indexer\.mainnet\.mystenlabs\.com\/summary$/);
});

test('a drift past the tolerance is a broken peg, measured on DeepBook', async () => {
  const drifted = [{ ...deepbookPegged[0], highest_bid: 0.9780, lowest_ask: 0.9800 }];
  stubFetch([['/summary', () => json(drifted)]]);
  const peg = await getPegStatus({});
  assert.equal(peg.primary, 'deepbook');
  assert.equal(peg.pegged, false);
  assert.equal(peg.deepbook.deviationBps, 210, 'mid 0.979 is 210 bps from 1');
  assert.equal((await getPegStatus({ DEEPBOOK_PEG_TOLERANCE_BPS: '250' })).pegged, true, 'the tolerance is configurable');
});

// ─── The USDY price ─────────────────────────────────────────────────────────

test('USDY: the configured price with its time, in integer micros, and no network call', async () => {
  const calls = stubFetch([]);
  const fresh = await getUsdyRedemptionPrice({ USDY_REDEMPTION_USD: '1.1391', USDY_REDEMPTION_AS_OF: new Date().toISOString() });
  assert.equal(fresh.status, 'LIVE');
  assert.equal(fresh.source, 'env:USDY_REDEMPTION_USD');
  assert.equal(fresh.priceMicros, 1_139_100n);
  assert.equal(calls.length, 0);
});

test('USDY: an old price is STALE, a price without its time is STALE, and nothing is not $1.00', async () => {
  const old = await getUsdyRedemptionPrice({ USDY_REDEMPTION_USD: '1.14', USDY_REDEMPTION_AS_OF: new Date(Date.now() - 7 * 3600_000).toISOString() });
  assert.equal(old.status, 'STALE');
  assert.equal((await getUsdyRedemptionPrice({ USDY_REDEMPTION_USD: '1.14' })).status, 'STALE');
  const none = await getUsdyRedemptionPrice({});
  assert.equal(none.status, 'UNAVAILABLE');
  assert.equal(none.priceMicros, null);
});

// ─── What Sui can actually fill ─────────────────────────────────────────────

const cetusOk = (amountIn, amountOut) => json({
  code: 200,
  msg: 'Success',
  data: {
    amount_in: amountIn,
    amount_out: amountOut,
    deviation_ratio: '-0.7',
    routes: [{ path: [{ provider: 'KRIYA' }, { provider: 'FLOWX' }] }, { path: [{ provider: 'KRIYA' }] }],
  },
});

test('liquidity: the best route’s USDY, with the DEXes it used; read-only', async () => {
  const calls = [];
  const q = await quoteUsdcToUsdyOnSui(usdc('1000'), {
    fetcher: async (url) => {
      calls.push(String(url));
      return cetusOk(1_000_000_000, 257_252_013);
    },
    now: () => new Date('2026-09-24T12:00:00Z'),
  });
  assert.equal(q.available, true);
  assert.equal(q.usdyOutMinor, 257_252_013n);
  assert.deepEqual(q.providers, ['FLOWX', 'KRIYA']);
  assert.equal(q.asOf, '2026-09-24T12:00:00.000Z');
  assert.match(calls[0], /^https:\/\/api-sui\.cetus\.zone\/router_v2\/find_routes\?/);
  assert.match(calls[0], /by_amount_in=true/);
  assert.match(decodeURIComponent(calls[0]), /::usdy::USDY/);
});

test('liquidity: a refused size, an HTTP error, a mismatched quote and zero are all "no route"', async () => {
  const refused = await quoteUsdcToUsdyOnSui(usdc('10000'), { fetcher: async () => json({ code: 400, msg: 'quote deviation error' }) });
  assert.equal(refused.available, false);
  assert.match(refused.reason, /not enough USDY liquidity on Sui/);

  const http = await quoteUsdcToUsdyOnSui(usdc('10'), { fetcher: async () => new Response('bad gateway', { status: 502 }) });
  assert.equal(http.available, false);

  const mismatch = await quoteUsdcToUsdyOnSui(usdc('10'), { fetcher: async () => cetusOk(1, 1) });
  assert.equal(mismatch.available, false, 'a quote for a different amount is not this quote');

  const zero = await quoteUsdcToUsdyOnSui(0n, { fetcher: async () => { throw new Error('must not be called'); } });
  assert.equal(zero.available, false);
});

// ─── The treasury quote, with the market in it ──────────────────────────────

const NAV = { status: 'LIVE', priceMicros: 1_140_000n, asOf: '2026-09-24T00:00:00Z' };
const base = { state: 'ACTIVE', country: 'MY', nav: NAV, apyPct: 4, ondoEligibilityConfirmed: false };

test('a deep enough market is fillable, and the slippage floor comes from the market', () => {
  const inMinor = usdc('100');
  // 87.50 USDY is worth 99.75 at 1.14: 25 bps short, inside the limit.
  const q = treasuryQuote({ ...base, usdcInMinor: inMinor, market: { usdyOutMinor: 87_500_000n, providers: ['CETUS'], asOf: 't' } });
  assert.equal(q.fillable, true);
  assert.equal(q.market.valueMinor, usdcValueOfUsdy(87_500_000n, 1_140_000n));
  assert.ok(q.market.shortfallBps <= MAX_MARKET_SHORTFALL_BPS);
  assert.equal(q.minUsdyOutMinor, (87_500_000n * 9_950n) / 10_000n);
});

test('a thin market is refused in plain words, and projections start from what would be held', () => {
  const inMinor = usdc('1000');
  const q = treasuryQuote({ ...base, usdcInMinor: inMinor, market: { usdyOutMinor: 257_252_013n, providers: ['KRIYA'], asOf: 't' } });
  assert.equal(q.fillable, false);
  assert.ok(q.market.shortfallBps > 7_000, `about 70% short, got ${q.market.shortfallBps}`);
  const reason = q.reasons.find((r) => r.startsWith('On Sui right now'));
  assert.ok(reason, 'the refusal says what the market would do');
  assert.match(reason, /1,000\.00 USDC buys 257\.25/);
  assert.match(reason, /not enough USDY liquidity on Sui/);
  assert.ok(q.projections[0].valueMinor < inMinor, 'growth is projected from the smaller position');
  assert.ok(q.projections[0].yieldMinor < 0n, 'and against the USDC paid, it shows the loss');
});

test('no route is not fillable; a locked business is never checked against the market', () => {
  const noRoute = treasuryQuote({ ...base, usdcInMinor: usdc('10000'), market: { unavailable: 'No Sui route can fill this size.' } });
  assert.equal(noRoute.fillable, false);
  assert.ok(noRoute.reasons.includes('No Sui route can fill this size.'));
  assert.equal(noRoute.market, null);

  const locked = treasuryQuote({ ...base, state: 'REGISTERED', usdcInMinor: usdc('100'), market: { usdyOutMinor: 1n, providers: [], asOf: 't' } });
  assert.equal(locked.allowed, false);
  assert.equal(locked.fillable, null);

  const unchecked = treasuryQuote({ ...base, usdcInMinor: usdc('100') });
  assert.equal(unchecked.fillable, null, 'no market input, no claim about the market');
});

// ─── The places that used to act on a mock ──────────────────────────────────

function code(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
}

test('the on-chain peg refresher pushes nothing without a dollar price', async () => {
  const route = code(await readFile(new URL('../app/api/cron/update-peg/route.ts', import.meta.url), 'utf8'));
  const refuse = route.indexOf('if (!attestation.push)');
  const push = route.indexOf('refreshPegOnSui(');
  assert.ok(refuse > 0 && push > refuse, 'the refusal comes before the push');

  // DeepBook prices USDT in USDC; update_peg wants each coin against the dollar.
  assert.deepEqual(await resolvePegAttestation({}), { push: false, reason: NO_DOLLAR_PRICE_REASON });
  // Only a run that asked for mocks by name attests one.
  assert.deepEqual(await resolvePegAttestation({ USE_MOCK_APIS: 'true' }), { push: true, usdcDeviationPpm: 0, usdtDeviationPpm: 0, primary: 'mock' });
});

test('settlement names an unverified peg, and nothing reads Pyth', async () => {
  const authorize = code(await readFile(new URL('../app/api/transfers/authorize/route.ts', import.meta.url), 'utf8'));
  assert.match(authorize, /pegStatus\.primary === 'none'/);
  assert.match(authorize, /code: 'peg_unverified'/);
  assert.match(authorize, /await getPegStatus\(\)/);
  for (const file of ['../app/api/transfers/authorize/route.ts', '../app/api/quotes/peg-status/route.ts', '../app/api/cron/update-peg/route.ts', '../lib/server/usdy.ts', '../lib/server/peg-attestation.ts', '../app/admin/(console)/transactions/page.tsx']) {
    assert.doesNotMatch(code(await readFile(new URL(file, import.meta.url), 'utf8')), /pyth/i, file);
  }
  const copilot = code(await readFile(new URL('../lib/server/copilot.ts', import.meta.url), 'utf8'));
  assert.doesNotMatch(copilot, /bps, Pyth\)`/, 'Zeke names the source that measured the peg');
  const zeke = await readFile(new URL('../lib/agent/oxwal.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(zeke, /pushed on chain in the same transaction/, 'Zeke does not claim an on-chain peg push that does not happen');
});
