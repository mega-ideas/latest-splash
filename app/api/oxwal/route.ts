import { runOxwalAgent, type OxwalAgentRequest } from '../../../lib/agent/oxwal';
import { oxwalRunResponse, startOxwalRun } from '@/lib/agent/stream-hub';
import { resolveAuthorityForSession } from '@/lib/auth/authority';
import { assertCleanBody, ProvenanceViolationError, provenanceViolationResponse } from '@/lib/auth/provenance-guard';
import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { readJsonBody } from '@/lib/server/http';
import { emitEvent } from '@/lib/server/events';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** §1.1 — the agent chat client sends ONLY { message, history }. orgId and
 *  actorId are derived from the session server-side; sending them is a
 *  provenance violation. */
type OxwalRouteBody = {
  message?: string;
  history?: OxwalAgentRequest['history'];
};

/**
 * Starts a 0xWal run and streams it. The run is registered server-side with
 * sequence-numbered events, so a browser that loses the connection resumes
 * from GET /api/oxwal/[runId]?after=<seq> instead of re-asking (which would
 * re-run the agent and could prepare a second proposal).
 */
export async function POST(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;

  const rawBody = await readJsonBody(request);
  try {
    assertCleanBody(rawBody, 'oxwal');
  } catch (error) {
    if (error instanceof ProvenanceViolationError) return provenanceViolationResponse(error);
    throw error;
  }
  const body = rawBody as OxwalRouteBody;
  const ctx = await resolveAuthorityForSession(auth.session);

  const message = (body.message ?? '').trim();
  if (!message) {
    return new Response(JSON.stringify({ error: 'message is required' }), { status: 400 });
  }
  void emitEvent({
    name: 'session_started',
    orgId: ctx.orgId,
    actorId: ctx.userId,
    props: { historyLength: Array.isArray(body.history) ? body.history.length : 0 },
  });

  const run = startOxwalRun({
    orgId: ctx.orgId,
    actorId: ctx.userId,
    source: runOxwalAgent({
      message,
      orgId: ctx.orgId,
      actorId: ctx.userId,
      history: Array.isArray(body.history) ? body.history.slice(-12) : [],
    }),
    onEvent: (event) => {
      if (event.type !== 'proposal') return;
      void emitEvent({
        name: 'action_proposed',
        orgId: ctx.orgId,
        actorId: ctx.userId,
        subjectId: event.proposal.id,
        corridor: event.proposal.corridor,
        amountMinor: event.proposal.explain.financialImpact.amountIn ?? null,
        currency: event.proposal.explain.financialImpact.currencyIn,
        props: { kind: event.proposal.kind, tier: event.proposal.tier },
      });
    },
  });

  return oxwalRunResponse(run, -1);
}
