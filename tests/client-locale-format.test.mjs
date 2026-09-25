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
 * So no "use client" file formats in the runtime's locale:
 * - toLocaleString(), toLocaleDateString() and toLocaleTimeString() take a
 *   locale, and `undefined` is not one;
 * - an Intl.DateTimeFormat or Intl.NumberFormat is built with one.
 * Numbers take 'en-US', as lib/formatMoney.ts does. Dates are rendered with
 * components/LocalTime.tsx, the one client module that formats in the
 * viewer's locale: it renders UTC until the page has hydrated.
 *
 * A fixed locale does not fix a date's time zone: toLocaleTimeString('en-GB')
 * still reads the runtime's zone, and this does not catch it. Such a date is
 * safe only where it first renders after hydration, from data fetched in the
 * browser.
 */

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SOURCE_DIRS = ['app', 'components', 'lib'];
const ALLOWED = new Set(['components/LocalTime.tsx']);
const LOCALE_METHODS = new Set(['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString']);
const INTL_FORMATTERS = new Set(['DateTimeFormat', 'NumberFormat']);

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

/** A locale argument that is missing or `undefined` leaves the runtime to choose. */
const noLocale = (args) => args.length === 0 || (ts.isIdentifier(args[0]) && args[0].text === 'undefined') || ts.isVoidExpression(args[0]);

/** Every call in `text` that formats in the runtime's locale, as `line: code`; null for a module that is not a client one. */
function runtimeLocaleCalls(fileName, text) {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  if (!isClient(source)) return null;
  const found = [];
  const visit = (node) => {
    let flagged = false;
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && LOCALE_METHODS.has(node.expression.name.text)) {
      flagged = noLocale(node.arguments);
    }
    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && ts.isPropertyAccessExpression(node.expression)) {
      const { expression: owner, name } = node.expression;
      if (ts.isIdentifier(owner) && owner.text === 'Intl' && INTL_FORMATTERS.has(name.text)) flagged = noLocale(node.arguments ?? []);
    }
    if (flagged) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      found.push(`${line + 1}: ${node.getText(source).replace(/\s+/g, ' ').slice(0, 90)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const SCANNED = SOURCE_DIRS.flatMap(sourceFiles).map((path) => ({ path, calls: runtimeLocaleCalls(path, readFileSync(join(ROOT, path), 'utf8')) }));
const CLIENT = SCANNED.filter((file) => file.calls !== null);

test('the check finds a call that leaves the locale to the runtime, however it is written', () => {
  const sample = [
    "'use client';",
    'const a = new Date(at).toLocaleString();',
    "const b = due.toLocaleDateString(undefined, { month: 'short' });",
    'const c = lastUpdate?.toLocaleTimeString();',
    'const d = new Intl.DateTimeFormat().format(at);',
    'const e = Intl.NumberFormat(void 0).format(n);',
    "const f = n.toLocaleString('en-US');",
    "const g = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });",
  ].join('\n');
  assert.deepEqual(
    runtimeLocaleCalls('sample.tsx', sample).map((call) => call.split(':')[0]),
    ['2', '3', '4', '5', '6'],
  );
  // A module without the directive runs where it is imported, and is not read as a client file.
  assert.equal(runtimeLocaleCalls('server.ts', 'const a = new Date().toLocaleString();'), null);
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
  const offenders = CLIENT.filter((file) => !ALLOWED.has(file.path)).flatMap((file) => file.calls.map((call) => `${file.path}:${call}`));
  assert.deepEqual(offenders, [], `\n  ${offenders.join('\n  ')}\n  Numbers take 'en-US'; dates render with components/LocalTime.tsx.\n`);
});
