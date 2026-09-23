import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { readJsonBody } from '@/lib/server/http';
import { RATE_LIMITS, enforceRateLimit } from '@/lib/server/rate-limit';
import { approverContext, stepUpResult } from '@/lib/server/step-up-http';
import { verifyStepUpCode } from '@/lib/server/step-up';

export const dynamic = 'force-dynamic';

/** WhatsApp style, step 2: the code, typed by the person it was sent to. */
export async function POST(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;
  const limited = await enforceRateLimit({ rule: RATE_LIMITS.stepUpVerifyUser, key: auth.session.email });
  if (limited) return limited;

  const body = await readJsonBody(request);
  const resolved = await approverContext(auth.session, body, 'step-up/verify');
  if ('response' in resolved) return resolved.response;
  const { ctx } = resolved;
  return stepUpResult(await verifyStepUpCode(ctx.deps, {
    orgId: ctx.orgId,
    userId: ctx.userId,
    approvalId: String(body.approvalId ?? ''),
    code: String(body.code ?? ''),
  }));
}
