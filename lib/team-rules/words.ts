/**
 * The small word-makers the spending-rules screens share: how long is left, and
 * how long a window is. Pure and client-safe.
 */
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * "5 hours 12 minutes", "3 days 5 hours", "95 days": the two units that matter
 * at each scale, never seconds. Nothing left, or nothing readable, is "now".
 */
export function timeLeftWords(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'now';
  if (ms < MIN) return 'under a minute';
  if (ms < HOUR) return plural(Math.floor(ms / MIN), 'minute', 'minutes');
  if (ms < 6 * HOUR) {
    const hours = Math.floor(ms / HOUR);
    const minutes = Math.floor((ms - hours * HOUR) / MIN);
    return minutes > 0 ? `${plural(hours, 'hour', 'hours')} ${plural(minutes, 'minute', 'minutes')}` : plural(hours, 'hour', 'hours');
  }
  if (ms < 2 * DAY) return plural(Math.floor(ms / HOUR), 'hour', 'hours');
  const days = Math.floor(ms / DAY);
  if (days < 7) {
    const hours = Math.floor((ms - days * DAY) / HOUR);
    return hours > 0 ? `${plural(days, 'day', 'days')} ${plural(hours, 'hour', 'hours')}` : plural(days, 'day', 'days');
  }
  return plural(days, 'day', 'days');
}

/** How long a running-total window is: "24 hours", "3 days". */
export function windowWords(ms: bigint): string {
  const day = 86_400_000n;
  if (ms % day === 0n && ms / day >= 2n) return `${ms / day} days`;
  const hours = ms / 3_600_000n;
  return ms % 3_600_000n === 0n ? `${hours} ${hours === 1n ? 'hour' : 'hours'}` : `${ms / 60_000n} minutes`;
}
