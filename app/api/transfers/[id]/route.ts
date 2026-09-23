import { NextResponse } from 'next/server';

import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { readSweepJob } from '@/lib/server/operations';
import { requireSessionAccount } from '@/lib/server/session-account';
import { readAuditReceipt, readTransfer } from '@/lib/server/transfers-store';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;

  // Being signed in is not the same as being entitled to this transfer. The
  // read used to take an id alone, so any authenticated user could fetch any
  // tenant's transfer by guessing or replaying one.
  const accountCheck = await requireSessionAccount(auth.session);
  if (accountCheck.response) return accountCheck.response;

  const { id } = await params;
  const intent = await readTransfer(accountCheck.account.orgId, id);

  if (!intent) {
    // 404 for both "does not exist" and "not yours". A 403 on the second would
    // confirm which ids exist, which is how a tenant gets enumerated.
    return NextResponse.json({ error: 'Transfer intent not found' }, { status: 404 });
  }

  // W9.5 — the delivery timeline renders REAL per-stage timestamps from the
  // lifecycle audit trail, never timer-faked progress.
  // Scoped by the same org as the transfer above: the trail is as sensitive
  // as the payment, and it is composed from that payment's own transitions.
  const receipt = await readAuditReceipt(accountCheck.account.orgId, id);
  const statusHistory = receipt?.statusHistory ?? [];

  return NextResponse.json({
    ...intent,
    sweepJob: intent.sweepJobId ? readSweepJob(intent.sweepJobId) : null,
    statusHistory,
  });
}
