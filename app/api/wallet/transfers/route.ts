import { NextResponse } from 'next/server';

import { readJsonBody } from '@/lib/server/http';
import { requireTermsAccepted } from '@/lib/server/onboarding';
import { createTransfer, listTransfers, payeeFromBody } from '@/lib/server/wallet-transfers';
import { transferRoute } from '@/lib/server/wallet-transfers-deps';
import { limitWalletRequests, NO_STORE, requirePayoutReader } from '@/lib/server/wallet-route';

export const dynamic = 'force-dynamic';

/**
 * Payments from the Splash Wallet to a Splash business or a saved wallet or
 * exchange recipient (v2 brief 5.4). A bank payout is POST /api/wallet/payouts.
 *
 * GET   this business's payments, newest first.
 * POST  { payee: { kind: 'recipient', recipientId } | { kind: 'splash_business',
 *       businessId }, amountMinor, maxFeeMinor, reference?, via?, asset? }
 *       with an Idempotency-Key header (or `clientKey`): the intent id. An
 *       owner's payment becomes a signing request for the owners. A staff
 *       member whose rule covers the amount, the recipient and the time
 *       window pays alone: a one-signer request for their own passkey
 *       (`staff_rule`); anything outside the rule asks the owners, and the
 *       answer's `plan` says why in plain words. `via: 'rule'` means "pay alone
 *       or tell me why not" (409 outside_rule, nothing stored); `via: 'ask'`
 *       asks the owners. `asset` other than USDC is refused. `maxFeeMinor` is
 *       the Splash fee the person was shown: the chain charges at most that.
 *       The business is the session's.
 */
export async function GET(request: Request) {
  const gate = await transferRoute(request);
  if (gate.response) return gate.response;
  const reader = requirePayoutReader(gate.route);
  if (reader) return reader;
  return NextResponse.json({ transfers: await listTransfers(gate.deps) }, { headers: NO_STORE });
}

export async function POST(request: Request) {
  const gate = await transferRoute(request);
  if (gate.response) return gate.response;
  const termsGate = await requireTermsAccepted(gate.route.orgId);
  if (termsGate) return termsGate;
  const limited = await limitWalletRequests(gate.route);
  if (limited) return limited;
  const body = await readJsonBody(request);
  const result = await createTransfer(
    gate.deps,
    { userId: gate.route.authority.userId, role: gate.route.authority.role },
    {
      clientKey: request.headers.get('idempotency-key') ?? body.clientKey,
      payee: payeeFromBody(body.payee),
      amountMinor: body.amountMinor,
      maxFeeMinor: body.maxFeeMinor,
      reference: body.reference,
      via: body.via,
      asset: body.asset,
    },
  );
  if (!result.ok) {
    const { ok, status, ...rest } = result;
    void ok;
    return NextResponse.json(rest, { status, headers: NO_STORE });
  }
  return NextResponse.json(
    { transfer: result.transfer, signingRequest: result.signingRequest ?? null, ask: result.ask ?? null, plan: result.plan, created: result.created },
    { status: result.created ? 201 : 200, headers: NO_STORE },
  );
}
