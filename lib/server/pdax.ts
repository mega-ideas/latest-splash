/**
 * The Philippines payout partner, through the ONE payout-partner interface
 * (v2 §4.5, lib/payouts/partner.ts). `PayoutPartnerAdapter` is that
 * interface: quote, createPayout (keyed by the intent id), status,
 * handleWebhook (signature first, inside the replay window) and
 * returnOrReverse, plus the bank route's deposit address, name enquiry and
 * settlement notice. The adapter itself is lib/payouts/pdax.ts.
 *
 * Which adapter runs is decided by the runtime mode alone
 * (lib/payouts/registry.ts): the sandbox outside production; in production
 * the live adapter, which refuses without its credentials and, until its API
 * is wired, with them. USE_MOCK_APIS never brings the sandbox into
 * production, and nothing here fabricates a quote or a payout reference.
 *
 * `legacySweepPayout` serves the v1 sweep executor (lib/server/sweep.ts), a
 * path that needs the retired custody package. It refuses in production, and
 * outside it names a sandbox reference, never a `DEMO_` one.
 */
import type { SweepJob } from '@/lib/server/operations';
import { PayoutPartnerUnavailable, type PayoutPartner } from '@/lib/payouts/partner';
import { payoutPartner } from '@/lib/payouts/registry';
import { isProductionRuntime } from '@/lib/server/runtime-mode';

export type PayoutPartnerAdapter = PayoutPartner;
export { PayoutPartnerUnavailable };

/** The Philippines payout adapter this server runs (throws PayoutPartnerUnavailable when the route is off). */
export function pdaxAdapter(env: NodeJS.ProcessEnv = process.env): PayoutPartnerAdapter {
  return payoutPartner('pdax', env);
}

/**
 * The v1 sweep's payout (custody path only). Production refuses: the v1
 * sweep has no intent-keyed instruction, no verified deposit address and no
 * ISO 20022 data, so it cannot go to the partner, and no reference is made up.
 */
export async function legacySweepPayout(job: SweepJob, env: NodeJS.ProcessEnv = process.env): Promise<{ partnerPayoutRef: string; sandbox: true }> {
  if (isProductionRuntime(env)) {
    throw new PayoutPartnerUnavailable('The v1 sweep does not pay out in production; payouts go through the payout-partner interface. Nothing was sent.', 'partner_not_built');
  }
  // Outside production: a labelled sandbox reference, so a test run is never mistaken for a payout.
  pdaxAdapter(env);
  return { partnerPayoutRef: `sandbox_pdax_${job.id}`, sandbox: true };
}
