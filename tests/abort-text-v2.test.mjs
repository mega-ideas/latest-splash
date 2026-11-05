/**
 * The sentences an operator reads when a v2 payment aborts must describe v2.
 *
 * `ABORT_CODES` in lib/server/sui-settlement.ts maps a bare code to the text
 * the console shows. `check-abort-codes.mjs` proves every code has one; these
 * tests check what some of them say. A sentence that sends an operator to a
 * function v2 removed, or to a person who cannot make the call, is worse than
 * a bare number during a failure.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const source = (rel) => readFile(new URL(rel, root), 'utf8');

/** code -> sentence, read from the ABORT_CODES literal. */
async function abortTable() {
  const text = await source('lib/server/sui-settlement.ts');
  const table = new Map();
  for (const m of text.matchAll(/^\s{2}(\d{1,4}):\s*'((?:[^'\\]|\\.)*)',?\s*$/gm)) {
    table.set(Number(m[1]), m[2]);
  }
  assert.ok(table.size > 100, `read the table (${table.size} entries)`);
  return table;
}

/** Every `fun name` declared in a Move source. */
function functionNames(move) {
  return new Set([...move.matchAll(/\bfun\s+([A-Za-z0-9_]+)/g)].map((m) => m[1]));
}

test('46 says that the founder nominates the wallet, not any owner', async () => {
  const table = await abortTable();
  const text = table.get(46);
  assert.ok(text, '46 is explained');
  assert.match(text, /founder/i);
  assert.doesNotMatch(text, /an owner nominated/i);
  assert.doesNotMatch(text, /An owner calls nominate_wallet/i);
});

test('the payment_intent sentences name only functions v2 still has', async () => {
  const table = await abortTable();
  const fns = functionNames(await source('move/splash_core/sources/payment_intent.move'));
  const wrong = [];
  for (const [code, text] of table) {
    if (code < 400 || code > 499) continue;
    // Codes only the v1 testnet package raises say so, and may name v1.
    if (text.includes('(v1 testnet package only)')) continue;
    for (const m of text.matchAll(/payment_intent::([A-Za-z0-9_]+)(\*)?/g)) {
      const [, name, glob] = m;
      const known = glob ? [...fns].some((f) => f.startsWith(name)) : fns.has(name);
      if (!known) wrong.push(`${code}: payment_intent::${name}${glob ?? ''}`);
    }
    // The two v1 entry points v2 removed, named without the module.
    for (const removed of [/\bconfirm_payment_intent\b/, /\bcreate_payment_intent\b(?!_)/]) {
      if (removed.test(text)) wrong.push(`${code}: ${removed.source}`);
    }
  }
  assert.deepEqual(wrong, [], `sentences naming functions v2 does not have:\n  ${wrong.join('\n  ')}`);
});

// The legacy approval path is not in v2 core (decision 3), and its fifteen-
// minute approval TTL went with it. A sentence that still describes it must
// say it is about an earlier testnet package, so an operator reading a v2
// abort is never sent to a path v2 core does not have.
test('only sentences marked as earlier-testnet-only describe the legacy approval path', async () => {
  const table = await abortTable();
  const marked = /\((?:v1 testnet package|earlier testnet packages|earlier v2 testnet package) only\)/;
  const legacy = /\blegacy approv|\bapprover set\b|\bconfirm_with_approval\b|\bfifteen-minute\b|\bdisable_legacy\b/;
  const wrong = [];
  for (const [code, text] of table) {
    if (code >= 1000) continue; // splash_spend and later: their approvals are v2's own.
    if (legacy.test(text) && !marked.test(text)) wrong.push(`${code}: ${text.slice(0, 80)}…`);
  }
  assert.deepEqual(wrong, [], `unmarked sentences about the legacy path:\n  ${wrong.join('\n  ')}`);
  for (const code of [21, 29, 30, 31, 32, 33, 41, 60, 369, 418, 431]) {
    assert.match(table.get(code) ?? '', marked, `${code} is marked as an earlier testnet package's code`);
  }
});
