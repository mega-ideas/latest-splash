import type { ProposalStatus, UnsignedProposal } from '../agent/types.ts';

/**
 * Whose proposals a queue may show: one workspace's, and nobody else's.
 *
 * The proposal store is process-global. It holds every tenant's proposals,
 * and after a cold start `ensureProposalStoreHydrated` loads every tenant's
 * open proposals back from Postgres. `/queue` listed it whole, filtered by
 * status alone, so every signed-in user — a brand-new account with no
 * membership included — saw every tenant's pending payments: the payee and
 * amount in the recommendation text, the amount again, and the maker's id.
 *
 * Any surface that lists the store goes through here, and the org comes from
 * the viewer's membership row (lib/server/viewer-org.ts), never the request.
 */

/** The statuses that are still maker-checker work. */
export const OPEN_QUEUE_STATUSES: ReadonlySet<ProposalStatus> = new Set<ProposalStatus>([
  'SIMULATED',
  'POLICY_EVALUATED',
  'PENDING_APPROVAL',
]);

/**
 * The open proposals one workspace may see. `null` — a viewer with no
 * membership, so no workspace — sees none: there is no org whose work is
 * theirs, and "every org" is not a fallback.
 */
/**
 * How long an approver has left, for a proposal on the queue. `now` is the
 * request's clock: the queue page renders once per request, and an expiry
 * computed against anything older tells the approver the wrong thing.
 */
export function approvalWindowLabel(expiresAt: string, now: number = Date.now()): string {
  const remainingMs = Date.parse(expiresAt) - now;
  if (!Number.isFinite(remainingMs)) return 'No expiry';
  if (remainingMs < 0) return 'Approval window closed';
  const minutes = Math.ceil(remainingMs / 60_000);
  if (minutes < 60) return `Expires in ${minutes}m`;
  return `Expires in ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function openProposalsForOrg(
  proposals: readonly UnsignedProposal[],
  orgId: string | null,
): UnsignedProposal[] {
  if (!orgId) return [];
  return proposals.filter((proposal) => proposal.orgId === orgId && OPEN_QUEUE_STATUSES.has(proposal.status));
}
