/**
 * What an approval actually causes.
 *
 * ─── The gap this closes ────────────────────────────────────────────────────
 *
 * The maker-checker path was complete right up to the last inch. A payment over
 * the threshold became a proposal; the proposal appeared in the queue; a second
 * approver signed it; the state machine walked SIMULATED -> PENDING_APPROVAL ->
 * SIGNED -> SUBMITTED.
 *
 * And then nothing. `SUBMITTED` was terminal in practice: nothing dispatched
 * SETTLE, and the payload a payment would be rebuilt from lived in a `Map` on
 * `globalThis` whose only reference in the entire repository was its own
 * definition. Two approvers signed, the queue showed the run as submitted, and
 * no money moved.
 *
 * That is worse than having no approval flow, because everybody involved
 * believes the payment went. A maker who is told "approved" does not re-send.
 *
 * ─── Why execution re-runs the guards ───────────────────────────────────────
 *
 * The payload is replayed through the SAME authorize path a direct payment
 * takes, not through a shortcut that trusts the approval. Time passed between
 * proposing and approving — possibly a day. In that window the balance can have
 * drained, the corridor can have been paused, the beneficiary can have failed
 * screening, and the daily ceiling can have been consumed by other payments.
 *
 * An approval says "this payment is authorised", not "skip the checks". It
 * removes the requirement for a second approver, because that is precisely
 * what it supplied. (A payout-run approval is no longer replayed at all: the
 * v1 custody batch route is removed, see RETIRED_KIND_REASON.)
 */
import 'server-only';

import { PROPOSAL_KINDS, type UnsignedProposal } from '@/lib/agent/types';
import { x402SettlementAvailability } from '@/lib/agent/x402';
import { closeApprovalClaim } from '@/lib/server/approved-proposal';
import { CUSTODIAL_TREASURY_RETIRED_REASON } from '@/lib/server/custodial-treasury';
import { kindInScope, launchScope, LAUNCH_SCOPE_NOT_SENT } from '@/lib/server/launch-scope';

export type ExecutionOutcome =
  | { state: 'EXECUTED'; detail: string; ref?: string }
  | { state: 'FAILED'; detail: string }
  | { state: 'SKIPPED'; detail: string };

/**
 * What an approval that did not reach the database causes: nothing.
 *
 * The proposal store writes through to Postgres and never throws when a write
 * fails, so the caller asks `store.writeFailed(id)` before executing. A payment
 * made on an approval held only in memory keeps its money movement and loses
 * its authorisation: after a restart the proposal comes back as whatever state
 * last landed — still pending, no signatures — and approvers are asked again
 * for a payment already made (which `consumed_approvals` then refuses as
 * "already used"). The caller also closes the claim (closeApprovalClaim), so
 * nothing can present it later.
 */
export const APPROVAL_NOT_SAVED = {
  state: 'FAILED',
  detail: 'The approval could not be saved, so the payment was not sent and nothing moved.',
} as const satisfies ExecutionOutcome;

/**
 * What an approval of a proposal of a kind that no longer exists records. A
 * payout run used to be one (Zeke drafted it, and the v1 custody route that
 * carried it out is removed); a sheet now goes to the wallet batch flow, which
 * the owners sign once. Said in the outcome itself, so the queue and Zeke show
 * it rather than a made-up success, and never as "re-authorize" through a
 * route that no longer exists.
 */
export const RETIRED_KIND_REASON =
  'Approved and recorded, not executed. Payout runs are no longer carried out from an approval: ' +
  'use Batch payouts, which pays from your business wallet once its owners sign. Nothing was sent.';

/**
 * Carry out the payment an approved proposal describes.
 *
 * Never throws. A proposal that cannot be executed is recorded as FAILED with
 * the reason, because an approval that quietly did nothing is the defect this
 * module exists to remove — replacing it with an approval that quietly failed
 * would be the same bug wearing a different hat.
 */
export type ExecutionContext = {
  /** The approver's own cookie, forwarded so the replay resolves a real
   *  session and a real membership rather than being handed an identity. */
  cookie: string;
  origin: string;
};

export async function executeApprovedProposal(
  proposal: UnsignedProposal,
  payload: Record<string, unknown> | null,
  context: ExecutionContext,
): Promise<ExecutionOutcome> {
  try {
    return await carryOut(proposal, payload, context);
  } finally {
    // One approval, one attempt, whatever the attempt was. The replay closes
    // the claim it presents; this closes the ones no route saw: an approval
    // recorded SKIPPED (a treasury move in Phase 0) or FAILED before a route
    // ran. Left open, a request naming one later would be carried out without
    // a second approver and, since an approval stands in for it, without a
    // second factor. The recorded outcome cannot stop that on its own: it is
    // not read back from Postgres after a restart, and this row is.
    await closeApprovalClaim(proposal.id, proposal.orgId);
  }
}

async function carryOut(
  proposal: UnsignedProposal,
  payload: Record<string, unknown> | null,
  context: ExecutionContext,
): Promise<ExecutionOutcome> {
  // First, before the payload is looked at. Every proposal of a retired kind (a payout run) has
  // none (only the removed route ever wrote one; Zeke's drafts carry none), so
  // asking for the payload first sent each of them to "re-authorize the
  // payment", which there is no longer a route to do. In every launch scope the
  // answer is the same: recorded, not carried out, and where to pay it.
  if (!(PROPOSAL_KINDS as readonly string[]).includes(proposal.kind)) {
    return { state: 'SKIPPED', detail: RETIRED_KIND_REASON };
  }

  if (!payload) {
    return {
      state: 'FAILED',
      detail:
        'The payment details for this approval could not be found, so nothing was sent. ' +
        'Re-authorize the payment to try again.',
    };
  }

  // The backstop for an approval that reached the executor anyway (approved
  // before the scope was set, or a caller that skipped the gate): recorded,
  // named, not carried out (lib/launch-scope-rules.ts).
  if (!kindInScope(proposal.kind, launchScope())) {
    return { state: 'SKIPPED', detail: `Approved and recorded, not executed. ${LAUNCH_SCOPE_NOT_SENT}` };
  }

  try {
    switch (proposal.kind) {
      case 'PAYMENT':
        return await executeTransfer(proposal, payload, context);
      case 'X402_PAYMENT':
        // There is no path that settles x402, so the default's "settles
        // through their own path" would be a lie. Recorded, named, not paid.
        return {
          state: 'SKIPPED',
          detail: `Approved and recorded — not paid. ${x402SettlementAvailability().reason}`,
        };
      case 'TREASURY_ALLOCATE':
      case 'TREASURY_REDEEM':
        // v2 D9: the custodial Smart Treasury ledger is retired, custody phase or
        // not (lib/server/custodial-treasury.ts). An approval for it is recorded
        // and moves nothing into a Splash-held position: Treasury is USDY in the
        // business's own wallet, signed by its owners there.
        return { state: 'SKIPPED', detail: `Approved and recorded, not executed. ${CUSTODIAL_TREASURY_RETIRED_REASON}` };
      default:
        // An agent-drafted FX, netting or internal-transfer proposal has its
        // own settlement path and is not replayed through the money routes.
        // Saying so is better than a silent no-op that reads as success.
        return {
          state: 'SKIPPED',
          detail: `Approved. ${proposal.kind} proposals settle through their own path, not this one.`,
        };
    }
  } catch (error) {
    return {
      state: 'FAILED',
      detail: error instanceof Error ? error.message : 'Execution failed for an unknown reason.',
    };
  }
}

/**
 * Replay a single transfer.
 *
 * `X-Splash-Approved-Proposal` is what tells the authorize route that the
 * second-approver requirement has already been met. It is read from the header
 * and then VERIFIED against the proposal store — a client sending that header
 * on its own gets nowhere, because the route checks that the named proposal
 * exists, belongs to the caller's org, is actually approved, approves this
 * payment, and has not been used. The route spends it; the replay closes it
 * when the route returns (lib/server/approved-proposal.ts).
 */
async function executeTransfer(
  proposal: UnsignedProposal,
  payload: Record<string, unknown>,
  context: ExecutionContext,
): Promise<ExecutionOutcome> {
  const { authorizeTransferForApproval } = await import('./approval-replay.ts');
  const result = await authorizeTransferForApproval({
    orgId: proposal.orgId,
    approvedProposalId: proposal.id,
    body: payload,
    ...context,
  });
  return result.ok
    ? { state: 'EXECUTED', detail: 'Payment sent.', ref: result.ref }
    : { state: 'FAILED', detail: result.error };
}
