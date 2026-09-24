/**
 * Who is asking to move money: a signed-in person, or an approval being
 * carried out.
 *
 * The two money routes used to ask `requireCustomerRequest` alone. That was
 * right for a person and wrong for a replay, which has no person: an approved
 * payment carried out from a WhatsApp reply arrives with no session at all, so
 * every one answered 401 (approval-replay-identity.ts has the whole history).
 *
 * So there are two answers, and nothing a client sends chooses between them:
 *
 *   a request the replay built carries a replay identity bound to that exact
 *   object — its participants are re-verified against the membership table,
 *   in the proposal's org, before the route sees it;
 *
 *   every other request is a customer request, with its session, its origin
 *   check and its idle clock, exactly as before.
 *
 * What a replay is then ALLOWED to skip is decided in the route, by a claim
 * the route verifies against the proposal store and the payment in the body
 * (approved-proposal.ts). Establishing the identity lifts nothing on its own.
 */
import 'server-only';

import type { CustomerSession } from '@/lib/auth/customer-session';
import {
  approvalReplayOf,
  checkReplayParticipants,
  type ApprovalReplayIdentity,
  type ParticipantVerdict,
} from '@/lib/server/approval-replay-identity';
import { requireCustomerRequest } from '@/lib/server/customer-auth';

export type PaymentRequestAuth =
  | { session: CustomerSession; replay: null; response: null }
  | { session: null; replay: ApprovalReplayIdentity; response: null }
  | { session: null; replay: null; response: Response };

export async function requirePaymentRequest(request: Request): Promise<PaymentRequestAuth> {
  const replay = approvalReplayOf(request);
  if (!replay) {
    const auth = await requireCustomerRequest(request);
    return auth.response
      ? { session: null, replay: null, response: auth.response }
      : { session: auth.session, replay: null, response: null };
  }

  const verdict = await verifyParticipants(replay);
  if (!verdict.ok) {
    console.warn('[approval-replay] refused', {
      proposalId: replay.proposalId,
      channel: replay.channel,
      reason: verdict.reason,
    });
    return {
      session: null,
      replay: null,
      response: Response.json(
        {
          error: `This approval can no longer release money: ${verdict.reason}. Nothing was sent.`,
          code: 'approval_replay_refused',
        },
        { status: 403 },
      ),
    };
  }
  return { session: null, replay, response: null };
}

async function verifyParticipants(replay: ApprovalReplayIdentity): Promise<ParticipantVerdict> {
  // No database, no membership to read — the same fail-closed answer
  // `resolveAuthorityForSession` gives a session in that state.
  if (!process.env.DATABASE_URL) {
    return { ok: false, reason: 'no database is configured, so no membership can be read' };
  }
  try {
    const { getDb } = await import('@/lib/db/client');
    return await checkReplayParticipants(getDb() as never, replay);
  } catch (error) {
    console.error('[approval-replay] could not verify the approvers', error);
    return { ok: false, reason: 'the approvers could not be verified' };
  }
}
