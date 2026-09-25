/**
 * A treasury move above the approval threshold, as the approval queue sees it.
 *
 * ─── The kind is what routes the approval ───────────────────────────────────
 *
 * `/api/treasury` proposed its moves as PAYMENT. The executor carries a PAYMENT
 * out by replaying it through `/api/transfers/authorize`, which rejects the
 * `{ action, amountUsd }` body as an invalid transfer, so an approved move was
 * recorded FAILED. In-app it did not even get that far: as a PAYMENT it named
 * no beneficiary, and policy holds such a payment for compliance at approval
 * time. The treasury kinds are what the executor routes back through
 * `/api/treasury`, and what policy and compliance treat as an org-internal
 * movement, which a treasury move is.
 *
 * ─── What an approval covers ────────────────────────────────────────────────
 *
 * The route resolves the claim under the treasury kind for its direction and
 * `treasuryMoveSubstance`: an approval of a withdrawal does not cover a move
 * in, and an approval of one amount does not cover another. It is spent when
 * it is resolved, so one approval carries out one move
 * (lib/server/approved-proposal.ts).
 *
 * ─── Why it stands in for the second factor ─────────────────────────────────
 *
 * The move reaches the queue only after its maker cleared TOTP, and that code
 * is single-use: it was spent when the proposal was made. Replaying it when
 * the approval lands can only fail, and an approval that can never be carried
 * out is the dead end the queue exists to remove. So an approval of this move
 * stands in for the code, as it does for a payroll run's
 * (lib/server/batch-approval.ts). It lifts nothing else: the pause and the
 * ceilings run again against the state at the moment of the move.
 */
import 'server-only';

import type { ProposalKind } from '@/lib/agent/types';
import type { ApprovalClaim } from '@/lib/server/approved-proposal';

export type TreasuryAction = 'move' | 'withdraw';
export type TreasuryProposalKind = Extract<ProposalKind, 'TREASURY_ALLOCATE' | 'TREASURY_REDEEM'>;

export function isTreasuryAction(value: unknown): value is TreasuryAction {
  return value === 'move' || value === 'withdraw';
}

/** Available → Smart Treasury allocates; Smart Treasury → Available redeems. */
export function treasuryProposalKind(action: TreasuryAction): TreasuryProposalKind {
  return action === 'move' ? 'TREASURY_ALLOCATE' : 'TREASURY_REDEEM';
}

/** The move a proposal is for: the org, the direction and the amount in USD
 *  to the cent. The key the route has always used, so a re-submitted move
 *  still finds the proposal waiting for it. */
export function treasuryIdempotencyKey(orgId: string, action: TreasuryAction, amountUsd: string): string {
  return `treasury:${orgId}:${action}:${amountUsd}`;
}

/** The approval this move is carried out under, standing in for its maker's
 *  spent code; null when this request must present a code itself. */
export function treasuryApprovedMove(claim: ApprovalClaim): string | null {
  return claim.approved && claim.proposalId ? claim.proposalId : null;
}
