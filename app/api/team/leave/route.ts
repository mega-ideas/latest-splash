import { requestToLeave, withdrawLeaveRequest } from '@/lib/server/team-leave';
import { limitTeamChanges, teamResponse, teamRoute } from '@/lib/server/team-route';

export const dynamic = 'force-dynamic';

/**
 * The signed-in person's own request to leave their own business (from the
 * session). Nothing changes for them until an owner approves it.
 *
 * POST    ask to leave. A second ask while one is open is the same request.
 *         The only owner of a business cannot ask.
 * DELETE  take the request back.
 */
export async function POST(request: Request) {
  const gate = await teamRoute(request);
  if (gate.response) return gate.response;
  const limited = await limitTeamChanges(gate.route);
  if (limited) return limited;
  const result = await requestToLeave(gate.route.db, { orgId: gate.route.orgId, actorUserId: gate.route.authority.userId });
  return teamResponse(result, result.ok ? { created: result.created } : undefined, 201);
}

export async function DELETE(request: Request) {
  const gate = await teamRoute(request);
  if (gate.response) return gate.response;
  const limited = await limitTeamChanges(gate.route);
  if (limited) return limited;
  const result = await withdrawLeaveRequest(gate.route.db, { orgId: gate.route.orgId, actorUserId: gate.route.authority.userId });
  return teamResponse(result);
}
