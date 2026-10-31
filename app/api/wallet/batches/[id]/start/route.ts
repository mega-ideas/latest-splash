import { NextResponse } from 'next/server';

import { readJsonBody } from '@/lib/server/http';
import { startBatchSigning } from '@/lib/server/wallet-batches';
import { batchRefusal, withFeeGuard } from '@/lib/server/wallet-batches-route';
import { batchRoute } from '@/lib/server/wallet-transfers-deps';
import { limitWalletRequests, NO_STORE } from '@/lib/server/wallet-route';

export const dynamic = 'force-dynamic';

/**
 * An owner starts the signatures for a batch (made by the owner, or prepared
 * by a team member). Every row is checked again against what is saved now.
 * Idempotent: a batch already collecting signatures or sent answers its
 * request. `{ schedule: true }` asks for the batch to run later under a rule,
 * which this server does not carry out yet: it answers 409 `schedule_not_wired`
 * and schedules nothing.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await batchRoute(request);
  if (gate.response) return gate.response;
  const limited = await limitWalletRequests(gate.route);
  if (limited) return limited;
  const body = await readJsonBody(request);
  const { id } = await params;
  return withFeeGuard(async () => {
    const result = await startBatchSigning(gate.deps, { userId: gate.route.authority.userId, role: gate.route.authority.role }, id, { schedule: body.schedule === true });
    if (!result.ok) return batchRefusal(result);
    return NextResponse.json({ batch: result.batch, signingRequest: result.signingRequest ?? null }, { headers: NO_STORE });
  });
}
