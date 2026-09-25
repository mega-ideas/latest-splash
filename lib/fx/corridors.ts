export type CorridorStatus = 'active' | 'coming_soon';

export type Corridor = {
  pair: string;
  sourceCurrency: 'USD';
  country: string;
  currency: string;
  flag: string;
  rate: number;
  precision: number;
  /**
   * Customer-facing fee in basis points (1 bps = 0.01%).
   * Source of truth — flows from this map into:
   *   - lib/server/quote.ts (off-chain quote engine)
   *   - lib/server/sui-settlement.ts (passes to contract)
   *   - dashboard pages (display)
   * Bounded on-chain by MAX_FEE_BPS = 200 in settlement.move.
   */
  feeBps: number;
  region: 'SOUTHEAST ASIA' | 'GLOBAL';
  status: CorridorStatus;
};

export const USD_CORRIDORS: Corridor[] = [
  { pair: 'USD → PHP', sourceCurrency: 'USD', country: 'PH', currency: 'PHP', flag: '🇵🇭', rate: 56.42, precision: 2, feeBps: 70,  region: 'SOUTHEAST ASIA', status: 'active' },
  { pair: 'USD → MYR', sourceCurrency: 'USD', country: 'MY', currency: 'MYR', flag: '🇲🇾', rate: 4.71,  precision: 2, feeBps: 70,  region: 'SOUTHEAST ASIA', status: 'active' },
  { pair: 'USD → IDR', sourceCurrency: 'USD', country: 'ID', currency: 'IDR', flag: '🇮🇩', rate: 16284, precision: 0, feeBps: 70,  region: 'SOUTHEAST ASIA', status: 'active' },
  { pair: 'USD → VND', sourceCurrency: 'USD', country: 'VN', currency: 'VND', flag: '🇻🇳', rate: 25385, precision: 0, feeBps: 70,  region: 'SOUTHEAST ASIA', status: 'active' },
  { pair: 'USD → THB', sourceCurrency: 'USD', country: 'TH', currency: 'THB', flag: '🇹🇭', rate: 35.82, precision: 2, feeBps: 70,  region: 'SOUTHEAST ASIA', status: 'active' },
  { pair: 'USD → SGD', sourceCurrency: 'USD', country: 'SG', currency: 'SGD', flag: '🇸🇬', rate: 1.345, precision: 3, feeBps: 70,  region: 'SOUTHEAST ASIA', status: 'active' },
  { pair: 'USD → EUR', sourceCurrency: 'USD', country: 'EU', currency: 'EUR', flag: '🇪🇺', rate: 0.924, precision: 3, feeBps: 70,  region: 'GLOBAL', status: 'active' },
  { pair: 'USD → GBP', sourceCurrency: 'USD', country: 'GB', currency: 'GBP', flag: '🇬🇧', rate: 0.789, precision: 3, feeBps: 70,  region: 'GLOBAL', status: 'active' },
  { pair: 'USD → INR', sourceCurrency: 'USD', country: 'IN', currency: 'INR', flag: '🇮🇳', rate: 83.42, precision: 2, feeBps: 70,  region: 'GLOBAL', status: 'coming_soon' },
  { pair: 'USD → AUD', sourceCurrency: 'USD', country: 'AU', currency: 'AUD', flag: '🇦🇺', rate: 1.54,  precision: 2, feeBps: 70,  region: 'GLOBAL', status: 'coming_soon' },
  { pair: 'USD → JPY', sourceCurrency: 'USD', country: 'JP', currency: 'JPY', flag: '🇯🇵', rate: 157.2, precision: 1, feeBps: 70,  region: 'GLOBAL', status: 'coming_soon' },
];

export const ACTIVE_USD_CORRIDORS = USD_CORRIDORS.filter((c) => c.status === 'active');

/** Hard ceiling — must stay ≤ MAX_FEE_BPS in settlement.move. */
export const CONTRACT_MAX_FEE_BPS = 200;

/**
 * FX spread saved by sourcing the target currency from netted treasury
 * inventory instead of a fresh market conversion. This is the per-transfer
 * form of the documented "15–30 bps cheaper FX" batch benefit; 25 bps is the
 * mid-corridor figure used to estimate savings on a single proposal.
 */
export const NETTING_SPREAD_BPS = 25;

/** Estimated netting saving in USD for a given USD notional. */
export function estimateNettingSavedUsd(amountUsd: number): number {
  return Math.max(0, amountUsd) * (NETTING_SPREAD_BPS / 10_000);
}

/** Fallback used when an unknown currency is quoted. Matches USD→PHP (lowest). */
export const FALLBACK_FEE_BPS = 70;

export function getUsdCorridorByCurrency(currency: string) {
  const normalized = currency.toUpperCase();
  return USD_CORRIDORS.find((c) => c.currency === normalized);
}

export function getUsdCorridorByCountry(country: string) {
  const normalized = country.toUpperCase();
  return USD_CORRIDORS.find((c) => c.country === normalized);
}

/**
 * Resolve the customer-facing fee in bps for a given currency.
 * Falls back to FALLBACK_FEE_BPS (80) if unknown.
 * Always clamped to CONTRACT_MAX_FEE_BPS so the result is guaranteed to be
 * accepted on-chain.
 */
export function getCorridorFeeBps(currency: string): number {
  const bps = getUsdCorridorByCurrency(currency)?.feeBps ?? FALLBACK_FEE_BPS;
  return Math.min(bps, CONTRACT_MAX_FEE_BPS);
}

export function formatUsd(amount: number) {
  return amount.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}
