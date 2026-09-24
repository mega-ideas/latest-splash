import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MoneyError,
  applyBps,
  applyRate,
  divRound,
  divideByRate,
  formatMinor,
  parseMinor,
  parseRate,
  rateToNumber,
  sumMinor,
  MICRO_DECIMALS,
  USD_DECIMALS,
} from '../lib/money.ts';

/* The case the W2 rule was written for. */

test('a hundred additions of 0.10 USD is exactly 10.00', () => {
  let total = 0n;
  for (let i = 0; i < 100; i++) total += parseMinor('0.10', USD_DECIMALS);
  assert.equal(total, 1000n);
  assert.equal(formatMinor(total, USD_DECIMALS), '10.00');

  // What the float path this replaces actually produces.
  let float = 0;
  for (let i = 0; i < 100; i++) float += Number.parseFloat('0.10');
  assert.notEqual(float, 10);
  assert.equal(float.toFixed(2), '10.00', 'and toFixed hides it, which is how it survived');
});

test('0.1 + 0.2 is 0.3, and at micro precision too', () => {
  assert.equal(parseMinor('0.1', USD_DECIMALS) + parseMinor('0.2', USD_DECIMALS), parseMinor('0.3', USD_DECIMALS));
  assert.equal(
    formatMinor(parseMinor('0.1', MICRO_DECIMALS) + parseMinor('0.2', MICRO_DECIMALS), MICRO_DECIMALS),
    '0.300000',
  );
  assert.notEqual(0.1 + 0.2, 0.3);
});

/* Parsing */

test('parseMinor is exact across scales, signs and shapes', () => {
  assert.equal(parseMinor('1', 2), 100n);
  assert.equal(parseMinor('1.5', 2), 150n);
  assert.equal(parseMinor('1.05', 2), 105n);
  assert.equal(parseMinor('0.01', 2), 1n);
  assert.equal(parseMinor('.5', 2), 50n);
  assert.equal(parseMinor('1.', 2), 100n);
  assert.equal(parseMinor('+2.50', 2), 250n);
  assert.equal(parseMinor('1234567890123456789.99', 2), 123456789012345678999n);
  assert.equal(parseMinor('5000.00', MICRO_DECIMALS), 5_000_000_000n);
});

test('a negative amount keeps its sign across the decimal point', () => {
  // lib/sui.ts toBaseUnits returned -500000 for '-1.5' — it negated the whole
  // part and added the fraction, so a refund was short by its own fraction.
  assert.equal(parseMinor('-1.5', MICRO_DECIMALS), -1_500_000n);
  assert.equal(parseMinor('-0.01', 2), -1n);
  assert.equal(formatMinor(parseMinor('-1.5', MICRO_DECIMALS), MICRO_DECIMALS), '-1.500000');
});

test('excess precision is refused unless a rounding mode says what to do', () => {
  assert.throws(() => parseMinor('0.005', 2), MoneyError);
  assert.throws(() => parseMinor('0.005', 2), /rounding mode/);
  assert.equal(parseMinor('0.005', 2, 'half-up'), 1n);
  assert.equal(parseMinor('0.005', 2, 'half-even'), 0n);
  assert.equal(parseMinor('0.015', 2, 'half-even'), 2n);
  assert.equal(parseMinor('0.009', 2, 'trunc'), 0n);
  assert.equal(parseMinor('0.001', 2, 'ceil'), 1n);
});

test('a fractional number is refused — its precision is already gone', () => {
  assert.throws(() => parseMinor(0.1, 2), /already been through a float/);
  assert.throws(() => parseMinor(1.5, 2), MoneyError);
  // A whole number is unambiguous, so it is allowed.
  assert.equal(parseMinor(5, 2), 500n);
  assert.equal(parseMinor(0, 2), 0n);
  // Already minor units.
  assert.equal(parseMinor(1234n, 2), 1234n);
});

test('garbage is refused rather than silently becoming zero', () => {
  for (const bad of ['', '  ', 'abc', '1.2.3', '$5.00', '1,000.00', '1e6', 'NaN', '--1']) {
    assert.throws(() => parseMinor(bad, 2), MoneyError, `"${bad}" should be refused`);
  }
  assert.throws(() => parseMinor(Number.NaN, 2), /not finite/);
  assert.throws(() => parseMinor(Number.POSITIVE_INFINITY, 2), /not finite/);
});

/* Formatting */

test('formatMinor always shows the currency scale, and round-trips', () => {
  assert.equal(formatMinor(1000n, 2), '10.00');
  assert.equal(formatMinor(5n, 2), '0.05');
  assert.equal(formatMinor(0n, 2), '0.00');
  assert.equal(formatMinor(-5n, 2), '-0.05');
  assert.equal(formatMinor(1234n, 0), '1234');
  for (const s of ['0.00', '1.00', '1234.56', '-9.99', '0.01']) {
    assert.equal(formatMinor(parseMinor(s, 2), 2), s);
  }
});

/* Rounding */

test('every rounding mode does what it says, in both signs', () => {
  assert.equal(divRound(7n, 2n, 'trunc'), 3n);
  assert.equal(divRound(-7n, 2n, 'trunc'), -3n);
  assert.equal(divRound(7n, 2n, 'floor'), 3n);
  assert.equal(divRound(-7n, 2n, 'floor'), -4n, 'floor goes toward -infinity; trunc goes toward zero');
  assert.equal(divRound(7n, 2n, 'ceil'), 4n);
  assert.equal(divRound(-7n, 2n, 'ceil'), -3n);
  assert.equal(divRound(5n, 10n, 'half-up'), 1n);
  assert.equal(divRound(4n, 10n, 'half-up'), 0n);
  assert.equal(divRound(5n, 10n, 'half-even'), 0n, '0.5 to even is 0');
  assert.equal(divRound(15n, 10n, 'half-even'), 2n, '1.5 to even is 2');
  assert.equal(divRound(25n, 10n, 'half-even'), 2n, '2.5 to even is 2');
  assert.equal(divRound(6n, 3n, 'trunc'), 2n, 'exact division is unaffected by mode');
  assert.throws(() => divRound(1n, 0n, 'trunc'), /division by zero/);
});

/* Rates */

test('an amount times a rate is exact integer arithmetic', () => {
  const rate = parseRate('56.12');
  const usd = parseMinor('1000.00', USD_DECIMALS);
  // 1000.00 USD × 56.12 = 56120.00 PHP
  assert.equal(formatMinor(applyRate(usd, rate, 'half-even', USD_DECIMALS), USD_DECIMALS), '56120.00');
});

test('a rate that does not divide evenly rounds where told, not where the float lands', () => {
  const rate = parseRate('0.3333333333');
  const amount = parseMinor('100.00', USD_DECIMALS);
  assert.equal(applyRate(amount, rate, 'floor', USD_DECIMALS), 3333n);
  assert.equal(applyRate(amount, rate, 'ceil', USD_DECIMALS), 3334n);
});

test('applyRate and divideByRate are inverses at the precision available', () => {
  const rate = parseRate('56.12');
  const usd = parseMinor('1000.00', USD_DECIMALS);
  const php = applyRate(usd, rate, 'half-even', USD_DECIMALS);
  assert.equal(divideByRate(php, rate, 'half-even', USD_DECIMALS), usd);
});

test('a cross-currency conversion respects both scales', () => {
  // 1 USD (2dp) at 1.0 into a 6dp coin is 1.000000
  const usd = parseMinor('1.00', USD_DECIMALS);
  const out = applyRate(usd, parseRate('1'), 'half-even', USD_DECIMALS, MICRO_DECIMALS);
  assert.equal(formatMinor(out, MICRO_DECIMALS), '1.000000');
});

test('dividing by a zero rate is refused, not Infinity', () => {
  assert.throws(() => divideByRate(100n, parseRate('0'), 'trunc', 2), /zero rate/);
});

/* Basis points */

test('basis points are exact and the rounding direction is the caller’s', () => {
  const amount = parseMinor('1000.00', USD_DECIMALS); // 100000 minor
  assert.equal(applyBps(amount, 80, 'half-even'), 800n, '0.80% of 1000.00 is 8.00');
  assert.equal(formatMinor(applyBps(amount, 80, 'half-even'), USD_DECIMALS), '8.00');
  // A fee that does not land on a whole cent: the direction is stated.
  const odd = parseMinor('10.01', USD_DECIMALS);
  assert.equal(applyBps(odd, 80, 'floor'), 8n);
  assert.equal(applyBps(odd, 80, 'ceil'), 9n);
  assert.throws(() => applyBps(amount, 8.5, 'floor'), /whole number/);
});

/* Sums */

test('sumMinor over an empty set is zero, and large sums do not lose precision', () => {
  assert.equal(sumMinor([]), 0n);
  // Beyond Number.MAX_SAFE_INTEGER: a batch total in micro units.
  const big = [9_007_199_254_740_993n, 1n];
  assert.equal(sumMinor(big), 9_007_199_254_740_994n);
  assert.notEqual(Number(9_007_199_254_740_993n) + 1, 9_007_199_254_740_994);
});

test('a batch of a hundred rows reconciles exactly against its own rows', () => {
  const rows = Array.from({ length: 100 }, (_, i) => `${(i + 1)}.${String((i * 7) % 100).padStart(2, '0')}`);
  const minors = rows.map((r) => parseMinor(r, USD_DECIMALS));
  const total = sumMinor(minors);
  // The same sum done the way the ledger would, digit by digit, must agree.
  let check = 0n;
  for (const r of rows) check += parseMinor(r, USD_DECIMALS);
  assert.equal(total, check);
  assert.equal(formatMinor(total, USD_DECIMALS), formatMinor(check, USD_DECIMALS));
});

test('a rate becomes a number for display, and only the digits it holds', () => {
  // A status line shows a price; it never multiplies an amount by it.
  assert.equal(rateToNumber(parseRate('1')), 1);
  assert.equal(rateToNumber(parseRate('0.9990')), 0.999);
  assert.equal(rateToNumber(parseRate('56.42')), 56.42);
  assert.equal(rateToNumber(parseRate('-0.0005')), -0.0005);
});
