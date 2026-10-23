import { NextResponse } from 'next/server';

import { getAdminSession } from '@/lib/server/admin-auth';
import { listDailyAuditBatchesForStaff } from '@/lib/server/audit-batches';

export const dynamic = 'force-dynamic';

/**
 * Every daily audit batch, for staff only.
 *
 * A batch spans every tenant (its leaves are other workspaces' transfer ids),
 * and this route used to hand all of it to any customer session. Sky's
 * decision (WS2): staff-only, roots and contents alike.
 */
export async function GET() {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ error: 'Staff authentication required' }, { status: 401 });
  }

  // Awaited: a Promise handed to NextResponse.json serialises as `{}`, and
  // tsc does not notice, because `json` takes anything.
  return NextResponse.json(
    { items: await listDailyAuditBatchesForStaff() },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
