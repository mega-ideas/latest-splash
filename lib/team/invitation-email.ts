/**
 * The email an invited person gets, and the words the owner reads about it
 * (v2 Phase 3, p3-invite-email).
 *
 * Pure and client-safe: it builds strings and decides nothing about sending.
 *
 * What the email is: a short notice that a named person invited them to a named
 * business, that it ends, and one link. What it is not: it carries no token,
 * no amount, no other business and no other person. The link is the app
 * address plus the invitation's id (lib/approve/link.ts); opening it asks the
 * person to sign in and accepts nothing, and signing in as anyone but the
 * invited email shows nothing of the invitation. So a forwarded email, or one
 * read over a shoulder, grants nothing.
 *
 * Every value inserted into it is cleaned to plain words (control characters
 * become spaces, so a name cannot add a header line or a paragraph; long names
 * are cut) and then escaped for the page. Sentence case, no emoji, no images
 * (so no tracking pixel), no marketing.
 */
import { INVITATION_DAYS } from './view.ts';

/** The longest a name may be in the email. A name this long is not a name; cutting it keeps the link in view. */
const NAME_MAX = 80;

/** Control characters, line and paragraph separators and invisible direction marks: all become a space. */
const CONTROL_CHARS = new RegExp('[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]', 'g');

/** A name as plain words: no control characters or line breaks, one space between words, cut if very long. */
export function plainLabel(value: unknown, fallback: string, max = NAME_MAX): string {
  const raw = typeof value === 'string' ? value : '';
  const cleaned = raw.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return fallback;
  return cleaned.length > max ? `${cleaned.slice(0, max - 1).trimEnd()}…` : cleaned;
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "9 November 2026": a date that cannot be read two ways, in UTC so the email says the same thing everywhere. */
function plainDate(date: Date): string {
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

export type InvitationEmailInput = {
  inviterName: string;
  businessName: string;
  /** The full link to the invitation's page. */
  link: string;
  expiresAt: Date;
};

export function invitationEmail(input: InvitationEmailInput): { subject: string; text: string; html: string } {
  const inviter = plainLabel(input.inviterName, 'Someone');
  const business = plainLabel(input.businessName, 'a business');
  const ends = plainDate(input.expiresAt);
  const subject = `${inviter} invited you to join ${business} on Splash`;

  const lead = `${inviter} invited you to join ${business} on Splash.`;
  const what = 'Splash is the app this business uses for its payments. Open the invitation and sign in with this email address to read it. You choose whether to accept or decline. Nothing happens until you do.';
  const button = 'Open the invitation';
  const ending = `The invitation is open for ${INVITATION_DAYS} days from when it was sent. It ends on ${ends} (UTC).`;
  const safety = 'If you were not expecting it, you can ignore this email. The link does nothing unless you sign in as the person it was sent to, so it is safe if it was forwarded.';

  const text = [lead, what, `${button}:\n${input.link}`, ending, safety].join('\n\n');

  const safeLink = escapeHtml(input.link);
  const paragraph = (value: string, style = '') =>
    `<p style="margin:0 0 16px 0;font-size:16px;line-height:24px;color:#1F4452;${style}">${escapeHtml(value)}</p>`;
  const html =
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>${escapeHtml(subject)}</title></head>` +
    '<body style="margin:0;padding:0;background:#F6F0ED;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F6F0ED;"><tr><td align="center" style="padding:24px 16px;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;font-family:system-ui,-apple-system,\'Segoe UI\',Roboto,Arial,sans-serif;"><tr><td style="padding:32px 28px;">' +
    paragraph(lead, 'font-size:20px;line-height:28px;font-weight:700;color:#0c3e48;') +
    paragraph(what) +
    `<p style="margin:24px 0;"><a href="${safeLink}" style="display:inline-block;padding:14px 24px;background:#0d6370;color:#ffffff;font-size:16px;font-weight:700;line-height:20px;text-decoration:none;border-radius:8px;">${escapeHtml(button)}</a></p>` +
    paragraph(ending, 'font-size:14px;line-height:22px;color:#326273;') +
    paragraph(safety, 'font-size:14px;line-height:22px;color:#326273;margin-bottom:0;') +
    '</td></tr></table></td></tr></table></body></html>';

  return { subject, text, html };
}

/** The state of an invitation's email, as an owner is shown it. */
export type InviteEmailState = 'sent' | 'failed' | 'not_configured' | 'sending' | 'not_sent';

/** How long a send may stay "sending" before its outcome is treated as unknown and an owner may send again. */
export const SEND_STALE_MS = 5 * 60 * 1000;

/** What the owner sees about one invitation's email. `message` is the sentence to show. */
export type InviteEmailWire = {
  state: InviteEmailState;
  sentAt: string | null;
  canResend: boolean;
  message: string;
};

export const INVITE_EMAIL_WORDS = {
  failed: 'We could not send the email. The invitation is still waiting for them. Try sending the email again.',
  not_configured: 'No email was sent. Email is not set up for Splash, so this invitation is waiting in the app only. They will see it when they sign in with this email address.',
  sending: 'The email is being sent.',
  not_sent: 'No email has been sent for this invitation yet. It is waiting in the app for them.',
  sentPrefix: 'Email sent',
  resend: 'Send the email again',
} as const;

/** The owner's view of one invitation's email, from what the invitation row records. */
export function inviteEmailWire(
  row: { emailState: string | null; emailAttemptAt: Date | null; emailSentAt: Date | null },
  ctx: { now: Date; owner: boolean },
): InviteEmailWire {
  let state: InviteEmailState;
  switch (row.emailState) {
    case 'sent':
      state = 'sent';
      break;
    case 'failed':
      state = 'failed';
      break;
    case 'not_configured':
      state = 'not_configured';
      break;
    case 'sending':
      // A send that never reported back is unknown; to the owner it is the same as a failure.
      state = row.emailAttemptAt && ctx.now.getTime() - row.emailAttemptAt.getTime() < SEND_STALE_MS ? 'sending' : 'failed';
      break;
    default:
      state = 'not_sent';
  }
  const sentAt = row.emailSentAt ? row.emailSentAt.toISOString() : null;
  const message = state === 'sent' ? INVITE_EMAIL_WORDS.sentPrefix : INVITE_EMAIL_WORDS[state];
  return { state, sentAt, canResend: ctx.owner && state !== 'sent' && state !== 'sending', message };
}
