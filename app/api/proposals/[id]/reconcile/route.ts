import { z } from 'zod';

import { getOxwalProposalStore } from '@/lib/agent/oxwal';
import { resolveAuthorityForSession, UnauthorizedError } from '@/lib/auth/authority';
import { assertCleanBody, ProvenanceViolationError, provenanceViolationResponse } from '@/lib/auth/provenance-guard';
import { ensureProposalStoreHydrated } from '@/lib/queue/proposal-persistence';
import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { readJsonBody } from '@/lib/server/http';
import {
  liveSpendRecorder,
  liveStuckRecords,
  reconcileStuckPayment,
} from '@/lib/server/stuck-payments';

/**
 * Record what happened to an approved payment whose outcome went missing
 * (lib/server/stuck-payments.ts). The client sends its answer and, for a
 * payment that went, what to find it by. Who is answering and what they may
 * do come from the session and the membership; authority-shaped body fields
 * are rejected before parsing.
 */
const reconcileSchema = z.object({
  outcome: z.enum(['SENT', 'NOT_SENT']),
  /** A transfer id, run id or bank reference. Printable and short: it is shown back in the audit trail. */
  reference: z.string().trim().max(120).regex(/^[\w\-.:#/ ]*$/).optional(),
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
    assertCleanBody(body, `proposals/${id}/reconcile`);
  } catch (error) {
    if (error instanceof ProvenanceViolationError) return provenanceViolationResponse(error);
    throw error;
  }
  const parsed = reconcileSchema.safeParse(body);
  if (!parsed.success) return json({ error: 'Say whether the payment was sent, with an optional reference.' }, 400);

  let ctx;
  try {
    ctx = await resolveAuthorityForSession(auth.session);
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return json({ error: 'This account has no workspace membership yet.', code: 'no_membership' }, 403);
    }
    throw error;
  }

  const store = getOxwalProposalStore();
  // After a cold start, a stuck payment is in Postgres until first touch.
  await ensureProposalStoreHydrated(store);
  const now = () => new Date();
  const answer = await reconcileStuckPayment(
    { store, ...liveStuckRecords(store), recordSpend: liveSpendRecorder(store, now), now },
    {
      proposalId: id,
      actor: { userId: ctx.userId, role: ctx.role, orgId: ctx.orgId },
      outcome: parsed.data.outcome,
      reference: parsed.data.reference,
    },
  );
  return json(answer.body, answer.status);
}
