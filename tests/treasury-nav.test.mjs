import assert from 'node:assert/strict';
import test from 'node:test';

import { getUsdyRedemptionPrice, navIsDecidable, NavUnavailableError, quoteSwap } from '../lib/server/usdy.ts';
import { deriveYieldMicros, spreadOnGain } from '../lib/policy/yield-accrual.ts';

/**
 * Two invariants, both previously violated:
 *
 *   1. NAV FAILS CLOSED. `getUsdyRedemptionPrice` returned a hardcoded `1.0`
 *      whenever the feed was missing. USDY is a price-accrual token — yield IS
 *      the price rising above $1 — so a permanent $1 fallback does not degrade
 *      gracefully. It silently asserts "zero yield, ever", misvalues every
 *      position, and is indistinguishable downstream from a real $1.00 reading.
 *
 *   2. THE LEDGER NEVER CREATES YIELD. `accrueDailyYield` computed
 *      `netApyPct / 100 / 365` and wrote that into balances — a configured
 *      constant manufacturing money, on the cron's schedule, whether or not the
 *      instrument earned anything.
 */

// These tests are about the configured price; Ondo's oracle (read first in
// production) is covered in tests/prices-and-liquidity.test.mjs.
process.env.USDY_ORACLE = 'off';

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('NAV: a missing feed is UNAVAILABLE, never 1.0', async () => {
  const reading = await withEnv(
    { USDY_REDEMPTION_USD: undefined, USDY_REDEMPTION_AS_OF: undefined },
    () => getUsdyRedemptionPrice(),
  );
  assert.equal(reading.status, 'UNAVAILABLE');
  assert.equal(reading.priceMicros, null, 'no price — not a substituted default');
  assert.equal(reading.asOf, null, 'an unmeasured price has no observation time');
  assert.equal(navIsDecidable(reading), false);
});

test('NAV: a zero, negative or unparseable price is UNAVAILABLE', async () => {
  for (const bad of ['0', '-1', 'not-a-number', '']) {
    const reading = await withEnv({ USDY_REDEMPTION_USD: bad }, () => getUsdyRedemptionPrice());
    assert.equal(reading.status, 'UNAVAILABLE', `expected ${JSON.stringify(bad)} to be UNAVAILABLE`);
    assert.equal(reading.priceMicros, null);
  }
});

test('NAV: a fresh reading is LIVE and decidable, in integer micros', async () => {
  const reading = await withEnv(
    { USDY_REDEMPTION_USD: '1.0432', USDY_REDEMPTION_AS_OF: new Date().toISOString() },
    () => getUsdyRedemptionPrice(),
  );
  assert.equal(reading.status, 'LIVE');
  assert.equal(reading.priceMicros, 1_043_200n);
  assert.equal(navIsDecidable(reading), true);
});

test('NAV: an old reading is STALE — valued but not decidable', async () => {
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const reading = await withEnv(
    { USDY_REDEMPTION_USD: '1.05', USDY_REDEMPTION_AS_OF: old },
    () => getUsdyRedemptionPrice(),
  );
  assert.equal(reading.status, 'STALE');
  assert.notEqual(reading.priceMicros, null, 'STALE still carries the price — it is tagged, not discarded');
  assert.equal(navIsDecidable(reading), false, 'but it must not drive an allocation decision');
});

test('NAV: a price with no observation time cannot be aged, so it is STALE', async () => {
  // The old implementation stamped `new Date()` on the fabricated value, which
  // made an invented price look freshly observed. An unageable price is exactly
  // the failure this function exists to prevent.
  const reading = await withEnv(
    { USDY_REDEMPTION_USD: '1.05', USDY_REDEMPTION_AS_OF: undefined },
    () => getUsdyRedemptionPrice(),
  );
  assert.equal(reading.status, 'STALE');
  assert.equal(reading.asOf, null);
  assert.equal(navIsDecidable(reading), false);
});

test('swap quotes refuse to price against an unavailable NAV', async () => {
  await assert.rejects(
    () => withEnv({ USDY_REDEMPTION_USD: undefined }, () => quoteSwap('usdc->usdy', 1_000_000n)),
    (error) => {
      assert.ok(error instanceof NavUnavailableError);
      assert.equal(error.code, 'nav_unavailable');
      return true;
    },
    'the min-out slippage guard is meaningless if computed from an invented price',
  );
});

test('swap quotes work on a live NAV', async () => {
  const quote = await withEnv(
    { USDY_REDEMPTION_USD: '1.05', USDY_REDEMPTION_AS_OF: new Date().toISOString() },
    () => quoteSwap('usdc->usdy', 1_050_000n),
  );
  assert.equal(quote.direction, 'usdc->usdy');
  assert.ok(BigInt(quote.minAmountOutMicro) > 0n);
  // 1.05 USDC at $1.05/USDY buys ~1 USDY, less the slippage guard.
  assert.ok(BigInt(quote.minAmountOutMicro) <= 1_000_000n);
});

test('no configured APY term exists in the derivation — it takes only prices', () => {
  // Under the old implementation a 99% APY alone moved the balance. The pure
  // derivation has no APY parameter at all: it cannot manufacture yield,
  // because there is nothing to manufacture it from.
  const result = deriveYieldMicros({
    principalMicro: 24_500_000_000n,   // $24,500
    priceMicros: 1_000_000n,           // $1.00 — unchanged
    previousPriceMicros: 1_000_000n,
  });
  assert.equal(result.accrued, true);
  assert.equal(result.yieldMicro, 0n, 'no price move, no yield — regardless of any configured rate');
});

test('yield is the price delta on units held', () => {
  const result = deriveYieldMicros({
    principalMicro: 1_000_000_000n,    // $1,000 at $1.00 = 1,000 units
    priceMicros: 1_010_000n,           // price rose 1%
    previousPriceMicros: 1_000_000n,
  });
  assert.equal(result.accrued, true);
  // ~990.1 units at the new price x $0.01 = ~$9.90
  assert.ok(result.yieldMicro > 9_800_000n && result.yieldMicro < 10_000_000n, `got ${result.yieldMicro}`);
});

test('the first observation establishes a baseline and records nothing', () => {
  const result = deriveYieldMicros({
    principalMicro: 1_000_000_000n,
    priceMicros: 1_050_000n,
    previousPriceMicros: null,
  });
  assert.equal(result.accrued, false);
  assert.equal(result.reason, 'no-baseline');
  assert.equal(result.yieldMicro, 0n, 'there is no delta from a price we never saw');
});

test('an empty position accrues nothing', () => {
  const result = deriveYieldMicros({
    principalMicro: 0n,
    priceMicros: 1_050_000n,
    previousPriceMicros: 1_000_000n,
  });
  assert.equal(result.accrued, false);
  assert.equal(result.reason, 'no-position');
});

test('a falling NAV records a loss rather than clamping at zero', () => {
  const result = deriveYieldMicros({
    principalMicro: 1_000_000_000n,
    priceMicros: 950_000n,             // price fell 5%
    previousPriceMicros: 1_000_000n,
  });
  assert.equal(result.accrued, true);
  assert.ok(result.yieldMicro < 0n, 'a price decline is a real loss on the position');
  // And no spread is taken on a loss.
  assert.equal(spreadOnGain(result.yieldMicro), 0n);
});

test('spread is charged on gains only', () => {
  assert.equal(spreadOnGain(10_000_000n), 50_000n, '50 bps of a $10 gain');
  assert.equal(spreadOnGain(-10_000_000n), 0n, 'never charged against a loss');
  assert.equal(spreadOnGain(0n), 0n);
});
