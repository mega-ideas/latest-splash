import { NextResponse } from 'next/server';

import { asResponse, NO_STORE, walletRoute } from '@/lib/server/wallet-route';
import { cancelSigningRequest, declineSigningRequest, readRequestForSigner } from '@/lib/server/wallet-signing';

export const dynamic = 'force-dynamic';

/** One request, for a signer or the person who asked. Another org's id is a 404. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await walletRoute(request);
  if (gate.response) return gate.response;
  const { id } = await params;
  const result = await readRequestForSigner(gate.route.ctx.signing, { orgId: gate.route.orgId, userId: gate.route.authority.userId, id });
  return asResponse(result, result.ok ? { request: result.request } : undefined);
}

/**
 * The person who asked withdraws the request (its partial signatures are
 * cleared). Any other signer DECLINES instead: that is recorded and the
 * request stays open for the others, so one signer cannot veto the quorum.
 * It closes only once the signers left cannot reach the threshold.
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await walletRoute(request);
  if (gate.response) return gate.response;
  const { id } = await params;
  const scope = { orgId: gate.route.orgId, userId: gate.route.authority.userId, id };
  const cancelled = await cancelSigningRequest(gate.route.ctx.signing, scope);
  if (cancelled.ok) return NextResponse.json({ outcome: 'cancelled' }, { headers: NO_STORE });
  if (cancelled.code !== 'not_requester') return asResponse(cancelled);
  const declined = await declineSigningRequest(gate.route.ctx.signing, scope);
  if (!declined.ok) return asResponse(declined);
  return NextResponse.json({ outcome: declined.closed ? 'declined_and_closed' : 'declined' }, { headers: NO_STORE });
}
