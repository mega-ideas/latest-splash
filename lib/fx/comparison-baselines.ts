import { applyBps } from '../money.ts';

/**
 * W9.1 — comparison baselines for the quote step and the landing calculator.
 *
 * Per-corridor, category-level cost figures for "what would this payment
 * cost elsewhere". ILLUSTRATIVE figures for a generic provider CATEGORY —
 * never a named competitor. Named competitors stay off every surface until a
 * sourced per-corridor number exists AND Sky approves adding it to the
 * claims register.
 *
 * Every corridor names the dataset its figures were read from, with the URL
 * and the date, so a reader can check the category midpoint against the
 * published page rather than take "commonly 1–3%" on trust. A corridor
 * without a reviewed entry renders no comparison at all.
 *
 * Money is bigint minor units (lib/money.ts): a flat fee in cents and a
 * margin in basis points, applied with explicit rounding.
 */

export type CategoryBaseline = {
  /** FX margin plus fees as basis points of the send amount. */
  marginBps: number;
  /** Flat fee component in USD cents (wire or processing). */
  flatUsdMinor: bigint;
  /** Human delivery-time range for the category. */
  delivery: string;
};

export type BaselineDataset = {
  /** Who published the figures. */
  name: string;
  /** Where a reader can check them. */
  url: string;
  /** The date the figures were true, ISO. */
  asOf: string;
  /** How the category midpoint was read from the dataset. */
  note: string;
};

export type ComparisonBaseline = {
  /** Target corridor currency (matches lib/fx/corridors.ts codes). */
  currency: string;
  fintech: CategoryBaseline;
  bankWire: CategoryBaseline;
  dataset: BaselineDataset;
  /** ISO date the entry was last reviewed against the dataset. */
  lastReviewed: string;
};

const BASELINES: Record<string, ComparisonBaseline> = {
  // USD → PHP (the live testnet corridor).
  PHP: {
    currency: 'PHP',
    fintech: { marginBps: 150, flatUsdMinor: 400n, delivery: '1–2 days' },
    bankWire: { marginBps: 250, flatUsdMinor: 3500n, delivery: '2–5 days' },
    dataset: {
      name: 'World Bank Remittance Prices Worldwide, United States to Philippines',
      url: 'https://remittanceprices.worldbank.org/corridor/United-States/Philippines',
      asOf: '2025-03-31',
      note:
        'Category midpoints for a transfer of US$1,000 or more: the bank figure is a correspondent wire with its FX margin, the fintech figure the digital-provider category. Read from the published corridor page, not from any named provider.',
    },
    lastReviewed: '2026-09-23',
  },
};

/** Baseline for a corridor, or null when none has been reviewed — callers
 *  must hide the comparison entirely in the null case. */
export function getComparisonBaseline(currency: string): ComparisonBaseline | null {
  return BASELINES[currency] ?? null;
}

/** Category cost in USD cents for a send amount in USD cents: flat + margin. */
export function baselineCostMinor(baseline: CategoryBaseline, amountUsdMinor: bigint): bigint {
  return baseline.flatUsdMinor + applyBps(amountUsdMinor, baseline.marginBps, 'half-up');
}
