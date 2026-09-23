import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { approverContext, stepUpResult } from '@/lib/server/step-up-http';
import { listPendingApprovals } from '@/lib/server/step-up';

export const dynamic = 'force-dynamic';

/** WhatsApp codes sent to me that I have not finished approving. */
export async function GET(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;
  const resolved = await approverContext(auth.session, {}, 'step-up/pending');
  if ('response' in resolved) return resolved.response;
  const { ctx } = resolved;
  return stepUpResult({ ok: true, approvals: await listPendingApprovals(ctx.deps.db, { orgId: ctx.orgId, userId: ctx.userId }) });
}
