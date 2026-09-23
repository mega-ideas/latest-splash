import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { readJsonBody } from '@/lib/server/http';
import { RATE_LIMITS, enforceRateLimit } from '@/lib/server/rate-limit';
import { approverContext, stepUpResult } from '@/lib/server/step-up-http';
import { confirmStepUpPasskey } from '@/lib/server/step-up';

export const dynamic = 'force-dynamic';

/** WhatsApp style, step 3: the approver's passkey signs the approval. */
export async function POST(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;
  const limited = await enforceRateLimit({ rule: RATE_LIMITS.stepUpVerifyUser, key: auth.session.email });
  if (limited) return limited;

  const body = await readJsonBody(request);
  const resolved = await approverContext(auth.session, body, 'step-up/passkey');
  if ('response' in resolved) return resolved.response;
  const { ctx } = resolved;
  return stepUpResult(await confirmStepUpPasskey(ctx.deps, {
    orgId: ctx.orgId,
    userId: ctx.userId,
    approvalId: String(body.approvalId ?? ''),
    signature: String(body.signature ?? ''),
  }));
}
