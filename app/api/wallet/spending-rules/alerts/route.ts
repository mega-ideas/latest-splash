import { NextResponse } from 'next/server';

import { resolveAuthorityForSession } from '@/lib/auth/authority';
import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { listSpendRuleAlertsForOrg, type DrizzleDb } from '@/lib/server/near-threshold-store';
import { requireSessionAccount } from '@/lib/server/session-account';
import { NO_STORE } from '@/lib/server/wallet-route';

export const dynamic = 'force-dynamic';

/**
 * Settings → Team & rules: the near-threshold alerts the cron recorded for
 * THIS business (v2 Phase 2; lib/server/near-threshold.ts). Owners only: an
 * alert names staff members and what they paid whom. The org comes from the
 * session (requireSessionAccount, WS2), never from the request, so another
 * business's alerts are never read. Detective only: nothing here changes a
 * rule.
 */
export async function GET(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;
  const accountCheck = await requireSessionAccount(auth.session);
  if (accountCheck.response) return accountCheck.response;
  let role: string;
  let orgId: string;
  try {
    const authority = await resolveAuthorityForSession(auth.session);
    role = authority.role;
    orgId = authority.orgId;
  } catch {
    return NextResponse.json({ error: 'no membership' }, { status: 403, headers: NO_STORE });
  }
  if (orgId !== accountCheck.account.orgId) return NextResponse.json({ error: 'no membership' }, { status: 403, headers: NO_STORE });
  if (role !== 'OWNER') return NextResponse.json({ error: 'Only an owner can see spending-rule alerts.' }, { status: 403, headers: NO_STORE });
  if (!process.env.DATABASE_URL) return NextResponse.json({ error: 'the alerts need the database, and DATABASE_URL is not set' }, { status: 503, headers: NO_STORE });
  const { getDb } = await import('@/lib/db/client');
  const db = getDb() as unknown as DrizzleDb;
  const alerts = await listSpendRuleAlertsForOrg(db, accountCheck.account.orgId, Date.now());
  return NextResponse.json({ alerts }, { headers: NO_STORE });
}
