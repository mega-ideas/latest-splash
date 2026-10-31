import { NextResponse } from 'next/server';

import { readJsonBody } from '@/lib/server/http';
import { orgMembers } from '@/lib/server/org-member-names';
import { orgMemberWalletAddresses } from '@/lib/server/wallet-deps';
import { appointPersonInCharge, listPersonsInCharge, revokePersonInCharge } from '@/lib/server/wallet-authority';
import { asResponse, limitWalletRequests, NO_STORE, refusal, walletRoute } from '@/lib/server/wallet-route';

export const dynamic = 'force-dynamic';

/**
 * The person in charge (Sky, 25 Oct): an off-chain role an owner appoints and
 * revokes. With the owners, the highest authority; they sign off a staff
 * member's migration of their own USDC. Every change is written to the
 * append-only trail (wallet_authority_events).
 *
 * GET               who is in charge in this business.
 * POST { userId }   an owner appoints a member of this business.
 * DELETE ?userId=   an owner revokes them; what they signed off and is still
 *                   unused is voided.
 */
export async function GET(request: Request) {
  const gate = await walletRoute(request);
  if (gate.response) return gate.response;
  const personsInCharge = await listPersonsInCharge(gate.route.db, gate.route.orgId);
  const members = await orgMembers(gate.route.db, gate.route.orgId);
  const named = personsInCharge.map((p) => ({ ...p, name: members.find((m) => m.userId === p.userId)?.name ?? 'A member' }));
  // The people to choose from go to an owner only: who holds which role is theirs to decide.
  // Whether each has a passkey on this site goes with them: a spending rule is given to that passkey's
  // address, so the owner learns who cannot be given one before the last question. This business's members only.
  const keys = gate.route.authority.role === 'OWNER' ? await orgMemberWalletAddresses(gate.route.db, gate.route.orgId) : [];
  const candidates = gate.route.authority.role === 'OWNER' ? members.map((m) => ({ ...m, hasPasskey: keys.some((k) => k.userId === m.userId && k.canSign) })) : [];
  return NextResponse.json({ personsInCharge: named, members: candidates }, { headers: NO_STORE });
}

export async function POST(request: Request) {
  const gate = await walletRoute(request);
  if (gate.response) return gate.response;
  const limited = await limitWalletRequests(gate.route);
  if (limited) return limited;
  const body = await readJsonBody(request);
  const userId = String(body.userId ?? '').trim();
  if (!userId) return refusal(400, 'Name the member to put in charge.');
  return asResponse(await appointPersonInCharge(gate.route.db, { orgId: gate.route.orgId, actorUserId: gate.route.authority.userId, userId }));
}

export async function DELETE(request: Request) {
  const gate = await walletRoute(request);
  if (gate.response) return gate.response;
  const limited = await limitWalletRequests(gate.route);
  if (limited) return limited;
  const userId = (new URL(request.url).searchParams.get('userId') ?? '').trim();
  if (!userId) return refusal(400, 'Name the person in charge to revoke.');
  return asResponse(await revokePersonInCharge(gate.route.db, { orgId: gate.route.orgId, actorUserId: gate.route.authority.userId, userId }));
}
