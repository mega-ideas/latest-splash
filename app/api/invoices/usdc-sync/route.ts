import { NextResponse } from 'next/server';

import { relyingPartyId } from '@/lib/auth/passkey';
import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { RATE_LIMITS, enforceRateLimit } from '@/lib/server/rate-limit';
import { requireSessionAccount } from '@/lib/server/session-account';
import { syncOrgInvoiceUsdcPayments } from '@/lib/server/usdc-invoice-payments';

/**
 * "Check USDC payments": every open invoice of the session's workspace,
 * matched against one read of its main admin's Splash wallet on Sui
 * (lib/server/usdc-invoice-payments.ts). Records what it finds, once; moves
 * nothing.
 */
export async function POST(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;
  const limited = await enforceRateLimit({ rule: RATE_LIMITS.invoiceUsdcSyncUser, key: auth.session.email });
  if (limited) return limited;
  const accountCheck = await requireSessionAccount(auth.session);
  if (accountCheck.response) return accountCheck.response;
  if (!process.env.DATABASE_URL) return NextResponse.json({ error: 'USDC payments need the database.' }, { status: 503 });

  const { getDb } = await import('@/lib/db/client');
  const result = await syncOrgInvoiceUsdcPayments(getDb(), accountCheck.account.orgId, { rpId: relyingPartyId() });
  return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
}
