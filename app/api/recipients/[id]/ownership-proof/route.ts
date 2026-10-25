import { NextResponse } from 'next/server';

import { RATE_LIMITS, enforceRateLimit } from '@/lib/server/rate-limit';
import { ownershipChallengesOf, requestOwnershipProof, revokeRecipientOwnership } from '@/lib/server/wallet-recipients';
import { NO_STORE, proofLinkDeps, recipientRoute } from '@/lib/server/wallet-recipients-deps';

export const dynamic = 'force-dynamic';

/**
 * The ownership proof of a wallet the supplier holds (v2 §4.7, D5b).
 *
 *   GET     the links made for it and what became of each (no tokens: they
 *           are not kept).
 *   POST    make the link (and email it to the supplier when its email is
 *           on file). Any open link is replaced. Owners and staff.
 *   DELETE  withdraw the proof: no payment to the wallet until it is proven
 *           again. Owners only.
 *
 * The recipient is read within the business from the session; another
 * business's id reads as absent.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const route = await recipientRoute(request);
  if (!route.ok) return route.response;
  const { id } = await params;
  return NextResponse.json({ challenges: await ownershipChallengesOf(route.db, route.orgId, id) }, { headers: NO_STORE });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const route = await recipientRoute(request);
  if (!route.ok) return route.response;
  const limited = await enforceRateLimit({ rule: RATE_LIMITS.ownershipProofUser, key: route.authority.userId });
  if (limited) return limited;
  const { id } = await params;
  const result = await requestOwnershipProof(await proofLinkDeps(route.db, route.orgId), { recipientId: id, requestedBy: route.authority.userId });
  if (!result.ok) return NextResponse.json({ error: result.error, code: result.code }, { status: result.status, headers: NO_STORE });
  const { ok: _ok, ...rest } = result;
  void _ok;
  return NextResponse.json(rest, { status: 201, headers: NO_STORE });
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const route = await recipientRoute(request);
  if (!route.ok) return route.response;
  if (route.authority.role !== 'OWNER') return NextResponse.json({ error: 'Only an owner can withdraw an ownership proof.' }, { status: 403, headers: NO_STORE });
  const { id } = await params;
  const result = await revokeRecipientOwnership({ db: route.db, orgId: route.orgId, now: () => new Date() }, { recipientId: id });
  if (!result.ok) return NextResponse.json({ error: result.error, code: result.code }, { status: result.status, headers: NO_STORE });
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
