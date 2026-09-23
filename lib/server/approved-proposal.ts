/**
 * "This payment already has its second approver" — verified, never taken on
 * trust.
 *
 * The replay sends `x-splash-approved-proposal: <id>`. That header is a CLAIM.
 * Treating it as a credential would turn the dual-approval control into a
 * header any client could set, which is a considerably worse hole than the one
 * the control was added to close.
 *
 * So the route resolves it: the proposal must exist, belong to the caller's
 * org, and have genuinely collected its approvals. Anything else and the header
 * is ignored entirely — the payment then meets the ordinary threshold check and
 * is sent for approval like any other, which is the safe direction to fail.
 */
import 'server-only';

/** Statuses that mean the humans have signed. */
const APPROVED_STATUSES = new Set(['APPROVED', 'SIGNED', 'SUBMITTED', 'SETTLED', 'ANCHORED']);

export type ApprovalClaim = {
  /** True only when a real, approved, same-org proposal backs the header. */
  approved: boolean;
  proposalId: string | null;
  /** Why it was refused, for the log. Never returned to the caller: a client
   *  probing header values should learn nothing from the difference. */
  reason?: string;
};

export async function resolveApprovalClaim(
  request: Request,
  orgId: string,
): Promise<ApprovalClaim> {
  const claimed = request.headers.get('x-splash-approved-proposal')?.trim();
  if (!claimed) return { approved: false, proposalId: null };

  try {
    const { getOxwalProposalStore } = await import('@/lib/agent/oxwal');
    const { ensureProposalStoreHydrated } = await import('@/lib/queue/proposal-persistence');

    const store = getOxwalProposalStore();
    await ensureProposalStoreHydrated(store);
    const proposal = store.get(claimed);

    if (!proposal) {
      return { approved: false, proposalId: null, reason: 'no such proposal' };
    }
    // Tenancy: an approval in another org is not an approval here.
    if (proposal.orgId !== orgId) {
      return { approved: false, proposalId: null, reason: 'proposal belongs to another org' };
    }
    if (!APPROVED_STATUSES.has(proposal.status)) {
      return { approved: false, proposalId: null, reason: `status is ${proposal.status}` };
    }
    // The signatures themselves, not just the status — a status can be reached
    // by a transition; the approval rows are the evidence humans acted.
    const distinctApprovers = new Set(proposal.approvals.map((a) => a.userId)).size;
    const required = proposal.explain.requiredApprovers ?? 1;
    if (distinctApprovers < required) {
      return {
        approved: false,
        proposalId: null,
        reason: `${distinctApprovers} of ${required} approvers signed`,
      };
    }

    return { approved: true, proposalId: proposal.id };
  } catch (error) {
    // Unreadable store means unverifiable claim means not approved.
    console.error('[approval] could not verify the approval claim', error);
    return { approved: false, proposalId: null, reason: 'store unavailable' };
  }
}
