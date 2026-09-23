import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { readJsonBody } from '@/lib/server/http';
import { RATE_LIMITS, enforceRateLimit } from '@/lib/server/rate-limit';
import { stepUpContext, stepUpResult } from '@/lib/server/step-up-http';
import { approveByClick } from '@/lib/server/step-up';

export const dynamic = 'force-dynamic';

/**
 * Click style: an approver clicks Approve. Payments only — in click style a
 * settings save is its own confirmation. A second person is required when
 * dual approval is on and the amount reaches the approval threshold.
 */
export async function POST(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;
  const limited = await enforceRateLimit({ rule: RATE_LIMITS.stepUpVerifyUser, key: auth.session.email });
  if (limited) return limited;

  const resolved = await stepUpContext(auth.session, await readJsonBody(request), 'step-up/approve');
  if ('response' in resolved) return resolved.response;
  const { ctx } = resolved;
  if (ctx.purpose !== 'STABLECOIN_TRANSFER') {
    return stepUpResult({ ok: false, status: 400, code: 'not_clickable', error: 'Only wallet transfers are approved by click.' });
  }
  return stepUpResult(await approveByClick(ctx.deps, {
    orgId: ctx.orgId,
    style: ctx.style,
    userId: ctx.userId,
    dbRole: ctx.dbRole,
    requesterUserId: ctx.requesterUserId,
    requireSecondPerson: ctx.settings.requireDualApproval && ctx.amountUsd >= ctx.settings.approvalThresholdUsd,
    purpose: ctx.purpose,
    subjectId: ctx.subject.subjectId,
    subject: ctx.subject.subject,
    summary: ctx.subject.summary,
  }));
}
