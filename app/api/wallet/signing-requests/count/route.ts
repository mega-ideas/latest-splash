import { NextResponse } from 'next/server';

import { waitingForMe } from '@/lib/dashboard/phone';
import { NO_STORE, walletRoute } from '@/lib/server/wallet-route';
import { signingInbox } from '@/lib/server/wallet-signing';

export const dynamic = 'force-dynamic';

/**
 * How many wallet requests wait for the signed-in person's signature, in their
 * own org (the phone's tab bar badge). The same inbox as the list beside it
 * and none of its bytes: the org and the person come from the session, and
 * nothing in the request is read.
 */
export async function GET(request: Request) {
  const gate = await walletRoute(request);
  if (gate.response) return gate.response;
  const { orgId, authority, ctx } = gate.route;
  const requests = await signingInbox(ctx.signing, { orgId, userId: authority.userId });
  return NextResponse.json({ waiting: waitingForMe(requests) }, { headers: NO_STORE });
}
