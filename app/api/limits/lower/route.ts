import { lowerLimit } from '@/lib/server/business-limits';
import { readJsonBody } from '@/lib/server/http';
import { limitChanges, limitResponse, limitsRoute } from '@/lib/server/limits-route';

export const dynamic = 'force-dynamic';

/**
 * An owner lowers a limit. It applies at once and nothing is asked: Sky's
 * decision is that an owner lowering a limit is always instant. Any request
 * still open for that limit is cancelled, so it is not raised again later.
 *
 * POST { kind, value }  Owners only.
 */
export async function POST(request: Request) {
  const gate = await limitsRoute(request);
  if (gate.response) return gate.response;
  const limited = await limitChanges(gate.route);
  if (limited) return limited;
  const body = await readJsonBody(request);
  const result = await lowerLimit(gate.route.db, { orgId: gate.route.orgId, actorUserId: gate.route.authority.userId, kind: body.kind, value: body.value });
  return limitResponse(result);
}
