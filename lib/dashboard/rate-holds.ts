/**
 * Quote holds on Transfer (v2 brief 5.1). The Rate holds page left the nav
 * and its route redirects to Transfer; holds stay in the backend
 * (GET /api/rate-holds, scoped to the caller's org). Transfer lists the
 * active ones so a hold made at the quote step can still be used later.
 * Pure, so it is tested as behaviour (tests/dashboard-review.test.mjs).
 */

export type RateHoldRow = {
  id: string;
  corridorCurrency: string;
  rate: string;
  holdUntil: string;
  state: 'ACTIVE' | 'EXECUTED' | 'EXPIRED' | 'CANCELLED';
  createdAt: string;
};

/** Holds that can still be used at `nowMs`, newest first. A hold the server
 *  still calls ACTIVE but whose time has run out is not offered. */
export function activeRateHolds<T extends RateHoldRow>(holds: readonly T[], nowMs: number): T[] {
  return holds
    .filter((hold) => hold.state === 'ACTIVE' && Date.parse(hold.holdUntil) > nowMs)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/** "22h 30m" left, or "under a minute". */
export function holdTimeLeft(holdUntil: string, nowMs: number): string {
  const minutes = Math.floor(Math.max(0, Date.parse(holdUntil) - nowMs) / 60_000);
  if (minutes < 1) return 'under a minute';
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}
