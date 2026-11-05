import { NextResponse } from 'next/server';

import { waitingFor } from '@/lib/server/approval-wait';
import { NO_STORE, teamRoute } from '@/lib/server/team-route';

export const dynamic = 'force-dynamic';

/**
 * What the signed-in person is waiting on, and what they have been told (v2 Phase 3, when nobody who can approve answers).
 *
 * The person who asked sees their own requests that are still waiting for approval, who was asked and that nobody has
 * answered; an owner sees every open one in the business. Beside them, the notices this person was sent in the last
 * 7 days: the reminders, and "Nobody approved in time. Nothing was paid. Ask again." The business and the person come
 * from the session, never the request; another business's requests are never read. It reads only. Reminding is
 * POST /api/approvals/waiting/:kind/:id/remind; cancelling is the existing withdraw.
 */
export async function GET(request: Request) {
  const gate = await teamRoute(request);
  if (gate.response) return gate.response;
  const { db, orgId, authority } = gate.route;
  const view = await waitingFor(db, {}, { orgId, userId: authority.userId });
  return NextResponse.json(view, { headers: NO_STORE });
}
