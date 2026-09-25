/**
 * A payroll run the approval queue carries out, and what its approval stands
 * in for when it does.
 *
 * ─── The maker's code cannot be presented twice ─────────────────────────────
 *
 * A run above the threshold reaches the queue only after its maker cleared the
 * second factor: the authenticator code, or a WhatsApp code and passkey for
 * exactly these rows. Both are single-use, and both were spent when the route
 * made the proposal (`markStepConsumed` in lib/auth/totp.ts). The queue replays
 * the approved payload, `{ rows, targetCurrency }`, and no code it could carry
 * would be valid. The route checked the second factor before it read the
 * approval, so every approved run stopped there — "The authorization code is
 * not valid.", or "not enrolled" — and was recorded FAILED with nobody paid.
 * `requireTotp` is on by default.
 *
 * So an approval of exactly this run stands in for the maker's factor, as an
 * approval from the queue already stands in for the WhatsApp step-up on the
 * transfer route. Only a claim `resolveApprovalClaim` approved counts: a
 * SUBMITTED BATCH_PAYOUT proposal in this org, carrying its approvers'
 * signatures, for these payable rows in this currency, with no outcome on
 * record, and spent by this request (lib/server/approved-proposal.ts). It lifts
 * the second factor and the second approver and nothing else: the minimum, the
 * row cap, the ceilings and the compliance pause run for it as for any run.
 *
 * ─── One approval, one run ──────────────────────────────────────────────────
 *
 * A run the queue releases is keyed by its approval, not by its rows. Keyed by
 * its rows, the next approved run of the same file — next month's identical
 * payroll, approved as a proposal of its own — found this month's run holding
 * the key and came back as an idempotent replay: recorded as carried out, and
 * nobody paid. Keyed by the approval, `batch_runs_idempotency_unique` lets one
 * approval release one run.
 *
 * The prefix belongs to the queue. A client key that used it could take an
 * approval's run key before the approval does, and the approved run would come
 * back as the client's run.
 */
import 'server-only';

import type { ApprovalClaim } from '@/lib/server/approved-proposal';

export const APPROVAL_RUN_KEY_PREFIX = 'approval:';

export type SecondFactor =
  /** The approval of this run stands in for its maker's spent code. */
  | { by: 'approval'; proposalId: string }
  /** This request clears it: a WhatsApp approval for these rows first when the
   *  org takes them, and otherwise the authenticator code. */
  | { by: 'request'; whatsapp: boolean };

/** Who clears the second factor for this run. */
export function batchSecondFactor(
  claim: ApprovalClaim,
  settings: { requireTotp: boolean; whatsappEnabled: boolean },
): SecondFactor {
  if (claim.approved && claim.proposalId) return { by: 'approval', proposalId: claim.proposalId };
  // A WhatsApp approval is spent only when a second factor is required at
  // all, and never by an approved run: the maker's was spent proposing it.
  return { by: 'request', whatsapp: settings.requireTotp && settings.whatsappEnabled };
}

export type RunKey =
  | { ok: true; key: string; proposalId: string | null }
  | { ok: false; error: string; code: 'reserved_idempotency_key' };

/**
 * The replay key a run is claimed under: its approval's when the queue released
 * it, else the caller's `Idempotency-Key`, else the key derived from its rows.
 */
export function batchRunKey(input: {
  claim: ApprovalClaim;
  headerKey: string | null | undefined;
  rowsKey: string;
}): RunKey {
  if (input.claim.approved && input.claim.proposalId) {
    return { ok: true, key: `${APPROVAL_RUN_KEY_PREFIX}${input.claim.proposalId}`, proposalId: input.claim.proposalId };
  }
  const headerKey = input.headerKey?.trim();
  if (headerKey?.startsWith(APPROVAL_RUN_KEY_PREFIX)) {
    return {
      ok: false,
      code: 'reserved_idempotency_key',
      error:
        `An Idempotency-Key starting with "${APPROVAL_RUN_KEY_PREFIX}" is reserved for runs the approval queue ` +
        'releases. Send a different key, or none.',
    };
  }
  return { ok: true, key: headerKey ? headerKey : input.rowsKey, proposalId: null };
}
