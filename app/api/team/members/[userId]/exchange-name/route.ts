import { NextResponse } from 'next/server';

import { readJsonBody } from '@/lib/server/http';
import { setOwnNameSharing } from '@/lib/server/exchange-names';
import { limitTeamChanges, NO_STORE, teamResponse, teamRoute } from '@/lib/server/team-route';

export const dynamic = 'force-dynamic';

/**
 * PUT { share: boolean }
 *
 * A person chooses whether their own name and job title may go to an exchange in the details of a payment they send.
 * Put your own id in the path: nobody else changes it for you, an owner included (403), and a person of another
 * business reads as absent (404). Instant. It changes only what the exchange is told and what the confirmation shows;
 * the audit record always holds who started a payment.
 */
export async function PUT(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  const gate = await teamRoute(request);
  if (gate.response) return gate.response;
  const { userId } = await params;
  const limited = await limitTeamChanges(gate.route);
  if (limited) return limited;
  const body = await readJsonBody(request);
  if (typeof body.share !== 'boolean') return NextResponse.json({ error: 'Say whether to share your name: on or off.', code: 'bad_value' }, { status: 400, headers: NO_STORE });
  const result = await setOwnNameSharing(gate.route.db, { orgId: gate.route.orgId, actorUserId: gate.route.authority.userId, userId, share: body.share });
  return teamResponse(result, result.ok ? { changed: result.changed, share: result.share } : undefined);
}
