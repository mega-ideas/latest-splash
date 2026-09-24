/**
 * Payments every approver has agreed to that nobody has sent yet.
 *
 * A WhatsApp reply records a vote and cannot send money, so a vote that
 * finishes on WhatsApp stops at APPROVED and waits for a signed-in approver
 * (lib/server/approval-settle.ts). The queue listed only proposals still
 * collecting approvals, so a fully approved payment dropped out of sight at
 * the one moment someone needed to act on it.
 *
 * This picks them out for the viewer's own workspace, and says in advance why
 * the viewer could not send one. The submit route decides either way
 * (`releaseApproved` in lib/queue/approval-walk.ts); the reason here only
 * spares a click the server would refuse.
 */
import type { UnsignedProposal, UserRole } from '../agent/types.ts';
import { canRoleApprove } from './proposal-state.ts';
import { AGENT_ACTOR_ID } from '@/lib/agent/identity';

/** The signed-in person looking at the queue, as their membership says. */
export type QueueViewer = { orgId: string; userId: string; role: UserRole };

export type ReadyToSend = {
  proposal: UnsignedProposal;
  /** Why this viewer cannot send it, or null when they can. */
  blockedReason: string | null;
};

function blockedReason(proposal: UnsignedProposal, viewer: QueueViewer, now: Date): string | null {
  if (proposal.createdBy !== AGENT_ACTOR_ID && proposal.createdBy === viewer.userId) {
    return 'You asked for this payment, so another approver sends it.';
  }
  if (proposal.explain.requiredApprovers !== 0 && !canRoleApprove(viewer.role)) {
    return 'Only an approver can send it.';
  }
  if (Date.parse(proposal.expiresAt) < now.getTime()) {
    return 'Its approval window has closed, so it has to be requested again.';
  }
  return null;
}

/**
 * The approved, unsent payments in the viewer's workspace, soonest to expire
 * first. No viewer (no membership) means no workspace, and nothing to show.
 */
export function readyToSend(
  proposals: UnsignedProposal[],
  viewer: QueueViewer | null,
  now: Date = new Date(),
): ReadyToSend[] {
  if (!viewer) return [];
  return proposals
    .filter((proposal) => proposal.orgId === viewer.orgId && proposal.status === 'APPROVED')
    .sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt))
    .map((proposal) => ({ proposal, blockedReason: blockedReason(proposal, viewer, now) }));
}
