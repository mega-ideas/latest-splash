/**
 * Amendment A1 §3: Splash's fee vectors live in ONE file, lib/fees/vectors.json.
 * scripts/gen-fee-tests.mjs generates move/splash_core/tests/fee_vectors_tests.move
 * from it, and the TS mirror's parity test (tests/fee-schedule.test.mjs) reads
 * the same file, so the chain and the server are held to the same numbers.
 *
 * What is pinned here:
 *   * the file holds every row of A1 §3's table, and the CROSS_CHAIN repeat
 *     of the BANK rows, nothing more and nothing changed. The table below is
 *     copied from the amendment, not from the file;
 *   * every row is well formed (A1's kind numbers, amounts as whole minor
 *     units, a discount of at most 100 bps);
 *   * the generated Move test is exactly what the generator makes of the
 *     file today, with one #[test] per row, so a vector edited without
 *     regenerating cannot pass for tested.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const VECTORS = path.resolve('lib/fees/vectors.json');
const GENERATED = path.resolve('move/splash_core/tests/fee_vectors_tests.move');

const SB = 0;
const WALLET = 1;
const EXCHANGE = 2;
const CROSS_CHAIN = 3;
const BANK = 4;

/** A1 §3, row by row: [kind, principal, expected fee, declared, partner, discount]. */
const BANK_ROWS = [
  ['999999999', '2999999'],
  ['1000000000', '2000000'],
  ['9999999999', '19999999'],
  ['10000000000', '12000000'],
  ['49999999999', '59999999'],
  ['50000000000', '35000000'],
  ['99999999999', '69999999'],
  ['100000000000', '50000000'],
];
const A1_TABLE = [
  ...BANK_ROWS.map(([p, f]) => [BANK, p, f]),
  // "CROSS_CHAIN: same rows as BANK"
  ...BANK_ROWS.map(([p, f]) => [CROSS_CHAIN, p, f]),
  [EXCHANGE, '999999999', '1499999'],
  [EXCHANGE, '1000000000', '1200000'],
  [EXCHANGE, '10000000000', '10000000'],
  [EXCHANGE, '50000000000', '35000000'],
  [EXCHANGE, '100000000000', '50000000'],
  [WALLET, '10000000', '100000'],
  [WALLET, '25000000', '250000'],
  [WALLET, '1250000000', '250000'],
  [WALLET, '10000000000', '2000000'],
  [WALLET, '25000000000', '5000000'],
  [WALLET, '1000000000000', '5000000'],
  [SB, '50000000000', '0'],
  // "Partner address declared WALLET, 5,000 → BANK"
  [BANK, '5000000000', '10000000', WALLET, true, 0],
  // "BANK 5,000 with 10 bps discount"
  [BANK, '5000000000', '5000000', BANK, true, 10],
];

function load() {
  return JSON.parse(readFileSync(VECTORS, 'utf8'));
}

/** A row as A1 states it, with the file's defaults filled in. */
function normal(row) {
  const declared = row.declared ?? row.kind;
  const partner = row.partner ?? row.kind === BANK;
  return [row.kind, row.principal_minor, row.expected_fee_minor, declared, partner, row.discount_bps].join('|');
}

test('the kinds are A1’s numbers', () => {
  assert.deepEqual(load().kinds, { SPLASH_BUSINESS: 0, WALLET: 1, EXCHANGE: 2, CROSS_CHAIN: 3, BANK_PAYOUT: 4 });
});

test('the file holds every row of A1 §3, and only those', () => {
  const want = A1_TABLE.map(([kind, p, f, declared = kind, partner = kind === BANK, discount = 0]) =>
    [kind, p, f, declared, partner, discount].join('|'),
  ).sort();
  const got = load().vectors.map(normal).sort();
  assert.deepEqual(got, want);
});

test('every row is well formed', () => {
  const { vectors } = load();
  const names = new Set();
  for (const row of vectors) {
    assert.equal(typeof row.name, 'string', JSON.stringify(row));
    assert.ok(!names.has(row.name), `two rows are named ${row.name}`);
    names.add(row.name);
    assert.ok([0, 1, 2, 3, 4].includes(row.kind), `${row.name}: kind ${row.kind}`);
    assert.match(row.principal_minor, /^(0|[1-9]\d*)$/, `${row.name}: principal_minor`);
    assert.match(row.expected_fee_minor, /^(0|[1-9]\d*)$/, `${row.name}: expected_fee_minor`);
    assert.ok(Number.isInteger(row.discount_bps) && row.discount_bps >= 0 && row.discount_bps <= 100, `${row.name}: discount_bps`);
    if ('declared' in row) assert.ok([0, 1, 2, 3, 4].includes(row.declared), `${row.name}: declared`);
    if ('partner' in row) assert.equal(typeof row.partner, 'boolean', `${row.name}: partner`);
  }
});

test('the generated Move test is what the generator makes of the file, one #[test] per row', async () => {
  const { renderFeeVectorTests } = await import('../scripts/gen-fee-tests.mjs');
  const expected = renderFeeVectorTests(load());
  const committed = readFileSync(GENERATED, 'utf8').replace(/\r\n/g, '\n');
  assert.equal(committed, expected, 'run `node scripts/gen-fee-tests.mjs`');
  const tests = committed.match(/^#\[test\]\nfun vector_/gm) ?? [];
  assert.equal(tests.length, load().vectors.length);
});
