import { NextResponse } from 'next/server';

import { readJsonBody } from '@/lib/server/http';
import { previewExchangeDisclosure, payeeFromBody } from '@/lib/server/wallet-transfers';
import { transferRoute } from '@/lib/server/wallet-transfers-deps';
import { limitWalletRequests, NO_STORE } from '@/lib/server/wallet-route';

export const dynamic = 'force-dynamic';

/**
 * What would be shared with an exchange if this staff member paid its account
 * alone (v2 Phase 3): `{ payee, amountMinor, purpose }` with the Idempotency-Key
 * the payment will use (the intent id the message is bound to). Answers the
 * message in plain words and the hash to confirm it with. The business is the
 * session's, the sender is the signed-in person, and everything else is read
 * on the server; nothing is stored and nothing is sent. Refused for a person
 * an owner has not allowed, for an owner, and where the Travel Rule provider is
 * not configured.
 */
export async function POST(request: Request) {
  const gate = await transferRoute(request);
  if (gate.response) return gate.response;
  const limited = await limitWalletRequests(gate.route);
  if (limited) return limited;
  const body = await readJsonBody(request);
  const result = await previewExchangeDisclosure(
    gate.deps,
    { userId: gate.route.authority.userId, role: gate.route.authority.role },
    { clientKey: request.headers.get('idempotency-key') ?? body.clientKey, payee: payeeFromBody(body.payee), amountMinor: body.amountMinor, purpose: body.purpose },
  );
  if (!result.ok) {
    const { ok, status, ...rest } = result;
    void ok;
    return NextResponse.json(rest, { status, headers: NO_STORE });
  }
  return NextResponse.json({ disclosure: result.disclosure, text: result.text, hash: result.hash }, { headers: NO_STORE });
}
