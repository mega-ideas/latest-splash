import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import ts from 'typescript';

import { formatUtc, toDate } from '../lib/formatDate.ts';

/**
 * A date that a client component renders during server rendering has to read
 * the same on the server and in the browser, or React throws a hydration error
 * and renders the tree again. The admin support console did, for a viewer in
 * en-GB: "9/25/2026, 8:47:50 PM" from the server, "25/09/2026, 8:47:50 pm" in
 * the browser.
 *
 * lib/formatDate.ts formats a moment the same way wherever it runs, and
 * components/LocalTime.tsx renders that until the page has hydrated, then the
 * viewer's own. tests/client-locale-format.test.mjs keeps client components
 * from formatting in the runtime's locale anywhere else.
 */

/** Runs `fn` with the process in another time zone, then puts it back. */
function inZone(zone, fn) {
  const before = process.env.TZ;
  process.env.TZ = zone;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
}

test('a moment reads the same in UTC whatever zone the process is in', () => {
  const moment = '2026-09-25T12:47:50Z';
  const kualaLumpur = inZone('Asia/Kuala_Lumpur', () => [new Date(moment).getHours(), formatUtc(moment)]);
  const newYork = inZone('America/New_York', () => [new Date(moment).getHours(), formatUtc(moment)]);
  // The zone did change: the same moment is 20:47 in Kuala Lumpur and 08:47 in New York.
  assert.deepEqual([kualaLumpur[0], newYork[0]], [20, 8]);
  assert.equal(kualaLumpur[1], '25 Sep 2026, 12:47:50 UTC');
  assert.equal(newYork[1], '25 Sep 2026, 12:47:50 UTC');
});

test('the date, the time, or both, and the moment rather than how it was written', () => {
  assert.equal(formatUtc('2026-09-25T12:47:50Z', 'date'), '25 Sep 2026');
  assert.equal(formatUtc('2026-09-25T12:47:50Z', 'time'), '12:47:50 UTC');
  // An offset names the same moment: 20:47 in Kuala Lumpur is 12:47 UTC.
  assert.equal(formatUtc('2026-09-25T20:47:50+08:00'), '25 Sep 2026, 12:47:50 UTC');
  // Past midnight in Kuala Lumpur is still the day before in UTC.
  assert.equal(formatUtc('2027-01-01T07:30:00+08:00'), '31 Dec 2026, 23:30:00 UTC');
  // The day is not padded; the time is.
  assert.equal(formatUtc('2026-03-05T04:03:02Z'), '5 Mar 2026, 04:03:02 UTC');
  // A number of milliseconds and a Date name the same moment as the string.
  const ms = Date.UTC(2026, 8, 25, 12, 47, 50);
  assert.equal(formatUtc(ms), '25 Sep 2026, 12:47:50 UTC');
  assert.equal(formatUtc(new Date(ms)), '25 Sep 2026, 12:47:50 UTC');
});

test('the months come from a table, not from ICU data, which calls en-GB September "Sept" in some versions', () => {
  const months = Array.from({ length: 12 }, (_, month) => formatUtc(Date.UTC(2026, month, 15), 'date').split(' ')[1]);
  assert.deepEqual(months, ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);
});

test('input that names no moment reads "Invalid Date", as toLocaleString() says', () => {
  assert.equal(toDate('not a date'), null);
  assert.equal(formatUtc('not a date'), 'Invalid Date');
  assert.equal(formatUtc(Number.NaN, 'time'), 'Invalid Date');
  assert.equal(formatUtc('not a date'), new Date('not a date').toLocaleString());
});

// ── components/LocalTime.tsx, rendered on the server ────────────────────────

// Node strips types but not JSX: compile the component the way Next would.
registerHooks({
  load(url, context, nextLoad) {
    if (!url.startsWith('file:') || !url.endsWith('.tsx')) return nextLoad(url, context);
    const { outputText } = ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), {
      compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    });
    return { format: 'module', source: outputText, shortCircuit: true };
  },
});
const { default: LocalTime } = await import('../components/LocalTime.tsx');

const serverHtml = (props) => renderToString(createElement(LocalTime, props));

test('LocalTime renders the moment in UTC on the server, in a <time> that carries it', () => {
  assert.match(serverHtml({ value: '2026-09-25T12:47:50Z' }), /^<time datetime="2026-09-25T12:47:50\.000Z">25 Sep 2026, 12:47:50 UTC<\/time>$/i);
  assert.match(serverHtml({ value: '2026-09-25T12:47:50Z', format: 'date' }), />25 Sep 2026</);
  assert.match(serverHtml({ value: new Date('2026-09-25T12:47:50Z'), format: 'time' }), />12:47:50 UTC</);
  // Options shape the viewer's text once hydrated; the server's stays UTC.
  assert.match(serverHtml({ value: '2026-09-25T12:47:50Z', options: { dateStyle: 'medium' } }), />25 Sep 2026, 12:47:50 UTC</);
});

test('LocalTime renders the same HTML whatever zone the server is in', () => {
  const props = { value: '2026-09-25T20:47:50+08:00' };
  assert.equal(inZone('Asia/Kuala_Lumpur', () => serverHtml(props)), inZone('America/New_York', () => serverHtml(props)));
});

test('LocalTime says "Invalid Date" for input that names no moment, with no datetime to carry', () => {
  assert.match(serverHtml({ value: 'not a date' }), /^<time>Invalid Date<\/time>$/);
});

test('LocalTime switches to the viewer\'s own text only once the page has hydrated', () => {
  // useSyncExternalStore reads the server snapshot while hydrating and the
  // client snapshot after: false, then true.
  const source = readFileSync(new URL('../components/LocalTime.tsx', import.meta.url), 'utf8');
  assert.match(source, /useSyncExternalStore\(subscribe, \(\) => true, \(\) => false\)/);
  assert.match(source, /else if \(!hydrated\) text = formatUtc\(date, format\);/);
});
