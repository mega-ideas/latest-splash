import { NextResponse } from 'next/server';

import { invitationStatusFor } from '@/lib/server/team-invitations';
import { inviteeRoute, NO_STORE, teamResponse } from '@/lib/server/team-route';

export const dynamic = 'force-dynamic';

/**
 * GET  what the link in the invitation email shows. Only the signed-in person
 * whose verified email the invitation was sent to is told anything; anyone
 * else, link in hand or not, gets the answer for an id that does not exist.
 * It reads, and accepts nothing: Accept and Decline are their own routes.
 */
export async function GET(request: Request, { params }: { params: Promise<{ invitationId: string }> }) {
  const gate = await inviteeRoute(request);
  if (gate.response) return gate.response;
  const { invitationId } = await params;
  const result = await invitationStatusFor(gate.route.db, { userId: gate.route.userId, invitationId });
  if (!result.ok) return teamResponse(result);
  return NextResponse.json(result, { headers: NO_STORE });
}
