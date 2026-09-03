import { runOxwalAgent, stringifyAgentJson, type OxwalAgentRequest } from '../../../lib/agent/oxwal';
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

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: unknown) => {
        controller.enqueue(encoder.encode(`data: ${stringifyAgentJson(event)}\n\n`));
      };

      for await (const event of runOxwalAgent({
        message,
        orgId: ctx.orgId,
        actorId: ctx.userId,
        history: Array.isArray(body.history) ? body.history.slice(-12) : [],
      })) {
        if (event.type === 'proposal') {
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
        }
        send(event);
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Content-Type-Options': 'nosniff',
      'X-Accel-Buffering': 'no',
    },
  });
}
