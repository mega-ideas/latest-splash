/**
 * The front door every Treasury route (app/api/treasury/wallet/*,
 * app/api/treasury/fund-referral) goes through: a signed-in customer, inside
 * the launch scope, with a membership. The org is the session's
 * (requireSessionAccount, WS2), and the role and user are the membership
 * row's (resolveAuthorityForSession), never the request's.
 */
import { NextResponse } from 'next/server';

import { UnauthorizedError, resolveAuthorityForSession } from '@/lib/auth/authority';
import { requireCustomerRequest, type CustomerSession } from '@/lib/server/customer-auth';
import { refuseOutsideLaunchScope } from '@/lib/server/launch-scope';
import { requireSessionAccount } from '@/lib/server/session-account';
import type { TreasuryCaller } from '@/lib/server/treasury-wallet';

export const NO_STORE = { 'Cache-Control': 'no-store' };

export async function treasuryCaller(
  request: Request,
): Promise<{ caller: TreasuryCaller; session: CustomerSession; response: null } | { caller: null; session: null; response: Response }> {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return { caller: null, session: null, response: auth.response };
  const outOfScope = refuseOutsideLaunchScope();
  if (outOfScope) return { caller: null, session: null, response: outOfScope };
  const accountCheck = await requireSessionAccount(auth.session);
  if (accountCheck.response) return { caller: null, session: null, response: accountCheck.response };
  let authority;
  try {
    authority = await resolveAuthorityForSession(auth.session);
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return { caller: null, session: null, response: NextResponse.json({ error: 'No workspace membership yet.', code: 'no_membership' }, { status: 403, headers: NO_STORE }) };
    }
    throw error;
  }
  if (authority.orgId !== accountCheck.account.orgId) {
    return { caller: null, session: null, response: NextResponse.json({ error: 'The session and its membership disagree about the business.' }, { status: 403, headers: NO_STORE }) };
  }
  return {
    caller: { orgId: accountCheck.account.orgId, userId: authority.userId, role: authority.role },
    session: auth.session,
    response: null,
  };
}

/** The database, or the reason there is none. Treasury orders and referrals are never kept in memory. */
export async function treasuryDb(): Promise<{ db: unknown; response: null } | { db: null; response: Response }> {
  if (!process.env.DATABASE_URL) {
    return { db: null, response: NextResponse.json({ error: 'Treasury needs the database, and this server has none.' }, { status: 503, headers: NO_STORE }) };
  }
  const { getDb } = await import('@/lib/db/client');
  return { db: getDb(), response: null };
}

export function answer(result: { status: number; body: Record<string, unknown> }) {
  return NextResponse.json(result.body, { status: result.status, headers: NO_STORE });
}
