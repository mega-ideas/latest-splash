import { NextResponse } from 'next/server';

import { resolveAuthorityForSession } from '@/lib/auth/authority';
import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { readJsonBody } from '@/lib/server/http';
import { requireTermsAccepted } from '@/lib/server/onboarding';
import { RATE_LIMITS, enforceRateLimit } from '@/lib/server/rate-limit';
import { requireSessionAccount } from '@/lib/server/session-account';
import { liveSendDeps, NO_LEDGER_RESPONSE } from '@/lib/server/stablecoin-deps';
import { submitWalletTransfer } from '@/lib/server/stablecoin-send';

export const dynamic = 'force-dynamic';

/**
 * Submit a transfer the business signed in its own wallet. Dry-run first; on
 * chain only if the signed bytes do exactly what was quoted; recorded as what
 * the chain actually did.
 */
export async function POST(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;
  const limited = await enforceRateLimit({ rule: RATE_LIMITS.stablecoinSubmitUser, key: auth.session.email });
  if (limited) return limited;
  const accountCheck = await requireSessionAccount(auth.session);
  if (accountCheck.response) return accountCheck.response;
  const termsGate = await requireTermsAccepted(accountCheck.account.orgId);
  if (termsGate) return termsGate;

  const deps = await liveSendDeps();
  if (!deps) return NextResponse.json(NO_LEDGER_RESPONSE, { status: 503 });

  const body = await readJsonBody(request);
  const ctx = await resolveAuthorityForSession(auth.session);
  const result = await submitWalletTransfer(deps, {
    orgId: accountCheck.account.orgId,
    role: ctx.role,
    outflowId: String(body.outflowId ?? ''),
    transactionBytes: String(body.transactionBytes ?? ''),
    signature: String(body.signature ?? ''),
  });
  if (!result.ok) {
    const { status, ...rest } = result;
    return NextResponse.json(rest, { status, headers: { 'Cache-Control': 'no-store' } });
  }
  return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
}
