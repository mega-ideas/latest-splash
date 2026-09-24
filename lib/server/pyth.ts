import { divRound, formatRate, parseRate, type Rate } from '../money.ts';
import { getDeepbookStablePrice } from '@/lib/server/deepbook';

/**
 * Pyth prices, read from Hermes.
 *
 * Since the Pyth Core upgrade (26 August 2026, 16:00 UTC) every Hermes request
 * needs a Pyth data-plan key, sent as `Authorization: Bearer <key>`. Without
 * one Hermes answers 401 — and this adapter used to catch that and return a
 * mock $1.00, so from that day the peg check, Zeke's peg note and the on-chain
 * peg refresher all ran on a price nobody had measured. Now no key, or any
 * failure, means no Pyth reading: callers are told Pyth is unavailable and
 * why. The fabricated $1.00 exists only when USE_MOCK_APIS=true asks for it.
 *
 * Env:
 *   PYTH_API_KEY     a Pyth data-plan key (Pyth Terminal). Unset: Pyth is off.
 *   PYTH_HERMES_URL  default https://hermes.pyth.network. Pyth also documents
 *                    https://pyth.dourolabs.app/hermes; routes are the same.
 */

const DEFAULT_HERMES = 'https://hermes.pyth.network';
const HERMES_TIMEOUT_MS = 3_000;

export const PRICE_IDS = {
  USDC_USD: '0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a',
  USDT_USD: '0x2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b',
  /** Ondo USDY redemption rate, `Crypto.USDY/USD.RR` — what one USDY redeems for. */
  USDY_USD_RR: '0xe3d1723999820435ebab53003a542ff26847720692af92523eea613a9a28d500',
} as const;

export interface PriceData {
  symbol: string;
  /** Display value. `priceRate` is the exact one; compare with that. */
  price: number;
  priceRate: Rate;
  confidence: number;
  /** Unix seconds: when Pyth published this price. */
  publishTime: number;
  source: 'pyth' | 'mock';
}

export interface DeepbookPeg {
  pair: string;
  midPrice: number;
  deviationBps: number;
  pegged: boolean;
  source: 'deepbook' | 'mock';
}

export interface PegStatus {
  /** Pyth's USDC/USD and USDT/USD, or null when Pyth is off or did not answer. */
  usdcUsd: PriceData | null;
  usdtUsd: PriceData | null;
  /** Whether Pyth answered, and if not, why (no key, key rejected, unreachable). */
  pyth: { available: boolean; reason: string | null };
  /** |USDC − USDT| / USDC in ppm, from Pyth. null without Pyth. */
  deviationPpm: number | null;
  pegged: boolean;
  usdtCheaper: boolean | null;
  spreadBps: number | null;
  /** DeepBook V3 CLOB cross-check (second source). null when unavailable. */
  deepbook: DeepbookPeg | null;
  /** Per-source peg confirmation. null when that source gave no reading. */
  sources: { pyth: boolean | null; deepbook: boolean | null };
  /** How many independent sources currently confirm the peg. */
  confirmedBy: number;
  /** |DeepBook USDT/USDC mid − Pyth-implied USDT/USDC| in bps. null if unavailable. */
  divergenceBps: number | null;
  /**
   * Which source decided: DeepBook first, Pyth second. 'none' when neither
   * gave a reading — and then `pegged` is false, because a peg nobody
   * measured is not a peg anyone may settle on.
   */
  primary: 'deepbook' | 'pyth' | 'none';
}

export type PythUnavailableCode = 'no_api_key' | 'rejected' | 'http_error' | 'unreachable' | 'missing_feed';

/** Pyth gave no reading. Never a price: the caller decides what "no price" means. */
export class PythUnavailableError extends Error {
  readonly code: PythUnavailableCode;

  constructor(code: PythUnavailableCode, message: string) {
    super(message);
    this.name = 'PythUnavailableError';
    this.code = code;
  }
}

export function hermesConfig(env: NodeJS.ProcessEnv = process.env): { baseUrl: string; apiKey: string | null } {
  const apiKey = (env.PYTH_API_KEY ?? '').trim() || null;
  const baseUrl = ((env.PYTH_HERMES_URL ?? '').trim() || DEFAULT_HERMES).replace(/\/+$/, '');
  return { baseUrl, apiKey };
}

/**
 * A Hermes price is an integer string plus a base-10 exponent — already a
 * scaled integer, and exactly what a Rate is. This used to compute
 * `parseFloat(priceStr) * Math.pow(10, expo)`, converting a value that
 * arrived exact into a double before anything compared it. A peg gate that
 * halts settlement should not be deciding on rounding noise.
 *
 * Pyth exponents are negative (−8 is typical). A positive one would mean a
 * whole-number price, which is still representable.
 */
function parseHermesPrice(priceStr: string, expo: number): Rate {
  const digits = BigInt(priceStr);
  if (expo <= 0) return { scaled: digits, scale: -expo };
  return { scaled: digits * 10n ** BigInt(expo), scale: 0 };
}

/** Rates for display and for the JSON body, where a bigint cannot go. */
function rateToNumber(rate: Rate): number {
  return Number(formatRate(rate));
}

function mockPrice(symbol: string): PriceData {
  return {
    symbol,
    price: 1.0,
    priceRate: parseRate('1'),
    confidence: 0.0001,
    publishTime: Math.floor(Date.now() / 1000),
    source: 'mock',
  };
}

/** Latest prices for `ids`, keyed by 0x-prefixed id. Throws PythUnavailableError. */
export async function fetchHermesPrices(
  ids: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, PriceData>> {
  const { baseUrl, apiKey } = hermesConfig(env);
  if (!apiKey) {
    throw new PythUnavailableError(
      'no_api_key',
      'Pyth is not configured: Hermes has required an API key (PYTH_API_KEY) since 26 August 2026.',
    );
  }
  const params = ids.map((id) => `ids[]=${encodeURIComponent(id)}`).join('&');
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/v2/updates/price/latest?${params}&parsed=true`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(HERMES_TIMEOUT_MS),
      next: { revalidate: 15 },
    } as RequestInit);
  } catch (error) {
    throw new PythUnavailableError('unreachable', `Pyth Hermes did not answer: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
  if (response.status === 401 || response.status === 403) {
    throw new PythUnavailableError('rejected', `Pyth Hermes refused the API key (HTTP ${response.status}).`);
  }
  if (!response.ok) throw new PythUnavailableError('http_error', `Pyth Hermes answered HTTP ${response.status}.`);

  let body: { parsed?: Array<{ id: string; price: { price: string; conf: string; expo: number; publish_time: number } }> };
  try {
    body = await response.json();
  } catch {
    throw new PythUnavailableError('http_error', 'Pyth Hermes returned a body that is not JSON.');
  }
  const out: Record<string, PriceData> = {};
  for (const item of body.parsed ?? []) {
    const id = item.id.startsWith('0x') ? item.id : `0x${item.id}`;
    const normalised = parseHermesPrice(item.price.price, item.price.expo);
    const confidence = parseHermesPrice(item.price.conf, item.price.expo);
    out[id] = {
      symbol: id,
      price: rateToNumber(normalised),
      priceRate: normalised,
      confidence: rateToNumber(confidence),
      publishTime: item.price.publish_time,
      source: 'pyth',
    };
  }
  return out;
}

/** Ondo's USDY redemption rate from Pyth. Throws PythUnavailableError. */
export async function fetchUsdyRedemptionRate(env: NodeJS.ProcessEnv = process.env): Promise<PriceData> {
  const prices = await fetchHermesPrices([PRICE_IDS.USDY_USD_RR], env);
  const rate = prices[PRICE_IDS.USDY_USD_RR];
  if (!rate) throw new PythUnavailableError('missing_feed', 'Pyth returned no USDY redemption rate.');
  return rate;
}

export type StablecoinPrices =
  | { available: true; usdc: PriceData; usdt: PriceData }
  | { available: false; code: PythUnavailableCode; reason: string };

export class PythAdapter {
  async getStablecoinPrices(env: NodeJS.ProcessEnv = process.env): Promise<StablecoinPrices> {
    if (env.USE_MOCK_APIS === 'true') {
      return { available: true, usdc: mockPrice('USDC/USD'), usdt: mockPrice('USDT/USD') };
    }
    try {
      const prices = await fetchHermesPrices([PRICE_IDS.USDC_USD, PRICE_IDS.USDT_USD], env);
      const usdc = prices[PRICE_IDS.USDC_USD];
      const usdt = prices[PRICE_IDS.USDT_USD];
      if (!usdc || !usdt) return { available: false, code: 'missing_feed', reason: 'Pyth returned no USDC or USDT price.' };
      return { available: true, usdc, usdt };
    } catch (error) {
      if (error instanceof PythUnavailableError) return { available: false, code: error.code, reason: error.message };
      return { available: false, code: 'unreachable', reason: error instanceof Error ? error.message : 'Pyth failed.' };
    }
  }

  async getPegStatus(env: NodeJS.ProcessEnv = process.env): Promise<PegStatus> {
    // Pyth (oracle) and DeepBook (on-chain CLOB) fetched in parallel — two
    // independent sources so peg health never rests on a single feed.
    const [reading, dbStable] = await Promise.all([
      this.getStablecoinPrices(env),
      getDeepbookStablePrice(),
    ]);

    const maxDeviationPpm = 3_000;
    // |price − 1| in parts per million, exactly, at the feed’s own scale.
    const ppmFromOne = (r: Rate): number => {
      const one = 10n ** BigInt(r.scale);
      const drift = r.scaled > one ? r.scaled - one : one - r.scaled;
      return Number(divRound(drift * 1_000_000n, one, 'half-even'));
    };

    let pythPegged: boolean | null = null;
    let spreadBps: number | null = null;
    let deviationPpm: number | null = null;
    let usdcScaled = 0n;
    let usdtScaled = 0n;
    if (reading.available) {
      const usdcDevPpm = ppmFromOne(reading.usdc.priceRate);
      const usdtDevPpm = ppmFromOne(reading.usdt.priceRate);
      // Peg health is judged on price deviation from $1.00. We intentionally do
      // NOT block the off-chain pre-check on Pyth publish-time staleness: demo/CI
      // clocks can skew far from Pyth's real publish times and produce false
      // "stale" positives that wrongly block every transfer. Staleness is still
      // enforced on-chain by peg_monitor::assert_pegged (60s) at real settlement.
      pythPegged = usdcDevPpm <= maxDeviationPpm && usdtDevPpm <= maxDeviationPpm;
      // (usdc − usdt) / usdc, in bps and ppm. Both feeds share a scale, so the
      // ratio is one integer division.
      usdcScaled = reading.usdc.priceRate.scaled;
      usdtScaled = reading.usdt.priceRate.scaled;
      const diff = usdcScaled - usdtScaled;
      const absDiff = diff < 0n ? -diff : diff;
      const usdcAbs = usdcScaled < 0n ? -usdcScaled : usdcScaled;
      spreadBps = usdcScaled === 0n ? 0 : Number(divRound(diff * 10_000n, usdcAbs, 'half-even'));
      deviationPpm = usdcScaled === 0n ? 0 : Number(divRound(absDiff * 1_000_000n, usdcAbs, 'half-even'));
    }

    // DeepBook V3 stable-pair mid as a second peg source.
    const dbToleranceBps = Number(process.env.DEEPBOOK_PEG_TOLERANCE_BPS ?? 100);
    const deepbook: DeepbookPeg | null = dbStable
      ? {
          pair: dbStable.pair,
          midPrice: rateToNumber(dbStable.midPrice),
          deviationBps: Number(dbStable.deviationBps),
          pegged: dbStable.deviationBps <= BigInt(Math.trunc(dbToleranceBps)),
          source: dbStable.source,
        }
      : null;

    // DeepBook (on-chain CLOB) is the PRIMARY peg gate — real, executable,
    // market-driven prices. Pyth (oracle) is the secondary confirmation and the
    // FALLBACK gate when the DeepBook feed is unavailable. With neither, the
    // peg is unverified and reported as not pegged: this used to fall through
    // to Pyth's mock $1.00 and pass.
    const pegged = deepbook ? deepbook.pegged : pythPegged === true;
    const primary: PegStatus['primary'] = deepbook ? 'deepbook' : pythPegged !== null ? 'pyth' : 'none';
    const sources = { deepbook: deepbook ? deepbook.pegged : null, pyth: pythPegged };
    const confirmedBy = (deepbook?.pegged ? 1 : 0) + (pythPegged ? 1 : 0);

    // Cross-source divergence: DeepBook USDT/USDC mid vs Pyth-implied USDT/USDC.
    // DeepBook mid against the Pyth-implied USDT/USDC, in bps. Integer
    // throughout so a divergence alarm cannot be triggered by rounding.
    const divergenceBps = ((): number | null => {
      if (!dbStable || !reading.available || usdcScaled === 0n) return null;
      const scale = dbStable.midPrice.scale;
      const unit = 10n ** BigInt(scale);
      const pythImplied = divRound(usdtScaled * unit, usdcScaled, 'half-even');
      const d = dbStable.midPrice.scaled - pythImplied;
      return Number(divRound((d < 0n ? -d : d) * 10_000n, unit, 'half-even'));
    })();

    return {
      usdcUsd: reading.available ? reading.usdc : null,
      usdtUsd: reading.available ? reading.usdt : null,
      pyth: { available: reading.available, reason: reading.available ? null : reading.reason },
      deviationPpm,
      pegged,
      usdtCheaper: spreadBps === null ? null : spreadBps > 0,
      spreadBps,
      deepbook,
      sources,
      confirmedBy,
      divergenceBps,
      primary,
    };
  }
}

export const pythAdapter = new PythAdapter();
