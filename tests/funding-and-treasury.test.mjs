import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { fromBase58, toHex } from '@mysten/sui/utils';

import {
  ANY_DESTINATION_CALLER,
  FUNDING_CHAINS,
  planCrossChainPayout,
  planFunding,
  SUI_CCTP_DOMAIN,
} from '../lib/payments/cctp.ts';
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

// Circle, "Supported blockchains and domains",
// https://developers.circle.com/cctp/concepts/supported-chains-and-domains,
// read 24 Oct 2026. Every CCTP V2 chain with USDC besides Sui (domain 8).
// Left out on purpose: BNB Smart Chain (17, USYC only) and Noble (4, legacy
// protocol only).
const CIRCLE_V2_DOMAINS = {
  APTOS: 9, ARBITRUM: 3, ARC: 26, AVALANCHE: 1, BASE: 6, CODEX: 12, CRONOS: 32, EDGE: 28,
  ETHEREUM: 0, HYPEREVM: 19, INJECTIVE: 29, INK: 21, LINEA: 11, MONAD: 15, MORPH: 30,
  OP_MAINNET: 2, PHAROS: 31, PLASMA: 33, PLUME: 22, POLYGON_POS: 7, SEI: 16, SOLANA: 5,
  SONIC: 13, STARKNET: 25, STELLAR: 27, UNICHAIN: 10, WORLD_CHAIN: 14, X_LAYER: 37, XDC: 18,
};
// Same page and date: the chains marked ✅ in "Source (Fast transfer)".
// Every other chain, Sui included, is N/A there.
const CIRCLE_FAST_SOURCES = [
  'ARBITRUM', 'BASE', 'CODEX', 'EDGE', 'ETHEREUM', 'INK', 'LINEA', 'MORPH', 'OP_MAINNET',
  'PLUME', 'SOLANA', 'STARKNET', 'UNICHAIN', 'WORLD_CHAIN', 'X_LAYER',
];

test('the planner is CCTP V2 only: no legacy route or name survives in cctp.ts', async () => {
  const source = await readFile(new URL('../lib/payments/cctp.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /CCTP_V1/);
  assert.doesNotMatch(source, /V1/i);
  assert.match(source, /'CCTP_V2'/);
});

test('Sui is domain 8, and every chain domain matches Circle’s table', () => {
  assert.equal(SUI_CCTP_DOMAIN, 8);
  const domains = Object.fromEntries(Object.entries(FUNDING_CHAINS).map(([chain, facts]) => [chain, facts.cctpDomain]));
  assert.deepEqual(domains, CIRCLE_V2_DOMAINS);
  assert.equal(Object.keys(FUNDING_CHAINS).length, 29, 'Circle lists 31 chains: Sui, BNB Smart Chain (no USDC), and 29 more');
  assert.equal(new Set(Object.values(domains)).size, 29, 'domains are unique');
  assert.ok(!Object.values(domains).includes(17) && !Object.values(domains).includes(4));
  const fastSources = Object.keys(FUNDING_CHAINS).filter((chain) => FUNDING_CHAINS[chain].fast !== null);
  assert.deepEqual(fastSources.sort(), [...CIRCLE_FAST_SOURCES].sort());
});

test('every listed chain reaches Sui over a CCTP V2 standard transfer at the 0 bps Circle lists', () => {
  for (const source of Object.keys(CIRCLE_V2_DOMAINS)) {
    const plan = planFunding({ source, asset: 'USDC', amount: '1000', destination: WALLET });
    assert.equal(plan.available, true, source);
    assert.equal(plan.route, 'CCTP_V2');
    assert.equal(plan.transfer, 'STANDARD');
    assert.equal(plan.cctp.sourceDomain, CIRCLE_V2_DOMAINS[source]);
    assert.equal(plan.cctp.destinationDomain, SUI_CCTP_DOMAIN);
    assert.equal(plan.cctp.mintRecipient, WALLET);
    assert.equal(plan.cctp.destinationCaller, ANY_DESTINATION_CALLER);
    assert.equal(plan.cctp.minFinalityThreshold, 2000);
    assert.equal(plan.cctp.maxFeeMinor, 0n);
    assert.equal(plan.arrivesMinor, usdc('1000'), `${source}: a standard transfer mints 1:1 with maxFee 0`);
    assert.ok(plan.warnings.some((w) => /maxFee 0/.test(w)), `${source}: the fee caveat is stated`);
    assert.ok(!plan.warnings.some((w) => /no fee/i.test(w)), `${source}: never claims "no fee"`);
  }
});

test('Aptos, unreachable over the legacy protocol, now reaches Sui', () => {
  const plan = planFunding({ source: 'APTOS', asset: 'USDC', amount: '100', destination: WALLET });
  assert.equal(plan.available, true);
  assert.equal(plan.route, 'CCTP_V2');
  assert.equal(plan.cctp.sourceDomain, 9);
  assert.equal(plan.wait, 'about 0.5 seconds');
});

test('fast transfer into Sui is planned only where Circle offers it, with its fee capped and the caveat stated', () => {
  const fast = planFunding({ source: 'BASE', asset: 'USDC', amount: '1000', destination: WALLET, speed: 'FAST' });
  assert.equal(fast.transfer, 'FAST');
  assert.equal(fast.cctp.minFinalityThreshold, 1000);
  // 1.3 bps of 1,000 USDC is 0.13 USDC; maxFee adds 20%.
  assert.equal(fast.cctp.maxFeeMinor, 156_000n);
  assert.equal(fast.arrivesMinor, usdc('1000') - 156_000n);
  assert.ok(fast.warnings.some((w) => /appears available/.test(w) && /Confirm with Circle before relying on it/.test(w)));
  assert.ok(fast.warnings.some((w) => /1\.3 bps/.test(w) && /Fetch the live fee/.test(w)));

  const notOffered = planFunding({ source: 'APTOS', asset: 'USDC', amount: '1000', destination: WALLET, speed: 'FAST' });
  assert.equal(notOffered.transfer, 'STANDARD');
  assert.equal(notOffered.cctp.maxFeeMinor, 0n);
  assert.ok(notOffered.warnings.some((w) => /does not offer fast transfer from Aptos/.test(w)));

  const standard = planFunding({ source: 'ETHEREUM', asset: 'USDC', amount: '1000', destination: WALLET });
  assert.ok(standard.warnings.some((w) => /Faster option/.test(w) && /confirm with Circle/.test(w)));
  assert.throws(() => planFunding({ source: 'LINEA', asset: 'USDC', amount: '0.000001', destination: WALLET, speed: 'FAST' }), /does not cover the fast transfer fee/);
});

test('from Solana, the Sui mint recipient is also given as a base58 public key of the same 32 bytes', () => {
  const plan = planFunding({ source: 'SOLANA', asset: 'USDC', amount: '5', destination: WALLET });
  assert.equal(`0x${toHex(fromBase58(plan.cctp.mintRecipientBase58))}`, WALLET);
  assert.equal(planFunding({ source: 'BASE', asset: 'USDC', amount: '5', destination: WALLET }).cctp.mintRecipientBase58, null);
});

test('USDT is never bridged: swapped to USDC first with the slippage floor, and refused on Sui', () => {
  const plan = planFunding({ source: 'ARBITRUM', asset: 'USDT', amount: '1000', destination: WALLET, swapSlippageBps: 30 });
  assert.equal(plan.minUsdcAfterSwapMinor, usdc('997'));
  assert.equal(plan.arrivesMinor, usdc('997'));
  assert.match(plan.steps[0].action, /Swap 1,000\.00 USDT to USDC/);
  assert.match(plan.steps[1].action, /Burn the USDC with CCTP V2/);
  assert.equal(planFunding({ source: 'SUI', asset: 'USDT', amount: '1', destination: WALLET }).available, false);
  assert.throws(() => planFunding({ source: 'BASE', asset: 'USDC', amount: '10', destination: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C' }), /32-byte Sui address/);
  assert.throws(() => planFunding({ source: 'BASE', asset: 'USDC', amount: '1.0000001', destination: WALLET }), /up to six decimals/);
});

// ─── Cross-chain recipients (burn on Sui, mint elsewhere) ───────────────────

test('an EVM recipient is left-padded to 32 bytes, and a bad checksum is refused', () => {
  const plan = planCrossChainPayout({ destinationChain: 'BASE', amount: '250', recipient: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed' });
  assert.equal(plan.available, true);
  assert.equal(plan.route, 'CCTP_V2');
  assert.equal(plan.transfer, 'STANDARD', 'Circle does not offer fast transfer from Sui');
  assert.equal(plan.cctp.mintRecipient, `0x${'0'.repeat(24)}5aaeb6053f3e94c9b9a09f33669435e7ef1beaed`);
  assert.equal(plan.cctp.sourceDomain, SUI_CCTP_DOMAIN);
  assert.equal(plan.cctp.destinationDomain, 6);
  assert.equal(plan.cctp.maxFeeMinor, 0n);
  assert.equal(plan.cctp.minFinalityThreshold, 2000);
  assert.equal(plan.arrivesMinor, usdc('250'));
  assert.match(plan.steps[0].action, /deposit_for_burn .*complete_burn/);
  assert.throws(() => planCrossChainPayout({ destinationChain: 'BASE', amount: '1', recipient: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD' }), /checksum/);
  assert.throws(() => planCrossChainPayout({ destinationChain: 'ETHEREUM', amount: '1', recipient: WALLET }), /40 hexadecimal/);
});

test('a Solana recipient must be their USDC token account, never the wallet key', () => {
  const usdcMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // any valid 32-byte base58 value
  assert.throws(() => planCrossChainPayout({ destinationChain: 'SOLANA', amount: '1', recipient: usdcMint }), /USDC token account/);
  const plan = planCrossChainPayout({ destinationChain: 'SOLANA', amount: '1', recipient: usdcMint, recipientIsUsdcTokenAccount: true });
  assert.equal(plan.cctp.mintRecipient, '0xc6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d61');
  assert.equal(plan.cctp.destinationDomain, 5);
  assert.ok(plan.warnings.some((w) => /never their wallet address/.test(w)));
  assert.throws(() => planCrossChainPayout({ destinationChain: 'SOLANA', amount: '1', recipient: '0OIl', recipientIsUsdcTokenAccount: true }), /base58/);
});

test('Aptos takes a long-form account address; Stellar, Starknet and Sui itself are not planned', () => {
  const aptos = `0x${'cd'.repeat(32)}`;
  assert.equal(planCrossChainPayout({ destinationChain: 'APTOS', amount: '1', recipient: aptos }).cctp.mintRecipient, aptos);
  assert.throws(() => planCrossChainPayout({ destinationChain: 'APTOS', amount: '1', recipient: '0x1' }), /long form/);
  for (const destinationChain of ['STELLAR', 'STARKNET', 'SUI']) {
    const plan = planCrossChainPayout({ destinationChain, amount: '1', recipient: WALLET });
    assert.equal(plan.available, false, destinationChain);
    assert.ok(plan.alternatives.length >= 1);
  }
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
