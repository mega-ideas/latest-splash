import { declineLeaveRequest } from '@/lib/server/team-leave';
import { limitTeamChanges, teamResponse, teamRoute } from '@/lib/server/team-route';

export const dynamic = 'force-dynamic';

/** POST  decline a request to leave in the signed-in person's own business. The person stays and is told so. Same who-may-decide rule as approving. */
export async function POST(request: Request, { params }: { params: Promise<{ requestId: string }> }) {
  const gate = await teamRoute(request);
  if (gate.response) return gate.response;
  const limited = await limitTeamChanges(gate.route);
  if (limited) return limited;
  const { requestId } = await params;
  const result = await declineLeaveRequest(gate.route.db, { orgId: gate.route.orgId, actorUserId: gate.route.authority.userId, requestId });
  return teamResponse(result, result.ok ? { changed: result.changed } : undefined);
}
