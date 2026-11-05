import { NextResponse } from 'next/server';

import { invitationsFor } from '@/lib/server/team-invitations';
import { inviteeRoute, NO_STORE } from '@/lib/server/team-route';

export const dynamic = 'force-dynamic';

/**
 * GET  the invitations sent to the signed-in person's own VERIFIED email, with
 * the business that sent each and the role. An account whose email is not
 * verified is shown none. Nothing in the request chooses whose invitations
 * these are, and no business the person already belongs to is named.
 */
export async function GET(request: Request) {
  const gate = await inviteeRoute(request);
  if (gate.response) return gate.response;
  const invitations = await invitationsFor(gate.route.db, { userId: gate.route.userId });
  return NextResponse.json({ invitations }, { headers: NO_STORE });
}
