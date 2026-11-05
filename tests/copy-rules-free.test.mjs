/**
 * The copy guard's "free" rule (the step B review).
 *
 * scripts/check-copy.mjs refused "zero fees" but not "zero-fee", and nothing
 * refused "for free": the landing said money "moves for free" on Sui's
 * "zero-fee rail". Sui gas is sponsored, not zero, and a payout has a
 * partner's rate. On a marketing surface the claim is refused in every
 * spelling. The signed-in product still says "Splash fee: free" for a
 * transfer between Splash users, which is Splash's own fee and true.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const rules = () => import('../scripts/copy-rules.mjs');

test('a marketing surface may not say zero-fee, fee-free or for free', async () => {
  const { copyViolations } = await rules();
  for (const line of [
    "simple USD payouts ride Sui's zero-fee rail",
    'Idle dollars on Sui already move for free.',
    'Zero fee transfers to the Philippines',
    'A fee-free payout',
    'zero fees on every payout',
  ]) {
    assert.ok(copyViolations('components/IsometricLanding.tsx', line).length > 0, `refused on the landing: ${line}`);
    assert.ok(copyViolations('content/landing-faq.ts', line).length > 0, `refused in content/: ${line}`);
  }
});

test('the product may still say Splash’s own fee is free', async () => {
  const { copyViolations } = await rules();
  assert.deepEqual(copyViolations('components/stablecoin/SendUsdcDesk.tsx', "'Splash fee: free'"), []);
  assert.deepEqual(copyViolations('components/IsometricLanding.tsx', 'Free between Splash businesses'), [], 'the fee schedule’s own line');
});
