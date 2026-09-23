import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { readJsonBody } from '@/lib/server/http';
import { RATE_LIMITS, enforceRateLimit } from '@/lib/server/rate-limit';
import { stepUpContext, stepUpResult } from '@/lib/server/step-up-http';
import { requestStepUp } from '@/lib/server/step-up';

export const dynamic = 'force-dynamic';

/** WhatsApp style: send the approver a code for exactly this subject. */
export async function POST(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;
  const limited = await enforceRateLimit({ rule: RATE_LIMITS.stepUpRequestUser, key: auth.session.email });
  if (limited) return limited;

  const resolved = await stepUpContext(auth.session, await readJsonBody(request), 'step-up/request');
  if ('response' in resolved) return resolved.response;
  const { ctx } = resolved;
  if (ctx.dbRole === 'viewer') {
    return stepUpResult({ ok: false, status: 403, code: 'viewer', error: 'Your role cannot ask for approvals.' });
  }
  return stepUpResult(await requestStepUp(ctx.deps, {
    orgId: ctx.orgId,
    style: ctx.style,
    requesterUserId: ctx.requesterUserId,
    requesterName: ctx.userName,
    purpose: ctx.purpose,
    subjectId: ctx.subject.subjectId,
    subject: ctx.subject.subject,
    label: ctx.subject.label,
    summary: ctx.subject.summary,
  }), 201);
}
