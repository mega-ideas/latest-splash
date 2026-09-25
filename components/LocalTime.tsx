'use client';

import { useSyncExternalStore } from 'react';

import { formatUtc, toDate, type DateFormat, type DateInput } from '@/lib/formatDate';

/** Whether the page has hydrated never changes afterwards: nothing to subscribe to. */
const subscribe = () => () => {};

/**
 * A moment in the viewer's own locale and time zone, without a hydration
 * mismatch.
 *
 * The server knows neither, so it renders the moment in UTC (formatUtc), and
 * the browser renders the same text while it hydrates, because
 * useSyncExternalStore reads the server snapshot then. Right after, it reads
 * the client snapshot and shows the viewer's own. A LocalTime that first
 * renders after hydration, as dates fetched in the browser do, shows the
 * viewer's straight away.
 *
 * `format` picks toLocaleString, toLocaleDateString or toLocaleTimeString;
 * `locale` and `options` pass through to it. Without a `locale` the text
 * reads the viewer's way; with one, that locale's way (a 24-hour 'en-GB'
 * clock, say). The zone is the viewer's unless `options.timeZone` names one.
 *
 * This is the one client module that formats dates:
 * tests/client-locale-format.test.mjs sends every other client component's
 * dates here.
 */
export default function LocalTime({
  value,
  format = 'datetime',
  locale,
  options,
}: {
  value: DateInput;
  format?: DateFormat;
  locale?: string;
  options?: Intl.DateTimeFormatOptions;
}) {
  const hydrated = useSyncExternalStore(subscribe, () => true, () => false);
  const date = toDate(value);
  let text: string;
  if (!date) text = 'Invalid Date';
  else if (!hydrated) text = formatUtc(date, format);
  else if (format === 'date') text = date.toLocaleDateString(locale, options);
  else if (format === 'time') text = date.toLocaleTimeString(locale, options);
  else text = date.toLocaleString(locale, options);
  return <time dateTime={date?.toISOString()}>{text}</time>;
}
