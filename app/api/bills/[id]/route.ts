import { readJsonBody } from '@/lib/server/http';
import { handleBillAction, handleBillRead } from '@/lib/server/bills';
import { liveBillDeps } from '@/lib/server/bills-deps';
import { answer, billCaller, billsDb } from '@/lib/server/bills-route';

export const dynamic = 'force-dynamic';

/**
 * GET    one of this org's supplier invoices, with the text it was read from.
 * PATCH  { action }: confirm the fields, acknowledge a possible duplicate,
 *        match a verified recipient, schedule (with the `revision` the page
 *        showed), take back to review, cancel.
 *        Another org's invoice is "not found".
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await billCaller(request);
  if (gate.response) return gate.response;
  const store = await billsDb();
  if (store.response) return store.response;
  const { id } = await params;
  return answer(await handleBillRead(store.db, gate.caller, id, liveBillDeps(store.db)));
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await billCaller(request);
  if (gate.response) return gate.response;
  const store = await billsDb();
  if (store.response) return store.response;
  const { id } = await params;
  return answer(await handleBillAction(store.db, gate.caller, id, await readJsonBody(request), liveBillDeps(store.db), { requireRevision: true }));
}
