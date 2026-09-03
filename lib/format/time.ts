/**
 * Deterministic timestamp formatting for server-rendered money surfaces.
 * Locale-dependent `toLocaleString()` differs between the server and the
 * viewer's browser and breaks hydration; settlement records also need an
 * explicit timezone so an auditor reads the same instant everywhere.
 */
const formatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC',
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** "02 Sep 2026, 01:14 UTC" for an ISO instant; the input echoed back when unparsable. */
export function formatInstant(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${formatter.format(date)} UTC`;
}
