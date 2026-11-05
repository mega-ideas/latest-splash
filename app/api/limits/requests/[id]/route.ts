import { cancelLimitRequest } from '@/lib/server/business-limits';
import { limitChanges, limitResponse, limitsRoute } from '@/lib/server/limits-route';

export const dynamic = 'force-dynamic';

/**
 * An owner cancels a request for a higher limit, until the higher limit
 * starts. A request of another business reads as absent (404). Cancelling
 * twice cancels once.
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await limitsRoute(request);
  if (gate.response) return gate.response;
  const limited = await limitChanges(gate.route);
  if (limited) return limited;
  const { id } = await params;
  const result = await cancelLimitRequest(gate.route.db, { orgId: gate.route.orgId, actorUserId: gate.route.authority.userId, requestId: id });
  return limitResponse(result);
}
