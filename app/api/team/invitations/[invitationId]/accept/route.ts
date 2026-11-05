import { acceptInvitation } from '@/lib/server/team-invitations';
import { inviteeRoute, limitInviteeChanges, teamResponse } from '@/lib/server/team-route';

export const dynamic = 'force-dynamic';

/**
 * POST  accept an invitation sent to the signed-in person's own verified
 * email. Once: a repeat changes nothing. Refused in plain words, naming no
 * business, when they already belong to one. Anyone else's invitation, and an
 * id that does not exist, are both "not found".
 */
export async function POST(request: Request, { params }: { params: Promise<{ invitationId: string }> }) {
  const gate = await inviteeRoute(request);
  if (gate.response) return gate.response;
  const limited = await limitInviteeChanges(gate.route);
  if (limited) return limited;
  const { invitationId } = await params;
  const result = await acceptInvitation(gate.route.db, { userId: gate.route.userId, invitationId });
  return teamResponse(result, result.ok ? { changed: result.changed, role: result.role } : undefined);
}
