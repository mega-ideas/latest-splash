import { CUSTODY_PHASE_REASON, PHASE0_DELIVERY_TIERS, deliveryTierOpen } from '../custody-phase-rules.ts';
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

// The tier lists, the customer-facing reason and the tier decision live in
// lib/custody-phase-rules.ts, which has no I/O, so the transfer form (a client
// component) locks the same tiers this gate refuses, in the same words.
export { CUSTODY_DELIVERY_TIERS, CUSTODY_PHASE_REASON, PHASE0_DELIVERY_TIERS } from '../custody-phase-rules.ts';

export type CustodyPhase = 'PHASE_0_PAYOUT_ONLY' | 'PHASE_2_CUSTODY';

export const CUSTODY_PHASE_CODE = 'custody_not_licensed';

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
  return deliveryTierOpen(tier, custodyPhaseEnabled(config));
}

/**
 * The operator's switch for SWEEP_ACCOUNT delivery: SWEEP_ACCOUNT_ENABLED,
 * on unless set to 'false' (lib/env.ts). It sits on top of the custody phase,
 * never instead of it: with custody on, an operator can still turn sweeps off,
 * and then nothing may recommend, offer, accept or execute one. The transfer
 * form learns it from app/dashboard/layout.tsx (SweepSwitchContext). Read from
 * process.env on every call rather than through the cached getEnv(), the same
 * reading the delivery executor always made, so tests can set it.
 *
 * It used to be read only inside the executor, after the payer was debited,
 * the payment settled and the recipient credited. With the switch off, a
 * sweep transfer then failed with the money already moved.
 */
export function sweepAccountEnabled(): boolean {
  return process.env.SWEEP_ACCOUNT_ENABLED !== 'false';
}

export const SWEEP_ACCOUNT_DISABLED_CODE = 'sweep_account_disabled';

/**
 * Shown to customers when the switch refuses a sweep before a recipient,
 * transfer or ledger line exists: a transfer at authorize, or a recipient
 * being saved. True in either phase: it names the switch, not the licence,
 * because with custody on the licence is not the reason.
 */
export const SWEEP_ACCOUNT_DISABLED_REASON =
  'Sweep-account delivery is switched off right now, so SWEEP_ACCOUNT cannot be used. ' +
  'Choose the PAYOUT_ONLY delivery, which pays the recipient directly.';

/**
 * The failure reason when the delivery executor meets a sweep while the
 * switch is off. The authorize route refuses those first, so this is the
 * executor's backstop for an intent that reached it anyway (an old row, a
 * future caller), and it claims nothing about what happened before it ran.
 * By then the customer may already have paid, so it never says "choose
 * PAYOUT_ONLY", which would invite a second payment.
 */
export const SWEEP_ACCOUNT_DISABLED_AT_DELIVERY =
  'Sweep-account delivery is switched off, so this transfer was not delivered: nothing was credited ' +
  'or paid out to the recipient. Check with Splash before sending it again.';

/**
 * The delivery tier to recommend for an invoice's payout. PHP used to map to
 * SWEEP_ACCOUNT unconditionally, so the invoice loop and the transfer prefill
 * recommended a fund-holding tier the authorize step then refused. The
 * recommendation now goes through the same checks the money routes enforce:
 * SWEEP_ACCOUNT only once the custody phase is on AND the sweep switch is on,
 * and PAYOUT_ONLY otherwise.
 */
export function invoiceDeliveryTier(
  targetCurrency: string | undefined,
  config: CustodyConfig = getContractConfig(),
  sweepOn: boolean = sweepAccountEnabled(),
): 'PAYOUT_ONLY' | 'SWEEP_ACCOUNT' {
  return targetCurrency === 'PHP' && deliveryTierAllowed('SWEEP_ACCOUNT', config) && sweepOn ? 'SWEEP_ACCOUNT' : 'PAYOUT_ONLY';
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

/**
 * The 403 for a SWEEP_ACCOUNT delivery while the sweep switch is off. Checked
 * after the custody gate, so in Phase 0 the licence reason still answers
 * first. It carries no phase or tier list: which other tiers are open depends
 * on the phase, and this refusal is only about the switch.
 */
export function sweepAccountDisabledResponse(): Response {
  return new Response(
    JSON.stringify({ error: SWEEP_ACCOUNT_DISABLED_REASON, code: SWEEP_ACCOUNT_DISABLED_CODE }),
    { status: 403, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } },
  );
}
