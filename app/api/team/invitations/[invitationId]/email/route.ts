import { resendInvitationEmail } from '@/lib/server/invitation-email';
import { limitTeamChanges, teamResponse, teamRoute } from '@/lib/server/team-route';

export const dynamic = 'force-dynamic';

/**
 * POST  send the invitation's email again. An OWNER's click, for an invitation of
 * the signed-in person's own business that is still open. At most one email per
 * click: an email that already went is not sent again, a click that arrives while
 * a send is running sends nothing, and an invitation that ended or was withdrawn
 * is refused in plain words. Another business's invitation reads as absent (404).
 * Nothing about whom to email is read from the request: the address is the
 * invitation's own. The answer says how it stands (sent, failed or not set up).
 */
export async function POST(request: Request, { params }: { params: Promise<{ invitationId: string }> }) {
  const gate = await teamRoute(request);
  if (gate.response) return gate.response;
  const limited = await limitTeamChanges(gate.route);
  if (limited) return limited;
  const { invitationId } = await params;
  const result = await resendInvitationEmail(gate.route.db, { orgId: gate.route.orgId, invitationId, actorUserId: gate.route.authority.userId });
  return teamResponse(result, result.ok ? { delivery: { state: result.state, sent: result.sent, sentAt: result.sentAt } } : undefined);
}
