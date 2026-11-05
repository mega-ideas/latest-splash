/**
 * The arithmetic of a spending rule's limits, ported line for line from the
 * Move that enforces them, so what Splash shows is what the chain will do.
 *
 * Allowances (`0x2::allowance`, framework source
 * crates/sui-framework/packages/sui-framework/sources/allowance.move):
 *
 *   A `RateLimit::Windowed` keeps `spent` for window number `index`, counted
 *   from `anchor_ms`, the time of the FIRST successful charge. Windows only
 *   roll forward, and `spent` is reset LAZILY: by the next charge that lands
 *   in a later window. So the `spent` an object carries is stale once its
 *   window has passed; read alone it would show a rule as used up when it is
 *   not. `liveRateLimit` applies the reset the next charge would.
 *
 *   `PeriodicMs(p)`: window i is [anchor + i·p, anchor + (i+1)·p).
 *   `CalendarMonths(m)`: a month elapses once the anchor's day of the month
 *   arrives (00:00 UTC), clamped to shorter months (a 31 January anchor
 *   renews on 28 or 29 February, then on 31 March): `elapsed_windows`.
 *
 *   `expiration_timestamp_ms` is exclusive, `start_timestamp_ms` inclusive.
 *   `current_spend` is everything ever charged, against `lifetime_cap`.
 *
 * Running totals (`splash_spend::spend_policy`, decision 4): what the
 * second-approval check counts for one payer and one recipient, the
 * `counted` function: the window's total until a window length after its
 * last payment, plus what it carried from the window before while that
 * still counts.
 *
 * Every amount and time is a bigint: u64 and u256 values do not fit a
 * double. Isomorphic: no server imports.
 */

export const MS_PER_DAY = 86_400_000n;

export type AllowanceWindow = { kind: 'periodic'; periodMs: bigint } | { kind: 'calendar'; months: number };

/** `RateLimit::Windowed`, as stored on the allowance. */
export type RateLimitState = {
  limit: bigint;
  /** What the object says was spent in window `index`. Stale once that window has passed. */
  spent: bigint;
  anchorMs: bigint | null;
  index: bigint;
  window: AllowanceWindow;
};

/** Howard Hinnant's civil_from_days, unsigned, as `allowance::civil_from_ms`. */
export function civilFromMs(timestampMs: bigint): { year: bigint; month: bigint; day: bigint } {
  const z = timestampMs / MS_PER_DAY + 719468n;
  const era = z / 146097n;
  const doe = z % 146097n;
  const yoe = (doe - doe / 1460n + doe / 36524n - doe / 146096n) / 365n;
  const doy = doe - (365n * yoe + yoe / 4n - yoe / 100n);
  const mp = (5n * doy + 2n) / 153n;
  const day = doy - (153n * mp + 2n) / 5n + 1n;
  const [year, month] = mp < 10n ? [era * 400n + yoe, mp + 3n] : [era * 400n + yoe + 1n, mp - 9n];
  return { year, month, day };
}

function isLeapYear(year: bigint): boolean {
  return year % 4n === 0n && (year % 100n !== 0n || year % 400n === 0n);
}

export function daysInMonth(year: bigint, month: bigint): bigint {
  if (month === 2n) return isLeapYear(year) ? 29n : 28n;
  return month === 4n || month === 6n || month === 9n || month === 11n ? 30n : 31n;
}

/** `allowance::elapsed_windows`. */
export function elapsedWindows(anchorMs: bigint, nowMs: bigint, months: number): bigint {
  const a = civilFromMs(anchorMs);
  const n = civilFromMs(nowMs);
  let elapsed = n.year * 12n + n.month - (a.year * 12n + a.month);
  const anniversary = a.day < daysInMonth(n.year, n.month) ? a.day : daysInMonth(n.year, n.month);
  if (elapsed > 0n && n.day < anniversary) elapsed -= 1n;
  return elapsed / BigInt(months);
}

/** `allowance::index_at`. Times before the anchor are window 0. */
export function windowIndexAt(window: AllowanceWindow, anchorMs: bigint, nowMs: bigint): bigint {
  if (nowMs <= anchorMs) return 0n;
  return window.kind === 'periodic' ? (nowMs - anchorMs) / window.periodMs : elapsedWindows(anchorMs, nowMs, window.months);
}

/** 00:00 UTC on the anchor's day in the month `monthsAfter` after the anchor's, clamped. */
function anniversaryMs(anchorMs: bigint, monthsAfter: bigint): bigint {
  const a = civilFromMs(anchorMs);
  const total = a.year * 12n + (a.month - 1n) + monthsAfter;
  const year = total / 12n;
  const month = (total % 12n) + 1n;
  const dim = daysInMonth(year, month);
  const day = a.day < dim ? a.day : dim;
  return BigInt(Date.UTC(Number(year), Number(month - 1n), Number(day)));
}

/**
 * Where window `index` starts and ends. Window 0 starts at the anchor itself;
 * a calendar window renews at 00:00 UTC on the anniversary day.
 */
export function windowBounds(window: AllowanceWindow, anchorMs: bigint, index: bigint): { startMs: bigint; endMs: bigint } {
  if (window.kind === 'periodic') {
    const startMs = anchorMs + index * window.periodMs;
    return { startMs, endMs: startMs + window.periodMs };
  }
  const months = BigInt(window.months);
  return { startMs: index === 0n ? anchorMs : anniversaryMs(anchorMs, index * months), endMs: anniversaryMs(anchorMs, (index + 1n) * months) };
}

/**
 * The rate limit as the next charge at `nowMs` would see it: `spent` reset if
 * `nowMs` is in a later window than the one it was counted in.
 */
export function liveRateLimit(
  rl: RateLimitState,
  nowMs: bigint,
): { limitMinor: bigint; spentMinor: bigint; remainingMinor: bigint; startsAtMs: bigint | null; endsAtMs: bigint | null; rolledOver: boolean } {
  if (rl.anchorMs === null) {
    // Nothing charged yet: the first charge anchors the windows.
    return { limitMinor: rl.limit, spentMinor: 0n, remainingMinor: rl.limit, startsAtMs: null, endsAtMs: null, rolledOver: false };
  }
  const current = windowIndexAt(rl.window, rl.anchorMs, nowMs);
  const rolledOver = current > rl.index;
  const spent = rolledOver ? 0n : rl.spent;
  const { startMs, endMs } = windowBounds(rl.window, rl.anchorMs, rolledOver ? current : rl.index);
  return { limitMinor: rl.limit, spentMinor: spent, remainingMinor: spent >= rl.limit ? 0n : rl.limit - spent, startsAtMs: startMs, endsAtMs: endMs, rolledOver };
}

/** A running total as `spend_policy::RunningTotal` stores it. */
export type RunningTotalState = {
  windowStartMs: bigint;
  windowEndMs: bigint;
  lastPaymentMs: bigint;
  total: bigint;
  carried: bigint;
  carriedUntilMs: bigint;
};

const U64_MAX = 18_446_744_073_709_551_615n;
const satAdd = (a: bigint, b: bigint) => (a > U64_MAX - b ? U64_MAX : a + b);

/** `spend_policy::counted`: what counts toward the threshold at `nowMs`, and until when. */
export function thresholdCounted(e: RunningTotalState, nowMs: bigint): { countedMinor: bigint; countsUntilMs: bigint } {
  let amount = 0n;
  let until = 0n;
  const totalUntil = satAdd(e.lastPaymentMs, e.windowEndMs - e.windowStartMs);
  if (nowMs < totalUntil) {
    amount = e.total;
    until = totalUntil;
  }
  if (nowMs < e.carriedUntilMs) {
    amount = satAdd(amount, e.carried);
    if (e.carriedUntilMs > until) until = e.carriedUntilMs;
  }
  return { countedMinor: amount, countsUntilMs: until };
}
