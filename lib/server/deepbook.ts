import { divRound, parseRate, type Rate } from '../money.ts';
/**
 * DeepBook V3 — Sui's native central-limit order book — as THE peg source
 * (lib/server/peg.ts). Pyth was a second source until its Hermes API began
 * requiring a paid key.
 *
 * Read path: the DeepBook Indexer REST `/summary` (per-pair last_price +
 * top-of-book), Mysten's public indexer: free, no key. The peg is a
 * real-world market fact, so we default to the MAINNET indexer even on a
 * testnet deployment; override via env. Never throws — returns null, and the
 * peg then counts as unverified (not pegged).
 *
 * WHICH book. The peg is USDC against other dollar stablecoins, read from an
 * explicit list of pools whose base coin was checked by type (2026-09-25):
 *
 *   USDSUI_USDC   usdSUI   0x44f8…b1c1::usdsui::USDSUI       (~584k a day)
 *   SUIUSDE_USDC  suiUSDe  0x41d5…1402::sui_usde::SUI_USDE   (~5k a day)
 *   USDT_USDC     USDT     0x375f…b068::usdt::USDT           (~1–2k a day)
 *
 * It used to be USDT_USDC alone. That book is so thin its best bid was 0.321
 * at one reading and 0.9994 minutes earlier, so payouts would pause and
 * resume with it, and anyone could move it for a dollar or two. Now every
 * listed book whose spread is within 1% counts, and the most-traded of them
 * decides: moving the price means moving the deepest book. A book wider than
 * 1% cannot place its mid within the 1% peg tolerance, so it is not a reading.
 *
 * Env:
 *   DEEPBOOK_INDEXER_URL    default https://deepbook-indexer.mainnet.mystenlabs.com
 *   DEEPBOOK_STABLE_PAIRS   comma-separated pools, default USDSUI_USDC,SUIUSDE_USDC,USDT_USDC
 *   DEEPBOOK_TIMEOUT_MS     default 2500 (settlement pre-check must stay snappy)
 */

const DEFAULT_INDEXER = 'https://deepbook-indexer.mainnet.mystenlabs.com';
export const DEFAULT_STABLE_PAIRS = ['USDSUI_USDC', 'SUIUSDE_USDC', 'USDT_USDC'] as const;
/** ask ÷ bid above this is not a usable book: 1%. */
const MAX_SPREAD_RATIO = 1.01;

export interface DeepbookStable {
  pair: string;
  /** Mid-price of the stable/stable pair (≈ 1.0 when pegged). */
  midPrice: Rate;
  lastPrice: Rate;
  /** |mid − 1| × 10_000 — peg deviation in basis points. */
  deviationBps: bigint;
  source: 'deepbook' | 'mock';
  asOf: string;
}

type SummaryItem = {
  trading_pairs: string;
  base_currency: string;
  quote_currency: string;
  last_price: number;
  highest_bid: number;
  lowest_ask: number;
  base_volume: number;
};

function indexerUrl(env: NodeJS.ProcessEnv): string {
  return (env.DEEPBOOK_INDEXER_URL?.trim() || DEFAULT_INDEXER).replace(/\/+$/, '');
}

export function stablePairs(env: NodeJS.ProcessEnv = process.env): string[] {
  const configured = (env.DEEPBOOK_STABLE_PAIRS ?? '').split(',').map((p) => p.trim().toUpperCase()).filter(Boolean);
  return configured.length > 0 ? configured : [...DEFAULT_STABLE_PAIRS];
}

/** A two-sided book no wider than 1%. */
function saneBook(item: SummaryItem): boolean {
  const bid = Number(item.highest_bid);
  const ask = Number(item.lowest_ask);
  return bid > 0 && ask > 0 && ask >= bid && ask / bid <= MAX_SPREAD_RATIO;
}

/**
 * The peg reading from the most-traded listed pool with a usable book.
 * Returns null on any error, timeout, or when no listed book is usable;
 * callers treat that as "no reading", never as a peg.
 */
export async function getDeepbookStablePrice(env: NodeJS.ProcessEnv = process.env): Promise<DeepbookStable | null> {
  if (env.USE_MOCK_APIS === 'true') {
    return { pair: 'MOCK_USDT_USDC', midPrice: parseRate('1'), lastPrice: parseRate('1'), deviationBps: 0n, source: 'mock', asOf: new Date().toISOString() };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(env.DEEPBOOK_TIMEOUT_MS ?? 2500));
  try {
    const res = await fetch(`${indexerUrl(env)}/summary`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
      next: { revalidate: 30 },
    } as RequestInit);
    if (!res.ok) return null;
    const data = (await res.json()) as SummaryItem[];
    if (!Array.isArray(data)) return null;

    const listed = new Set(stablePairs(env));
    const item = data
      .filter((d) => listed.has((d.trading_pairs ?? '').toUpperCase()) && saneBook(d))
      .sort((a, b) => Number(b.base_volume) - Number(a.base_volume))[0];
    if (!item) return null;

    // The book quotes decimal strings. Parsing them as rates keeps the mid
    // and the peg deviation exact: deviationBps decides whether settlement
    // halts, so it is the last number that should be approximate.
    let bid: Rate;
    let ask: Rate;
    let last: Rate;
    try {
      bid = parseRate(String(item.highest_bid));
      ask = parseRate(String(item.lowest_ask));
      last = parseRate(String(item.last_price));
    } catch {
      return null;
    }
    // (bid + ask) / 2, in the shared scale.
    const midScaled = divRound(bid.scaled + ask.scaled, 2n, 'half-even');
    if (midScaled <= 0n) return null;
    const mid: Rate = { scaled: midScaled, scale: bid.scale };
    // |mid - 1| in basis points, exactly. ONE is 1.0 at the same scale.
    const ONE = 10n ** BigInt(mid.scale);
    const drift = midScaled > ONE ? midScaled - ONE : ONE - midScaled;
    const deviationBps = divRound(drift * 10_000n, ONE, 'half-even');

    return {
      pair: item.trading_pairs,
      midPrice: mid,
      lastPrice: last.scaled > 0n ? last : mid,
      deviationBps,
      source: 'deepbook',
      asOf: new Date().toISOString(),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
