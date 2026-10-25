import { handleBillPay } from '@/lib/server/bills';
import { liveBillDeps } from '@/lib/server/bills-deps';
import { answer, billCaller, billsDb } from '@/lib/server/bills-route';

export const dynamic = 'force-dynamic';

/**
 * POST  send a scheduled invoice for approval: hand it to the payment flow
 *       (lib/bills/payment-hook.ts), keyed by the invoice id. Sent already,
 *       it answers with the same intent. Without the payment flow on this
 *       server it answers 501 PAYMENT_FLOW_NOT_WIRED and changes nothing.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await billCaller(request);
  if (gate.response) return gate.response;
  const store = await billsDb();
  if (store.response) return store.response;
  const { id } = await params;
  return answer(await handleBillPay(store.db, gate.caller, id, liveBillDeps(store.db)));
}
