import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { hermesConfig, PRICE_IDS, PythAdapter } from '../lib/server/pyth.ts';
import { getUsdyRedemptionPrice } from '../lib/server/usdy.ts';
import { quoteUsdcToUsdyOnSui } from '../lib/server/usdy-liquidity.ts';
import { MAX_MARKET_SHORTFALL_BPS, treasuryQuote, usdcValueOfUsdy } from '../lib/payments/treasury-usdy.ts';
import { parseUsdcMinor } from '../lib/payments/stablecoin-lane.ts';

/**
 * Prices that are measured or absent, never invented.
 *
 * Pyth Hermes has required an API key since 26 August 2026 and answers 401
 * without one. The adapter used to turn that into a mock $1.00, so the peg
 * check and the on-chain peg refresher ran on made-up prices. And USDY on Sui
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

function hermesBody(entries) {
  return {
    parsed: entries.map(([id, price, expo, publishTime]) => ({
      id: id.replace(/^0x/, ''),
      price: { price, conf: '10000', expo, publish_time: publishTime },
    })),
  };
}

const NOW_S = Math.floor(Date.now() / 1000);
const deepbookPegged = [{ trading_pairs: 'USDT_USDC', base_currency: 'USDT', quote_currency: 'USDC', last_price: 1.0, highest_bid: 0.9999, lowest_ask: 1.0001, base_volume: 50_000 }];

test.afterEach(() => {
  globalThis.fetch = realFetch;
});

// ─── Pyth ───────────────────────────────────────────────────────────────────

test('no PYTH_API_KEY: Pyth is off, nothing is fetched, and no $1.00 appears', async () => {
  const calls = stubFetch([]);
  const reading = await new PythAdapter().getStablecoinPrices({});
  assert.equal(reading.available, false);
  assert.equal(reading.code, 'no_api_key');
  assert.match(reading.reason, /26 August 2026/);
  assert.equal(calls.length, 0, 'a request that can only 401 is not sent');
});

test('with a key, Hermes is asked with a Bearer token and the prices are exact', async () => {
  const calls = stubFetch([
    ['/v2/updates/price/latest', () => json(hermesBody([
      [PRICE_IDS.USDC_USD, '99990000', -8, NOW_S],
      [PRICE_IDS.USDT_USD, '100010000', -8, NOW_S],
    ]))],
  ]);
  const reading = await new PythAdapter().getStablecoinPrices({ PYTH_API_KEY: ' key-123 ' });
  assert.equal(reading.available, true);
  assert.equal(reading.usdc.price, 0.9999);
  assert.equal(reading.usdc.source, 'pyth');
  assert.equal(reading.usdc.priceRate.scaled, 99_990_000n);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.Authorization, 'Bearer key-123');
  assert.ok(calls[0].url.startsWith('https://hermes.pyth.network/v2/updates/price/latest?'));
});

test('a rejected key and an unreachable Hermes are both "unavailable", with the reason', async () => {
  stubFetch([['/v2/updates/price/latest', () => new Response('unauthorized', { status: 401 })]]);
  const rejected = await new PythAdapter().getStablecoinPrices({ PYTH_API_KEY: 'bad' });
  assert.equal(rejected.available, false);
  assert.equal(rejected.code, 'rejected');

  globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
  const down = await new PythAdapter().getStablecoinPrices({ PYTH_API_KEY: 'k' });
  assert.equal(down.available, false);
  assert.equal(down.code, 'unreachable');
});

test('PYTH_HERMES_URL moves the endpoint; USE_MOCK_APIS is the only way to a mock', async () => {
  assert.deepEqual(hermesConfig({ PYTH_HERMES_URL: 'https://pyth.dourolabs.app/hermes/', PYTH_API_KEY: 'k' }), {
    baseUrl: 'https://pyth.dourolabs.app/hermes',
    apiKey: 'k',
  });
  const mocked = await new PythAdapter().getStablecoinPrices({ USE_MOCK_APIS: 'true' });
  assert.equal(mocked.available, true);
  assert.equal(mocked.usdc.source, 'mock');
});

// ─── The peg decision ───────────────────────────────────────────────────────

test('no DeepBook and no Pyth: the peg is unverified, and unverified is not pegged', async () => {
  stubFetch([['/summary', () => new Response('down', { status: 503 })]]);
  const peg = await new PythAdapter().getPegStatus({});
  assert.equal(peg.pegged, false, 'this used to pass on the mock $1.00');
  assert.equal(peg.primary, 'none');
  assert.equal(peg.usdcUsd, null);
  assert.equal(peg.pyth.available, false);
  assert.equal(peg.confirmedBy, 0);
});

test('DeepBook alone decides when Pyth is off, and Pyth is not counted as a confirmation', async () => {
  stubFetch([['/summary', () => json(deepbookPegged)]]);
  const peg = await new PythAdapter().getPegStatus({});
  assert.equal(peg.pegged, true);
  assert.equal(peg.primary, 'deepbook');
  assert.equal(peg.sources.pyth, null);
  assert.equal(peg.confirmedBy, 1);
  assert.equal(peg.divergenceBps, null);
});

test('with both sources, both confirm and the divergence is measured', async () => {
  stubFetch([
    ['/summary', () => json(deepbookPegged)],
    ['/v2/updates/price/latest', () => json(hermesBody([
      [PRICE_IDS.USDC_USD, '100000000', -8, NOW_S],
      [PRICE_IDS.USDT_USD, '100000000', -8, NOW_S],
    ]))],
  ]);
  const peg = await new PythAdapter().getPegStatus({ PYTH_API_KEY: 'k' });
  assert.equal(peg.primary, 'deepbook');
  assert.equal(peg.confirmedBy, 2);
  assert.equal(peg.deviationPpm, 0);
  assert.equal(typeof peg.divergenceBps, 'number');
});

// ─── The USDY price ─────────────────────────────────────────────────────────

test('USDY: Pyth’s redemption rate when a key is set, dated by Pyth, in integer micros', async () => {
  stubFetch([['/v2/updates/price/latest', (href) => {
    assert.ok(href.includes(encodeURIComponent(PRICE_IDS.USDY_USD_RR)));
    return json(hermesBody([[PRICE_IDS.USDY_USD_RR, '114012345', -8, NOW_S - 60]]));
  }]]);
  const nav = await getUsdyRedemptionPrice({ PYTH_API_KEY: 'k' });
  assert.equal(nav.status, 'LIVE');
  assert.equal(nav.priceMicros, 1_140_123n, '1.14012345 → 1.140123, half-even');
  assert.equal(nav.source, 'pyth:Crypto.USDY/USD.RR');
  assert.equal(nav.asOf, new Date((NOW_S - 60) * 1000).toISOString());
});

test('USDY: an old Pyth publish is STALE; a Pyth failure falls back to the dated configured price', async () => {
  stubFetch([['/v2/updates/price/latest', () => json(hermesBody([[PRICE_IDS.USDY_USD_RR, '114000000', -8, NOW_S - 7 * 3600]]))]]);
  assert.equal((await getUsdyRedemptionPrice({ PYTH_API_KEY: 'k' })).status, 'STALE');

  stubFetch([['/v2/updates/price/latest', () => new Response('unauthorized', { status: 401 })]]);
  const fallback = await getUsdyRedemptionPrice({
    PYTH_API_KEY: 'k',
    USDY_REDEMPTION_USD: '1.1391',
    USDY_REDEMPTION_AS_OF: new Date().toISOString(),
  });
  assert.equal(fallback.status, 'LIVE');
  assert.equal(fallback.source, 'env:USDY_REDEMPTION_USD');
  assert.equal(fallback.priceMicros, 1_139_100n);

  // No key and no configured price: nothing, not $1.00.
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

test('the on-chain peg refresher pushes nothing without a live price', async () => {
  const route = code(await readFile(new URL('../app/api/cron/update-peg/route.ts', import.meta.url), 'utf8'));
  const refuse = route.indexOf('if (!reading.available)');
  const push = route.indexOf('refreshPegOnSui(');
  assert.ok(refuse > 0 && push > refuse, 'the refusal comes before the push');
});

test('settlement names an unverified peg, and nothing but USE_MOCK_APIS reaches the mock', async () => {
  const authorize = code(await readFile(new URL('../app/api/transfers/authorize/route.ts', import.meta.url), 'utf8'));
  assert.match(authorize, /pegStatus\.primary === 'none'/);
  assert.match(authorize, /code: 'peg_unverified'/);
  const pyth = code(await readFile(new URL('../lib/server/pyth.ts', import.meta.url), 'utf8'));
  assert.equal(pyth.match(/mockPrice\('USDC\/USD'\)/g).length, 1, 'one mock, behind USE_MOCK_APIS');
  assert.match(pyth, /if \(env\.USE_MOCK_APIS === 'true'\) \{\s*return \{ available: true, usdc: mockPrice/);
  const copilot = code(await readFile(new URL('../lib/server/copilot.ts', import.meta.url), 'utf8'));
  assert.doesNotMatch(copilot, /bps, Pyth\)`/, 'Zeke names the source that measured the peg');
});
