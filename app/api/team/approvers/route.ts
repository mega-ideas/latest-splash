import { NextResponse } from 'next/server';

import { fewApproversWarning, MIN_APPROVERS } from '@/lib/approve/wait';
import { relyingPartyId } from '@/lib/auth/passkey';
import { approverCountOf } from '@/lib/server/approval-wait';
import { NO_STORE, teamRoute } from '@/lib/server/team-route';
import { memberRole } from '@/lib/server/wallet-authority';

export const dynamic = 'force-dynamic';

/**
 * How many people can approve payments for this business right now, and the warning the owners see on Limits and Team
 * when that is fewer than three (v2 Phase 3, when nobody who can approve answers).
 *
 * "Can approve" means can really sign: an owner with a working passkey on this site, not a member (a business wallet is
 * signed by its owners' passkeys). Only an owner is told: anyone else gets no count and no warning. It reads only and
 * blocks nothing. The business and the person come from the session.
 */
export async function GET(request: Request) {
  const gate = await teamRoute(request);
  if (gate.response) return gate.response;
  const { db, orgId, authority } = gate.route;
  if ((await memberRole(db, orgId, authority.userId)) !== 'admin') {
    return NextResponse.json({ count: null, minimum: MIN_APPROVERS, warning: null }, { headers: NO_STORE });
  }
  const count = await approverCountOf(db, orgId, relyingPartyId());
  return NextResponse.json({ count, minimum: MIN_APPROVERS, warning: fewApproversWarning(count) }, { headers: NO_STORE });
}
