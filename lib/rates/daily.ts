import { getUsdCorridorByCurrency } from '@/lib/fx/corridors';
import { getNetworkProfile } from '@/lib/network';

export type DailyRateRow = {
  id: string;
  date: string;
  pair: string;
  pythMid: string;
  executed: string;
  spreadPct: string;
};

export type DailyRates = {
  /** True only on mainnet with executed volume; otherwise the rows are sandbox samples. */
  live: boolean;
  rows: DailyRateRow[];
  asOf: string;
};

function isoDay(offset: number, now: Date) {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - offset));
  return day.toISOString().slice(0, 10);
}

/**
 * Daily transparency rows for the live corridors. Real rows require
 * `network=mainnet` AND executed volume; neither exists yet, so the page gets
 * deterministic sandbox rows derived from the corridor reference rates and
 * says so. Sandbox rows never pretend to be executions.
 */
export function getDailyRates(now = new Date(), days = 7): DailyRates {
  const profile = getNetworkProfile();
  const live = profile.live && process.env.RATES_HAVE_VOLUME === 'true';
  if (live) {
    // No executed-rate store exists yet; a live network with volume must plug
    // one in here before the flag is set. Returning nothing is the honest
    // default: the page then shows "no executed volume yet".
    return { live: true, rows: [], asOf: now.toISOString() };
  }
  const rows: DailyRateRow[] = [];
  for (const corridor of profile.corridors) {
    const reference = getUsdCorridorByCurrency(corridor.currency);
    if (!reference) continue;
    const precision = reference.precision;
    for (let offset = 0; offset < days; offset += 1) {
      // Small deterministic wobble so the sample reads like a series, not a constant.
      const wobble = 1 + (((offset * 7 + corridor.currency.length) % 5) - 2) * 0.0009;
      const mid = reference.rate * wobble;
      const spread = reference.feeBps / 10_000 * 0.14; // the FX share of the edge fee, illustrative
      const executed = mid * (1 - spread);
      rows.push({
        id: `${corridor.currency}-${offset}`,
        date: isoDay(offset, now),
        pair: `USD / ${corridor.currency}`,
        pythMid: mid.toFixed(precision),
        executed: executed.toFixed(precision),
        spreadPct: `${(spread * 100).toFixed(2)}%`,
      });
    }
  }
  return { live: false, rows, asOf: now.toISOString() };
}
