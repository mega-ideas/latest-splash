import { askForHigherFromAnswers } from '@/lib/server/limit-start';
import { limitChanges, limitResponse, limitsRoute } from '@/lib/server/limits-route';

export const dynamic = 'force-dynamic';

/**
 * "Ask for higher limits": the owner asks Splash, in one tap, for the limits their answers worked out to beyond what the
 * business has. One request for each limit, on the ordinary request path (Splash reviews it; if approved it starts after a
 * 24 hour notice). Nothing is read from the request: the figures are the ones stored with the business's answers, and the
 * same answers asked twice ask once.
 *
 * POST {}  Owners only. The business and the person are the session's.
 */
export async function POST(request: Request) {
  const gate = await limitsRoute(request);
  if (gate.response) return gate.response;
  const limited = await limitChanges(gate.route);
  if (limited) return limited;
  const result = await askForHigherFromAnswers(gate.route.db, {
    orgId: gate.route.orgId,
    actorUserId: gate.route.authority.userId,
  });
  return limitResponse(result);
}
