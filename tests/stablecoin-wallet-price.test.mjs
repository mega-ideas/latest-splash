/**
 * One wallet price (Amendment A1 §2.2, §2.4, §2.5). A USDC transfer out of
 * Splash on the Send USDC desk, when its fee is switched on, pays Splash's
 * WALLET fee from the fee schedule: floor rounding, the minimum and maximum,
 * and the 100 bps ceiling that beats the minimum, exactly as splash_fee
 * computes it on chain. Its terms are rendered from the schedule, never
 * typed in, and the fee goes to the FeeConfig's fee recipient (the finance
 * multisig), never a single address from the environment. While the
 * FeeConfig has no recipient (fees off at publish), nothing is charged.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { kindPrice } from '../lib/fees/copy.ts';
import { FEE_CEILING_BPS, FEE_KIND, LAUNCH_SCHEDULE, splashFee } from '../lib/fees/schedule.ts';
import * as lane from '../lib/payments/stablecoin-lane.ts';

const USDC = 1_000_000n;
const wallet = (principalMinor) => splashFee({ kind: FEE_KIND.WALLET, principalMinor, discountBps: 0, schedule: LAUNCH_SCHEDULE });

test('a wallet transfer out of Splash pays the WALLET schedule, as splash_fee computes it', () => {
  for (const p of [1n * USDC, 10n * USDC, 25n * USDC, 1_000n * USDC, 1_250n * USDC, 10_000n * USDC, 25_000n * USDC, 1_000_000n * USDC, 1_000_002_500n]) {
    assert.equal(lane.stablecoinFeeMinor(p, 'EXTERNAL', true), wallet(p), `${p}`);
    assert.ok(lane.stablecoinFeeMinor(p, 'EXTERNAL', true) * 10_000n <= p * FEE_CEILING_BPS, `${p}: within the ceiling`);
  }
  // The ceiling beats the minimum: 1 USDC pays 0.01, not a 0.05 floor.
  assert.equal(lane.stablecoinFeeMinor(1n * USDC, 'EXTERNAL', true), 10_000n);
  assert.equal(lane.stablecoinFeeMinor(10n * USDC, 'EXTERNAL', true), 100_000n);
  assert.equal(lane.stablecoinFeeMinor(1_000_000n * USDC, 'EXTERNAL', true), 5n * USDC);
  assert.equal(lane.stablecoinFeeMinor(1_000n * USDC, 'SPLASH', true), 0n);
  assert.equal(lane.stablecoinFeeMinor(1_000n * USDC, 'EXTERNAL', false), 0n);
});

test("the fee's terms are rendered from the schedule, not typed in", () => {
  const q = lane.quoteStablecoinTransfer(10_000n * USDC, { destination: 'EXTERNAL', anchorFeeOn: true });
  const said = lane.describeStablecoinFee(q);
  assert.ok(said.includes(kindPrice(LAUNCH_SCHEDULE, FEE_KIND.WALLET)), said);
  assert.match(said, /Splash fee/);
  assert.doesNotMatch(said, /audit-anchor|min 0\.05/i);
  const source = readFileSync('lib/payments/stablecoin-lane.ts', 'utf8');
  assert.doesNotMatch(source, /0\.02 ?%|min 0\.05/, 'no typed rate or floor');
  assert.equal('ANCHOR_FEE_BPS' in lane, false, 'no rate of its own');
});

test("the fee goes to the FeeConfig's fee recipient, and is off while it has none", async () => {
  const deps = readFileSync('lib/server/stablecoin-deps.ts', 'utf8');
  assert.doesNotMatch(deps, /SPLASH_FEE_ADDRESS_MAINNET/, 'no single fee address from the environment');
  const { laneWalletFee } = await import('../lib/server/stablecoin-fee.ts');
  const off = await laneWalletFee({ STABLECOIN_ANCHOR_FEE: 'off' });
  assert.equal(off.on, false);
  // Switched on with no FeeConfig to read: the fee is charged but has no
  // recipient, so transfers out of Splash stay closed rather than defaulting.
  const unread = await laneWalletFee({ STABLECOIN_ANCHOR_FEE: 'on', SUI_NETWORK: 'mainnet' });
  assert.equal(unread.on, true);
  assert.equal(unread.recipient, null);
});
