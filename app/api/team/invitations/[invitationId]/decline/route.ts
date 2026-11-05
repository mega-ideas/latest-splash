import { declineInvitation } from '@/lib/server/team-invitations';
import { inviteeRoute, limitInviteeChanges, teamResponse } from '@/lib/server/team-route';

export const dynamic = 'force-dynamic';

/** POST  decline an invitation sent to the signed-in person's own verified email. Final; a repeat changes nothing. */
export async function POST(request: Request, { params }: { params: Promise<{ invitationId: string }> }) {
  const gate = await inviteeRoute(request);
  if (gate.response) return gate.response;
  const limited = await limitInviteeChanges(gate.route);
  if (limited) return limited;
  const { invitationId } = await params;
  const result = await declineInvitation(gate.route.db, { userId: gate.route.userId, invitationId });
  return teamResponse(result, result.ok ? { changed: result.changed } : undefined);
}
