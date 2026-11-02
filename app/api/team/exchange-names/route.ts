import { NextResponse } from 'next/server';

import { readJsonBody } from '@/lib/server/http';
import { nameSharingOf, setBusinessNameSharing } from '@/lib/server/exchange-names';
import { limitTeamChanges, NO_STORE, teamResponse, teamRoute } from '@/lib/server/team-route';

export const dynamic = 'force-dynamic';

/**
 * GET   what this business and this person have chosen about naming people to an exchange.
 * PUT { share: boolean }   an owner chooses for the business. Instant: no notice, no cooldown.
 *
 * When a staff member pays an exchange account alone, the exchange is told who sent the payment. By default that is
 * their name and job title. If the business (this switch) or the person (their own) chose not to share, the exchange
 * is told the business sent it and no person's name or title is sent. This changes only that: what the exchange is
 * told and what the confirmation shows. The business and the person come from the session, never the request; anyone
 * who is not an owner is refused; the audit record is not affected.
 */
export async function GET(request: Request) {
  const gate = await teamRoute(request);
  if (gate.response) return gate.response;
  const state = await nameSharingOf(gate.route.db, gate.route.orgId, gate.route.authority.userId);
  return NextResponse.json({ business: state.business, person: state.person, shared: state.shared }, { headers: NO_STORE });
}

export async function PUT(request: Request) {
  const gate = await teamRoute(request);
  if (gate.response) return gate.response;
  const limited = await limitTeamChanges(gate.route);
  if (limited) return limited;
  const body = await readJsonBody(request);
  if (typeof body.share !== 'boolean') return NextResponse.json({ error: 'Say whether to share names: on or off.', code: 'bad_value' }, { status: 400, headers: NO_STORE });
  const result = await setBusinessNameSharing(gate.route.db, { orgId: gate.route.orgId, actorUserId: gate.route.authority.userId, share: body.share });
  return teamResponse(result, result.ok ? { changed: result.changed, share: result.share } : undefined);
}
