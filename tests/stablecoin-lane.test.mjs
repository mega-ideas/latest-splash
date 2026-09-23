import assert from 'node:assert/strict';
import test from 'node:test';

import {
  checkStablecoinAllowance,
  laneAccess,
  MIN_STABLECOIN_TRANSFER_MINOR,
  normaliseSuiAddress,
  parseUsdcMinor,
  quoteStablecoinTransfer,
  stablecoinFeeMinor,
  stablecoinLimitsFor,
  STABLECOIN_WINDOW_MS,
  SUI_USDC_COIN_TYPE,
  UNVERIFIED_STABLECOIN_CAP_MINOR,
} from '../lib/payments/stablecoin-lane.ts';

/**
 * The stablecoin lane's rules and arithmetic. Real money runs through these
 * numbers, so the boundaries are tested at the unit, not near it.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 24, 12, 0, 0);
const usdc = (s) => parseUsdcMinor(s);

test('settlement is Circle native USDC on Sui, with the verified coin types', () => {
  assert.equal(
    SUI_USDC_COIN_TYPE.mainnet,
    '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
  );
  assert.equal(
    SUI_USDC_COIN_TYPE.testnet,
    '0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC',
  );
});

test('the fee is 0.80% on top, rounded half-up at the micro-unit', () => {
  assert.equal(stablecoinFeeMinor(usdc('1000')), usdc('8'));
  // 80 bps is exactly 1/125, so a remainder of 63/125 rounds up and 62/125
  // rounds down — an exact half never occurs.
  assert.equal(stablecoinFeeMinor(1_000_063n), 8_001n);
  assert.equal(stablecoinFeeMinor(1_000_062n), 8_000n);

  const q = quoteStablecoinTransfer(usdc('1000'));
  assert.equal(q.principalMinor, usdc('1000'), 'the recipient receives exactly what was entered');
  assert.equal(q.feeMinor, usdc('8'));
  assert.equal(q.totalDebitMinor, usdc('1008'), 'the business pays principal + fee');
  assert.equal(q.feeBps, 80);
});

test('below 1 USDC a wallet transfer is refused, and amounts are never silently rounded', () => {
  assert.throws(() => quoteStablecoinTransfer(MIN_STABLECOIN_TRANSFER_MINOR - 1n), /minimum wallet transfer is 1\.000000 USDC/);
  assert.doesNotThrow(() => quoteStablecoinTransfer(MIN_STABLECOIN_TRANSFER_MINOR));
  assert.equal(usdc('1250.5'), 1_250_500_000n);
  assert.throws(() => usdc('1.0000001'), /fraction digits/);
});

test('an unverified business may send exactly 5,000 USDC in 30 days, and not one micro-unit more', () => {
  const prior = [{ principalMinor: usdc('4000'), atMs: NOW - 10 * DAY }];
  const exact = checkStablecoinAllowance({ state: 'REGISTERED', principalMinor: usdc('1000'), prior, nowMs: NOW });
  assert.equal(exact.ok, true);
  assert.equal(exact.remainingMinor, usdc('1000'));

  const over = checkStablecoinAllowance({ state: 'REGISTERED', principalMinor: usdc('1000') + 1n, prior, nowMs: NOW });
  assert.equal(over.ok, false);
  assert.match(over.reason, /up to 5000\.000000 USDC in any 30 days/);
  assert.match(over.reason, /Finish verification/);
});

test('the window is rolling: the calendar-month reset trick does not work', () => {
  // 5,000 sent late on the 30th of a month...
  const prior = [{ principalMinor: UNVERIFIED_STABLECOIN_CAP_MINOR, atMs: NOW - 1 * DAY }];
  // ...and 1 more USDC the next day is refused, month boundary or not.
  const r = checkStablecoinAllowance({ state: 'REGISTERED', principalMinor: usdc('1'), prior, nowMs: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.remainingMinor, 0n);
});

test('outflows older than the window stop counting — at the boundary exactly', () => {
  const atBoundary = [{ principalMinor: UNVERIFIED_STABLECOIN_CAP_MINOR, atMs: NOW - STABLECOIN_WINDOW_MS }];
  assert.equal(checkStablecoinAllowance({ state: 'REGISTERED', principalMinor: usdc('5000'), prior: atBoundary, nowMs: NOW }).ok, true);

  const justInside = [{ principalMinor: UNVERIFIED_STABLECOIN_CAP_MINOR, atMs: NOW - STABLECOIN_WINDOW_MS + 1 }];
  assert.equal(checkStablecoinAllowance({ state: 'REGISTERED', principalMinor: usdc('1'), prior: justInside, nowMs: NOW }).ok, false);
});

test('the cap is shared: x402 payments and transfers draw from one allowance', () => {
  const prior = [
    { principalMinor: usdc('4999.99'), atMs: NOW - 2 * DAY }, // a transfer
    { principalMinor: usdc('0.01'), atMs: NOW - DAY }, // an x402 payment
  ];
  const r = checkStablecoinAllowance({ state: 'KYB_SUBMITTED', principalMinor: usdc('0.01'), prior, nowMs: NOW });
  assert.equal(r.ok, false, 'a cent over, counting the x402 cent');
});

test('suspended and rejected businesses get no allowance at all', () => {
  for (const state of ['SUSPENDED', 'REJECTED']) {
    assert.equal(stablecoinLimitsFor(state), null);
    const r = checkStablecoinAllowance({ state, principalMinor: usdc('1'), prior: [], nowMs: NOW });
    assert.equal(r.ok, false, `${state} must not inherit the unverified allowance`);
    for (const lane of ['FIAT_IN_USD', 'FIAT_OUT_LOCAL', 'STABLECOIN_WALLET', 'X402', 'TREASURY']) {
      assert.equal(laneAccess(state, lane).allowed, false, `${state} ${lane}`);
    }
  }
});

test('onboarding businesses: stablecoin and x402 open, USD-in and local payouts and treasury locked', () => {
  for (const state of ['REGISTERED', 'KYB_SUBMITTED', 'KYB_PROVIDER_APPROVED', 'KYB_ADMIN_APPROVED']) {
    assert.equal(laneAccess(state, 'STABLECOIN_WALLET').allowed, true);
    assert.equal(laneAccess(state, 'X402').allowed, true);
    assert.equal(laneAccess(state, 'FIAT_IN_USD').allowed, false);
    assert.equal(laneAccess(state, 'FIAT_OUT_LOCAL').allowed, false);
    assert.match(laneAccess(state, 'FIAT_OUT_LOCAL').reason, /unlock when your business is verified/);
    assert.equal(laneAccess(state, 'TREASURY').allowed, false);
  }
});

test('verified businesses get the on-chain Tier 3 defaults on this lane', () => {
  const l = stablecoinLimitsFor('ACTIVE');
  assert.equal(l.perTransferMinor, usdc('20000'));
  assert.equal(l.windowCapMinor, usdc('500000'));
  assert.equal(checkStablecoinAllowance({ state: 'ACTIVE', principalMinor: usdc('20000'), prior: [], nowMs: NOW }).ok, true);
  const tooBig = checkStablecoinAllowance({ state: 'ACTIVE', principalMinor: usdc('20000') + 1n, prior: [], nowMs: NOW });
  assert.equal(tooBig.ok, false);
  assert.match(tooBig.reason, /at most 20000\.000000 USDC/);
});

test('a Sui address is accepted and lower-cased; an Ethereum address is refused, never padded', () => {
  const sui = '0x' + 'AB'.repeat(32);
  assert.equal(normaliseSuiAddress(`  ${sui} `), sui.toLowerCase());

  const evm = '0x209693Bc6afc0C5328bA36FaF03C514EF312287C';
  assert.throws(() => normaliseSuiAddress(evm), /That is an Ethereum address/);
  assert.throws(() => normaliseSuiAddress('0x' + '0'.repeat(64)), /zero address/);
  assert.throws(() => normaliseSuiAddress('0x1234'), /64 hexadecimal/);
  assert.throws(() => normaliseSuiAddress('ab'.repeat(32)), /64 hexadecimal/, 'no 0x prefix is refused too');
});
