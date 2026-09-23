import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { readJsonBody } from '@/lib/server/http';
import { RATE_LIMITS, enforceRateLimit } from '@/lib/server/rate-limit';
import { stepUpContext, stepUpResult } from '@/lib/server/step-up-http';
import { stepUpStatus } from '@/lib/server/step-up';

export const dynamic = 'force-dynamic';

/** Where an approval stands, and in which style this workspace approves. */
export async function POST(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;
  const limited = await enforceRateLimit({ rule: RATE_LIMITS.stepUpVerifyUser, key: auth.session.email });
  if (limited) return limited;

  const resolved = await stepUpContext(auth.session, await readJsonBody(request), 'step-up/status');
  if ('response' in resolved) return resolved.response;
  const { ctx } = resolved;
  const status = await stepUpStatus(ctx.deps.db, {
    orgId: ctx.orgId,
    purpose: ctx.purpose,
    subjectId: ctx.subject.subjectId,
    subject: ctx.subject.subject,
  });
  const secondPersonRequired = ctx.purpose === 'STABLECOIN_TRANSFER'
    && ctx.settings.requireDualApproval
    && ctx.amountUsd >= ctx.settings.approvalThresholdUsd;
  // Whose move it is, without handing the browser another person's user id.
  const { approverUserId, ...shown } = status as typeof status & { approverUserId?: string };
  return stepUpResult({
    ok: true,
    approverIsYou: approverUserId === ctx.userId,
    style: ctx.style,
    summary: ctx.subject.summary,
    youAreRequester: ctx.requesterUserId === ctx.userId,
    secondPersonRequired,
    // Click style: can THIS person press Approve? An admin or checker, and not
    // the one who asked when a second person is required.
    youCanApprove: ctx.style === 'CLICK'
      && (ctx.dbRole === 'admin' || ctx.dbRole === 'checker')
      && !(secondPersonRequired && ctx.requesterUserId === ctx.userId),
    ...shown,
  });
}
