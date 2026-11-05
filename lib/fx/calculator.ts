import { applyBps, applyRate, divRound, parseRate } from '../money.ts';
import { BANK_DESTINATION, destinationKind } from '../fees/destination.ts';
import { LAUNCH_SCHEDULE, type FeeSchedule } from '../fees/schedule.ts';
import { buildFeeQuote, type FeeQuote } from '../fees/quote.ts';
import { baselineCostMinor, type BaselineDataset, type ComparisonBaseline } from './comparison-baselines.ts';

/**
 * The landing-page calculator, and the rule it obeys: it prices the leg
 * Splash charges for, a payout to a supplier's bank, and nothing else. A
 * client who holds ringgit converts it to dollars at their own bank at their
 * own rate; that leg is theirs, and a comparison that folded it into
 * Splash's price would be comparing two different journeys.
 *
 * Splash's fee is the schedule's (Amendment A1 §2.2, §2.7): a payout to a
 * bank is a BANK_PAYOUT, charged on top of the amount at the tier its size
 * falls in, computed by lib/fees/schedule.ts exactly as the chain computes
 * it. The schedule is handed in (the page passes the one in force), so no
 * rate is written here. The payout partner's fee comes from the partner's
 * own quote when the customer sends, so the calculator shows it as not
 * quoted yet rather than guessing it.
 *
 * Every figure is bigint minor units through lib/money.ts. The exchange
 * rate is never assumed: without a dated rate there is no PHP figure, and the
 * page says the rate is quoted when you send.
 */

/** One US cent in USDC minor units: the rails deliver USDC one to one. */
const CENT_IN_USDC_MINOR = 10_000n;

export const SPLASH_LEG = {
  leg: 'USD to PHP',
  label: 'Illustrative',
} as const;

/**
 * Splash's fee quote on a USD amount sent to a supplier's bank, under
 * `schedule`. `feesOn` is the FeeConfig's, with the schedule it came with:
 * while it is false no Splash fee is charged, and the quote says so.
 */
export function splashQuote(
  amountUsdMinor: bigint,
  schedule: FeeSchedule = LAUNCH_SCHEDULE,
  { feesOn = true }: { feesOn?: boolean } = {},
): FeeQuote {
  if (amountUsdMinor < 0n) throw new RangeError('an amount is never negative');
  return buildFeeQuote({
    kind: destinationKind(BANK_DESTINATION),
    principalMinor: amountUsdMinor * CENT_IN_USDC_MINOR,
    state: { feesOn, schedule },
    partnerFee: { minor: null, source: "From the payout partner's live quote when you send" },
  });
}

/**
 * The all-in rate a flat + margin price works out to on a given amount, in
 * basis points, rounded half-up. This is how "RM30 + 2.85% is 7.77% on
 * RM610 and 2.91% on RM50,000" is computed — the education page's worked
 * examples, and the bank row's rate here.
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
  splash: { quote: FeeQuote; label: 'Illustrative'; leg: string };
  /** The named, dated dataset's bank wire, or null when no dataset was given. */
  bankWire: { costMinor: bigint; effectiveBps: number; delivery: string; dataset: BaselineDataset } | null;
  /** Centavos the amount converts to before the partner's fee, or null: without a dated rate there is no figure. */
  phpReceivedMinor: bigint | null;
  fxRate: FxRateInput | null;
};

export function estimatePayment(input: {
  amountUsdMinor: bigint;
  baseline: ComparisonBaseline | null;
  fxRate: FxRateInput | null;
  schedule?: FeeSchedule;
  /** Whether Splash's fees are on under that schedule (FeeConfig's). */
  feesOn?: boolean;
}): CalculatorEstimate {
  const { amountUsdMinor, baseline, fxRate } = input;

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

  // Splash's fee is charged on top, so the whole amount is converted.
  const phpReceivedMinor =
    fxRate && amountUsdMinor > 0n ? applyRate(amountUsdMinor, parseRate(fxRate.phpPerUsd), 'half-up', 2, 2) : null;

  return {
    amountUsdMinor,
    splash: { quote: splashQuote(amountUsdMinor, input.schedule, { feesOn: input.feesOn ?? true }), label: SPLASH_LEG.label, leg: SPLASH_LEG.leg },
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
  const sign = bps < 0 ? '-' : '';
  const abs = BigInt(Math.abs(bps));
  return `${sign}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}%`;
}
