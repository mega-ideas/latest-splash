import { NextResponse } from 'next/server';

import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { readBatch } from '@/lib/server/batches-store';
import { requireSessionAccount } from '@/lib/server/session-account';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;

  // The batch already recorded which org authorized it; nothing checked it on
  // the way back out, so any authenticated user could read any tenant's
  // payout run — row counts, totals, the settlement digest.
  const accountCheck = await requireSessionAccount(auth.session);
  if (accountCheck.response) return accountCheck.response;

  const { id } = await params;
  const batch = await readBatch(accountCheck.account.orgId, id);

  if (!batch) {
    // 404 for both "does not exist" and "not yours".
    return NextResponse.json({ error: 'Batch not found' }, { status: 404 });
  }

  return NextResponse.json(batch);
}
