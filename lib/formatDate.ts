/**
 * Dates as text that the server and every browser agree on.
 *
 * `toLocaleString()` with no arguments formats in the runtime's own locale and
 * time zone: the server's while a page renders there, the viewer's in the
 * browser. A client component that renders a date during server rendering
 * puts one text in the HTML and another in the browser's first render, and
 * React throws a hydration error and renders the tree again.
 *
 * formatUtc builds its text from the date's UTC fields and an English month
 * table rather than from Intl, whose output differs between ICU versions
 * (en-GB's September is "Sep" in some and "Sept" in others). It is what
 * components/LocalTime.tsx renders until the page has hydrated.
 */

export type DateInput = string | number | Date;

/** Which of toLocaleString, toLocaleDateString and toLocaleTimeString it stands for. */
export type DateFormat = 'datetime' | 'date' | 'time';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad = (n: number) => String(n).padStart(2, '0');

/** The moment `value` names, or null when it names none. */
export function toDate(value: DateInput): Date | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * `25 Sep 2026, 12:47:50 UTC`, `25 Sep 2026` or `12:47:50 UTC`, the same
 * wherever it runs. "Invalid Date" when `value` names no moment, as
 * toLocaleString() says.
 */
export function formatUtc(value: DateInput, format: DateFormat = 'datetime'): string {
  const date = toDate(value);
  if (!date) return 'Invalid Date';
  const day = `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
  const time = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} UTC`;
  if (format === 'date') return day;
  if (format === 'time') return time;
  return `${day}, ${time}`;
}
