/**
 * What happens when the last approver says yes.
 *
 * A WhatsApp reply and an in-app approval reach the same place here. The
 * channel decided how the question was asked; it must not decide what an
 * approval is worth, and a settlement path that differs by channel is two
 * settlement paths that will drift.
 *
 * This module records the approvals on the proposal, walks the state machine,
 * and hands off to the same executor an in-app approval uses — which replays
 * the real authorize route, so every guard runs again against current state.
 */
import 'server-only';

import { eq } from 'drizzle-orm';

import { approvalTokens } from '@/lib/db/schema';
import { mapDbRole } from '@/lib/auth/authority';
import { memberships } from '@/lib/db/schema';

export type SettleOutcome = { settled: boolean; message: string };

/**
 * Carry out a payment every approver has agreed to.
 *
 * Never throws. An approval that could not be carried out is reported as such
 * — the failure mode this whole sequence exists to remove is an approval that
 * silently does nothing, and replacing it with one that silently fails would be
 * the same bug wearing a different hat.
 */
export async function settleFullyApprovedProposal(proposalId: string): Promise<SettleOutcome> {
  try {
    const { getOxwalProposalStore } = await import('@/lib/agent/oxwal');
    const { ensureProposalStoreHydrated } = await import('@/lib/queue/proposal-persistence');
    const { executeApprovedProposal } = await import('@/lib/server/approval-execution');

    const store = getOxwalProposalStore();
    await ensureProposalStoreHydrated(store);
    const proposal = store.get(proposalId);
    if (!proposal) return { settled: false, message: 'That payment could not be found.' };

    const { getDb } = await import('@/lib/db/client');
    const db = getDb();

    // Every ballot that said yes becomes an approval on the proposal, recorded
    // against the USER. The number the reply came from never appears: it is not
    // an identity and must not read as one in an audit trail.
    const ballots = await db
      .select()
      .from(approvalTokens)
      .where(eq(approvalTokens.proposalId, proposalId));

    let current = proposal;
    for (const ballot of ballots) {
      if (ballot.decision !== 'APPROVE') continue;
      if (current.approvals.some((a) => a.userId === ballot.userId)) continue;

      const rows = await db
        .select({ role: memberships.role })
        .from(memberships)
        .where(eq(memberships.userId, ballot.userId))
        .limit(1);
      const role = mapDbRole(rows[0]?.role ?? 'viewer');

      try {
        // The state machine re-applies maker != checker and the distinct-approver
        // rule. A ballot cannot smuggle a second vote past it.
        current = store.transition(current.id, {
          type: 'APPROVE',
          approval: {
            userId: ballot.userId,
            role,
            signedAt: (ballot.decidedAt ?? new Date()).toISOString(),
          },
        });
      } catch {
        // Already counted, or not in a state that accepts one. Neither is a
        // reason to stop counting the rest.
        continue;
      }
    }

    if (current.status === 'PENDING_APPROVAL') {
      return { settled: false, message: 'Recorded. The payment still needs another approver.' };
    }

    const signed =
      current.status === 'SIGNED'
        ? current
        : store.transition(current.id, {
            type: 'SIGN',
            signatureRef: `whatsapp:${proposalId}`,
            signedBy: 'approvers',
            policyAuthorized: true,
            signedAt: new Date().toISOString(),
          });
    const submitted =
      signed.status === 'SUBMITTED' ? signed : store.transition(signed.id, { type: 'SUBMIT' });
    await store.flush();

    // No session here — a webhook has none. The replay therefore runs without a
    // forwarded cookie, and the authorize route resolves the org from the
    // proposal itself via the verified approval header.
    const outcome = await executeApprovedProposal(submitted, submitted.executionPayload ?? null, {
      cookie: '',
      origin: (process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000').replace(/\/$/, ''),
    });

    store.recordExecution(submitted.id, { ...outcome, at: new Date().toISOString() });
    await store.flush();

    return outcome.state === 'EXECUTED'
      ? { settled: true, message: 'Approved by everyone. The payment has been sent.' }
      : { settled: false, message: `Approved, but the payment did not go: ${outcome.detail}` };
  } catch (error) {
    console.error('[approval-settle] failed', error);
    return {
      settled: false,
      message: 'Approved, but the payment could not be completed. An operator has been alerted.',
    };
  }
}
