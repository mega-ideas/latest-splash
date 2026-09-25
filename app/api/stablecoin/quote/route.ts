import { NextResponse } from 'next/server';

import { resolveAuthorityForSession } from '@/lib/auth/authority';
import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { readJsonBody } from '@/lib/server/http';
import { requireTermsAccepted } from '@/lib/server/onboarding';
import { RATE_LIMITS, enforceRateLimit } from '@/lib/server/rate-limit';
import { requireSessionAccount } from '@/lib/server/session-account';
import { liveSendDeps, NO_LEDGER_RESPONSE } from '@/lib/server/stablecoin-deps';
import { quoteWalletTransfer } from '@/lib/server/stablecoin-send';

export const dynamic = 'force-dynamic';

/**
 * Quote a USDC-on-Sui transfer to a saved wallet recipient: reserve the
 * allowance and return the exact unsigned transaction for the business's own
 * wallet to sign. Deliberately NOT behind requireActiveOrg — this is the lane
 * an unverified business may use; its limits are enforced by the reservation.
 */
export async function POST(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;
  const limited = await enforceRateLimit({ rule: RATE_LIMITS.stablecoinQuoteUser, key: auth.session.email });
  if (limited) return limited;
  const accountCheck = await requireSessionAccount(auth.session);
  if (accountCheck.response) return accountCheck.response;
  const termsGate = await requireTermsAccepted(accountCheck.account.orgId);
  if (termsGate) return termsGate;

  const deps = await liveSendDeps();
  if (!deps) return NextResponse.json(NO_LEDGER_RESPONSE, { status: 503 });

  const body = await readJsonBody(request);
  const ctx = await resolveAuthorityForSession(auth.session);
  const result = await quoteWalletTransfer(deps, {
    // From the session, never the body.
    orgId: accountCheck.account.orgId,
    userId: ctx.userId,
    role: ctx.role,
    recipientId: String(body.recipientId ?? ''),
    amount: String(body.amount ?? ''),
    senderAddress: String(body.senderAddress ?? ''),
    // After a wallet would not sign the gasless transfer: the same one with
    // gas paid in SUI, replacing (and releasing) the quote it could not sign.
    payGasInSui: body.payGasInSui === true,
    replaces: typeof body.replaces === 'string' && body.replaces ? body.replaces : undefined,
  });
  if (!result.ok) {
    const { status, ...rest } = result;
    return NextResponse.json(rest, { status, headers: { 'Cache-Control': 'no-store' } });
  }
  return NextResponse.json(result, { status: 201, headers: { 'Cache-Control': 'no-store' } });
}
