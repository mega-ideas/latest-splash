import { NextResponse } from 'next/server';

import { getTransfer, getTransferByRef } from '@/lib/server/wallet-transfers';
import { transferRoute } from '@/lib/server/wallet-transfers-deps';
import { NO_STORE, requirePayoutReader } from '@/lib/server/wallet-route';
import { readRequestForSigner } from '@/lib/server/wallet-signing';

export const dynamic = 'force-dynamic';

/**
 * One payment started from Transfer, by its id, its signing request or its
 * payment reference: where it is (waiting for signatures, asked of the owners,
 * on its way, settled, failed) and, to a signer or the person who asked, the
 * signing request itself. This business's only: another's reads as absent.
 */
export async function GET(request: Request, { params }: { params: Promise<{ ref: string }> }) {
  const gate = await transferRoute(request);
  if (gate.response) return gate.response;
  const reader = requirePayoutReader(gate.route);
  if (reader) return reader;
  const { ref } = await params;
  const row = await getTransferByRef(gate.deps, ref);
  const transfer = row ? await getTransfer(gate.deps, row.id) : null;
  if (!transfer) return NextResponse.json({ error: 'No such payment.' }, { status: 404, headers: NO_STORE });
  let signingRequest = null;
  if (transfer.signingRequestId) {
    const read = await readRequestForSigner(gate.route.ctx.signing, { orgId: gate.route.orgId, userId: gate.route.authority.userId, id: transfer.signingRequestId });
    if (read.ok) signingRequest = read.request;
  }
  return NextResponse.json({ transfer, signingRequest }, { headers: NO_STORE });
}
