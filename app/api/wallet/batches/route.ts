import { NextResponse } from 'next/server';

import { sheetRowsFromBody } from '@/lib/batch/sheet';
import { readJsonBody } from '@/lib/server/http';
import { requireTermsAccepted } from '@/lib/server/onboarding';
import { createBatch, listBatches } from '@/lib/server/wallet-batches';
import { batchRefusal, withFeeGuard } from '@/lib/server/wallet-batches-route';
import { batchRoute } from '@/lib/server/wallet-transfers-deps';
import { limitWalletRequests, NO_STORE, requirePayoutReader } from '@/lib/server/wallet-route';

export const dynamic = 'force-dynamic';

/**
 * Batch payouts (v2 brief 5.6): up to 20 payments in one transaction the
 * owners sign once. The business is the session's.
 *
 * GET   this business's batches, newest first.
 * POST  { rows: [{ recipient, amount, reference }], maxFeeMinor, label? } with
 *       an Idempotency-Key header (or `clientKey`): the batch's intent id.
 *       `maxFeeMinor` is the total Splash fee the person was shown (from
 *       POST /api/wallet/batches/review), and `confirmDuplicates` / `confirmNewPayees`
 *       are true only when the person confirmed the repeats and the payees found
 *       by name that the review showed. A retry under the same key is answered
 *       from the stored batch. The rows are checked again here; a
 *       sheet can name only a recipient this business saved. An owner's batch
 *       becomes one signing request for the owners; a team member's waits for
 *       an owner to start the signatures.
 */
export async function GET(request: Request) {
  const gate = await batchRoute(request);
  if (gate.response) return gate.response;
  const reader = requirePayoutReader(gate.route);
  if (reader) return reader;
  return NextResponse.json({ batches: await listBatches(gate.deps) }, { headers: NO_STORE });
}

export async function POST(request: Request) {
  const gate = await batchRoute(request);
  if (gate.response) return gate.response;
  const termsGate = await requireTermsAccepted(gate.route.orgId);
  if (termsGate) return termsGate;
  const limited = await limitWalletRequests(gate.route);
  if (limited) return limited;
  const body = await readJsonBody(request);
  return withFeeGuard(async () => {
    const result = await createBatch(
      gate.deps,
      { userId: gate.route.authority.userId, role: gate.route.authority.role },
      {
        clientKey: request.headers.get('idempotency-key') ?? body.clientKey,
        rows: sheetRowsFromBody(body.rows),
        maxFeeMinor: body.maxFeeMinor,
        label: body.label,
        confirmDuplicates: body.confirmDuplicates === true,
        confirmNewPayees: body.confirmNewPayees === true,
      },
    );
    if (!result.ok) return batchRefusal(result);
    return NextResponse.json({ batch: result.batch, signingRequest: result.signingRequest ?? null, created: result.created }, { status: result.created ? 201 : 200, headers: NO_STORE });
  });
}
