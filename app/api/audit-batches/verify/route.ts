import { NextResponse } from 'next/server';

import { getAdminSession } from '@/lib/server/admin-auth';
import { verifyDailyAuditBatchForStaff } from '@/lib/server/audit-batches';
import { readJsonBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

/** Inclusion, Walrus and anchor check for one leaf. Staff only, like the list. */
export async function POST(request: Request) {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ error: 'Staff authentication required' }, { status: 401 });
  }

  try {
    const body = await readJsonBody(request);
    const batchId = typeof body.batchId === 'string' ? body.batchId : '';
    const transferId = typeof body.transferId === 'string' ? body.transferId : '';
    if (!batchId || !transferId) {
      return NextResponse.json({ error: 'batchId and transferId are required' }, { status: 400 });
    }
    return NextResponse.json(await verifyDailyAuditBatchForStaff(batchId, transferId), {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'verification failed' },
      { status: 400 },
    );
  }
}
