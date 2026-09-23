import { getContractConfig } from './contract-config.ts';

/**
 * Which phase the deployment is in, decided by the one thing the code can
 * actually check.
 *
 * Phase 0 pays out: a transfer leaves Splash and lands with the recipient's
 * bank or wallet, and nothing is held for anyone. Holding customer funds —
 * a STORED_BALANCE or SWEEP_ACCOUNT delivery, and the treasury — is Phase 2,
 * and needs a money-broking licence Splash does not hold (Business Module:
 * "Money broking license: RM 1–1.5m paid-up capital"; the MFCA is a bank
 * account, not a licence, and is never described as one).
 *
 * The code cannot check a licence. It checks the custody package: the
 * `splash_custody` Move package is published only when the licence exists,
 * so `SPLASH_CUSTODY_PACKAGE_ID` (or `custodyPackageId` in
 * data/contract-config.json) being set IS the Phase-2 switch. Until then every
 * fund-holding path refuses with the same plain reason, and the treasury
 * surfaces say when they arrive rather than showing a projection as if it
 * were a balance.
 */

export const PHASE0_DELIVERY_TIERS = ['PAYOUT_ONLY'] as const;
export const CUSTODY_DELIVERY_TIERS = ['STORED_BALANCE', 'SWEEP_ACCOUNT'] as const;

export type CustodyPhase = 'PHASE_0_PAYOUT_ONLY' | 'PHASE_2_CUSTODY';

export const CUSTODY_PHASE_CODE = 'custody_not_licensed';

/** Plain, and licence-named. Shown to customers, so it claims nothing. */
export const CUSTODY_PHASE_REASON =
  'Holding customer funds — stored balances, sweep accounts and the treasury — is a Phase 2 capability that needs ' +
  'a money-broking licence Splash does not hold yet. Phase 0 pays out only: choose the PAYOUT_ONLY delivery.';

/** Only the field the decision reads, so callers and tests can pass a literal. */
export type CustodyConfig = { custodyPackageId?: string };

export function custodyPhaseEnabled(config: CustodyConfig = getContractConfig()): boolean {
  return Boolean((config.custodyPackageId ?? '').trim());
}

export function currentCustodyPhase(config: CustodyConfig = getContractConfig()): CustodyPhase {
  return custodyPhaseEnabled(config) ? 'PHASE_2_CUSTODY' : 'PHASE_0_PAYOUT_ONLY';
}

/** Whether a delivery tier may be used now. Unknown tiers are never allowed. */
export function deliveryTierAllowed(tier: string, config: CustodyConfig = getContractConfig()): boolean {
  if ((PHASE0_DELIVERY_TIERS as readonly string[]).includes(tier)) return true;
  if ((CUSTODY_DELIVERY_TIERS as readonly string[]).includes(tier)) return custodyPhaseEnabled(config);
  return false;
}

/**
 * The delivery tier to recommend for an invoice's payout. PHP used to map to
 * SWEEP_ACCOUNT unconditionally, so the invoice loop and the transfer prefill
 * recommended a fund-holding tier the authorize step then refused. The
 * recommendation now goes through the same `deliveryTierAllowed()` the money
 * routes enforce: SWEEP_ACCOUNT only once the custody phase is on, and
 * PAYOUT_ONLY otherwise.
 */
export function invoiceDeliveryTier(
  targetCurrency: string | undefined,
  config: CustodyConfig = getContractConfig(),
): 'PAYOUT_ONLY' | 'SWEEP_ACCOUNT' {
  return targetCurrency === 'PHP' && deliveryTierAllowed('SWEEP_ACCOUNT', config) ? 'SWEEP_ACCOUNT' : 'PAYOUT_ONLY';
}

/**
 * The 403 every gated path answers with. A plain Response, so this module
 * stays importable under `node --test` without Next's runtime.
 */
export function custodyPhaseResponse(): Response {
  return new Response(
    JSON.stringify({
      error: CUSTODY_PHASE_REASON,
      code: CUSTODY_PHASE_CODE,
      phase: 'PHASE_0_PAYOUT_ONLY' satisfies CustodyPhase,
      allowedDeliveryTiers: [...PHASE0_DELIVERY_TIERS],
    }),
    { status: 403, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } },
  );
}
