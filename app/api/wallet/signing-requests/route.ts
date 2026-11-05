import { NextResponse } from 'next/server';

import { NO_STORE, walletRoute } from '@/lib/server/wallet-route';
import { signingInbox } from '@/lib/server/wallet-signing';

export const dynamic = 'force-dynamic';

/**
 * The in-app inbox: wallet transactions waiting on the signed-in person's
 * signature, in their own org, each with its exact bytes, digest and what
 * the bytes do (decoded on the server from the bytes, never from client
 * state).
 */
export async function GET(request: Request) {
  const gate = await walletRoute(request);
  if (gate.response) return gate.response;
  const { orgId, authority, ctx } = gate.route;
  const requests = await signingInbox(ctx.signing, { orgId, userId: authority.userId });
  return NextResponse.json({ requests }, { headers: NO_STORE });
}
