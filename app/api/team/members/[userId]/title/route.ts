import { NextResponse } from 'next/server';

import { readJsonBody } from '@/lib/server/http';
import { setMemberTitle } from '@/lib/server/team-admin';
import { limitTeamChanges, NO_STORE, teamResponse, teamRoute } from '@/lib/server/team-route';

export const dynamic = 'force-dynamic';

/**
 * PUT { title: string | null }
 *
 * Set or clear a member's job title, the "(CFO)" in "Aisha (CFO)". An owner sets anyone's title in
 * their own business, and any member sets their own (put your own id in the path). Nobody else sets
 * another person's, the Finance lead included. The title is cleaned to plain words on the server
 * (at most 40 characters); an empty title clears it, and something that is not words is refused.
 * A person of another business reads as absent (404). The same title again changes nothing.
 *
 * A title changes only how a name is written. It grants nothing, and an owner's own change to it is
 * instant: there is no notice and no cooldown.
 */
export async function PUT(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  const gate = await teamRoute(request);
  if (gate.response) return gate.response;
  const limited = await limitTeamChanges(gate.route);
  if (limited) return limited;
  const { userId } = await params;
  const body = await readJsonBody(request);
  // A body without a title is a mistake, not a request to clear it.
  if (!Object.hasOwn(body, 'title')) {
    return NextResponse.json({ error: 'Send the title, or null to clear it.', code: 'bad_title' }, { status: 400, headers: NO_STORE });
  }
  const result = await setMemberTitle(gate.route.db, { orgId: gate.route.orgId, actorUserId: gate.route.authority.userId, userId, title: body.title });
  return teamResponse(result, result.ok ? { changed: result.changed, title: result.title } : undefined);
}
