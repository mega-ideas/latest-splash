import { requestHigherLimit } from '@/lib/server/business-limits';
import { readJsonBody } from '@/lib/server/http';
import { limitChanges, limitResponse, limitsRoute } from '@/lib/server/limits-route';

export const dynamic = 'force-dynamic';

/**
 * An owner asks Splash for a higher limit.
 *
 * POST { kind, requested, reason }, with an `Idempotency-Key` header (or
 *      `requestKey`): the same key is the same request, so a retry asks once.
 *      Owners only. The figure must be higher than the limit now and inside
 *      the ceiling; the reason is a sentence. Nothing changes until Splash
 *      approves it and its 24 hour notice has passed.
 */
export async function POST(request: Request) {
  const gate = await limitsRoute(request);
  if (gate.response) return gate.response;
  const limited = await limitChanges(gate.route);
  if (limited) return limited;
  const body = await readJsonBody(request);
  const result = await requestHigherLimit(gate.route.db, {
    orgId: gate.route.orgId,
    actorUserId: gate.route.authority.userId,
    kind: body.kind,
    requested: body.requested,
    reason: body.reason,
    requestKey: request.headers.get('idempotency-key') ?? body.requestKey,
  });
  return limitResponse(result, result.ok && !result.replayed ? 201 : 200);
}
