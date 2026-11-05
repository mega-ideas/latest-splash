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
 * Every value inserted into it is cleaned to plain words and then escaped for
 * the page: control characters become spaces (so a name cannot add a header
 * line or a paragraph), invisible and direction-changing characters are
 * removed, long names are cut, and anything a mail client would turn into a
 * link (a web address, a bare domain, an email address, a number host) is taken
 * out. Splash sends this from its own address, so the only link in it is the
 * invitation's. Sentence case, no emoji, no images (so no tracking pixel), no
 * marketing.
 */
/** The longest a name may be in the email. A name this long is not a name; cutting it keeps the link in view. */
const NAME_MAX = 80;

/** Control characters, line and paragraph separators and zero-width or direction marks that sit between words: all become a space. */
const CONTROL_CHARS = new RegExp('[\u0000-\u001f\u007f-\u009f  ​-‏‪-‮⁦-⁩﻿]', 'g');

/**
 * Characters that draw nothing and can hide text, spoof a name or defeat a
 * filter: every Unicode format character (soft hyphen, word joiner, invisible
 * operators, Arabic letter mark, Mongolian vowel separator, the tag block),
 * plus the grapheme joiner, the Hangul fillers and the variation selectors.
 * They are removed, not turned into a space, so a word is not split in two.
 */
const INVISIBLE_CHARS = /[\p{Cf}͏ᅟᅠㅤﾠ︀-️\u{e0100}-\u{e01ef}]/gu;

/** More than any name needs; the cleaning below never works on more than this. */
const INPUT_MAX = 2000;

/** Control characters become spaces and invisible ones disappear. */
function cleanText(raw: string): string {
  return raw.replace(CONTROL_CHARS, ' ').replace(INVISIBLE_CHARS, '');
}

function cut(cleaned: string, max: number): string {
  return cleaned.length > max ? `${cleaned.slice(0, max - 1).trimEnd()}…` : cleaned;
}

/** A name as plain words: no control characters or line breaks, no invisible ones, one space between words, cut if very long. */
export function plainLabel(value: unknown, fallback: string, max = NAME_MAX): string {
  const raw = typeof value === 'string' ? value.slice(0, INPUT_MAX) : '';
  const cleaned = cleanText(raw).replace(/\s+/g, ' ').trim();
  return cleaned ? cut(cleaned, max) : fallback;
}

/*
 * Anything a mail client would turn into a link, in a name. Splash sends this
 * email from its own address, so a name must never carry someone else's link
 * (or address) into it: the subject, the text and the page are Splash's words
 * around a name, and the only link is the invitation's.
 */
const SCHEME_URL = /\b[a-z][a-z0-9+.-]*:\/\/\S*/giu;
const BARE_SCHEME = /\b(?:mailto|tel|sms|javascript|data|file|ftp|https?)\s*:\S*/giu;
const EMAIL_ADDRESS = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
const WWW_NAME = /\bwww\.\S*/giu;
const DOMAIN_NAME = /(?<![\p{L}\p{N}_-])(?:[\p{L}\p{N}_-]+\.)+\p{L}[\p{L}\p{N}-]+(?![\p{L}\p{N}_-])(?::\d+)?(?:[/?#]\S*)?/gu;
const IPV4_HOST = /(?<![\p{N}.])\d{1,3}(?:\.\d{1,3}){3}(?![\p{N}])(?::\d+)?(?:[/?#]\S*)?/gu;
const IDEOGRAPHIC_STOP = /(?<=[\p{L}\p{N}-])[。｡](?=[\p{L}\p{N}-])/gu;
const LEFT_OVER_EDGES = /^[\s:;,|/\\@–—-]+|[\s:;,|/\\@–—-]+$/gu;

/** A name for the email: plain words (see plainLabel) with every link, domain, address and numeric host taken out. */
export function emailLabel(value: unknown, fallback: string, max = NAME_MAX): string {
  const raw = typeof value === 'string' ? value.slice(0, INPUT_MAX) : '';
  // Compatibility forms first (full-width letters and dots, the dot leader), then the ideographic full stop between word characters.
  const flat = cleanText(raw.normalize('NFKC')).replace(IDEOGRAPHIC_STOP, '.');
  const stripped = flat
    .replace(SCHEME_URL, ' ')
    .replace(BARE_SCHEME, ' ')
    .replace(EMAIL_ADDRESS, ' ')
    .replace(WWW_NAME, ' ')
    .replace(DOMAIN_NAME, ' ')
    .replace(IPV4_HOST, ' ')
    .replace(/@/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(LEFT_OVER_EDGES, '');
  return stripped ? cut(stripped, max) : fallback;
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const two = (n: number) => String(n).padStart(2, '0');

/** "9 November 2026 at 09:00 UTC": a moment that cannot be read two ways, in UTC so the email says the same thing everywhere. */
function plainMoment(date: Date): string {
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()} at ${two(date.getUTCHours())}:${two(date.getUTCMinutes())} UTC`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long is left when the email is sent, in words. A resend on day five says so, not "7 days". */
function timeLeft(expiresAt: Date, now: Date): string {
  const ms = expiresAt.getTime() - now.getTime();
  if (ms < DAY_MS) return 'There is less than a day left.';
  const days = Math.round(ms / DAY_MS);
  return days === 1 ? 'There is about 1 day left.' : `There are about ${days} days left.`;
}

export type InvitationEmailInput = {
  inviterName: string;
  businessName: string;
  /** The full link to the invitation's page. */
  link: string;
  expiresAt: Date;
  /** When the email is sent; the days left are counted from here. */
  now?: Date;
};

export function invitationEmail(input: InvitationEmailInput): { subject: string; text: string; html: string } {
  const inviter = emailLabel(input.inviterName, 'Someone');
  const business = emailLabel(input.businessName, 'a business');
  const ends = plainMoment(input.expiresAt);
  const subject = `${inviter} invited you to join ${business} on Splash`;

  const lead = `${inviter} invited you to join ${business} on Splash.`;
  const what = 'Splash is the app this business uses for its payments. Open the invitation and sign in with this email address to read it. You choose whether to accept or decline. Nothing happens until you do.';
  const button = 'Open the invitation';
  const ending = `The invitation ends on ${ends}. ${timeLeft(input.expiresAt, input.now ?? new Date())}`;
  const safety = 'If you were not expecting it, you can ignore this email. The link does nothing unless you sign in as the person it was sent to, so it is safe if it was forwarded.';

  const text = [lead, what, `${button}:\n${input.link}`, ending, safety].join('\n\n');

  const safeLink = escapeHtml(input.link);
  const paragraph = (value: string, style = '') =>
    `<p style="margin:0 0 16px 0;font-size:16px;line-height:24px;color:#1F4452;${style}">${escapeHtml(value)}</p>`;
  const html =
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">' +
    `<title>${escapeHtml(subject)}</title></head>` +
    '<body style="margin:0;padding:0;background:#F6F0ED;color-scheme:light;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F6F0ED;"><tr><td align="center" style="padding:24px 16px;">' +
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:12px;font-family:system-ui,-apple-system,\'Segoe UI\',Roboto,Arial,sans-serif;"><tr><td style="padding:32px 28px;">' +
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
  sending: 'The email may already be on its way. If it has not arrived in a few minutes, you will be able to send it again.',
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
