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
  // resolved per candidate org rather than the number choosing an org. A live
  // token is found first, then the number is checked against THAT org.
  const { findApproverOrgsForNumber } = await import('@/lib/server/approver-lookup');
  const candidateOrgs = await findApproverOrgsForNumber(from);
  if (candidateOrgs.length === 0) {
    console.warn('[whatsapp] reply from a number bound to no approver');
    return twiml('This number is not registered to approve payments.');
  }

  for (const orgId of candidateOrgs) {
    const resolved = await resolveApproverByNumber(from, orgId);
    if (!resolved.ok) continue;

    const lookup = await findLiveTokenForUser(resolved.approver.userId, now);
    if (!lookup.ok) continue;

    const result = await applyDecision({
      tokenId: lookup.token.id,
      proposalId: lookup.token.proposalId,
      approver: resolved.approver,
      decision: intent,
      now,
    });

    if (!result.ok) return twiml(result.message);

    // A unanimous approval settles through the same path an in-app approval
    // does — this route decides nothing about money, it only records a vote.
    if (result.tally.unanimous) {
      const { settleFullyApprovedProposal } = await import('@/lib/server/approval-settle');
      const outcome = await settleFullyApprovedProposal(lookup.token.proposalId);
      return twiml(outcome.message);
    }

    return twiml(result.message);
  }

  return twiml('There is no payment waiting on your approval right now.');
}
