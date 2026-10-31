import { NextResponse } from 'next/server';

import { readJsonBody } from '@/lib/server/http';
import { addTeamMember, fundsAccessOf, listTeam, listTeamActivity, teamManager } from '@/lib/server/team-admin';
import { limitTeamChanges, NO_STORE, teamResponse, teamRoute } from '@/lib/server/team-route';
import { memberRole } from '@/lib/server/wallet-authority';

export const dynamic = 'force-dynamic';

/**
 * The team of the signed-in person's own business (the session's; nothing
 * about the business or the actor is read from the request).
 *
 * GET   who the caller is (their role and whether they manage the team). The
 *       people with their emails and what each holds, and the trail of team
 *       changes, go to an owner and the Finance lead only.
 * POST  { email, role } an owner or the Finance lead adds a person who has a
 *       verified Splash account. Every refusal is the service's: default deny,
 *       and the Finance lead cannot give the owner role.
 */
export async function GET(request: Request) {
  const gate = await teamRoute(request);
  if (gate.response) return gate.response;
  const manager = await teamManager(gate.route.db, gate.route.orgId, gate.route.authority.userId);
  const role = await memberRole(gate.route.db, gate.route.orgId, gate.route.authority.userId);
  const access = await fundsAccessOf(gate.route.db, gate.route.orgId, gate.route.authority.userId);
  const members = manager ? await listTeam(gate.route.db, gate.route.orgId) : [];
  // Newest first for a page that reads top down.
  const activity = manager ? (await listTeamActivity(gate.route.db, gate.route.orgId, 50)).reverse() : [];
  return NextResponse.json({ you: { userId: gate.route.authority.userId, role, manager, addFunds: access.addFunds, withdraw: access.withdraw }, members, activity }, { headers: NO_STORE });
}

export async function POST(request: Request) {
  const gate = await teamRoute(request);
  if (gate.response) return gate.response;
  const limited = await limitTeamChanges(gate.route);
  if (limited) return limited;
  const body = await readJsonBody(request);
  const result = await addTeamMember(gate.route.db, { orgId: gate.route.orgId, actorUserId: gate.route.authority.userId, email: body.email, role: body.role });
  return teamResponse(result, result.ok ? { member: result.member } : undefined, 201);
}
