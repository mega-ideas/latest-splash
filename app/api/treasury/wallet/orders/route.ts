import { readJsonBody } from '@/lib/server/http';
import { RATE_LIMITS, enforceRateLimit } from '@/lib/server/rate-limit';
import { liveQuoteDeps } from '@/lib/server/treasury-deps';
import { resolveTreasurySwapRoute } from '@/lib/server/treasury-providers';
import { answer, treasuryCaller, treasuryDb } from '@/lib/server/treasury-route';
import { handleTreasuryOrder } from '@/lib/server/treasury-wallet';
import { listTreasuryOrders, orderView } from '@/lib/server/treasury-wallet-orders';

export const dynamic = 'force-dynamic';

/**
 * GET   this org's treasury orders, newest first.
 * POST  { intentId, direction, amount, minOutMinor }: hand a swap or a
 *       redemption from the business wallet to its signers. The intent id is
 *       the idempotency key (unique per org). Without a swap route on this
 *       server (TREASURY_WALLET_SWAPS off, or production, which has no live
 *       route in this build) it refuses and records nothing.
 */
export async function GET(request: Request) {
  const gate = await treasuryCaller(request);
  if (gate.response) return gate.response;
  const store = await treasuryDb();
  if (store.response) return store.response;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const orders = await listTreasuryOrders(store.db as any, gate.caller.orgId);
  return answer({ status: 200, body: { orders: orders.map(orderView) } });
}

export async function POST(request: Request) {
  const gate = await treasuryCaller(request);
  if (gate.response) return gate.response;
  const limited = await enforceRateLimit({ rule: RATE_LIMITS.treasuryQuoteUser, key: gate.session.email });
  if (limited) return limited;
  const store = await treasuryDb();
  if (store.response) return store.response;
  return answer(await handleTreasuryOrder(store.db, gate.caller, await readJsonBody(request), {
    ...liveQuoteDeps(),
    resolveRoute: () => resolveTreasurySwapRoute(),
  }));
}
