import { NextResponse } from 'next/server';

import { resolveAuthorityForSession } from '@/lib/auth/authority';
import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { readJsonBody } from '@/lib/server/http';
import { requireTermsAccepted } from '@/lib/server/onboarding';
import { RATE_LIMITS, enforceRateLimit } from '@/lib/server/rate-limit';
import { requireSessionAccount } from '@/lib/server/session-account';
import { NO_LEDGER_RESPONSE } from '@/lib/server/stablecoin-deps';
import { liveX402Deps } from '@/lib/server/x402-deps';
import { quoteX402 } from '@/lib/server/x402-pay';

export const dynamic = 'force-dynamic';

function respond(result: { ok: boolean; status?: number } & Record<string, unknown>, okStatus = 200) {
  if (!result.ok) {
    const { status, ...rest } = result;
    return NextResponse.json(rest, { status: status ?? 400, headers: { 'Cache-Control': 'no-store' } });
  }
  return NextResponse.json(result, { status: okStatus, headers: { 'Cache-Control': 'no-store' } });
}

/** Reserve an x402 payment against the shared allowance and build it for signing. */
export async function POST(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;
  const limited = await enforceRateLimit({ rule: RATE_LIMITS.stablecoinQuoteUser, key: auth.session.email });
  if (limited) return limited;
  const accountCheck = await requireSessionAccount(auth.session);
  if (accountCheck.response) return accountCheck.response;
  const termsGate = await requireTermsAccepted(accountCheck.account.orgId);
  if (termsGate) return termsGate;
  const deps = await liveX402Deps();
  if (!deps) return NextResponse.json(NO_LEDGER_RESPONSE, { status: 503 });

  const body = await readJsonBody(request);
  const ctx = await resolveAuthorityForSession(auth.session);
  return respond(await quoteX402(deps, {
    orgId: accountCheck.account.orgId,
    userId: ctx.userId,
    role: ctx.role,
    url: String(body.url ?? ''),
    senderAddress: String(body.senderAddress ?? ''),
    attestPayee: body.attestPayee === true,
  }), 201);
}
