import assert from 'node:assert/strict';
import test from 'node:test';

import { FUNDING_CHAINS, planFunding, SUI_CCTP_DOMAIN } from '../lib/payments/cctp.ts';
import { parseUsdcMinor } from '../lib/payments/stablecoin-lane.ts';
import {
  dailyGrowthPpb,
  minReceived,
  projectValue,
  treasuryQuote,
  USDY_COIN_TYPE_SUI,
  usdcValueOfUsdy,
  usdyForUsdc,
} from '../lib/payments/treasury-usdy.ts';

const WALLET = `0x${'ab'.repeat(32)}`;
const usdc = (s) => parseUsdcMinor(s);

// ─── Funding ────────────────────────────────────────────────────────────────

test('USDC on Sui goes straight to the Splash wallet; there is no native USDT on Sui', () => {
  const direct = planFunding({ source: 'SUI', asset: 'USDC', amount: '250', destination: WALLET });
  assert.equal(direct.available, true);
  assert.equal(direct.route, 'DIRECT');
  assert.equal(direct.arrivesMinor, usdc('250'));
  const usdt = planFunding({ source: 'SUI', asset: 'USDT', amount: '250', destination: WALLET });
  assert.equal(usdt.available, false);
  assert.match(usdt.reason, /no native USDT on Sui/);
});

test('Ethereum, Arbitrum, Base and Solana reach Sui over CCTP V1, domain 8, with the phase-out stated', () => {
  for (const source of ['ETHEREUM', 'ARBITRUM', 'BASE', 'SOLANA']) {
    const plan = planFunding({ source, asset: 'USDC', amount: '1000', destination: WALLET });
    assert.equal(plan.available, true, source);
    assert.equal(plan.route, 'CCTP_V1');
    assert.equal(plan.cctp.destinationDomain, SUI_CCTP_DOMAIN);
    assert.equal(plan.cctp.sourceDomain, FUNDING_CHAINS[source].cctpDomain);
    assert.equal(plan.cctp.mintRecipient, WALLET);
    assert.equal(plan.arrivesMinor, usdc('1000'), 'CCTP mints 1:1; Circle charges no fee on V1');
    assert.ok(plan.warnings.some((w) => /phasing V1 out since 31 July 2026/.test(w)));
  }
  assert.deepEqual([FUNDING_CHAINS.ETHEREUM.cctpDomain, FUNDING_CHAINS.ARBITRUM.cctpDomain, FUNDING_CHAINS.BASE.cctpDomain, FUNDING_CHAINS.SOLANA.cctpDomain], [0, 3, 6, 5]);
});

test('Aptos has no CCTP route to Sui: V2 only there, V1 only on Sui', () => {
  const plan = planFunding({ source: 'APTOS', asset: 'USDC', amount: '100', destination: WALLET });
  assert.equal(plan.available, false);
  assert.match(plan.reason, /do not interoperate/);
  assert.ok(plan.alternatives.length >= 2);
});

test('USDT is swapped to USDC first, and the plan carries the slippage floor', () => {
  const plan = planFunding({ source: 'ARBITRUM', asset: 'USDT', amount: '1000', destination: WALLET, swapSlippageBps: 30 });
  assert.equal(plan.minUsdcAfterSwapMinor, usdc('997'));
  assert.equal(plan.arrivesMinor, usdc('997'));
  assert.match(plan.steps[0].action, /Swap 1,000\.00 USDT to USDC/);
  assert.throws(() => planFunding({ source: 'BASE', asset: 'USDC', amount: '10', destination: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C' }), /32-byte Sui address/);
});

// ─── Treasury math ──────────────────────────────────────────────────────────

test('USDC → USDY at the price, rounded down; the round trip never creates value', () => {
  assert.equal(USDY_COIN_TYPE_SUI.endsWith('::usdy::USDY'), true);
  const price = 1_139_000n; // $1.139 per USDY
  const out = usdyForUsdc(usdc('1000'), price);
  assert.equal(out, 877_963_125n); // 877.963125 USDY
  assert.ok(usdcValueOfUsdy(out, price) <= usdc('1000'), 'floor at every step');
  assert.equal(minReceived(1_000_000n, 50), 995_000n);
  assert.throws(() => usdyForUsdc(1n, 0n), /positive/);
});

test('projections compound daily and err low', () => {
  assert.equal(projectValue(usdc('1000'), 0, 365), usdc('1000'));
  const year = projectValue(usdc('1000'), 5, 365);
  assert.ok(year <= usdc('1050') && year > usdc('1049.99'), `5% APY for a year ≈ 1050, got ${year}`);
  assert.ok(dailyGrowthPpb(5) > 0n);
  assert.throws(() => dailyGrowthPpb(-1), /APY/);
});

test('treasury eligibility: verified only, never US, preview until Ondo eligibility is confirmed, and no price no quote', () => {
  const nav = { status: 'LIVE', priceMicros: 1_139_000n, asOf: '2026-09-24T00:00:00Z' };
  const unverified = treasuryQuote({ state: 'REGISTERED', country: 'MY', usdcInMinor: usdc('1000'), nav, apyPct: 4, ondoEligibilityConfirmed: true });
  assert.equal(unverified.allowed, false);
  assert.match(unverified.reasons[0], /verified businesses/);

  const us = treasuryQuote({ state: 'ACTIVE', country: 'US', usdcInMinor: usdc('1000'), nav, apyPct: 4, ondoEligibilityConfirmed: true });
  assert.equal(us.allowed, false);

  const noPrice = treasuryQuote({ state: 'ACTIVE', country: 'MY', usdcInMinor: usdc('1000'), nav: { status: 'UNAVAILABLE', priceMicros: null }, apyPct: 4, ondoEligibilityConfirmed: true });
  assert.equal(noPrice.allowed, false);
  assert.equal(noPrice.usdyOutMinor, null);

  const unaged = treasuryQuote({ state: 'ACTIVE', country: 'MY', usdcInMinor: usdc('1000'), nav: { status: 'STALE', priceMicros: 1_000_000n, asOf: null }, apyPct: 4, ondoEligibilityConfirmed: false });
  assert.equal(unaged.allowed, false, 'a flat, undated $1.00 is a placeholder, not a price');
  assert.equal(unaged.usdyOutMinor, null);
  assert.ok(unaged.reasons.some((r) => /no observation time/.test(r)));

  const preview = treasuryQuote({ state: 'ACTIVE', country: 'MY', usdcInMinor: usdc('1000'), nav, apyPct: 4, ondoEligibilityConfirmed: false });
  assert.equal(preview.allowed, true);
  assert.equal(preview.mode, 'SANDBOX');
  assert.ok(preview.reasons.some((r) => /Preview only/.test(r)));
  assert.equal(preview.projections.length, 3);
  assert.equal(preview.minUsdyOutMinor, minReceived(preview.usdyOutMinor, 50));
});
