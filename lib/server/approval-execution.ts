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
 * An approval says "this payment is authorised", not "skip the checks". The
 * only thing it removes is the requirement for a second approver, because that
 * is precisely what it supplied.
 */
import 'server-only';

import type { UnsignedProposal } from '@/lib/agent/types';

export type ExecutionOutcome =
  | { state: 'EXECUTED'; detail: string; ref?: string }
  | { state: 'FAILED'; detail: string }
  | { state: 'SKIPPED'; detail: string };

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
  if (!payload) {
    return {
      state: 'FAILED',
      detail:
        'The payment details for this approval could not be found, so nothing was sent. ' +
        'Re-authorize the payment to try again.',
    };
  }

  try {
    switch (proposal.kind) {
      case 'PAYMENT':
        return await executeTransfer(proposal, payload, context);
      case 'BATCH_PAYOUT':
        return await executeBatch(proposal, payload, context);
      default:
        // An agent-drafted treasury or FX proposal has its own settlement path
        // and is not replayed through the money routes. Saying so is better
        // than a silent no-op that reads as success.
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
 * exists, belongs to the caller's org, and is actually approved.
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

async function executeBatch(
  proposal: UnsignedProposal,
  payload: Record<string, unknown>,
  context: ExecutionContext,
): Promise<ExecutionOutcome> {
  const { authorizeBatchForApproval } = await import('./approval-replay.ts');
  const result = await authorizeBatchForApproval({
    orgId: proposal.orgId,
    approvedProposalId: proposal.id,
    body: payload,
    ...context,
  });
  return result.ok
    ? { state: 'EXECUTED', detail: 'Payout run started.', ref: result.ref }
    : { state: 'FAILED', detail: result.error };
}
