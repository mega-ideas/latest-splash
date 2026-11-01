import { limitResponse, limitsRoute } from '@/lib/server/limits-route';
import { readLimitsView } from '@/lib/server/business-limits';

export const dynamic = 'force-dynamic';

/**
 * The business's limits on automatic payments (Settings, Limits): each limit
 * in plain words with its current figure, why it is that figure, the most
 * Splash will grant, and any request for a higher one.
 *
 * Owners and the Finance lead see it; the Finance lead sees but cannot ask
 * (`canAsk` is false). Anyone else is refused. The business is the session's.
 */
export async function GET(request: Request) {
  const gate = await limitsRoute(request);
  if (gate.response) return gate.response;
  const result = await readLimitsView(gate.route.db, { orgId: gate.route.orgId, userId: gate.route.authority.userId });
  return limitResponse(result.ok ? { ok: true as const, ...result.view } : result);
}
