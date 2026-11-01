import { withdrawInvitation } from '@/lib/server/team-invitations';
import { limitTeamChanges, teamResponse, teamRoute } from '@/lib/server/team-route';

export const dynamic = 'force-dynamic';

/**
 * DELETE  withdraw an open invitation of the signed-in person's own business.
 * Another business's invitation reads as absent (404). An owner may withdraw
 * any; the Finance lead only those below owner. A repeat changes nothing.
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ invitationId: string }> }) {
  const gate = await teamRoute(request);
  if (gate.response) return gate.response;
  const limited = await limitTeamChanges(gate.route);
  if (limited) return limited;
  const { invitationId } = await params;
  const result = await withdrawInvitation(gate.route.db, { orgId: gate.route.orgId, actorUserId: gate.route.authority.userId, invitationId });
  return teamResponse(result, result.ok ? { changed: result.changed } : undefined);
}
