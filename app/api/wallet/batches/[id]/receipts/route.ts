import { NextResponse } from 'next/server';

import { batchReceiptsCsv, batchReceiptsFor } from '@/lib/server/batch-receipts';
import { RATE_LIMITS, enforceRateLimit } from '@/lib/server/rate-limit';
import { receiptDepsFor, batchRoute } from '@/lib/server/wallet-transfers-deps';
import { NO_STORE, requirePayoutReader } from '@/lib/server/wallet-route';

export const dynamic = 'force-dynamic';

/**
 * A batch's receipts (v2 brief 5.6): one per payment, and the batch's totals.
 * Owners and staff of the business; another business's batch reads as absent.
 *
 *   GET             { batch }
 *   GET ?format=csv the receipts as a CSV, one line per payment
 *
 * A batch that has not settled has receipts that say so (`final: false`).
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await batchRoute(request);
  if (gate.response) return gate.response;
  const reader = requirePayoutReader(gate.route);
  if (reader) return reader;
  const limited = await enforceRateLimit({ rule: RATE_LIMITS.controlsEvidenceUser, key: gate.route.authority.userId });
  if (limited) return limited;
  const format = new URL(request.url).searchParams.get('format') ?? 'json';
  if (format !== 'json' && format !== 'csv') return NextResponse.json({ error: 'format is json or csv' }, { status: 400, headers: NO_STORE });
  const { id } = await params;
  const made = await batchReceiptsFor(await receiptDepsFor(gate.route.db, gate.route.orgId), id);
  if (!made.ok) return NextResponse.json({ error: made.error, code: made.code }, { status: made.status, headers: NO_STORE });
  if (format === 'csv') {
    return new Response(batchReceiptsCsv(made.batch), {
      headers: { ...NO_STORE, 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="splash-batch-receipts-${id.slice(-8)}.csv"` },
    });
  }
  return NextResponse.json({ batch: made.batch }, { headers: NO_STORE });
}
