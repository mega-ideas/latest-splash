import { applyDecision } from '@/lib/server/approval-requests';
import { findLiveTokenForUser } from '@/lib/server/approval-tokens';
import { resolveApproverByNumber } from '@/lib/server/approver-channels';
import { readReplyIntent, verifyTwilioSignature } from '@/lib/server/whatsapp';

/**
 * Inbound WhatsApp replies from Twilio.
 *
 * ─── The signature check is not defence in depth. It is the defence. ────────
 *
 * This URL is public and is not a secret: it sits in the Twilio console, in
 * request logs, and in anyone's browser history who has opened the dashboard.
 * There is no session, no cookie and no API key on this route — a webhook has
 * none of those by construction.
 *
 * So `X-Twilio-Signature` is the only thing standing between this endpoint and
 * a stranger POSTing a form body that claims to be an approver's number.
 * Without it, releasing a payment would require knowing a URL.
 *
 * It is verified before the body is read for meaning, and an unverifiable
 * request is refused rather than trusted. "We could not check" must never
 * behave like "it is fine".
 *
 * ─── Why the reply is only ever half the story ──────────────────────────────
 *
 * A verified message proves Twilio delivered it and which number it came from.
 * It proves nothing about who was holding the phone. The number is resolved
 * against `approver_channels` — verified, bound to a user, and that user must
 * hold an approving role in the org the payment belongs to, re-checked now
 * rather than when the request went out.
 *
 * Under the unanimous rule this is what makes reply-approval defensible: a
 * stolen handset can refuse payments, which is noisy and reversible, and cannot
 * release one, because that needs every other approver's phone too.
 *
 * ─── A reply is a vote, never a release ─────────────────────────────────────
 *
 * Even a unanimous reply stops at APPROVED. Sending the payment replays the
 * money route, and that route runs as a signed-in person; this request has no
 * session and is not handed one (lib/server/approval-settle.ts says why). A
 * signed-in approver sends it: the one whose code completes the vote, or one
 * who releases it in the app.
 *
 * In `code` mode a reply can refuse and cannot approve. Approving there takes
 * the code typed into Splash, which is the handset AND a signed-in approver.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Twilio expects TwiML. A plain message is the whole reply the sender sees. */
function twiml(message: string): Response {
  const escaped = message
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escaped}</Message></Response>`,
    { status: 200, headers: { 'Content-Type': 'text/xml' } },
  );
}

export async function POST(request: Request) {
  const raw = await request.text();
  const params = Object.fromEntries(new URLSearchParams(raw)) as Record<string, string>;

  // Twilio signs the URL it was configured with. Behind a proxy the request URL
  // can differ from that, so the configured value wins when it is set.
  const url = (process.env.TWILIO_WEBHOOK_URL ?? '').trim() || request.url;

  if (
    !verifyTwilioSignature({
      url,
      params,
      signature: request.headers.get('x-twilio-signature'),
    })
  ) {
    // Deliberately terse and deliberately 403. A caller probing this endpoint
    // learns only that it refused.
    console.warn('[whatsapp] refused an unverified inbound webhook');
    return new Response('forbidden', { status: 403 });
  }

  const from = (params.From ?? '').replace(/^whatsapp:/, '');
  const body = params.Body ?? '';
  const intent = readReplyIntent(body);

  if (intent === 'UNKNOWN') {
    // Not guessed at. "yes" and "ok" are not accepted for a payment, and a
    // conversational reply must not release money by accident.
    return twiml('Reply APPROVE or REJECT to answer the payment request.');
  }

  const now = new Date();

  // The proposal decides which org the question belongs to, so the number is
  // resolved per candidate org rather than the number choosing an org: the
  // person's role is checked in each org, and only a ballot in THAT org counts.
  const { findApproverOrgsForNumber } = await import('@/lib/server/approver-lookup');
  const candidateOrgs = await findApproverOrgsForNumber(from);
  if (candidateOrgs.length === 0) {
    console.warn('[whatsapp] reply from a number bound to no approver');
    return twiml('This number is not registered to approve payments.');
  }

  for (const orgId of candidateOrgs) {
    const resolved = await resolveApproverByNumber(from, orgId);
    if (!resolved.ok) continue;

    // A ballot in THIS org only. The role was just checked here; a ballot in
    // another workspace would be answered on the strength of this one's.
    const lookup = await findLiveTokenForUser(resolved.approver.userId, now, { orgId });
    if (!lookup.ok) continue;

    // Asked for a code, so approving takes the code typed into Splash. A reply
    // can still stop the payment, which is what the message offers.
    if (intent === 'APPROVE' && lookup.token.channel !== 'reply') {
      return twiml('To approve, enter the code from your message in Splash. Reply REJECT to stop this payment.');
    }

    const result = await applyDecision({
      tokenId: lookup.token.id,
      proposalId: lookup.token.proposalId,
      approver: resolved.approver,
      decision: intent,
      now,
    });

    if (!result.ok) return twiml(result.message);

    const { refuseFromBallot, settleFullyApprovedProposal } = await import('@/lib/server/approval-settle');

    // One refusal ends it, on the proposal as well as in the tally.
    if (result.tally.refused) {
      return twiml((await refuseFromBallot(lookup.token.proposalId)).message);
    }

    // A unanimous vote walks the same path an in-app approval does: policy
    // re-evaluated, every ballot recorded. It records votes and decides nothing
    // about money: no releaser, so it stops at approved.
    if (result.tally.unanimous) {
      const outcome = await settleFullyApprovedProposal(lookup.token.proposalId, {
        channel: 'whatsapp',
        releaser: null,
      });
      return twiml(outcome.message);
    }

    return twiml(result.message);
  }

  return twiml('There is no payment waiting on your approval right now.');
}
