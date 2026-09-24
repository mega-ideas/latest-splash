import { divRound } from '../money.ts';

/**
 * USDY's price from Ondo's own oracle, read for free.
 *
 * Ondo publishes `USDYOracleWrapper` on Ethereum as "a stable entry point for
 * reading the USDY price" (docs.ondo.finance/addresses). `getPriceData()`
 * returns the price with 18 decimals and the time it applies to (the block's
 * own time: the price accrues on a schedule Ondo sets). One `eth_call`
 * through a public Ethereum node: no key, no account. Read on 2026-09-24 it
 * gave 1.14730001, the price ondo.finance showed.
 *
 * A public node could lie. This price only values a treasury PREVIEW (nothing
 * is swapped), and a treasury that moves money should read through a node it
 * trusts: set ETHEREUM_RPC_URL.
 *
 * Env:
 *   ETHEREUM_RPC_URL   default https://ethereum-rpc.publicnode.com
 *   USDY_ORACLE        'off' skips it (the configured price is then used)
 */

export const USDY_ORACLE_WRAPPER = '0x87b126e5518b6a1Bb8465779b4607C45C643DF90';
/** getPriceData() → (uint256 price, uint256 timestamp) */
const GET_PRICE_DATA = '0xa4a28168';
const DEFAULT_RPC = 'https://ethereum-rpc.publicnode.com';
const TIMEOUT_MS = 4_000;
// USDY is issued at $1.00 and accrues; outside this band the answer is not a
// USDY price, whatever returned it.
const MIN_PRICE_MICROS = 1_000_000n;
const MAX_PRICE_MICROS = 3_000_000n;

export type UsdyOracleReading = { priceMicros: bigint; observedAt: Date };

/** Ondo's USDY price, or null (with the reason logged) — never a default. */
export async function readUsdyOracle(
  env: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = fetch,
): Promise<UsdyOracleReading | null> {
  if ((env.USDY_ORACLE ?? '').trim().toLowerCase() === 'off') return null;
  const rpc = (env.ETHEREUM_RPC_URL ?? '').trim() || DEFAULT_RPC;
  let body: { result?: unknown; error?: { message?: string } };
  try {
    const response = await fetcher(rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [{ to: USDY_ORACLE_WRAPPER, data: GET_PRICE_DATA }, 'latest'],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });
    if (!response.ok) return unavailable(`Ethereum node answered HTTP ${response.status}`);
    body = await response.json();
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : 'Ethereum node did not answer');
  }
  if (body.error) return unavailable(`oracle call failed: ${body.error.message ?? 'unknown error'}`);
  if (typeof body.result !== 'string' || !/^0x[0-9a-fA-F]{128}$/.test(body.result)) {
    return unavailable('oracle returned something other than (price, timestamp)');
  }
  const price18 = BigInt(`0x${body.result.slice(2, 66)}`);
  const seconds = BigInt(`0x${body.result.slice(66, 130)}`);
  const priceMicros = divRound(price18, 10n ** 12n, 'half-even');
  if (priceMicros < MIN_PRICE_MICROS || priceMicros > MAX_PRICE_MICROS) {
    return unavailable(`oracle price ${priceMicros} µUSD is outside the plausible USDY range`);
  }
  const observedAt = new Date(Number(seconds) * 1000);
  if (!Number.isFinite(observedAt.getTime()) || seconds === 0n) return unavailable('oracle returned no timestamp');
  return { priceMicros, observedAt };
}

function unavailable(reason: string): null {
  console.warn(`[usdy-oracle] no reading: ${reason}`);
  return null;
}
