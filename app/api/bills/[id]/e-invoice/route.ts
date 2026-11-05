import { NextResponse } from 'next/server';

import { readJsonBody } from '@/lib/server/http';
import { answerSafely, handleBillEInvoice, readBillEInvoice } from '@/lib/server/bills';
import { liveBillDeps } from '@/lib/server/bills-deps';
import { NO_STORE, answer, billCaller, billsDb } from '@/lib/server/bills-route';

export const dynamic = 'force-dynamic';

/**
 * GET   the self-billed e-invoice made for a paid invoice; ?download=1 as a file.
 * POST  make it (once): a paid invoice from a supplier outside Malaysia, with
 *       the business's TIN, contact number, state, what was bought and, for a
 *       currency other than MYR, the exchange rate. Made already, it answers
 *       with the same file; `refresh` remakes one older than 72 hours.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await billCaller(request);
  if (gate.response) return gate.response;
  const store = await billsDb();
  if (store.response) return store.response;
  const { id } = await params;
  const result = await answerSafely(gate.caller.orgId, async () => readBillEInvoice(store.db, gate.caller, id));
  if (result.status !== 200 || new URL(request.url).searchParams.get('download') !== '1') return answer(result);
  const file = result.body.eInvoice as { fileName: string; document: unknown };
  return new NextResponse(JSON.stringify(file.document, null, 2), {
    status: 200,
    headers: {
      ...NO_STORE,
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${file.fileName.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
    },
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await billCaller(request);
  if (gate.response) return gate.response;
  const store = await billsDb();
  if (store.response) return store.response;
  const { id } = await params;
  const body = await readJsonBody(request);
  return answer(await answerSafely(gate.caller.orgId, async () => handleBillEInvoice(store.db, gate.caller, id, body, liveBillDeps(store.db))));
}
