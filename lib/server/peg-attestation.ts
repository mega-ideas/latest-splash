/**
 * What the settlement PTB is allowed to write into `PegState`.
 *
 * Audit finding (high): every settlement PTB called
 *
 *     peg_monitor::update_peg(state, cap, SPLASH_PEG_USDC_DEVIATION_PPM ?? '0',
 *                                         SPLASH_PEG_USDT_DEVIATION_PPM ?? '0', clock)
 *
 * as its FIRST command, and `settle_payment` — which calls `assert_pegged` —
 * as its second. The breaker therefore read a perfect 0-ppm peg that the very
 * same transaction had just written, one instruction earlier. `assert_pegged`
 * could not fail. The on-chain peg circuit breaker, the control that exists so
 * that funds cannot leave on a broken peg even when the off-chain layer is
 * bypassed, was inert in every deployment.
 *
 * Two things were wrong and both are fixed here:
 *
 *  1. The pushed value was a CONSTANT (env, defaulting to `0`), not a
 *     measurement. A settlement may only attest a reading it actually took.
 *  2. The price adapter fell back to a mock $1.00 on any oracle error, so
 *     even "measured" could mean fabricated. A fabricated reading is never
 *     pushed; a mock exists only when USE_MOCK_APIS asks for one by name.
 *
 * When no live reading is available the PTB simply omits `update_peg`. That is
 * the fail-closed direction: `PegState` goes stale and `assert_pegged` aborts
 * with 302 `E_PEG_STALE` rather than green-lighting a settlement against a peg
 * nobody checked.
 *
 * And today there is no reading to attest. `update_peg` takes each coin's
 * distance from the DOLLAR. Splash's only price source is DeepBook
 * (lib/server/peg.ts), which prices USDT in USDC: it can say the two coins
 * agree, not what either is worth in dollars, and writing 0 for USDC would be
 * the constant this file exists to forbid. Dollar prices need an oracle; Pyth
 * was that oracle until Hermes began requiring a paid key (26 August 2026)
 * and Splash chose not to buy one. So the on-chain breaker stays stale and
 * the settlement paths that call `assert_pegged` (splash_custody's
 * settlement.move, behind the custody gate) refuse to settle. Payouts check
 * the peg off chain against DeepBook before they start (transfers/authorize),
 * and `confirm_payment_intent` does not read PegState. The USDC lane moves
 * USDC as USDC, so there is no conversion for a peg to guard.
 */

export type PegAttestation =
  | { push: true; usdcDeviationPpm: number; usdtDeviationPpm: number; primary: string }
  | { push: false; reason: string };

export const NO_DOLLAR_PRICE_REASON =
  'no dollar price to attest: DeepBook prices USDT in USDC, not in dollars, and Splash has no dollar oracle';

/**
 * Whether this settlement may attest the peg on chain, and what.
 *
 * Never throws: an oracle problem must not crash a settlement path, it must
 * decline to attest and let the on-chain staleness guard do its job.
 */
export async function resolvePegAttestation(env: NodeJS.ProcessEnv = process.env): Promise<PegAttestation> {
  // Demo/CI runs with USE_MOCK_APIS explicitly asked for fabricated prices, so
  // attesting a perfect peg is honest there — but only there, and only because
  // the operator opted in by name.
  if (env.USE_MOCK_APIS === 'true') return { push: true, usdcDeviationPpm: 0, usdtDeviationPpm: 0, primary: 'mock' };
  return { push: false, reason: NO_DOLLAR_PRICE_REASON };
}
