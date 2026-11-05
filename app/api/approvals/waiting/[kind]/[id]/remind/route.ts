import { NextResponse } from 'next/server';

import { remindNow } from '@/lib/server/approval-wait';
import { RATE_LIMITS, enforceRateLimit } from '@/lib/server/rate-limit';
import { NO_STORE, teamRoute } from '@/lib/server/team-route';

export const dynamic = 'force-dynamic';

const ID = /^[A-Za-z0-9_-]{8,80}$/;

/**
 * "Remind them now" (v2 Phase 3, when nobody who can approve answers): the person who asked, or an owner, tells everyone
 * who can still approve a waiting request, in the app and by e-mail. Once per 10 minutes per request (429 `too_soon`
 * with `retryAfterSec`). `kind` is `signing` (a payment, batch, withdrawal or change the owners sign) or `ask` (a staff
 * payment the owners were asked to approve). The business and the person come from the session; a request of another
 * business, or one this person may not remind, reads as absent. It approves nothing: the reminder is words and a link
 * that signs nothing. Cancelling is the existing withdraw (DELETE /api/wallet/signing-requests/:id, POST
 * /api/wallet/approval-asks/:id { action: 'withdraw' }).
 */
export async function POST(request: Request, { params }: { params: Promise<{ kind: string; id: string }> }) {
  const gate = await teamRoute(request);
  if (gate.response) return gate.response;
  const { db, orgId, authority } = gate.route;
  const { kind, id } = await params;
  if ((kind !== 'signing' && kind !== 'ask') || !ID.test(id)) {
    return NextResponse.json({ error: 'There is no such request.', code: 'not_found' }, { status: 404, headers: NO_STORE });
  }
  const limited = await enforceRateLimit({ rule: RATE_LIMITS.approvalRemindUser, key: authority.userId, message: 'You have sent a lot of reminders. Try again in a little while.' });
  if (limited) return limited;
  const result = await remindNow(db, {}, { orgId, userId: authority.userId, kind, id });
  if (result.ok) return NextResponse.json({ ok: true, reminded: result.reminded, nextAt: result.nextAt }, { headers: NO_STORE });
  const headers: Record<string, string> = { ...NO_STORE };
  if (typeof result.retryAfterSec === 'number') headers['Retry-After'] = String(result.retryAfterSec);
  return NextResponse.json(
    { error: result.error, code: result.code, ...(typeof result.retryAfterSec === 'number' ? { retryAfterSec: result.retryAfterSec, nextAt: result.nextAt } : {}) },
    { status: result.status, headers },
  );
}
