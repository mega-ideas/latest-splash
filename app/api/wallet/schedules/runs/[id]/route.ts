import { NextResponse } from 'next/server';

import { getRunView } from '@/lib/server/scheduled-payments';
import { scheduleRoute } from '@/lib/server/scheduled-payments-deps';
import { NO_STORE, requirePayoutReader } from '@/lib/server/wallet-route';

export const dynamic = 'force-dynamic';

/** One scheduled run with its payments: the receipt of an automatic run. Another business's reads as absent. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await scheduleRoute(request);
  if (gate.response) return gate.response;
  const reader = requirePayoutReader(gate.route);
  if (reader) return reader;
  const { id } = await params;
  const run = await getRunView(gate.deps, id);
  if (!run) return NextResponse.json({ error: 'No such run.', code: 'run_not_found' }, { status: 404, headers: NO_STORE });
  return NextResponse.json({ run }, { headers: NO_STORE });
}
