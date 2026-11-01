import { deliverInvitationEmail } from '@/lib/server/invitation-email';
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
 *
 * The invitation is made first, and stands whatever happens next. Then the
 * person is emailed, once (lib/server/invitation-email.ts): a repeat of this
 * request, which finds the same invitation, sends nothing more. The answer
 * carries how that email stands (sent, failed, or no sender set up) so the
 * owner is told plainly; a failed email never fails the invitation.
 */
export async function POST(request: Request) {
  const gate = await teamRoute(request);
  if (gate.response) return gate.response;
  const limited = await limitTeamChanges(gate.route);
  if (limited) return limited;
  const body = await readJsonBody(request);
  const result = await sendInvitation(gate.route.db, { orgId: gate.route.orgId, actorUserId: gate.route.authority.userId, email: body.email, role: body.role });
  if (!result.ok) return teamResponse(result);
  const delivered = await deliverInvitationEmail(gate.route.db, { orgId: gate.route.orgId, actorUserId: gate.route.authority.userId, invitationId: result.invitation.id }).catch(() => null);
  const delivery = delivered && delivered.ok ? { state: delivered.state, sent: delivered.sent } : { state: 'failed' as const, sent: false };
  return teamResponse(result, { invitation: { id: result.invitation.id, role: result.invitation.role, expiresAt: result.invitation.expiresAt }, created: result.created, delivery }, 201);
}
