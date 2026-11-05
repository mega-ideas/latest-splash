import { SUI_USDC_COIN_TYPE } from '../payments/stablecoin-lane.ts';
import { USDY_COIN_TYPE_SUI } from '../payments/treasury-usdy.ts';

/**
 * What swapping USDC for USDY on Sui would actually return, right now.
 *
 * Read from the Cetus aggregator's route finder, which searches the Sui DEXes
 * it indexes (Cetus, Aftermath, FlowX, Kriya and others) for the best path.
 * Read-only: nothing is built, signed or sent.
 *
 * Why it exists: the treasury plan assumed USDC could be swapped for USDY on a
 * Sui DEX at about the redemption price. Measured on 2026-09-24, it can only
 * at pocket-change size — 1 USDC bought 0.87 USDY (about fair at ~$1.15),
 * 100 USDC came back 14% short, 1,000 USDC 70% short, and 10,000 USDC had no
 * route at all. A quote priced off the redemption rate alone would have shown
 * a business USDY the market could not deliver.
 */

const CETUS_ROUTER = 'https://api-sui.cetus.zone/router_v2/find_routes';
const TIMEOUT_MS = 5_000;

export type UsdyMarketQuote =
  | {
      available: true;
      usdcInMinor: bigint;
      /** USDY the best route returns, before any slippage allowance. */
      usdyOutMinor: bigint;
      /** The DEXes on the route, as the aggregator names them. */
      providers: string[];
      asOf: string;
      source: 'cetus-aggregator';
    }
  | { available: false; reason: string };

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

function safeBigint(value: unknown): bigint | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  return null;
}

export async function quoteUsdcToUsdyOnSui(
  usdcInMinor: bigint,
  deps: { fetcher?: Fetcher; now?: () => Date } = {},
): Promise<UsdyMarketQuote> {
  const route = await findRoute(SUI_USDC_COIN_TYPE.mainnet, USDY_COIN_TYPE_SUI, usdcInMinor, 'USDY', deps);
  if (!route.available) return route;
  return { available: true, usdcInMinor, usdyOutMinor: route.amountOut, providers: route.providers, asOf: route.asOf, source: 'cetus-aggregator' };
}

export type UsdyRedeemMarketQuote =
  | {
      available: true;
      usdyInMinor: bigint;
      /** USDC the best route returns for the USDY, before any slippage allowance. */
      usdcOutMinor: bigint;
      providers: string[];
      asOf: string;
      source: 'cetus-aggregator';
    }
  | { available: false; reason: string };

/** The other way: what selling USDY for USDC on Sui returns right now. Read-only. */
export async function quoteUsdyToUsdcOnSui(
  usdyInMinor: bigint,
  deps: { fetcher?: Fetcher; now?: () => Date } = {},
): Promise<UsdyRedeemMarketQuote> {
  const route = await findRoute(USDY_COIN_TYPE_SUI, SUI_USDC_COIN_TYPE.mainnet, usdyInMinor, 'USDC', deps);
  if (!route.available) return route;
  return { available: true, usdyInMinor, usdcOutMinor: route.amountOut, providers: route.providers, asOf: route.asOf, source: 'cetus-aggregator' };
}

async function findRoute(
  from: string,
  target: string,
  amountIn: bigint,
  targetName: 'USDY' | 'USDC',
  deps: { fetcher?: Fetcher; now?: () => Date },
): Promise<{ available: true; amountOut: bigint; providers: string[]; asOf: string } | { available: false; reason: string }> {
  if (amountIn <= 0n) return { available: false, reason: 'Enter an amount above zero.' };
  const usdcInMinor = amountIn;
  const fetcher = deps.fetcher ?? fetch;
  const url =
    `${CETUS_ROUTER}?from=${encodeURIComponent(from)}` +
    `&target=${encodeURIComponent(target)}` +
    `&amount=${amountIn.toString()}&by_amount_in=true`;

  let body: { code?: number; msg?: string; data?: { amount_in?: unknown; amount_out?: unknown; routes?: Array<{ path?: Array<{ provider?: string }> }> } };
  try {
    const res = await fetcher(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS), cache: 'no-store' });
    if (!res.ok) return { available: false, reason: `The Sui DEX route finder answered HTTP ${res.status}.` };
    body = await res.json();
  } catch (error) {
    return { available: false, reason: `The Sui DEX route finder did not answer: ${error instanceof Error ? error.message : 'unknown error'}.` };
  }

  // The aggregator refuses a size it can only fill at an extreme price
  // ("quote deviation error"); that is a finding, not an outage.
  if (body.code !== 200 || !body.data) {
    return {
      available: false,
      reason: `No Sui route can fill this size at a sane price (${body.msg ?? 'no route'}): ${targetName === 'USDY' ? 'there is not enough USDY liquidity on Sui' : 'there is not enough liquidity on Sui to sell this much USDY'}.`,
    };
  }
  const answeredIn = safeBigint(body.data.amount_in);
  const amountOut = safeBigint(body.data.amount_out);
  if (answeredIn !== usdcInMinor || amountOut === null || amountOut === 0n) {
    return { available: false, reason: 'The Sui DEX route finder returned a quote that does not match the request.' };
  }
  const providers = [...new Set((body.data.routes ?? []).flatMap((r) => (r.path ?? []).map((p) => p.provider ?? '')).filter(Boolean))].sort();
  return { available: true, amountOut, providers, asOf: (deps.now ?? (() => new Date()))().toISOString() };
}
