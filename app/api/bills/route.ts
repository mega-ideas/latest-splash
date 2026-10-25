import { readJsonBody } from '@/lib/server/http';
import { RATE_LIMITS, enforceRateLimit } from '@/lib/server/rate-limit';
import { handleBillIntake, handleBillList } from '@/lib/server/bills';
import { liveBillDeps } from '@/lib/server/bills-deps';
import { answer, billCaller, billsDb } from '@/lib/server/bills-route';

export const dynamic = 'force-dynamic';

/**
 * GET   this org's supplier invoices, newest first, with where each one is.
 * POST  { intakeKey, documentName?, text? | pdfBase64? }: bring one in.
 *       Zeke and the parser read it; nothing is paid or scheduled. The intake
 *       key is the idempotency key (unique per org), and the same document
 *       twice returns the invoice already on file.
 */
export async function GET(request: Request) {
  const gate = await billCaller(request);
  if (gate.response) return gate.response;
  const store = await billsDb();
  if (store.response) return store.response;
  return answer(await handleBillList(store.db, gate.caller, liveBillDeps(store.db)));
}

export async function POST(request: Request) {
  const gate = await billCaller(request);
  if (gate.response) return gate.response;
  // Each intake can feed a document to the model: bounded per user.
  const limited = await enforceRateLimit({ rule: RATE_LIMITS.extractInvoiceUser, key: gate.session.email });
  if (limited) return limited;
  const store = await billsDb();
  if (store.response) return store.response;
  return answer(await handleBillIntake(store.db, gate.caller, await readJsonBody(request), liveBillDeps(store.db)));
}
