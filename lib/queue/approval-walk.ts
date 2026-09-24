/**
 * From "simulated" to "released", one way, whichever channel the approval came
 * through.
 *
 * ─── Why one implementation ─────────────────────────────────────────────────
 *
 * The in-app submit route re-evaluated policy at the moment of approval and
 * walked a proposal SIMULATED → POLICY_EVALUATED → PENDING_APPROVAL before it
 * counted anyone's approval. The WhatsApp and code channels did neither. They
 * applied APPROVE straight to the SIMULATED proposal a money route creates —
 * the state machine accepts APPROVE only from PENDING_APPROVAL — swallowed
 * each refusal, then failed to SIGN from SIMULATED. Every ballot-approved
 * payment ended "Approved, but the payment could not be completed", and had
 * it got further, a reply would have skipped the policy, expiry and
 * compliance re-check that a click in the app gets.
 *
 * A second copy of an approval path is a second set of rules. Both paths now
 * take these steps, in this order:
 *
 *   evaluateAtApproval    policy re-run now, then the walk to the approval gate
 *   recordApprovals       each approval through the state machine, which is
 *                         what enforces maker ≠ checker, approving roles and
 *                         distinct approvers
 *   releaseApproved       SIGN → SUBMIT, by an approver who is not the maker
 *
 * All synchronous, on purpose. A caller that reads the live proposal and runs
 * them with no await in between cannot interleave with another request in the
 * same process: of two approvals that land together, one releases the payment
 * and the other finds it already submitted.
 */
import type { ComplianceResult, OrgPolicy, ProposalStatus, UnsignedProposal, UserRole } from '../agent/types.ts';
import type { PolicyDecision } from '../policy/evaluate.ts';
import { authorizeProposalSubmission } from '../safety/submit-guard.ts';
import {
  canRoleApprove,
  ProposalStateError,
  type InMemoryProposalStore,
  type ProposalApproval,
} from './proposal-state.ts';
import { AGENT_ACTOR_ID } from '@/lib/agent/identity';

/** A person acting on a proposal, with the role they hold in its org. */
export type ApprovalActor = { userId: string; role: UserRole };

export type GateInput = {
  proposalId: string;
  /** Who is acting now. The policy engine reads the role; the signature guard
   *  needs a human id. */
  actor: ApprovalActor;
  policy: OrgPolicy;
  /** Screening, resolved from server-held records for the live proposal. */
  compliance: (proposal: UnsignedProposal) => ComplianceResult;
  signatureRef: string;
  now: Date;
};

function live(store: InMemoryProposalStore, proposalId: string): UnsignedProposal {
  const proposal = store.get(proposalId);
  if (!proposal) throw new ProposalStateError(`proposal ${proposalId} was not found`);
  return proposal;
}

/**
 * Policy, quote expiry and compliance, evaluated at the moment of approval
 * rather than when the payment was proposed a day earlier. Then the walk to
 * where approvals are counted: SIMULATED → POLICY_EVALUATED →
 * PENDING_APPROVAL, or → APPROVED when policy asks for no approver at all.
 *
 * Throws `ProposalStateError` when policy blocks, before any transition, so a
 * blocked proposal stays exactly where it was.
 */
export function evaluateAtApproval(
  store: InMemoryProposalStore,
  input: GateInput,
): { proposal: UnsignedProposal; decision: PolicyDecision } {
  const proposal = live(store, input.proposalId);
  if (!proposal.simulation) {
    throw new ProposalStateError('proposal must be simulated before it can be approved');
  }

  const decision = authorizeProposalSubmission({
    proposal,
    actor: input.actor.role,
    policy: input.policy,
    simulation: proposal.simulation,
    compliance: input.compliance(proposal),
    signatureRef: input.signatureRef,
    signedBy: input.actor.userId,
    now: input.now.toISOString(),
  });

  let current = proposal;
  if (current.status === 'SIMULATED') {
    // The policy engine decides how many approvers this needs. Not the channel
    // the answer came through, and not the caller.
    current = store.transition(current.id, {
      type: 'POLICY_EVALUATED',
      requiredApprovers: decision.outcome === 'REQUIRE_APPROVAL' ? decision.approvers : 0,
    });
  }
  if (current.status === 'POLICY_EVALUATED') {
    current = store.transition(
      current.id,
      current.explain.requiredApprovers === 0 ? { type: 'MARK_APPROVED' } : { type: 'QUEUE_FOR_APPROVAL' },
    );
  }
  return { proposal: current, decision };
}

export type RefusedApproval = { userId: string; reason: string };

/**
 * Count approvals on a proposal waiting at the gate, in the order given.
 *
 * Each goes through the APPROVE transition, which refuses the maker, a role
 * that cannot approve and a second vote from one person. A refusal is
 * reported and does not stop the rest being counted: one ballot the state
 * machine will not take is no reason to discard everyone else's.
 */
export function recordApprovals(
  store: InMemoryProposalStore,
  proposalId: string,
  approvals: ProposalApproval[],
): { proposal: UnsignedProposal; refused: RefusedApproval[] } {
  let current = live(store, proposalId);
  const refused: RefusedApproval[] = [];

  for (const approval of approvals) {
    // Not at the gate, or the requirement is already met: nothing left for
    // this approval to do.
    if (current.status !== 'PENDING_APPROVAL') break;
    if (current.approvals.some((existing) => existing.userId === approval.userId)) continue;
    try {
      current = store.transition(current.id, { type: 'APPROVE', approval });
    } catch (error) {
      refused.push({
        userId: approval.userId,
        reason: error instanceof Error ? error.message : 'the approval was refused',
      });
    }
  }

  return { proposal: current, refused };
}

export type ReleaseInput = {
  releaser: ApprovalActor;
  signatureRef: string;
  /** The decision `evaluateAtApproval` returned in this same step. Only a
   *  policy evaluation that just passed authorises a signature. */
  decision: PolicyDecision;
  now: Date;
};

/**
 * Sign and submit an approved proposal, for the person releasing it.
 *
 * SIGN does not check either of these by itself, because until now its only
 * caller was the approver who had just approved:
 *
 *   the maker never releases their own payment. Maker ≠ checker holds at the
 *   last step, not only at the vote;
 *
 *   once approvals were required, only someone who could have given one may
 *   release it. A payment everyone approved over WhatsApp waits at APPROVED
 *   for a signed-in person, and "signed in" must not mean "any member": a
 *   viewer is read-only.
 */
export function releaseApproved(
  store: InMemoryProposalStore,
  proposalId: string,
  input: ReleaseInput,
): UnsignedProposal {
  const proposal = live(store, proposalId);
  if (input.decision.outcome === 'BLOCK') {
    throw new ProposalStateError(`policy blocked the release: ${input.decision.reason}`);
  }
  if (proposal.createdBy !== AGENT_ACTOR_ID && proposal.createdBy === input.releaser.userId) {
    throw new ProposalStateError('maker cannot release their own proposal');
  }
  if (proposal.explain.requiredApprovers !== 0 && !canRoleApprove(input.releaser.role)) {
    throw new ProposalStateError(`${input.releaser.role} cannot release an approved payment`);
  }

  const signed =
    proposal.status === 'SIGNED'
      ? proposal
      : store.transition(proposal.id, {
          type: 'SIGN',
          signatureRef: input.signatureRef,
          signedBy: input.releaser.userId,
          policyAuthorized: true,
          signedAt: input.now.toISOString(),
        });
  return store.transition(signed.id, { type: 'SUBMIT' });
}

/** Handed to the payment route. A refusal cannot call it back. */
const RELEASED = new Set<ProposalStatus>(['SIGNED', 'SUBMITTED', 'SETTLED', 'ANCHORED', 'REVERSED']);
/** Nothing can approve it any more. */
const CLOSED = new Set<ProposalStatus>(['REJECTED', 'FAILED', 'EXPIRED']);

export type RefusalResult =
  | { state: 'REJECTED' | 'ALREADY_CLOSED' | 'ALREADY_RELEASED'; proposal: UnsignedProposal }
  | { state: 'NOT_FOUND' };

/**
 * One refusal ends it: on the proposal, not only in the ballot tally.
 *
 * An approver who rejects is told no further approvals can change that. The
 * tally stopped counting, but the proposal itself stayed approvable, so a
 * click in the queue could still release what a ballot had refused. Rejecting
 * the proposal closes every path at once.
 *
 * A refusal that arrives after the payment was released cannot stop it, and
 * the proposal is not rewritten to claim it did.
 */
export function rejectUnlessReleased(
  store: InMemoryProposalStore,
  proposalId: string,
  reason: string,
): RefusalResult {
  const proposal = store.get(proposalId);
  if (!proposal) return { state: 'NOT_FOUND' };
  if (RELEASED.has(proposal.status)) return { state: 'ALREADY_RELEASED', proposal };
  if (CLOSED.has(proposal.status)) return { state: 'ALREADY_CLOSED', proposal };
  return { state: 'REJECTED', proposal: store.transition(proposal.id, { type: 'REJECT', reason }) };
}
