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
 * `format` picks toLocaleString, toLocaleDateString or toLocaleTimeString, and
 * `options` pass through to it. This is the one client module that formats in
 * the viewer's locale: tests/client-locale-format.test.mjs holds every other
 * client component to a fixed one.
 */
export default function LocalTime({
  value,
  format = 'datetime',
  options,
}: {
  value: DateInput;
  format?: DateFormat;
  options?: Intl.DateTimeFormatOptions;
}) {
  const hydrated = useSyncExternalStore(subscribe, () => true, () => false);
  const date = toDate(value);
  let text: string;
  if (!date) text = 'Invalid Date';
  else if (!hydrated) text = formatUtc(date, format);
  else if (format === 'date') text = date.toLocaleDateString(undefined, options);
  else if (format === 'time') text = date.toLocaleTimeString(undefined, options);
  else text = date.toLocaleString(undefined, options);
  return <time dateTime={date?.toISOString()}>{text}</time>;
}
