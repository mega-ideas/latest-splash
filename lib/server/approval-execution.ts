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
 * what it supplied, and stands in for the maker's second factor, which was
 * checked when the payment was proposed and cannot be checked twice — the
 * trade-off is written down in approved-proposal.ts.
 */
import 'server-only';

import type { UnsignedProposal } from '@/lib/agent/types';
import { x402SettlementAvailability } from '@/lib/agent/x402';
import { CUSTODY_PHASE_WHY } from '@/lib/custody-phase-rules';
import {
  replayIdentityFromProposal,
  type ReplayChannel,
  type ReplayKind,
} from '@/lib/server/approval-replay-identity';
import { custodyPhaseEnabled } from '@/lib/server/custody-phase';

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
  /** Where the replayed request says it is addressed. Nothing reads it for
   *  authority. */
  origin: string;
  /** How the final approval arrived. Recorded with the replay; it grants
   *  nothing. The replay runs as the approval itself — the proposal's org,
   *  maker and approvers — whichever channel delivered it. */
  channel: ReplayChannel;
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
      case 'BATCH_PAYOUT':
        return await replayApproved(proposal.kind, proposal, payload, context);
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
      // falls through
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
 * Replay a transfer or a payout run through its real route, as the approval.
 *
 * The identity is derived from the proposal record here and bound to the
 * request the replay builds; the route re-verifies it against the store, the
 * membership table and the payment in the body before anything moves. Nothing
 * about it travels in a header a client could also send.
 */
async function replayApproved(
  kind: ReplayKind,
  proposal: UnsignedProposal,
  payload: Record<string, unknown>,
  context: ExecutionContext,
): Promise<ExecutionOutcome> {
  const { authorizeTransferForApproval, authorizeBatchForApproval } = await import('./approval-replay.ts');
  const replay = kind === 'PAYMENT' ? authorizeTransferForApproval : authorizeBatchForApproval;
  const result = await replay({
    identity: replayIdentityFromProposal(proposal, context.channel),
    body: payload,
    origin: context.origin,
  });

  if (result.ok && result.alreadyMade) {
    // The batch replay key found this exact run already made. Nothing new was
    // paid, and saying "started" would claim a payout that did not happen.
    return {
      state: 'SKIPPED',
      detail: `Approved. This exact run was already submitted${result.ref ? ` as ${result.ref}` : ''}, so it was not sent again.`,
    };
  }
  if (result.ok) {
    return { state: 'EXECUTED', detail: kind === 'PAYMENT' ? 'Payment sent.' : 'Payout run started.', ref: result.ref };
  }
  if (result.code === 'approval_already_used') {
    // Another replay of the same approval got there first and its outcome is
    // the one that counts. This one released nothing.
    return {
      state: 'SKIPPED',
      detail: 'Approved. This approval already released its payment, so it was not sent a second time.',
    };
  }
  return { state: 'FAILED', detail: result.error };
}
