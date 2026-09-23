import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { jsonSafe } from '../lib/server/json.ts';

/**
 * The money boundary at the wire.
 *
 * Phase 2 made every amount and rate a bigint. `JSON.stringify` throws on those
 * rather than coercing them, so a route that returned one 500'd —
 * `/api/quotes/peg-status` did, in production code, and nothing caught it:
 * no test called the route, and TypeScript is perfectly happy to hand a `Rate`
 * to `NextResponse.json`.
 */

test('a bigint survives as an exact string, not a lossy number', () => {
  // 2^53 + 1 — the first integer a JS number cannot represent. If this ever
  // serialises as a number it comes back as 9007199254740992, one short.
  const big = 9007199254740993n;
  assert.equal(jsonSafe(big), '9007199254740993');
  assert.equal(JSON.parse(JSON.stringify(jsonSafe({ amount: big }))).amount, '9007199254740993');
});

test('nested money survives — a Rate inside a quote inside a list', () => {
  const payload = {
    quotes: [{ id: 'q1', rate: { scaled: 1_000_000_000_000n, scale: 12 }, feeMinor: 250n }],
    totalMinor: 100_000n,
  };
  const out = jsonSafe(payload);
  const round = JSON.parse(JSON.stringify(out));
  assert.equal(round.quotes[0].rate.scaled, '1000000000000');
  assert.equal(round.quotes[0].rate.scale, 12);
  assert.equal(round.quotes[0].feeMinor, '250');
  assert.equal(round.totalMinor, '100000');
});

test('everything that is not a bigint is left alone', () => {
  assert.equal(jsonSafe(null), null);
  assert.equal(jsonSafe(undefined), undefined);
  assert.equal(jsonSafe(1.5), 1.5);
  assert.equal(jsonSafe('x'), 'x');
  assert.equal(jsonSafe(true), true);
  assert.deepEqual(jsonSafe([1, 'a', null]), [1, 'a', null]);
});

test('a Date becomes an ISO string rather than an empty object', () => {
  const d = new Date('2026-09-05T12:00:00.000Z');
  assert.equal(jsonSafe({ at: d }).at, '2026-09-05T12:00:00.000Z');
});

test('the peg-status route uses the money responder', () => {
  const source = readFileSync('app/api/quotes/peg-status/route.ts', 'utf8');
  assert.match(source, /moneyJson\(/);
  assert.doesNotMatch(
    source.replace(/\/\*[\s\S]*?\*\//g, ' '),
    /NextResponse\.json\(/,
    'this payload carries Rate values; NextResponse.json throws on their bigints',
  );
});

/**
 * The other half of the same afternoon: six routes called
 * `resolveSessionAccount` directly, so an account with no membership — the
 * ordinary state right after signup — got a 500 instead of an answer. Two of
 * them were the money-authorization routes.
 */
function routesCalling(name) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name === 'route.ts' && readFileSync(path, 'utf8').includes(name)) found.push(path);
    }
  };
  walk('app/api');
  return found;
}

test('no route resolves a session account without handling the no-membership case', () => {
  const direct = routesCalling('resolveSessionAccount(');
  assert.deepEqual(
    direct,
    [],
    'use requireSessionAccount — it answers 403 with an actionable message instead of throwing',
  );
});

test('every route that needs an account uses the answering form', () => {
  const routes = routesCalling('requireSessionAccount(');
  assert.ok(routes.length >= 6, `expected the six money routes, found ${routes.length}`);
  for (const path of routes) {
    const source = readFileSync(path, 'utf8');
    assert.match(
      source,
      /if \(accountCheck\.response\) return accountCheck\.response;/,
      `${path} resolves an account but never returns the refusal`,
    );
  }
});
