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

export function comparisonRows(pricing: ComparisonPricing, baseline: ComparisonBaseline | null): ComparisonRow[] {
  const bank = baseline?.bankWire;
  const fintech = baseline?.fintech;
  const varies = { bank: UNSOURCED, broker: UNSOURCED, fintech: UNSOURCED };
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
      splash: pricing.feesOn ? pricing.bank : pricing.bankFeePhrase,
    },
    { feature: 'Rate before you approve', ...varies, splash: 'Shown and locked for the quote' },
    { feature: 'Pay a bank or a wallet', ...varies, splash: 'Both, in one transfer flow' },
    { feature: 'Settlement', ...varies, splash: 'All-or-nothing on Sui' },
    { feature: 'Batch payments', ...varies, splash: 'Many payees, one approval' },
    { feature: 'Where your money sits', ...varies, splash: 'Your Splash Wallet, held by your business' },
    { feature: 'AI copilot', ...varies, splash: lockedCopy.agent },
    { feature: 'Payment record', ...varies, splash: 'Encrypted receipt, kept' },
  ];
}
