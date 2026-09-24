import { NextResponse } from 'next/server';

import { usdcRecordsCsv } from '@/lib/payments/usdc-records';
import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { RATE_LIMITS, enforceRateLimit } from '@/lib/server/rate-limit';
import { requireSessionAccount } from '@/lib/server/session-account';
import { listUsdcRecords } from '@/lib/server/usdc-records';

export const dynamic = 'force-dynamic';

/**
 * Every USDC transfer this workspace quoted, as CSV for its books: amounts,
 * fees, who asked, who approved and how, the Sui transaction and the audit
 * record. Scoped to the session's workspace — never an org id from the
 * request.
 */
export async function GET(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;
  const limited = await enforceRateLimit({ rule: RATE_LIMITS.stablecoinExportUser, key: auth.session.email });
  if (limited) return limited;
  const accountCheck = await requireSessionAccount(auth.session);
  if (accountCheck.response) return accountCheck.response;
  if (!process.env.DATABASE_URL) return NextResponse.json({ error: 'The export needs the database.' }, { status: 503 });

  const { getDb } = await import('@/lib/db/client');
  const records = await listUsdcRecords(getDb(), accountCheck.account.orgId);
  const day = new Date().toISOString().slice(0, 10);
  return new Response(usdcRecordsCsv(records), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="splash-usdc-transfers-${day}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}
