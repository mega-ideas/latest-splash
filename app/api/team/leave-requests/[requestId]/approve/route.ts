import { NextResponse } from 'next/server';

import { approveLeaveRequest } from '@/lib/server/team-leave';
import { runLeaveFollowUp } from '@/lib/server/team-leave-followup';
import { leaveFollowUpDeps } from '@/lib/server/team-leave-rules';
import { limitTeamChanges, NO_STORE, teamResponse, teamRoute } from '@/lib/server/team-route';

export const dynamic = 'force-dynamic';

/**
 * POST  approve a request to leave in the signed-in person's own business. Only
 * an owner decides (the Finance lead sees the requests and decides none), and
 * nobody decides their own. The membership ends and every hold clears in one
 * transaction. Then the person's spending rule is taken back through the
 * spending-rules revoke path (a request the wallet's owners sign) and the
 * answer says whether they are still a signer on the business wallet; every
 * outcome is a line of the trail. A repeat changes nothing.
 */
export async function POST(request: Request, { params }: { params: Promise<{ requestId: string }> }) {
  const gate = await teamRoute(request);
  if (gate.response) return gate.response;
  const limited = await limitTeamChanges(gate.route);
  if (limited) return limited;
  const { requestId } = await params;
  const result = await approveLeaveRequest(gate.route.db, { orgId: gate.route.orgId, actorUserId: gate.route.authority.userId, requestId });
  if (!result.ok) return teamResponse(result);
  if (!result.changed || !result.leaver) return NextResponse.json({ changed: result.changed, rules: null, signer: null, note: null }, { headers: NO_STORE });
  const who = { orgId: gate.route.orgId, actorUserId: gate.route.authority.userId, leaverUserId: result.leaver.userId };
  const followUp = await runLeaveFollowUp(gate.route.db, { ...who, requestId, deps: leaveFollowUpDeps(request, who) });
  return NextResponse.json({ changed: true, rules: followUp.rules, signer: followUp.signer, note: followUp.note }, { headers: NO_STORE });
}
