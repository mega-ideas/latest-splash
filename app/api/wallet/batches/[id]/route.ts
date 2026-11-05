import { NextResponse } from 'next/server';

import { getBatch } from '@/lib/server/wallet-batches';
import { readRequestForSigner } from '@/lib/server/wallet-signing';
import { batchRoute } from '@/lib/server/wallet-transfers-deps';
import { NO_STORE, requirePayoutReader } from '@/lib/server/wallet-route';

export const dynamic = 'force-dynamic';

/**
 * One batch, with its signing request as the caller sees it (the bytes their
 * device decodes before they sign). Another business's batch reads as absent.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await batchRoute(request);
  if (gate.response) return gate.response;
  const reader = requirePayoutReader(gate.route);
  if (reader) return reader;
  const { id } = await params;
  const batch = await getBatch(gate.deps, id);
  if (!batch) return NextResponse.json({ error: 'No such batch.', code: 'batch_not_found' }, { status: 404, headers: NO_STORE });
  let signingRequest = null;
  if (batch.signingRequestId) {
    const read = await readRequestForSigner(gate.route.ctx.signing, { orgId: gate.route.orgId, userId: gate.route.authority.userId, id: batch.signingRequestId });
    if (read.ok) signingRequest = read.request;
  }
  return NextResponse.json({ batch, signingRequest }, { headers: NO_STORE });
}
