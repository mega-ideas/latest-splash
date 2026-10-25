/**
 * The landing comparison table (v2 brief section 6, "Routes & comparison").
 *
 * Two rules hold every cell:
 *
 * - A Splash cell says what is true today. Nothing on the roadmap (early
 *   payment on invoices, netting) and no projected yield: those rows are
 *   gone, not softened.
 * - A competitor cell is a figure read from the reviewed, dated dataset in
 *   lib/fx/comparison-baselines.ts (the World Bank corridor page), or
 *   "Varies". A category claim nobody has sourced ("hidden markup", "No")
 *   is not a cell. With no reviewed dataset, every competitor cell varies.
 *
 * Client-safe and pure: the landing passes the fee schedule in words, and
 * the baseline for the corridor it compares (USD to PHP).
 */
import { lockedCopy } from '@/content/claims';
import { formatBps } from '@/lib/fx/calculator';
import type { CategoryBaseline, ComparisonBaseline } from '@/lib/fx/comparison-baselines';
import { formatMinor } from '@/lib/money';

/** What a competitor cell says when no dataset backs it. */
export const UNSOURCED = 'Varies';

/** How long a payment takes, in words true for the live route (lib/landing/routes.ts). */
export const SPEED_LINE = 'Seconds on Sui, minutes to a PH bank';

export type ComparisonRow = {
  feature: string;
  bank: string;
  broker: string;
  fintech: string;
  splash: string;
};

/** The fee schedule in words, as lib/fees/copy.ts pricingSummary writes it. */
export type ComparisonPricing = { feesOn: boolean; bank: string; bankFeePhrase: string };

function cost(category: CategoryBaseline | undefined): string {
  return category ? `US$${formatMinor(category.flatUsdMinor, 2)} + ${formatBps(category.marginBps)} FX margin` : UNSOURCED;
}

/**
 * The rows that compare something: a competitor cell here can carry a
 * figure from the dataset. With no reviewed dataset these cells say
 * "Varies", and the row still shows Splash's side.
 *
 * The bank and fintech fee cells are all-in (a flat fee plus the FX margin),
 * so the Splash cell names both of its legs: Splash's own fee from the
 * schedule, and the payout partner's rate, shown before approval.
 */
export function comparisonRows(pricing: ComparisonPricing, baseline: ComparisonBaseline | null): ComparisonRow[] {
  const bank = baseline?.bankWire;
  const fintech = baseline?.fintech;
  return [
    {
      feature: 'Settlement speed',
      bank: bank?.delivery ?? UNSOURCED,
      broker: UNSOURCED,
      fintech: fintech?.delivery ?? UNSOURCED,
      splash: SPEED_LINE,
    },
    {
      feature: 'Fee to a bank',
      bank: cost(bank),
      broker: UNSOURCED,
      fintech: cost(fintech),
      // The schedule once fees are on; until then, the phrase says none is charged.
      splash: pricing.feesOn
        ? `${pricing.bankFeePhrase} + the partner’s rate, shown before you approve`
        : `${pricing.bankFeePhrase}; the partner’s rate is shown before you approve`,
    },
  ];
}

export type SplashCapability = { feature: string; splash: string };

/**
 * What Splash does today where no dataset says what a bank, a broker or a
 * fintech app does: Splash's side alone, as a list, not a table of "Varies"
 * cells (the step B review). Every line is true today.
 */
export function splashToday(): SplashCapability[] {
  return [
    { feature: 'Rate before you approve', splash: 'Shown and locked for the quote' },
    { feature: 'Pay a bank or a wallet', splash: 'Both, in one transfer flow' },
    { feature: 'Settlement', splash: 'All-or-nothing on Sui' },
    { feature: 'Batch payments', splash: 'Many payees, one approval' },
    { feature: 'Where your money sits', splash: 'Your Splash Wallet, held by your business' },
    { feature: 'AI copilot', splash: lockedCopy.agent },
    { feature: 'Payment record', splash: 'Encrypted receipt, kept' },
  ];
}
