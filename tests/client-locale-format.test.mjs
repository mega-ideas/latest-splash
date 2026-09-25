import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

/**
 * A client component renders twice, on the server and then in the browser,
 * and the two renders must produce the same text. toLocaleString() with no
 * arguments formats in the runtime's own locale and time zone: the server's
 * while the page renders there, the viewer's in the browser. For a viewer in
 * en-GB the admin support console rendered "9/25/2026, 8:47:50 PM" on the
 * server and "25/09/2026, 8:47:50 pm" in the browser, and React threw a
 * hydration error and rendered the tree again.
 *
 * So in a "use client" file:
 * - nothing formats in the runtime's locale: toLocaleString(),
 *   toLocaleDateString() and toLocaleTimeString() take a locale, and an
 *   Intl.DateTimeFormat or Intl.NumberFormat is built with one. `undefined`
 *   and `[]` are not locales: both leave it to the runtime. Numbers take
 *   'en-US', as lib/formatMoney.ts does.
 * - no date is formatted at all, except by components/LocalTime.tsx. A fixed
 *   locale leaves the runtime's time zone in the text, and even a fixed zone
 *   leaves its ICU data: Node's spells en-GB September "Sept", which some
 *   browsers do not. LocalTime renders UTC, built by hand, until the page has
 *   hydrated.
 * A date is a toLocaleDateString, toLocaleTimeString or Intl.DateTimeFormat
 * call, or a toLocaleString on a `new Date(…)` or with date options.
 */

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SOURCE_DIRS = ['app', 'components', 'lib'];
const ALLOWED = new Set(['components/LocalTime.tsx']);
const LOCALE_METHODS = new Set(['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString']);
const DATE_METHODS = new Set(['toLocaleDateString', 'toLocaleTimeString']);
const INTL_FORMATTERS = new Set(['DateTimeFormat', 'NumberFormat']);
const DATE_OPTIONS = new Set([
  'dateStyle', 'timeStyle', 'era', 'year', 'month', 'day', 'weekday', 'hour', 'minute', 'second',
  'fractionalSecondDigits', 'dayPeriod', 'hour12', 'hourCycle', 'timeZone', 'timeZoneName',
]);

function sourceFiles(dir) {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [path] : [];
  });
}

/** Whether the file opens with a 'use client' directive. */
function isClient(source) {
  for (const statement of source.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) return false;
    if (statement.expression.text === 'use client') return true;
  }
  return false;
}

/** A locale argument that is missing, `undefined` or `[]` leaves the runtime to choose. */
function noLocale(args) {
  const [locale] = args;
  if (!locale) return true;
  if (ts.isIdentifier(locale) && locale.text === 'undefined') return true;
  return ts.isVoidExpression(locale) || (ts.isArrayLiteralExpression(locale) && locale.elements.length === 0);
}

/** Options that shape a date: an object literal naming any date field. */
const dateOptions = (options) =>
  Boolean(options) && ts.isObjectLiteralExpression(options) && options.properties.some((p) => p.name && DATE_OPTIONS.has(p.name.getText()));

/**
 * The calls in `text` that format in the runtime's locale (`locale`) or format
 * a date (`date`), each as `line: code`; null for a module that is not a
 * client one.
 */
function formattingCalls(fileName, text) {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  if (!isClient(source)) return null;
  const found = { locale: [], date: [] };
  const record = (kind, node) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    found[kind].push(`${line + 1}: ${node.getText(source).replace(/\s+/g, ' ').slice(0, 90)}`);
  };
  const visit = (node) => {
    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && node.expression && ts.isPropertyAccessExpression(node.expression)) {
      const { expression: owner, name } = node.expression;
      const args = node.arguments ?? [];
      if (ts.isCallExpression(node) && LOCALE_METHODS.has(name.text)) {
        if (noLocale(args)) record('locale', node);
        const onDate = ts.isNewExpression(owner) && ts.isIdentifier(owner.expression) && owner.expression.text === 'Date';
        if (DATE_METHODS.has(name.text) || onDate || dateOptions(args[1])) record('date', node);
      }
      if (ts.isIdentifier(owner) && owner.text === 'Intl' && INTL_FORMATTERS.has(name.text)) {
        if (noLocale(args)) record('locale', node);
        if (name.text === 'DateTimeFormat') record('date', node);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const SCANNED = SOURCE_DIRS.flatMap(sourceFiles).map((path) => ({ path, calls: formattingCalls(path, readFileSync(join(ROOT, path), 'utf8')) }));
const CLIENT = SCANNED.filter((file) => file.calls !== null);
const offenders = (kind) =>
  CLIENT.filter((file) => !ALLOWED.has(file.path)).flatMap((file) => file.calls[kind].map((call) => `${file.path}:${call}`));

test('the check finds a call that leaves the locale to the runtime, or formats a date, however it is written', () => {
  const sample = [
    "'use client';",
    'const a = new Date(at).toLocaleString();',
    "const b = due.toLocaleDateString(undefined, { month: 'short' });",
    'const c = lastUpdate?.toLocaleTimeString();',
    'const d = new Intl.DateTimeFormat().format(at);',
    'const e = Intl.NumberFormat(void 0).format(n);',
    "const f = at.toLocaleTimeString([], { hour: '2-digit' });",
    "const g = n.toLocaleString('en-US');",
    "const h = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });",
    "const i = at.toLocaleDateString('en-GB', { timeZone: 'UTC' });",
    "const j = new Date().toLocaleString('en-US');",
    "const k = when.toLocaleString('en-US', { month: 'short', day: 'numeric' });",
    "const l = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC' });",
  ].join('\n');
  const lines = (kind) => formattingCalls('sample.tsx', sample)[kind].map((call) => call.split(':')[0]);
  assert.deepEqual(lines('locale'), ['2', '3', '4', '5', '6', '7']);
  // Numbers with a locale (8, 9) are fine; every date is LocalTime's.
  assert.deepEqual(lines('date'), ['2', '3', '4', '5', '7', '10', '11', '12', '13']);
  // A module without the directive runs where it is imported, and is not read as a client file.
  assert.equal(formattingCalls('server.ts', 'const a = new Date().toLocaleString();'), null);
});

test('every client file is read', (t) => {
  t.diagnostic(`${CLIENT.length} client files of ${SCANNED.length} under ${SOURCE_DIRS.join(', ')}`);
  assert.ok(CLIENT.length >= 90, `only ${CLIENT.length} client files were found`);
  for (const path of ALLOWED) {
    assert.ok(existsSync(join(ROOT, path)), `${path} is allowed but does not exist`);
    assert.ok(CLIENT.some((file) => file.path === path), `${path} is allowed but is not a client file`);
  }
});

test('no client component formats a date or a number in the runtime\'s locale', () => {
  const found = offenders('locale');
  assert.deepEqual(found, [], `\n  ${found.join('\n  ')}\n  Numbers take 'en-US'; dates render with components/LocalTime.tsx.\n`);
});

test('every date a client component shows is rendered by LocalTime', () => {
  const found = offenders('date');
  assert.deepEqual(found, [], `\n  ${found.join('\n  ')}\n  Render it with <LocalTime value={…} />; pass \`locale\` and \`options\` for a fixed format.\n`);
});
