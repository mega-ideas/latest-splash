import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

/**
 * Many tests read a source file as text and strip its comments first, with
 * the pattern /\/\*[\s\S]*?\*\//g (tests/invoice-currency-read.test.mjs and
 * over forty others). The pattern cannot tell a comment from a string: in
 * `accept=".pdf,image/*"` it sees a comment open, and the next `*` `/` in the
 * file closes it. When a doc comment was added below InvoiceLoop's file
 * input, lines 424-787 read as one comment, and two tests stopped seeing the
 * code they check.
 *
 * So a `/*` inside a string, template, JSX text or regular expression is not
 * followed by a block comment later in the same file. Where such a string has
 * to stay, the comments after it are `//` lines.
 *
 * scripts/ is left out: check-copy.mjs and check-store-access.mjs skip
 * comments themselves, so they name '/*' and '*' + '/' as strings, and the
 * pattern takes the line between as a comment. No test reads that line.
 */

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SOURCE_DIRS = ['app', 'components', 'lib', 'content'];
const NAIVE_COMMENT = /\/\*[\s\S]*?\*\//g;
const LITERALS = new Set([
  ts.SyntaxKind.StringLiteral, ts.SyntaxKind.NoSubstitutionTemplateLiteral, ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle, ts.SyntaxKind.TemplateTail, ts.SyntaxKind.JsxText, ts.SyntaxKind.RegularExpressionLiteral,
]);

function sourceFiles(dir) {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(path);
    return /\.(tsx?|jsx?|mjs)$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [path] : [];
  });
}

/** The comments the pattern would strip that open inside a literal, as `line: the lines it takes`. */
function fakeComments(fileName, text) {
  if (!text.includes('/*')) return [];
  const kind = /\.[jt]sx$/.test(fileName) ? ts.ScriptKind.TSX : /\.m?js$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const literals = [];
  const visit = (node) => {
    if (LITERALS.has(node.kind)) literals.push([node.getStart(source), node.getEnd()]);
    ts.forEachChild(node, visit);
  };
  visit(source);
  const found = [];
  for (const match of text.matchAll(NAIVE_COMMENT)) {
    if (!literals.some(([start, end]) => match.index >= start && match.index < end)) continue;
    const line = text.slice(0, match.index).split('\n').length;
    found.push(`${line}: takes ${match[0].split('\n').length} lines, to "${match[0].slice(-40).replace(/\s+/g, ' ')}"`);
  }
  return found;
}

test('the check finds a string that opens a comment for the pattern, and only that', () => {
  const input = '<input type="file" accept=".pdf,image/*" />';
  assert.deepEqual(fakeComments('a.tsx', `${input}\n/** A doc comment. */\nconst x = 1;`).map((f) => f.split(':')[0]), ['1']);
  // A real comment, and a `/*` in a string with no comment after it, are fine.
  assert.deepEqual(fakeComments('b.tsx', `/** A doc comment. */\n${input}\n// A line comment.`), []);
  assert.deepEqual(fakeComments('c.mjs', "const glob = 'src/**';\nconst x = 1;"), []);
  // A later string that closes it counts too: the pattern does not know it is a string.
  assert.deepEqual(fakeComments('d.mjs', "const glob = 'src/**';\nconst mime = `*/*`;").map((f) => f.split(':')[0]), ['1']);
});

test('no string in the source opens a comment for the tests that strip comments', (t) => {
  const files = SOURCE_DIRS.flatMap(sourceFiles);
  t.diagnostic(`${files.length} files under ${SOURCE_DIRS.join(', ')}`);
  assert.ok(files.length >= 400, `only ${files.length} files were read`);
  const found = files.flatMap((path) => fakeComments(path, readFileSync(join(ROOT, path), 'utf8')).map((f) => `${path}:${f}`));
  assert.deepEqual(found, [], `\n  ${found.join('\n  ')}\n  Keep the comments after that string as // lines.\n`);
});
