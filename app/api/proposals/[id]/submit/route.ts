import { z } from 'zod';

import { getOxwalProposalStore } from '@/lib/agent/oxwal';
import { resolveAuthorityForSession } from '@/lib/auth/authority';
import { assertCleanBody, ProvenanceViolationError, provenanceViolationResponse } from '@/lib/auth/provenance-guard';
import { resolveComplianceForProposal } from '@/lib/compliance/proposal-screening';
import { proposalApprovalHash } from '@/lib/proposals/canonical-hash';
import { ensureProposalStoreHydrated } from '@/lib/queue/proposal-persistence';
import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { requireActiveOrg } from '@/lib/server/kyb-gate';
import { readJsonBody } from '@/lib/server/http';
import { authorizeProposalSubmission } from '@/lib/safety/submit-guard';
import { executeApprovedProposal } from '@/lib/server/approval-execution';

/**
 * Track A §1.1 — the client may send ONLY its decision and signature binding.
 * Identity, role, policy, and compliance are derived server-side
 * (lib/auth/authority.ts); authority-shaped body fields are rejected with 400
 * by the provenance guard before parsing.
 */
const submitSchema = z.object({
  signatureRef: z.string().trim().min(1),
  decision: z.enum(['APPROVE', 'REJECT']).default('APPROVE'),
  /** Optional binding commitment: the canonical hash the approver reviewed. */
  approvalHash: z.string().trim().optional(),
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, (_key, value) => (typeof value === 'bigint' ? value.toString() : value)), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;

  const { id } = await params;
  const body = await readJsonBody(request);
  try {
    assertCleanBody(body, `proposals/${id}/submit`);
  } catch (error) {
    if (error instanceof ProvenanceViolationError) return provenanceViolationResponse(error);
    throw error;
  }
  const parsed = submitSchema.safeParse(body);
  if (!parsed.success) return json({ error: 'Invalid proposal submission' }, 400);

  // Server-derived authority: session identity → DB membership → org policy.
  // KYB money gate (wallet spec §3.2). Checked here rather than in a layout
  // because /queue — the maker-checker board that releases funds — sits outside
  // app/dashboard and would bypass a layout-only gate entirely.
  const gate = await requireActiveOrg(auth.session);
  if (gate.response) return gate.response;

  const ctx = await resolveAuthorityForSession(auth.session);

  const store = getOxwalProposalStore();
  // W1: after a cold start, open proposals live in Postgres until first touch.
  await ensureProposalStoreHydrated(store);
  const proposal = store.get(id);
  // Tenancy: a proposal outside the caller's org does not exist for them.
  if (!proposal || proposal.orgId !== ctx.orgId) return json({ error: 'Proposal not found' }, 404);
  if (!proposal.simulation) return json({ error: 'Proposal must be simulated before submission' }, 409);

  // §1.4 approval binding — recompute the canonical hash from the stored row.
  const currentHash = proposalApprovalHash(proposal);
  if (proposal.approvalHash && proposal.approvalHash !== currentHash) {
    console.error(`[approval-hash] stored hash mismatch on ${id} — possible unversioned canon mutation`);
    return json({ error: 'Approval hash mismatch — the proposal changed and must be re-reviewed', code: 'APPROVAL_HASH_MISMATCH' }, 409);
  }
  if (parsed.data.approvalHash && parsed.data.approvalHash !== currentHash) {
    return json({ error: 'Approval hash mismatch — the proposal changed since you reviewed it; re-approval is required', code: 'APPROVAL_HASH_MISMATCH' }, 409);
  }

  if (parsed.data.decision === 'REJECT') {
    const rejected = store.transition(id, { type: 'REJECT', reason: `rejected by ${ctx.userId}` });
    await store.flush();
    return json({ proposal: rejected });
  }

  // §1.5 maker-checker: the state machine enforces maker≠checker against the
  // DB-derived ctx.userId, never a request claim.
  if (proposal.createdBy !== 'OXWAL' && proposal.createdBy === ctx.userId) {
    return json({ error: 'Maker cannot approve their own proposal' }, 403);
  }

  try {
    // §1.4 TOCTOU — policy, quote expiry, and compliance are re-evaluated NOW
    // (approval/submit time), not just at proposal time. Compliance comes
    // from persisted screening records; a missing record BLOCKS.
    const policyDecision = authorizeProposalSubmission({
      proposal,
      actor: ctx.role,
      policy: ctx.policy,
      simulation: proposal.simulation,
      compliance: resolveComplianceForProposal(proposal),
      signatureRef: parsed.data.signatureRef,
      signedBy: ctx.userId,
    });

    // Walk the maker-checker chain from wherever the proposal currently sits.
    // The policy engine (not the caller) decides how many approvers are needed.
    const signedAt = new Date().toISOString();
    let current = proposal;

    if (current.status === 'SIMULATED') {
      const approvers = policyDecision.outcome === 'REQUIRE_APPROVAL' ? policyDecision.approvers : 0;
      current = store.transition(id, { type: 'POLICY_EVALUATED', requiredApprovers: approvers });
      if (approvers === 0) {
        current = store.transition(id, { type: 'MARK_APPROVED' });
      } else {
        current = store.transition(id, { type: 'QUEUE_FOR_APPROVAL' });
      }
    }

    if (current.status === 'PENDING_APPROVAL') {
      current = store.transition(id, {
        type: 'APPROVE',
        approval: { userId: ctx.userId, role: ctx.role, signedAt },
      });
      if (current.status === 'PENDING_APPROVAL') {
        // Dual-control: this signature is recorded; a distinct co-approver
        // must sign from the queue before submission.
        return json({
          proposal: current,
          policyDecision,
          error: 'Your approval is recorded — a second approver must sign from the queue before this settles.',
        }, 409);
      }
    }

    const signed = current.status === 'SIGNED'
      ? current
      : store.transition(id, {
          type: 'SIGN',
          signatureRef: parsed.data.signatureRef,
          signedBy: ctx.userId,
          policyAuthorized: true,
          signedAt,
        });
    const submitted = store.transition(signed.id, { type: 'SUBMIT' });
    // W1: the approval/submission is durable before we tell the client so a
    // crash right after this response cannot lose it.
    await store.flush();

    // And then the payment actually happens.
    //
    // SUBMITTED used to be where this ended: nothing dispatched SETTLE, and
    // the payload lived in a process map with no readers. Two approvers
    // signed, the queue showed the run as submitted, and no money moved —
    // worse than having no approval flow, because everyone believed it had.
    //
    // The replay runs the real authorize route, so every guard re-runs
    // against current state. A day can pass between proposing and approving;
    // an approval authorises a payment, it does not vouch for a balance.
    const outcome = await executeApprovedProposal(
      submitted,
      submitted.executionPayload ?? null,
      {
        cookie: request.headers.get('cookie') ?? '',
        origin: new URL(request.url).origin,
      },
    );
    // `recordExecution`, never `revise` — a canon revision voids every
    // approval, and this outcome arrives immediately after they were
    // collected. Writing it through `revise` would delete the signatures
    // that authorised the very payment it is reporting on.
    store.recordExecution(submitted.id, { ...outcome, at: new Date().toISOString() });
    await store.flush();

    return json({ proposal: store.get(submitted.id) ?? submitted, policyDecision, execution: outcome });
  } catch (error) {
    await store.flush();
    return json({ error: error instanceof Error ? error.message : 'Proposal submission blocked' }, 409);
  }
}
