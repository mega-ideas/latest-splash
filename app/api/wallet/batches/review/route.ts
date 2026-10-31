import { NextResponse } from 'next/server';

import { sheetRowsFromBody } from '@/lib/batch/sheet';
import { readJsonBody } from '@/lib/server/http';
import { reviewBatch } from '@/lib/server/wallet-batches';
import { batchRefusal, withFeeGuard } from '@/lib/server/wallet-batches-route';
import { batchRoute } from '@/lib/server/wallet-transfers-deps';
import { limitWalletRequests, NO_STORE, requireWithdrawalRequester } from '@/lib/server/wallet-route';

export const dynamic = 'force-dynamic';

/**
 * POST { rows: [{ recipient, amount, reference }] }: every row of a sheet,
 * checked (its cells, the saved recipient it names, its screening, its fee
 * from the schedule on chain) with its own error, and the batch's totals and
 * the wallet's shortfall, before anything is made. `maxFeeMinor` is exactly
 * the total fee shown: send it back with the batch. Nothing is stored, and
 * nothing in a cell is read as an instruction.
 */
export async function POST(request: Request) {
  const gate = await batchRoute(request);
  if (gate.response) return gate.response;
  const asker = requireWithdrawalRequester(gate.route);
  if (asker) return asker;
  const limited = await limitWalletRequests(gate.route);
  if (limited) return limited;
  const body = await readJsonBody(request);
  return withFeeGuard(async () => {
    const result = await reviewBatch(gate.deps, { userId: gate.route.authority.userId, role: gate.route.authority.role }, sheetRowsFromBody(body.rows));
    if (!result.ok) return batchRefusal(result);
    return NextResponse.json({ review: result.review }, { headers: NO_STORE });
  });
}
