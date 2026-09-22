import { applyBps, applyRate, divRound, formatMinor, parseRate } from '../money.ts';
import { baselineCostMinor, type BaselineDataset, type ComparisonBaseline } from './comparison-baselines.ts';
import { getCorridorFeeBps } from './corridors.ts';

/**
 * The landing-page calculator, and the one rule it obeys: Splash prices one
 * leg, USD to PHP, and the calculator prices nothing else. A client who
 * holds ringgit converts it to dollars at their own bank at their own rate;
 * that leg is theirs, and a comparison that folded it into Splash's price —
 * or compared Splash's USD-to-PHP fee with a bank's MYR-to-PHP total — would
 * be comparing two different journeys.
 *
 * Every figure is bigint minor units through lib/money.ts. The exchange
 * rate is never assumed: without a dated rate there is no PHP figure, and the
 * page says the rate is quoted when you send.
 */

/** Mirrors FIXED_FEE_CENTS in lib/server/quote.ts — $4.50. */
export const SPLASH_FIXED_FEE_MINOR = 450n;

export const SPLASH_USD_PHP = {
  leg: 'USD to PHP',
  flatUsdMinor: SPLASH_FIXED_FEE_MINOR,
  /** From lib/fx/corridors.ts, the single source the quote engine also reads. */
  marginBps: getCorridorFeeBps('PHP'),
  label: 'Illustrative',
} as const;

/** Splash's charge on a USD amount: flat + amount × margin. */
export function splashCostMinor(amountUsdMinor: bigint): bigint {
  return SPLASH_USD_PHP.flatUsdMinor + applyBps(amountUsdMinor, SPLASH_USD_PHP.marginBps, 'half-up');
}

/**
 * The all-in rate a flat + margin price works out to on a given amount, in
 * basis points, rounded half-up. This is how "RM30 + 2.85% is 7.77% on
 * RM610 and 2.91% on RM50,000" is computed — the education page's worked
 * examples, never a landing-page comparison.
 */
export function effectiveRateBps(input: { flatMinor: bigint; marginBps: number; amountMinor: bigint }): number {
  if (input.amountMinor <= 0n) throw new RangeError('an effective rate needs a positive amount');
  const cost = input.flatMinor + applyBps(input.amountMinor, input.marginBps, 'half-up');
  const bps = divRound(cost * 10_000n, input.amountMinor, 'half-up');
  return Number(bps);
}

export type FxRateInput = {
  /** PHP per USD, as a decimal string, exactly as quoted. */
  phpPerUsd: string;
  /** When that rate was true, ISO. */
  asOf: string;
};

export type CalculatorEstimate = {
  amountUsdMinor: bigint;
  splash: { costMinor: bigint; effectiveBps: number; label: 'Illustrative'; leg: string };
  /** The named, dated dataset's bank wire, or null when no dataset was given. */
  bankWire: { costMinor: bigint; effectiveBps: number; delivery: string; dataset: BaselineDataset } | null;
  /** Centavos received, or null: without a dated rate there is no figure. */
  phpReceivedMinor: bigint | null;
  fxRate: FxRateInput | null;
};

export function estimatePayment(input: {
  amountUsdMinor: bigint;
  baseline: ComparisonBaseline | null;
  fxRate: FxRateInput | null;
}): CalculatorEstimate {
  const { amountUsdMinor, baseline, fxRate } = input;
  const splashCost = splashCostMinor(amountUsdMinor);

  const bankWire = baseline
    ? {
        costMinor: baselineCostMinor(baseline.bankWire, amountUsdMinor),
        effectiveBps:
          amountUsdMinor > 0n
            ? effectiveRateBps({
                flatMinor: baseline.bankWire.flatUsdMinor,
                marginBps: baseline.bankWire.marginBps,
                amountMinor: amountUsdMinor,
              })
            : 0,
        delivery: baseline.bankWire.delivery,
        dataset: baseline.dataset,
      }
    : null;

  const net = amountUsdMinor - splashCost;
  const phpReceivedMinor =
    fxRate && net > 0n ? applyRate(net, parseRate(fxRate.phpPerUsd), 'half-up', 2, 2) : null;

  return {
    amountUsdMinor,
    splash: {
      costMinor: splashCost,
      effectiveBps:
        amountUsdMinor > 0n
          ? effectiveRateBps({
              flatMinor: SPLASH_USD_PHP.flatUsdMinor,
              marginBps: SPLASH_USD_PHP.marginBps,
              amountMinor: amountUsdMinor,
            })
          : 0,
      label: SPLASH_USD_PHP.label,
      leg: SPLASH_USD_PHP.leg,
    },
    bankWire,
    phpReceivedMinor,
    fxRate,
  };
}

/** Basis points as a percentage string with two decimals: 777 → "7.77%". A
 * basis point is a hundredth of a percent, so the integer formats exactly like
 * two-decimal minor units; no float arithmetic touches it. */
export function formatBps(bps: number): string {
  if (!Number.isInteger(bps)) throw new RangeError(`basis points are integers, got ${bps}`);
  return `${formatMinor(BigInt(bps), 2)}%`;
}
