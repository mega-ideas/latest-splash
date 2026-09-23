import type { KybLifecycleState } from '../compliance/kyb-state.ts';
import { laneAccess } from './stablecoin-lane.ts';

/**
 * Treasury in the business's own wallet: USDC on Sui → Ondo USDY on Sui.
 *
 * USDY is a price-accrual token: any yield shows up as its price moving above
 * $1, with nothing paid out — and the rate varies. The business swaps
 * USDC for USDY in its own Splash wallet; Splash never holds either.
 *
 * This module is the arithmetic and the eligibility, and nothing that moves
 * money. Until Ondo eligibility is confirmed for the business it is a
 * preview (SANDBOX): numbers shown, nothing swapped.
 *
 * Every amount is bigint minor units. USDC and USDY on Sui both have 6
 * decimals (read from mainnet coin metadata, 2026-09-24), so a price in
 * micro-USD converts one to the other without rescaling.
 */

export const USDY_COIN_TYPE_SUI = '0x960b531667636f39e85867775f52f6b1f220a058c4de786905bdf761e06a56bb::usdy::USDY';
export const USDY_DECIMALS = 6;

const ONE_MICRO = 1_000_000n;
const PPB = 1_000_000_000n;

/** USDY bought with `usdcMinor` at `priceMicros` (USD per USDY, ×1e6). Rounded down. */
export function usdyForUsdc(usdcMinor: bigint, priceMicros: bigint): bigint {
  if (priceMicros <= 0n) throw new RangeError('USDY price must be positive');
  return (usdcMinor * ONE_MICRO) / priceMicros;
}

/** The USD value of `usdyMinor` at `priceMicros`. Rounded down. */
export function usdcValueOfUsdy(usdyMinor: bigint, priceMicros: bigint): bigint {
  return (usdyMinor * priceMicros) / ONE_MICRO;
}

/** The least a swap may return at `slippageBps`. Rounded down. */
export function minReceived(outMinor: bigint, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 1000) throw new RangeError('slippage must be 0–10%');
  return (outMinor * BigInt(10_000 - slippageBps)) / 10_000n;
}

/**
 * Daily growth, in parts per billion, for an annual rate compounded daily.
 * A RATE, computed once in floating point and then fixed; the money it is
 * applied to never touches a float.
 */
export function dailyGrowthPpb(apyPct: number): bigint {
  if (!Number.isFinite(apyPct) || apyPct < 0 || apyPct > 100) throw new RangeError('APY must be 0–100%');
  return BigInt(Math.round((Math.pow(1 + apyPct / 100, 1 / 365) - 1) * 1e9));
}

/** Value after `days` of daily compounding, rounded DOWN each day — a
 *  projection that errs, it errs low. */
export function projectValue(principalMinor: bigint, apyPct: number, days: number): bigint {
  const g = dailyGrowthPpb(apyPct);
  let v = principalMinor;
  for (let d = 0; d < days; d += 1) v = (v * (PPB + g)) / PPB;
  return v;
}

export interface TreasuryQuote {
  allowed: boolean;
  /** SANDBOX until Ondo eligibility is confirmed: numbers, no swap. */
  mode: 'SANDBOX' | 'LIVE';
  reasons: string[];
  usdcInMinor: bigint;
  priceMicros: bigint | null;
  priceStatus: 'LIVE' | 'STALE' | 'UNAVAILABLE';
  usdyOutMinor: bigint | null;
  minUsdyOutMinor: bigint | null;
  apyPct: number;
  projections: Array<{ days: number; valueMinor: bigint; yieldMinor: bigint }>;
}

export function treasuryQuote(input: {
  state: KybLifecycleState;
  /** ISO alpha-2 of the business. USDY is not offered to US persons. */
  country: string | null;
  usdcInMinor: bigint;
  /** asOf: when the SOURCE observed the price. A price that cannot be aged is not priced from. */
  nav: { status: 'LIVE' | 'STALE' | 'UNAVAILABLE'; priceMicros: bigint | null; asOf?: string | null };
  apyPct: number;
  slippageBps?: number;
  ondoEligibilityConfirmed: boolean;
}): TreasuryQuote {
  const reasons: string[] = [];
  const lane = laneAccess(input.state, 'TREASURY');
  if (!lane.allowed) reasons.push(lane.reason);
  if ((input.country ?? '').toUpperCase() === 'US') reasons.push('Ondo does not offer USDY to US persons, so it is not available to this business.');
  if (input.usdcInMinor <= 0n) reasons.push('Enter an amount above zero.');
  if (input.nav.status === 'UNAVAILABLE' || input.nav.priceMicros === null) {
    reasons.push('The USDY price is unavailable, so no swap can be priced. Splash will not guess it.');
  } else if (!input.nav.asOf) {
    // A price with no observation time may be a placeholder (a flat $1.00
    // misprices USDY, which accrues above $1) and cannot be aged at all.
    reasons.push('The USDY price has no observation time, so it cannot be told apart from a placeholder. Set USDY_REDEMPTION_AS_OF with the price, or connect a feed.');
  }
  const allowed = reasons.length === 0;
  const mode: TreasuryQuote['mode'] = input.ondoEligibilityConfirmed ? 'LIVE' : 'SANDBOX';
  if (allowed && mode === 'SANDBOX') {
    reasons.push('Preview only: Ondo eligibility for this business is not confirmed yet, so nothing is swapped.');
  }
  if (allowed && input.nav.status === 'STALE') {
    reasons.push('The USDY price is stale — treat these numbers as indicative, not a quote to act on.');
  }

  const priced = allowed && input.nav.priceMicros !== null;
  const usdyOut = priced ? usdyForUsdc(input.usdcInMinor, input.nav.priceMicros as bigint) : null;
  return {
    allowed,
    mode,
    reasons,
    usdcInMinor: input.usdcInMinor,
    priceMicros: input.nav.priceMicros,
    priceStatus: input.nav.status,
    usdyOutMinor: usdyOut,
    minUsdyOutMinor: usdyOut === null ? null : minReceived(usdyOut, input.slippageBps ?? 50),
    apyPct: input.apyPct,
    projections: priced
      ? [30, 90, 365].map((days) => {
          const valueMinor = projectValue(input.usdcInMinor, input.apyPct, days);
          return { days, valueMinor, yieldMinor: valueMinor - input.usdcInMinor };
        })
      : [],
  };
}
