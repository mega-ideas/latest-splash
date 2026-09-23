/**
 * The Phase-0 custody rules, with no I/O.
 *
 * lib/server/custody-phase.ts decides WHETHER the custody phase is on: it
 * reads the contract config, which pulls in node:fs, so a client component
 * cannot import it. What that answer means for a delivery tier, and what a
 * customer is told about it, lives here instead, so the transfer form's
 * padlocks and the routes' 403 come from the same lists, the same function
 * and the same sentence. The server module re-exports all of it.
 *
 * Import-free on purpose: anything this file imported would ship to the
 * browser with the transfer form.
 */

export const PHASE0_DELIVERY_TIERS = ['PAYOUT_ONLY'] as const;
export const CUSTODY_DELIVERY_TIERS = ['STORED_BALANCE', 'SWEEP_ACCOUNT'] as const;

/** Why the fund-holding tiers are closed. Plain, and licence-named; it claims nothing. */
export const CUSTODY_PHASE_WHY =
  'Holding customer funds — stored balances, sweep accounts and the treasury — is a Phase 2 capability that needs ' +
  'a money-broking licence Splash does not hold yet.';

/** The refusal every gated route answers with. Shown to customers, so it claims nothing. */
export const CUSTODY_PHASE_REASON = `${CUSTODY_PHASE_WHY} Phase 0 pays out only: choose the PAYOUT_ONLY delivery.`;

/**
 * Whether a delivery tier is open in the given phase. Unknown tiers never are.
 * The server gate is this with `custodyPhaseEnabled()` as the phase.
 */
export function deliveryTierOpen(tier: string, custodyOn: boolean): boolean {
  if ((PHASE0_DELIVERY_TIERS as readonly string[]).includes(tier)) return true;
  if ((CUSTODY_DELIVERY_TIERS as readonly string[]).includes(tier)) return custodyOn;
  return false;
}
