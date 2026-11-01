import { NextResponse } from 'next/server';

import { assertCleanBody, ProvenanceViolationError, provenanceViolationResponse } from '@/lib/auth/provenance-guard';
import { INGEST_LIMITS, type IngestInput } from '@/lib/batch/ingest';
import { readCappedText } from '@/lib/server/capped-body';
import { requireTermsAccepted } from '@/lib/server/onboarding';
import { liveColumnMapper } from '@/lib/server/sheet-columns-deps';
import { readSheetForZeke, readSheetRows } from '@/lib/server/zeke-batch-sheet';
import { withFeeGuard } from '@/lib/server/wallet-batches-route';
import { batchRoute } from '@/lib/server/wallet-transfers-deps';
import { limitWalletRequests, NO_STORE, requireWithdrawalRequester } from '@/lib/server/wallet-route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** A 256 KB spreadsheet as base64 is a third larger; the rest is the envelope. */
const BODY_CAP = Math.ceil((INGEST_LIMITS.maxBytes * 4) / 3) + 4096;

const refuse = (status: number, error: string, code: string) => NextResponse.json({ error, code }, { status, headers: NO_STORE });

/**
 * A payout sheet, read by the server. The business is the session's; nothing
 * about it is taken from the body, and a body that names one is refused.
 *
 *   { kind: 'text', text, name? }      a CSV file's text, or rows pasted from a spreadsheet
 *   { kind: 'xlsx', base64, name? }    a spreadsheet
 *   review: false                      the rows only, for Batch payouts (its next step reviews them)
 *
 * The answer is a card Zeke shows: every row, what is wrong with it, the
 * wallet's shortfall, and the rows exactly as the wallet batch flow takes them
 * (POST /api/wallet/batches, whose own review runs again at that step). Nothing
 * is stored, signed or asked of anyone here. The file is data: see
 * lib/batch/ingest.ts. The model, when one is configured, sees header names only.
 */
export async function POST(request: Request) {
  const gate = await batchRoute(request);
  if (gate.response) return gate.response;
  const termsGate = await requireTermsAccepted(gate.route.orgId);
  if (termsGate) return termsGate;
  const asker = requireWithdrawalRequester(gate.route);
  if (asker) return asker;
  const limited = await limitWalletRequests(gate.route);
  if (limited) return limited;

  const raw = await readCappedText(request, BODY_CAP);
  if (!raw.ok) return refuse(413, 'That file is too large to be a batch. A batch is at most 20 payments.', 'too_large');
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw.text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    body = parsed as Record<string, unknown>;
  } catch {
    return refuse(400, 'The sheet could not be read from that request.', 'bad_request');
  }
  try {
    assertCleanBody(body, 'batch-sheet');
  } catch (error) {
    if (error instanceof ProvenanceViolationError) return provenanceViolationResponse(error);
    throw error;
  }

  const name = typeof body.name === 'string' ? body.name : undefined;
  let input: IngestInput;
  if (body.kind === 'xlsx') {
    const base64 = typeof body.base64 === 'string' ? body.base64 : '';
    if (!/^[A-Za-z0-9+/=\s]*$/.test(base64)) return refuse(400, 'The sheet could not be read from that request.', 'bad_request');
    input = { kind: 'xlsx', name, bytes: new Uint8Array(Buffer.from(base64, 'base64')) };
  } else if (body.kind === 'text' && typeof body.text === 'string') {
    input = { kind: 'text', name, text: body.text };
  } else {
    return refuse(400, 'Send the sheet as text or as an .xlsx file.', 'bad_request');
  }

  const actor = { userId: gate.route.authority.userId, role: gate.route.authority.role };
  const mapColumns = liveColumnMapper();
  return withFeeGuard(async () => {
    if (body.review === false) {
      const rows = await readSheetRows(actor, input, { mapColumns });
      if (!rows.ok) return refuse(rows.status, rows.error, rows.code);
      const { ok, ...rest } = rows;
      void ok;
      return NextResponse.json(rest, { headers: NO_STORE });
    }
    const result = await readSheetForZeke(gate.deps, actor, input, { source: body.source === 'pasted' ? 'pasted' : 'file', fileName: name ?? null, mapColumns });
    if (!result.ok) return refuse(result.status, result.error, result.code);
    return NextResponse.json({ card: result.card }, { headers: NO_STORE });
  });
}
