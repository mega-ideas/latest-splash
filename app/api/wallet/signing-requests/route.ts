import { NextResponse } from 'next/server';

import { waitingForMe } from '@/lib/dashboard/phone';
import { NO_STORE, walletRoute } from '@/lib/server/wallet-route';
import { signingInbox } from '@/lib/server/wallet-signing';

export const dynamic = 'force-dynamic';

/**
 * The in-app inbox: wallet transactions waiting on the signed-in person's
 * signature, in their own org, each with its exact bytes, digest and what
 * the bytes do (decoded on the server from the bytes, never from client
 * state).
 *
 * `?count=1` answers only how many of them wait for this person's signature
 * (the phone's tab bar badge): the same inbox, none of its bytes.
 */
export async function GET(request: Request) {
  const gate = await walletRoute(request);
  if (gate.response) return gate.response;
  const { orgId, authority, ctx } = gate.route;
  const requests = await signingInbox(ctx.signing, { orgId, userId: authority.userId });
  if (new URL(request.url).searchParams.get('count') === '1') return NextResponse.json({ waiting: waitingForMe(requests) }, { headers: NO_STORE });
  return NextResponse.json({ requests }, { headers: NO_STORE });
}
