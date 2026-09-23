/**
 * WhatsApp, through Twilio.
 *
 * Two jobs: send an approval request to an approver's own number, and prove
 * that an inbound reply genuinely came from Twilio.
 *
 * ─── The signature check is the whole security story of the inbound half ────
 *
 * Twilio POSTs replies to a public URL. Without verifying `X-Twilio-Signature`,
 * anyone who learns that URL can POST a form body claiming to be an approver's
 * number and release a payment. There is no other authentication on a webhook —
 * the URL is not a secret, it appears in the Twilio console and in logs.
 *
 * So the verification is not defence in depth here. It is the only defence, and
 * a missing auth token means we refuse the request rather than fall back to
 * trusting it.
 *
 * ─── A number is not an identity ────────────────────────────────────────────
 *
 * This module resolves nothing about who a person is. It reports which number
 * a message came from, and `lib/server/approver-channels.ts` decides whether
 * that number belongs to a user allowed to approve. WhatsApp authenticates a
 * handset; only the channel binding turns that into a person.
 */
import 'server-only';

import { createHmac, timingSafeEqual } from 'node:crypto';

export type WhatsAppSendResult =
  | { sent: true; providerRef: string }
  | { sent: false; reason: string };

function config(env: NodeJS.ProcessEnv = process.env) {
  return {
    accountSid: (env.TWILIO_ACCOUNT_SID ?? '').trim(),
    authToken: (env.TWILIO_AUTH_TOKEN ?? '').trim(),
    from: (env.TWILIO_WHATSAPP_FROM ?? '').trim(),
  };
}

export function whatsappConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const { accountSid, authToken, from } = config(env);
  return accountSid.length > 0 && authToken.length > 0 && from.length > 0;
}

/**
 * E.164, or null.
 *
 * Stored and compared in one shape only. `+60 10-265 1678`, `010 265 1678` and
 * `+60102651678` are one number to a person and three strings to a database —
 * and a lookup that misses silently means an approval request that goes
 * nowhere, or worse, a reply that matches nobody and is discarded.
 */
export function normaliseE164(input: string | null | undefined): string | null {
  const raw = (input ?? '').trim();
  if (raw.length === 0) return null;
  const digits = raw.replace(/[^\d+]/g, '');
  const withPlus = digits.startsWith('+') ? digits : `+${digits}`;
  // E.164: a leading +, a country code that cannot start with 0, and at most
  // fifteen digits in total.
  return /^\+[1-9]\d{7,14}$/.test(withPlus) ? withPlus : null;
}

/** Twilio addresses WhatsApp endpoints as `whatsapp:+E164`. */
const channelAddress = (e164: string) => `whatsapp:${e164}`;

/**
 * Send one message.
 *
 * With no credentials this logs and reports `sent: false` rather than
 * throwing. An approval request that could not be delivered must not take down
 * the payment path that raised it — the proposal still exists, the queue still
 * shows it, and an approver can still act in the app. Silence on WhatsApp is a
 * degraded channel, not a failed payment.
 */
export async function sendWhatsApp(
  to: string,
  body: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<WhatsAppSendResult> {
  const e164 = normaliseE164(to);
  if (!e164) return { sent: false, reason: 'not a valid E.164 number' };

  const { accountSid, authToken, from } = config(env);
  if (!whatsappConfigured(env)) {
    console.info(
      '[whatsapp] not configured — would have sent to %s: %s',
      e164,
      body.slice(0, 120),
    );
    return { sent: false, reason: 'TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_WHATSAPP_FROM are not all set' };
  }

  try {
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          To: channelAddress(e164),
          From: channelAddress(normaliseE164(from) ?? from),
          Body: body,
        }),
      },
    );
    const payload = (await response.json()) as { sid?: string; message?: string };
    if (!response.ok) {
      return { sent: false, reason: payload.message ?? `Twilio returned ${response.status}` };
    }
    return { sent: true, providerRef: payload.sid ?? 'unknown' };
  } catch (error) {
    return { sent: false, reason: error instanceof Error ? error.message : 'send failed' };
  }
}

/**
 * Is this really Twilio?
 *
 * Twilio signs `url + sorted(key + value for each POST field)` with the account
 * auth token, HMAC-SHA1, base64. Recomputing it is the only way to know a
 * webhook body was not written by whoever guessed the URL.
 *
 * Returns false when unconfigured. An unverifiable request is not a trusted
 * one, and "we could not check" must never read as "it is fine".
 */
export function verifyTwilioSignature(input: {
  url: string;
  params: Record<string, string>;
  signature: string | null;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const { authToken } = config(input.env ?? process.env);
  if (!authToken || !input.signature) return false;

  const data = Object.keys(input.params)
    .sort()
    .reduce((acc, key) => acc + key + input.params[key], input.url);

  const expected = createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');

  const a = Buffer.from(expected);
  const b = Buffer.from(input.signature);
  // Length check first: timingSafeEqual throws on a mismatch, and the length of
  // a base64 SHA-1 is fixed anyway, so this leaks nothing.
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * What an inbound reply means.
 *
 * Deliberately strict. "yes", "ok", "sure" are not accepted: a person replying
 * conversationally to a payment request must not release money by accident, and
 * an ambiguous message is better answered with a prompt than guessed at.
 *
 * Rejection is looser than approval on purpose — "no" and "stop" both stop the
 * payment. The asymmetry is the safe direction: over-reading a refusal costs a
 * re-send, over-reading an approval costs the money.
 */
export type ReplyIntent = 'APPROVE' | 'REJECT' | 'UNKNOWN';

export function readReplyIntent(body: string): ReplyIntent {
  const text = body.trim().toUpperCase();
  if (/^(APPROVE|APPROVED)\b/.test(text)) return 'APPROVE';
  if (/^(REJECT|REJECTED|DENY|DENIED|NO|STOP|CANCEL)\b/.test(text)) return 'REJECT';
  return 'UNKNOWN';
}
