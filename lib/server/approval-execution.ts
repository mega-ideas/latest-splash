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
 * what it supplied, and the maker's second factor, which was spent proposing
 * the payment and cannot be presented again (lib/server/batch-approval.ts).
 */
import 'server-only';

import type { UnsignedProposal } from '@/lib/agent/types';
import { x402SettlementAvailability } from '@/lib/agent/x402';
import { CUSTODY_PHASE_WHY } from '@/lib/custody-phase-rules';
import { closeApprovalClaim } from '@/lib/server/approved-proposal';
import { custodyPhaseEnabled } from '@/lib/server/custody-phase';

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
      case 'X402_PAYMENT':
        // There is no path that settles x402, so the default's "settles
        // through their own path" would be a lie. Recorded, named, not paid.
        return {
          state: 'SKIPPED',
          detail: `Approved and recorded — not paid. ${x402SettlementAvailability().reason}`,
        };
      case 'TREASURY_ALLOCATE':
      case 'TREASURY_REDEEM':
        // Same honesty in Phase 0: /api/treasury refuses every treasury move,
        // so no "own path" exists to settle this one.
        if (!custodyPhaseEnabled()) {
          return { state: 'SKIPPED', detail: `Approved and recorded, not executed. ${CUSTODY_PHASE_WHY}` };
        }
        // With custody on, /api/treasury IS that path: these proposals come
        // from its approval branch, and are replayed through it as a payment
        // is through the transfer route. They used to be proposed as PAYMENT,
        // and replayed into the transfer route, which refused them.
        return await executeTreasuryMove(proposal, payload, context);
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

/**
 * Replay a treasury move through `/api/treasury`. The route resolves the
 * approval under the treasury kind for the move's direction and amount, and it
 * stands in for the second factor and the second approver
 * (lib/server/treasury-approval.ts); the pause and the ceilings run again as
 * they would for any move.
 */
async function executeTreasuryMove(
  proposal: UnsignedProposal,
  payload: Record<string, unknown>,
  context: ExecutionContext,
): Promise<ExecutionOutcome> {
  const { authorizeTreasuryForApproval } = await import('./approval-replay.ts');
  const result = await authorizeTreasuryForApproval({
    orgId: proposal.orgId,
    approvedProposalId: proposal.id,
    body: payload,
    ...context,
  });
  if (!result.ok) return { state: 'FAILED', detail: result.error };
  return {
    state: 'EXECUTED',
    detail:
      proposal.kind === 'TREASURY_REDEEM'
        ? 'Withdrawal from Smart Treasury requested. It reaches Available after the notice window.'
        : 'Moved into Smart Treasury.',
  };
}
