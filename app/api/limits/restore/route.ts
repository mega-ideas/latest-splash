import { restoreLimit } from '@/lib/server/business-limits';
import { readJsonBody } from '@/lib/server/http';
import { limitChanges, limitResponse, limitsRoute } from '@/lib/server/limits-route';

export const dynamic = 'force-dynamic';

/**
 * An owner puts a limit they lowered back up, to no more than the highest figure
 * their business has held. It applies at once and nothing is asked: owners' own
 * changes are instant. A figure above that is a request to Splash
 * (POST /api/limits/requests), with its 24 hour notice.
 *
 * POST { kind, value }  Owners only.
 */
export async function POST(request: Request) {
  const gate = await limitsRoute(request);
  if (gate.response) return gate.response;
  const limited = await limitChanges(gate.route);
  if (limited) return limited;
  const body = await readJsonBody(request);
  const result = await restoreLimit(gate.route.db, { orgId: gate.route.orgId, actorUserId: gate.route.authority.userId, kind: body.kind, value: body.value });
  return limitResponse(result);
}
