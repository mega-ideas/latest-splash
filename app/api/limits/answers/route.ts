import { saveLimitAnswers } from '@/lib/server/limit-start';
import { readJsonBody } from '@/lib/server/http';
import { limitChanges, limitResponse, limitsRoute } from '@/lib/server/limits-route';

export const dynamic = 'force-dynamic';

/**
 * An owner tells Splash how the business will use it: three answers, in plain words. The answers are checked and saved
 * with the limits they work out to; a NEW business (no limits yet) is started at them, once, and a business that already
 * runs keeps its limits and is shown what a new business like it would start at.
 *
 * POST { monthlyUsdc, paymentsPerWeek, firstTransferUsdc }
 *      Owners only. The business and the person are the session's. A refused answer saves nothing and is said in
 *      words, per answer, without repeating what was typed. The same answers again are the same save.
 */
export async function POST(request: Request) {
  const gate = await limitsRoute(request);
  if (gate.response) return gate.response;
  const limited = await limitChanges(gate.route);
  if (limited) return limited;
  const body = await readJsonBody(request);
  const result = await saveLimitAnswers(gate.route.db, {
    orgId: gate.route.orgId,
    actorUserId: gate.route.authority.userId,
    answers: { monthlyUsdc: body.monthlyUsdc, paymentsPerWeek: body.paymentsPerWeek, firstTransferUsdc: body.firstTransferUsdc },
  });
  return limitResponse(result, result.ok && !result.replayed ? 201 : 200);
}
