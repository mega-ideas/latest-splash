import { NextResponse } from 'next/server';

import { sendStoredExchangeMessage } from '@/lib/server/wallet-transfers';
import { transferRoute } from '@/lib/server/wallet-transfers-deps';
import { limitWalletRequests, NO_STORE } from '@/lib/server/wallet-route';

export const dynamic = 'force-dynamic';

/**
 * Send again the Travel Rule message of a staff member's own exchange payment
 * (`ref` is its signing request id), when the provider could not be reached the
 * first time. It is made from the message kept with the payment, goes once, and
 * only for the person who made the payment while an owner's switch is still on.
 * Another person's or another business's payment reads as absent.
 */
export async function POST(request: Request, { params }: { params: Promise<{ ref: string }> }) {
  const gate = await transferRoute(request);
  if (gate.response) return gate.response;
  const limited = await limitWalletRequests(gate.route);
  if (limited) return limited;
  const { ref } = await params;
  const result = await sendStoredExchangeMessage(gate.deps, { userId: gate.route.authority.userId, role: gate.route.authority.role }, { signingRequestId: ref });
  if (!result.ok) {
    const { ok, status, ...rest } = result;
    void ok;
    return NextResponse.json(rest, { status, headers: NO_STORE });
  }
  return NextResponse.json({ travelRule: result.travelRule }, { headers: NO_STORE });
}
