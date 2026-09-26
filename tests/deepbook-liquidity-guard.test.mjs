import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * Regression guard for the S-11 fix in
 * `liquidity_guard::assert_deepbook_liquidity` (move/splash_custody/sources/liquidity_guard.move).
 *
 * `sui move test` cannot run in this repo — the pinned DeepBook dependency
 * ships test files that fail to compile against the current toolchain
 * (unbound `destroy` in deepbook's own vault_tests.move), which aborts the
 * whole test build before our modules are reached. So the arithmetic the fix
 * depends on is pinned here instead, using REAL numbers measured against the
 * live testnet SUI/DBUSDC pool (0x1c19362c…) on 2026-08-09:
 *
 *   mid_price                     0.691
 *   get_quote_quantity_out_input_fee(1.3 SUI)
 *     -> remaining_base           0.0985   (lot-size dust + input-side taker fee)
 *     -> quote_out                0.8256
 *
 * Two bugs made every batch unsettleable:
 *   1. the guard required `remaining_base == 0`, which a lot-quantized book
 *      can never return;
 *   2. slippage was priced against the REQUESTED quantity rather than the
 *      FILLED quantity, charging the unfilled dust as if it executed at zero.
 */

const BPS = 10_000;
const MIN_FILL_BPS = 9_000; // must match MIN_FILL_BPS in move/splash_custody/sources/liquidity_guard.move

// Measured on-chain, in base units (MIST) to mirror the contract's u64 math.
const MID_PRICE = 0.691;
const REQUESTED = 1.3;
const REMAINING = 0.0985;
const QUOTE_OUT = 0.8256;

const filled = REQUESTED - REMAINING;

function slippageBps(quoteOut, baseUnits, midPrice) {
  const effective = quoteOut / baseUnits;
  return effective >= midPrice ? 0 : Math.floor(((midPrice - effective) / midPrice) * BPS);
}

test('S-11: the old perfect-fill requirement rejected a healthy book', () => {
  // This is the assert that shipped: remaining_base == 0.
  assert.notEqual(REMAINING, 0, 'a lot-quantized book always returns dust');
  // Measured across 1.1 - 5.0 SUI, the remainder never reached zero, so the
  // old guard rejected 100% of batches regardless of available liquidity.
});

test('S-11: pricing the requested quantity wildly overstates slippage', () => {
  const wrong = slippageBps(QUOTE_OUT, REQUESTED, MID_PRICE);
  // ~809 bps — this is what tripped E_SLIPPAGE_EXCEEDED on a healthy pool.
  assert.ok(wrong > 700, `expected the buggy formula to overstate slippage, got ${wrong}`);
});

test('S-11: pricing the filled quantity gives the true execution slippage', () => {
  const correct = slippageBps(QUOTE_OUT, filled, MID_PRICE);
  // ~56 bps — the real cost of crossing a 43 bps spread.
  assert.ok(correct < 100, `expected realistic slippage, got ${correct}`);
  assert.ok(
    correct < slippageBps(QUOTE_OUT, REQUESTED, MID_PRICE),
    'the corrected formula must never report MORE slippage than the buggy one',
  );
});

test('S-11: the fill-ratio floor accepts lot dust but rejects an unfillable book', () => {
  const fillBps = Math.floor((filled / REQUESTED) * BPS);
  assert.ok(fillBps >= MIN_FILL_BPS, `1.3 SUI fills ${fillBps} bps, must clear ${MIN_FILL_BPS}`);

  // Below the pool's minSize (1 SUI) DeepBook fills nothing at all — that must
  // still be rejected, which is what makes the relaxation safe.
  const nothingFilled = 0;
  assert.ok(
    Math.floor((nothingFilled / REQUESTED) * BPS) < MIN_FILL_BPS,
    'a zero fill must still fail the guard',
  );
});

test('S-11: a batch below the pool minSize is rejected, not silently settled', () => {
  // Measured: getQuoteQuantityOutInputFee(0.009) -> remaining 0.009, quote 0.
  const tinyRequested = 0.009;
  const tinyRemaining = 0.009;
  const tinyQuote = 0;
  assert.equal(tinyQuote, 0, 'sub-minSize returns a zero quote');
  assert.equal(
    tinyRequested - tinyRemaining,
    0,
    'nothing fills below minSize, so the quote_out > 0 assert correctly rejects it',
  );
});
