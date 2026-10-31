import { NextResponse } from 'next/server';

import { listRunViews } from '@/lib/server/scheduled-payments';
import { scheduleRoute } from '@/lib/server/scheduled-payments-deps';
import { NO_STORE, requirePayoutReader } from '@/lib/server/wallet-route';

export const dynamic = 'force-dynamic';

/**
 * Every scheduled run of this business, newest first: what History lists, with
 * its state in plain words (scheduled, waiting for approval, approved, paid,
 * skipped, not approved in time, did not go through). Another business's runs
 * are never in it.
 */
export async function GET(request: Request) {
  const gate = await scheduleRoute(request);
  if (gate.response) return gate.response;
  const reader = requirePayoutReader(gate.route);
  if (reader) return reader;
  return NextResponse.json({ runs: await listRunViews(gate.deps) }, { headers: NO_STORE });
}
