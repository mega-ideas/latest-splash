/**
 * Delivering a link to a mailbox.
 *
 * This is the half of account verification that reaches outside the
 * process. Two transports: `console`, which prints the link to the server
 * log and refuses to exist in production, and `resend`, which posts to
 * Resend's HTTPS API with nothing more than `fetch`. The provider is chosen
 * by `EMAIL_TRANSPORT`; `lib/env.ts` refuses to start production without a
 * real one, because a membership grant requires a verified mailbox, and
 * without delivery nobody can ever be granted anything.
 *
 * The token goes in the body of the message, never the subject line —
 * subjects end up in notification previews, mail logs and other people's
 * screenshots.
 */

export type VerificationEmailKind = 'verify_email' | 'reset_password';

export type SendVerificationInput = {
  to: string;
  /** The full link, with the token already in it. */
  url: string;
  kind: VerificationEmailKind;
};

/** Any other message: a notice whose words the caller has already written. */
export type EmailMessage = {
  to: string;
  subject: string;
  /** Plain text. Paragraphs are separated by a blank line. */
  text: string;
  /** A paragraph of `text` that is exactly this URL becomes a link in HTML. */
  link?: string;
};

export interface EmailTransport {
  readonly name: 'console' | 'resend';
  sendVerification(input: SendVerificationInput): Promise<void>;
  /** Resolves with the provider's message id when it gives one. */
  sendMessage(message: EmailMessage): Promise<{ providerRef: string | null }>;
}

/** The keys this module reads. A parameter, so tests pass literal objects. */
export type TransportEnv = {
  NODE_ENV?: string;
  EMAIL_TRANSPORT?: string;
  EMAIL_API_KEY?: string;
  EMAIL_FROM?: string;
};

export class EmailDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmailDeliveryError';
  }
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);

/** The message for each kind. Plain words; nothing about the address is
 *  assumed, and the link is the only call to action. */
export function messageFor(input: SendVerificationInput): { subject: string; text: string; html: string } {
  if (input.kind === 'reset_password') {
    const text =
      'A password reset was requested for this address.\n\n' +
      'Open this link within 30 minutes to choose a new password:\n\n' +
      `${input.url}\n\n` +
      'If you did not ask for this, ignore this email; your password stays as it is. ' +
      'Every signed-in session ends when a new password is set.';
    return { subject: 'Reset your password', text, html: htmlFor(text, input.url) };
  }
  const text =
    'Someone — hopefully you — entered this address to create a Splash account.\n\n' +
    'Open this link within 30 minutes to confirm the address and choose your password:\n\n' +
    `${input.url}\n\n` +
    'If that was not you, ignore this email. The account cannot be used, and cannot be ' +
    'given access to anything, until this link is opened.';
  return { subject: 'Confirm your email address', text, html: htmlFor(text, input.url) };
}

function htmlFor(text: string, url: string | null): string {
  const paragraphs = text.split('\n\n').map((paragraph) => {
    if (url !== null && paragraph === url) {
      const safe = escapeHtml(url);
      return `<p><a href="${safe}">${safe}</a></p>`;
    }
    return `<p>${escapeHtml(paragraph)}</p>`;
  });
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#1F4452">${paragraphs.join('')}</body></html>`;
}

/**
 * Development only. It prints the link, which is exactly what makes it
 * unacceptable anywhere a real address could be entered.
 */
export function createConsoleTransport(env: TransportEnv = process.env): EmailTransport {
  if (env.NODE_ENV === 'production') {
    throw new Error(
      'the console email transport prints links to the server log and is development only; set EMAIL_TRANSPORT=resend in production',
    );
  }
  return {
    name: 'console',
    async sendVerification(input) {
      console.info(`[email:console] ${input.kind} for ${input.to}\n  ${input.url}`);
    },
    async sendMessage(message) {
      console.info(`[email:console] "${message.subject}" for ${message.to}\n  ${message.text.split('\n')[0]}`);
      return { providerRef: null };
    },
  };
}

/** Resend over plain HTTPS. No SDK: one endpoint, one bearer token. */
export function createResendTransport(input: { apiKey: string; from: string; fetch?: typeof fetch }): EmailTransport {
  const doFetch = input.fetch ?? globalThis.fetch;
  async function post(to: string, subject: string, text: string, html: string, what: string) {
    const response = await doFetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${input.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: input.from, to: [to], subject, text, html }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new EmailDeliveryError(`resend returned HTTP ${response.status} for a ${what} message`);
    }
    return response;
  }
  return {
    name: 'resend',
    async sendVerification(message) {
      const { subject, text, html } = messageFor(message);
      await post(message.to, subject, text, html, message.kind);
    },
    async sendMessage(message) {
      const response = await post(message.to, message.subject, message.text, htmlFor(message.text, message.link ?? null), 'notice');
      const body = (await response.json().catch(() => null)) as { id?: unknown } | null;
      return { providerRef: typeof body?.id === 'string' ? body.id : null };
    },
  };
}

/** The transport the environment names. Throws rather than guessing. */
export function resolveEmailTransport(env: TransportEnv = process.env): EmailTransport {
  const kind = (env.EMAIL_TRANSPORT ?? '').trim() || 'console';
  if (kind === 'resend') {
    const apiKey = (env.EMAIL_API_KEY ?? '').trim();
    const from = (env.EMAIL_FROM ?? '').trim();
    if (!apiKey || !from) throw new Error('EMAIL_TRANSPORT=resend requires EMAIL_API_KEY and EMAIL_FROM');
    return createResendTransport({ apiKey, from });
  }
  if (kind === 'console') return createConsoleTransport(env);
  throw new Error(`unknown EMAIL_TRANSPORT "${kind}"; expected console or resend`);
}

/**
 * Compose the link and send it. One place builds the URL, so every route
 * points at the same page with the same query parameter.
 */
export async function sendVerificationEmail(input: {
  to: string;
  token: string;
  kind: VerificationEmailKind;
  appUrl?: string;
  transport?: EmailTransport;
}): Promise<void> {
  const base = (input.appUrl ?? process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
  const path = input.kind === 'verify_email' ? '/verify-email' : '/reset-password';
  const url = `${base}${path}?token=${encodeURIComponent(input.token)}`;
  await (input.transport ?? resolveEmailTransport()).sendVerification({ to: input.to, url, kind: input.kind });
}
