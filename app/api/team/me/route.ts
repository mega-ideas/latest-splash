import { NextResponse } from 'next/server';

import { financeLeadOf, fundsAccessOf, teamManager } from '@/lib/server/team-admin';
import { NO_STORE, teamRoute } from '@/lib/server/team-route';
import { memberRole } from '@/lib/server/wallet-authority';

export const dynamic = 'force-dynamic';

/**
 * What the signed-in person may do in their own business, read from the
 * server each time: whether they manage the team, and whether an owner lets
 * them add funds and withdraw. Pages that offer Add funds (Transfer, Batch,
 * Home) ask this and offer nothing until it answers. It decides nothing: the
 * routes behind each action check the same rule again.
 */
export async function GET(request: Request) {
  const gate = await teamRoute(request);
  if (gate.response) return gate.response;
  const { db, orgId, authority } = gate.route;
  const [role, manager, access, lead] = await Promise.all([
    memberRole(db, orgId, authority.userId),
    teamManager(db, orgId, authority.userId),
    fundsAccessOf(db, orgId, authority.userId),
    financeLeadOf(db, orgId),
  ]);
  return NextResponse.json({ role, manager, financeLead: lead === authority.userId, addFunds: access.addFunds, withdraw: access.withdraw }, { headers: NO_STORE });
}
