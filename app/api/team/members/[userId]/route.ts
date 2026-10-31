import { readJsonBody } from '@/lib/server/http';
import { changeTeamMemberRole, removeTeamMember } from '@/lib/server/team-admin';
import { limitTeamChanges, teamResponse, teamRoute } from '@/lib/server/team-route';

export const dynamic = 'force-dynamic';

/**
 * One member of the signed-in person's own business. Another business's
 * member reads as absent (404). The service decides, default deny.
 *
 * PATCH   { role } an owner (or the Finance lead, for viewers, staff and
 *         approvers) changes the role. The same role again changes nothing.
 * DELETE  removes the member; their place in charge, Finance lead role,
 *         Add funds and Withdraw access and sign-offs end with it.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  const gate = await teamRoute(request);
  if (gate.response) return gate.response;
  const limited = await limitTeamChanges(gate.route);
  if (limited) return limited;
  const { userId } = await params;
  const body = await readJsonBody(request);
  const result = await changeTeamMemberRole(gate.route.db, { orgId: gate.route.orgId, actorUserId: gate.route.authority.userId, userId, role: body.role });
  return teamResponse(result, result.ok ? { changed: result.changed } : undefined);
}

export async function DELETE(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  const gate = await teamRoute(request);
  if (gate.response) return gate.response;
  const limited = await limitTeamChanges(gate.route);
  if (limited) return limited;
  const { userId } = await params;
  const result = await removeTeamMember(gate.route.db, { orgId: gate.route.orgId, actorUserId: gate.route.authority.userId, userId });
  return teamResponse(result);
}
