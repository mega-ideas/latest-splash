import { readJsonBody } from '@/lib/server/http';
import { setMemberAccess } from '@/lib/server/team-admin';
import { limitTeamChanges, teamResponse, teamRoute } from '@/lib/server/team-route';

export const dynamic = 'force-dynamic';

/**
 * PUT { access: 'add_funds' | 'withdraw', allowed: boolean }
 *
 * An owner, and only an owner, lets a staff member or an approver of their
 * own business use Add funds or Withdraw in the dashboard, or takes it back.
 * The Finance lead is refused. Money still moves only by the owners' signatures.
 */
export async function PUT(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  const gate = await teamRoute(request);
  if (gate.response) return gate.response;
  const limited = await limitTeamChanges(gate.route);
  if (limited) return limited;
  const { userId } = await params;
  const body = await readJsonBody(request);
  const result = await setMemberAccess(gate.route.db, { orgId: gate.route.orgId, actorUserId: gate.route.authority.userId, userId, access: body.access, allowed: body.allowed === true });
  return teamResponse(result, result.ok ? { changed: result.changed } : undefined);
}
