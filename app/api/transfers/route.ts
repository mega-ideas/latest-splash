import { NextResponse } from 'next/server';

import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { readSweepJob } from '@/lib/server/operations';
import { requireSessionAccount } from '@/lib/server/session-account';
import { listTransfersFor } from '@/lib/server/transfers-store';

export async function GET(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;

  // Two problems in one line, both fixed here.
  //
  // It read `operations.transfers` directly, so it returned EVERY tenant's
  // transfers — and `?export=true` returned all of them in one response.
  //
  // And once transfers moved to Postgres that map stopped being written at
  // all, so this page would have rendered empty against a real database. A
  // store bypassed is a store that silently stops working.
  const accountCheck = await requireSessionAccount(auth.session);
  if (accountCheck.response) return accountCheck.response;

  const { searchParams } = new URL(request.url);
  const filter = searchParams.get('filter') ?? 'all';
  const page = Math.max(1, Number.parseInt(searchParams.get('page') ?? '1', 10));
  const perPage = searchParams.get('export') === 'true' ? Number.MAX_SAFE_INTEGER : 20;

  // Bounded, and the bound is stated rather than implied: an export that
  // silently truncates is worse than one that is documented as a page.
  const MAX_HISTORY = 5_000;
  let records = await listTransfersFor(accountCheck.account.orgId, MAX_HISTORY);

  if (filter === 'successful') {
    records = records.filter((r) => r.state === 'SETTLED' || r.state === 'DISBURSED' || r.state === 'CREDITED');
  } else if (filter === 'failed') {
    records = records.filter((r) => r.state === 'FAILED' || r.state === 'REFUNDED' || r.state === 'REFUNDING');
  } else if (filter === 'pending') {
    records = records.filter(
      (r) => r.state !== 'SETTLED' && r.state !== 'DISBURSED' && r.state !== 'CREDITED' && r.state !== 'FAILED' && r.state !== 'REFUNDED',
    );
  }

  const total = records.length;
  const items = records.slice((page - 1) * perPage, page * perPage).map((record) => ({
    ...record,
    heldDurationMs: record.sweepJobId ? readSweepJob(record.sweepJobId)?.heldDurationMs ?? null : null,
  }));

  return NextResponse.json({ items, total, page, perPage });
}
