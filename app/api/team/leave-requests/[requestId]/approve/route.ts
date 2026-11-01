import { NextResponse } from 'next/server';

import { approveLeaveRequest } from '@/lib/server/team-leave';
import { revokeLeaverRules, ruleRevokeNote, type RuleRevoke } from '@/lib/server/team-leave-rules';
import { limitTeamChanges, NO_STORE, teamResponse, teamRoute } from '@/lib/server/team-route';

export const dynamic = 'force-dynamic';

/**
 * POST  approve a request to leave in the signed-in person's own business. An
 * owner decides any request but their own; the Finance lead only for a person
 * below owner who is not in charge and holds neither Add funds nor Withdraw.
 * The membership ends and every hold clears in one transaction. When an owner
 * approves, the person's spending rule is then taken back through the
 * spending-rules revoke path (a request the wallet's owners sign); the answer
 * says in words which of those happened. A repeat changes nothing.
 */
export async function POST(request: Request, { params }: { params: Promise<{ requestId: string }> }) {
  const gate = await teamRoute(request);
  if (gate.response) return gate.response;
  const limited = await limitTeamChanges(gate.route);
  if (limited) return limited;
  const { requestId } = await params;
  const result = await approveLeaveRequest(gate.route.db, { orgId: gate.route.orgId, actorUserId: gate.route.authority.userId, requestId });
  if (!result.ok) return teamResponse(result);
  let rules: RuleRevoke | null = null;
  if (result.changed && result.leaver) {
    rules = gate.route.authority.role === 'OWNER' ? await revokeLeaverRules(request, { orgId: gate.route.orgId, actorUserId: gate.route.authority.userId }) : 'by_owner';
  }
  return NextResponse.json({ changed: result.changed, rules, note: rules ? ruleRevokeNote(rules) : null }, { headers: NO_STORE });
}
