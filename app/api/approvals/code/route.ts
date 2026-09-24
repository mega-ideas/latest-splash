import { NextResponse } from 'next/server';
import { z } from 'zod';

import { resolveAuthorityForSession, UnauthorizedError } from '@/lib/auth/authority';
import { assertCleanBody, ProvenanceViolationError, provenanceViolationResponse } from '@/lib/auth/provenance-guard';
import { applyDecision } from '@/lib/server/approval-requests';
import { findTokenByCode } from '@/lib/server/approval-tokens';
import { refuseFromBallot, settleFullyApprovedProposal } from '@/lib/server/approval-settle';
import { resolveApproverById } from '@/lib/server/approver-channels';
import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { readJsonBody } from '@/lib/server/http';

/**
 * Approving with a one-time code, typed into Splash.
 *
 * This is the default channel, and it is the stronger of the two for one
 * reason: it needs the phone AND a live authenticated session with an approver
 * role. A stolen handset alone releases nothing, because the code has nowhere
 * to go without a session.
 *
 * Reply-by-WhatsApp authenticates a handset. This authenticates a handset and a
 * person, and the person is the one recorded. It is also why this route, and
 * not the webhook, releases the payment when the last code completes the vote:
 * the replay of the money route runs as this session.
 *
 * The code is scoped to the SESSION's user — it is not a bearer secret. Reading
 * somebody else's code off their screen achieves nothing here, because the
 * lookup is `(this user, this code)` and a code belonging to another approver
 * simply does not exist for the caller.
 */
export const dynamic = 'force-dynamic';

const schema = z.object({
  code: z.string().trim().min(4).max(12),
  decision: z.enum(['APPROVE', 'REJECT']).default('APPROVE'),
});

export async function POST(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;

  const body = await readJsonBody(request);
  try {
    assertCleanBody(body, 'approvals/code');
  } catch (error) {
    if (error instanceof ProvenanceViolationError) return provenanceViolationResponse(error);
    throw error;
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Enter the code from your approval message.' }, { status: 400 });
  }

  let ctx;
  try {
    ctx = await resolveAuthorityForSession(auth.session);
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json(
        { error: 'This account has no workspace membership yet.', code: 'no_membership' },
        { status: 403 },
      );
    }
    throw error;
  }

  const now = new Date();
  // Scoped to this user. A code belonging to another approver does not resolve.
  const lookup = await findTokenByCode(ctx.userId, parsed.data.code, now);
  if (!lookup.ok) {
    return NextResponse.json({ error: lookup.reason }, { status: 400 });
  }

  // The role that counts is the one this person holds in the org the payment
  // belongs to, read from that membership row. Never `ctx.role` mapped back to
  // a membership name: that table had no FINANCE_ADMIN, so a finance admin fell
  // through to viewer, and `ctx.role` is the role in whichever workspace the
  // session resolved to.
  const eligible = await resolveApproverById(ctx.userId, lookup.token.orgId);
  if (!eligible.ok) {
    return NextResponse.json(
      { error: 'Your role cannot approve payments.', code: 'not_an_approver' },
      { status: 403 },
    );
  }

  const result = await applyDecision({
    tokenId: lookup.token.id,
    proposalId: lookup.token.proposalId,
    approver: eligible.approver,
    decision: parsed.data.decision,
    now,
  });

  if (!result.ok) return NextResponse.json({ error: result.message }, { status: 409 });

  // One refusal ends it: the proposal is closed too, so no other path can
  // release what a ballot refused.
  if (result.tally.refused) {
    const refusal = await refuseFromBallot(lookup.token.proposalId);
    return NextResponse.json({
      ok: true,
      decision: result.decision,
      tally: result.tally,
      settled: false,
      message: refusal.message,
    });
  }

  // The same walk a WhatsApp reply and an in-app approval take. This request
  // carries a session, so the approver who completed the vote is the one who
  // releases the payment, if they may: an approver in the payment's own org,
  // not its maker, signed in to that org.
  if (result.tally.unanimous) {
    const outcome = await settleFullyApprovedProposal(lookup.token.proposalId, {
      channel: 'code',
      releaser: {
        userId: ctx.userId,
        sessionOrgId: ctx.orgId,
        cookie: request.headers.get('cookie') ?? '',
        origin: new URL(request.url).origin,
      },
    });
    return NextResponse.json({
      ok: true,
      decision: result.decision,
      tally: result.tally,
      settled: outcome.settled,
      stage: outcome.stage,
      message: outcome.message,
    });
  }

  return NextResponse.json({
    ok: true,
    decision: result.decision,
    tally: result.tally,
    settled: false,
    message: result.message,
  });
}
