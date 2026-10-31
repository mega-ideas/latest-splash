import { readJsonBody } from '@/lib/server/http';
import { appointFinanceLead, revokeFinanceLead } from '@/lib/server/team-admin';
import { limitTeamChanges, teamResponse, teamRoute } from '@/lib/server/team-route';

export const dynamic = 'force-dynamic';

/**
 * The Finance lead: one approver of the business whom an owner trusts with the
 * team. Only an owner appoints or takes the role back; the Finance lead cannot
 * change their own role.
 *
 * POST    { userId } an owner appoints an approver of this business. One at a
 *         time: a second appointment is refused until the first is taken back.
 * DELETE  an owner takes the role back.
 */
export async function POST(request: Request) {
  const gate = await teamRoute(request);
  if (gate.response) return gate.response;
  const limited = await limitTeamChanges(gate.route);
  if (limited) return limited;
  const body = await readJsonBody(request);
  const result = await appointFinanceLead(gate.route.db, { orgId: gate.route.orgId, actorUserId: gate.route.authority.userId, userId: String(body.userId ?? '').trim() });
  return teamResponse(result, undefined, 201);
}

export async function DELETE(request: Request) {
  const gate = await teamRoute(request);
  if (gate.response) return gate.response;
  const limited = await limitTeamChanges(gate.route);
  if (limited) return limited;
  const result = await revokeFinanceLead(gate.route.db, { orgId: gate.route.orgId, actorUserId: gate.route.authority.userId });
  return teamResponse(result);
}
