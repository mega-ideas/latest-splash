import { NextResponse } from 'next/server';

import { resolveAuthorityForSession, type AuthorityContext } from '@/lib/auth/authority';
import { canAskForWithdrawal } from '@/lib/payouts/withdrawal-rules';
import { complianceResponse, screenDepsFor } from '@/lib/server/compliance-deps';
import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { readJsonBody } from '@/lib/server/http';
import { screenRecipient } from '@/lib/server/kyt-screenings';
import { RATE_LIMITS, enforceRateLimit } from '@/lib/server/rate-limit';
import { requireSessionAccount } from '@/lib/server/session-account';
import type { DrizzleDb } from '@/lib/server/wallet-signing-store';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

/**
 * Screen an address this business means to pay (v2 §4.6): `{ kind, chain,
 * address }`, kind `wallet_recipient` or `exchange_recipient` (on Sui) or
 * `cross_chain_recipient` (Solana, Ethereum, Base, …). The address is checked
 * against its chain first. The answer is the provider's, kept for this
 * business only (the org comes from the session); with no provider answer the
 * verdict is null, never CLEAR. Owners and staff.
 */
export async function POST(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;
  const accountCheck = await requireSessionAccount(auth.session);
  if (accountCheck.response) return accountCheck.response;
  let authority: AuthorityContext;
  try {
    authority = await resolveAuthorityForSession(auth.session);
  } catch {
    return NextResponse.json({ error: 'no membership' }, { status: 403, headers: NO_STORE });
  }
  if (authority.orgId !== accountCheck.account.orgId) return NextResponse.json({ error: 'no membership' }, { status: 403, headers: NO_STORE });
  if (!canAskForWithdrawal(authority.role)) {
    return NextResponse.json({ error: 'Only an owner or a staff member can screen a recipient.' }, { status: 403, headers: NO_STORE });
  }
  const limited = await enforceRateLimit({ rule: RATE_LIMITS.recipientCreateUser, key: auth.session.email });
  if (limited) return limited;
  if (!process.env.DATABASE_URL) return NextResponse.json({ error: 'Screening needs the database.' }, { status: 503, headers: NO_STORE });
  const { getDb } = await import('@/lib/db/client');
  const body = await readJsonBody(request);
  const result = await screenRecipient(screenDepsFor({ db: getDb() as unknown as DrizzleDb, orgId: accountCheck.account.orgId }), {
    kind: body.kind,
    chain: body.chain,
    address: body.address,
    requestedBy: authority.userId,
  });
  return complianceResponse(result, 201);
}
