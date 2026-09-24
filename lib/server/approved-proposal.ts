/**
 * "This payment already has its second approver" — verified, bound to the
 * payment, spent once. Never taken on trust.
 *
 * The replay sends `x-splash-approved-proposal: <id>`. That header is a CLAIM.
 * Treating it as a credential would turn the dual-approval control into a
 * header any client could set, which is a considerably worse hole than the one
 * the control was added to close.
 *
 * So the route resolves it: the proposal must exist, belong to the caller's
 * org, be the kind of payment the route makes, be SUBMITTED, carry its
 * approvers' signatures, approve THIS payment, and not have been used. Then it
 * is spent before the route relies on it. Anything else and the header is
 * ignored entirely — the payment then meets the ordinary threshold check and
 * is sent for approval like any other, which is the safe direction to fail.
 *
 * ─── Why THIS payment ───────────────────────────────────────────────────────
 * Checked for existence, org and status only, an approved proposal's id could
 * ride on a different payment — another batch, another recipient, a larger
 * amount — and skip the second approver for it. Each route now says what an
 * approval of its kind covers, and the approved payload and the request must
 * reduce to the same digest.
 *
 * ─── Why spent ──────────────────────────────────────────────────────────────
 * Nothing recorded that an approval had been used, and SETTLED and ANCHORED
 * counted as approved alongside SUBMITTED, so the same approved payment could
 * be sent again after it executed, with no second approver. The first request
 * to act on a claim now spends it — in this process with no await between the
 * checks and the mark, then in `consumed_approvals`, whose primary key decides
 * across processes. The replay closes the claim when it returns
 * (`closeApprovalClaim`), so a replay refused before the route reached the
 * claim does not leave it live either.
 */
import 'server-only';

import type { ProposalKind } from '@/lib/agent/types';
import { subjectDigest } from '@/lib/server/step-up';

/**
 * The one status an approved payment is carried out in. Both callers of the
 * replay — the submit route, and the settle path when a code typed into Splash
 * completes the vote — walk the proposal SIGNED -> SUBMITTED and replay it
 * there. (A WhatsApp reply never replays: it has no session to run as.)
 * APPROVED is before SIGN checks the canon; SETTLED and ANCHORED are after the
 * money moved.
 */
const EXECUTABLE_STATUS = 'SUBMITTED';

export type ApprovalClaim = {
  /** True only when a real, approved, same-org proposal for THIS payment backs
   *  the header, and this request is the one that spent it. */
  approved: boolean;
  proposalId: string | null;
  /** Why it was refused, for the log. Never returned to the caller: a client
   *  probing header values should learn nothing from the difference. */
  reason?: string;
};

/** What a route carries out, and how to tell whether an approval covers it. */
export type ClaimScope = {
  /** The proposal kind the route makes. A batch approval does not cover a
   *  single payout, whatever its payload happens to look like. */
  kind: ProposalKind;
  /** What an approval of this kind covers. Applied to the approved payload and
   *  to this request; the claim holds only when the two digests match. */
  substance: (payload: Record<string, unknown>) => unknown;
  /** This request's payment. */
  body: Record<string, unknown>;
  /** What spends it, for the record: the route. */
  consumer: string;
};

export async function resolveApprovalClaim(
  request: Request,
  orgId: string,
  scope: ClaimScope,
): Promise<ApprovalClaim> {
  const claimed = request.headers.get('x-splash-approved-proposal')?.trim();
  if (!claimed) return { approved: false, proposalId: null };

  // A claim that was presented and did not hold is worth a line in the log:
  // a replay that lost a race, or an approval tried on a payment it does not
  // cover. The header is the client's, so only as much as an id needs.
  const refuse = (reason: string): ApprovalClaim => {
    console.warn(`[approval] claim ${claimed.slice(0, 80)} refused on ${scope.consumer}: ${reason}`);
    return { approved: false, proposalId: null, reason };
  };

  try {
    const { getOxwalProposalStore } = await import('@/lib/agent/oxwal');
    const { ensureProposalStoreHydrated } = await import('@/lib/queue/proposal-persistence');

    const store = getOxwalProposalStore();
    await ensureProposalStoreHydrated(store);

    // No await from here to the spend: every check and the mark see the same
    // proposal, and no other request in this process runs in between.
    const proposal = store.get(claimed);
    if (!proposal) return refuse('no such proposal');
    // Tenancy: an approval in another org is not an approval here.
    if (proposal.orgId !== orgId) return refuse('proposal belongs to another org');
    if (proposal.kind !== scope.kind) return refuse(`a ${proposal.kind} approval does not cover a ${scope.kind}`);
    if (proposal.status !== EXECUTABLE_STATUS) return refuse(`status is ${proposal.status}`);
    // The signatures themselves, not just the status — a status can be reached
    // by a transition; the approval rows are the evidence humans acted.
    const distinctApprovers = new Set(proposal.approvals.map((a) => a.userId)).size;
    const required = proposal.explain.requiredApprovers ?? 1;
    if (distinctApprovers < required) return refuse(`${distinctApprovers} of ${required} approvers signed`);
    // What the approvers signed off and what this request would do, reduced to
    // what an approval of this kind covers, must be one payment.
    if (!proposal.executionPayload) return refuse('the approved payment is not on record');
    if (subjectDigest(scope.substance(proposal.executionPayload)) !== subjectDigest(scope.substance(scope.body))) {
      return refuse('it approved a different payment');
    }
    if (!store.consumeApproval(proposal.id, { at: new Date().toISOString(), by: scope.consumer })) {
      return refuse('already used');
    }
  } catch (error) {
    // Unreadable store means unverifiable claim means not approved.
    console.error('[approval] could not verify the approval claim', error);
    return { approved: false, proposalId: null, reason: 'store unavailable' };
  }

  // Spent in this process. Across processes, the row decides.
  const durable = await consumeDurably(claimed, orgId, scope.consumer);
  if (durable !== 'spent') return refuse(durable === 'taken' ? 'already used' : 'the spend could not be recorded');
  return { approved: true, proposalId: claimed };
}

/**
 * Spend an approval the replay presented, if the route did not.
 *
 * The replay presents a claim once. A route that refused before reaching the
 * claim (no session, a KYB or terms gate, a second factor) leaves it unspent,
 * and the next request to present it with the same body would carry out a
 * payment the approval record says failed. Called when the replay returns,
 * whatever it returned; a no-op when the route already spent it. Never throws.
 */
export async function closeApprovalClaim(proposalId: string, orgId: string): Promise<void> {
  try {
    const { getOxwalProposalStore } = await import('@/lib/agent/oxwal');
    getOxwalProposalStore().consumeApproval(proposalId, { at: new Date().toISOString(), by: 'execution' });
  } catch (error) {
    console.error('[approval] could not close the approval claim in this process', error);
  }
  await consumeDurably(proposalId, orgId, 'execution');
}

/**
 * The cross-process half of the spend: an insert against the
 * `consumed_approvals` primary key. Without a database the in-process mark is
 * the whole story. A database that cannot record the spend refuses it: an
 * approval that cannot be marked used must not be used.
 */
async function consumeDurably(
  proposalId: string,
  orgId: string,
  consumedBy: string,
): Promise<'spent' | 'taken' | 'unrecorded'> {
  try {
    const { proposalPersistenceEnabled } = await import('@/lib/queue/proposal-persistence');
    if (!proposalPersistenceEnabled()) return 'spent';
    const { getDb } = await import('@/lib/db/client');
    const { consumeApprovalRecord } = await import('@/lib/db/proposal-repo');
    return (await consumeApprovalRecord(getDb(), { proposalId, orgId, consumedBy })) ? 'spent' : 'taken';
  } catch (error) {
    console.error('[approval] could not record the approval as spent', error);
    return 'unrecorded';
  }
}
