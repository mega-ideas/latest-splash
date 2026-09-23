import { NextResponse } from 'next/server';
import { z } from 'zod';

import { resolveAuthorityForSession, UnauthorizedError } from '@/lib/auth/authority';
import { assertCleanBody, ProvenanceViolationError, provenanceViolationResponse } from '@/lib/auth/provenance-guard';
import { canApprove, type MembershipRole } from '@/lib/membership-roles';
import { applyDecision } from '@/lib/server/approval-requests';
import { findTokenByCode } from '@/lib/server/approval-tokens';
import { settleFullyApprovedProposal } from '@/lib/server/approval-settle';
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
 * person, and the person is the one recorded.
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

  const dbRole = ({ OWNER: 'admin', APPROVER: 'checker', MAKER: 'maker' } as Record<string, MembershipRole>)[
    ctx.role
  ] ?? 'viewer';
  if (!canApprove(dbRole)) {
    return NextResponse.json(
      { error: 'Your role cannot approve payments.', code: 'not_an_approver' },
      { status: 403 },
    );
  }

  const now = new Date();
  // Scoped to this user. A code belonging to another approver does not resolve.
  const lookup = await findTokenByCode(ctx.userId, parsed.data.code, now);
  if (!lookup.ok) {
    return NextResponse.json({ error: lookup.reason }, { status: 400 });
  }

  const result = await applyDecision({
    tokenId: lookup.token.id,
    proposalId: lookup.token.proposalId,
    approver: {
      userId: ctx.userId,
      email: auth.session.email,
      name: null,
      role: dbRole,
      whatsappE164: null,
    },
    decision: parsed.data.decision,
    now,
  });

  if (!result.ok) return NextResponse.json({ error: result.message }, { status: 409 });

  // The same settlement path a WhatsApp reply reaches. The channel decided how
  // the question was asked; it does not decide what an approval is worth.
  if (result.tally.unanimous) {
    const outcome = await settleFullyApprovedProposal(lookup.token.proposalId);
    return NextResponse.json({
      ok: true,
      decision: result.decision,
      tally: result.tally,
      settled: outcome.settled,
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
