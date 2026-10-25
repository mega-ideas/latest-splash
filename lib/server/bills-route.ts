/**
 * The front door every Pay invoices route (app/api/bills/*) goes through: a
 * signed-in customer with a membership. The org is the session's
 * (requireSessionAccount, WS2); the role and user are the membership row's
 * (resolveAuthorityForSession), never the request's. Supplier invoices are
 * never kept in memory: with no database the routes refuse.
 */
import { NextResponse } from 'next/server';

import { UnauthorizedError, resolveAuthorityForSession } from '@/lib/auth/authority';
import { requireCustomerRequest, type CustomerSession } from '@/lib/server/customer-auth';
import { requireSessionAccount } from '@/lib/server/session-account';
import type { Answer, BillCaller } from '@/lib/server/bills';
import type { BillsDb } from '@/lib/server/bills-store';

export const NO_STORE = { 'Cache-Control': 'no-store' };

export async function billCaller(
  request: Request,
): Promise<{ caller: BillCaller; session: CustomerSession; response: null } | { caller: null; session: null; response: Response }> {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return { caller: null, session: null, response: auth.response };
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

export async function billsDb(): Promise<{ db: BillsDb; response: null } | { db: null; response: Response }> {
  if (!process.env.DATABASE_URL) {
    return { db: null, response: NextResponse.json({ error: 'Pay invoices needs the database, and this server has none.' }, { status: 503, headers: NO_STORE }) };
  }
  const { getDb } = await import('@/lib/db/client');
  return { db: getDb() as unknown as BillsDb, response: null };
}

export function answer(result: Answer) {
  return NextResponse.json(result.body, { status: result.status, headers: NO_STORE });
}
