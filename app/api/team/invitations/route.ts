import { readJsonBody } from '@/lib/server/http';
import { sendInvitation } from '@/lib/server/team-invitations';
import { limitTeamChanges, teamResponse, teamRoute } from '@/lib/server/team-route';

export const dynamic = 'force-dynamic';

/**
 * POST { email, role }  SEND AN INVITATION. An owner, or the Finance lead for
 * a viewer, staff member or approver, asks a person to join. The person sees
 * it after signing in with that verified email and accepts or declines; it
 * ends after 7 days. Any email may be invited, and the answer is the same
 * whether or not the address has an account, so this cannot be used to find
 * out who has one or where. The business and the sender come from the session.
 * (The open invitations are in GET /api/team.)
 */
export async function POST(request: Request) {
  const gate = await teamRoute(request);
  if (gate.response) return gate.response;
  const limited = await limitTeamChanges(gate.route);
  if (limited) return limited;
  const body = await readJsonBody(request);
  const result = await sendInvitation(gate.route.db, { orgId: gate.route.orgId, actorUserId: gate.route.authority.userId, email: body.email, role: body.role });
  return teamResponse(result, result.ok ? { invitation: { id: result.invitation.id, role: result.invitation.role, expiresAt: result.invitation.expiresAt }, created: result.created } : undefined, 201);
}
