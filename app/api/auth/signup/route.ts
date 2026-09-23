import { NextResponse } from 'next/server';
import { z } from 'zod';

import { AccountExistsError, createAccount, findAccount, type AccountIdentity } from '@/lib/auth/accounts';
import { issueVerificationToken } from '@/lib/auth/email-verification';
import { sendVerificationEmail } from '@/lib/auth/email-transport';
import { clientIp } from '@/lib/auth/login-rate-limit';
import { MIN_PASSWORD_LENGTH, PasswordError } from '@/lib/auth/password';
import { readJsonBody } from '@/lib/server/http';
import { RATE_LIMITS, checkRateLimit, rateLimited, recordHit } from '@/lib/server/rate-limit';

/**
 * Create an account. It grants nothing.
 *
 * This route used to call `createSignupSession`, which took any email, ignored
 * the password entirely, and returned a signed session cookie. That session
 * then reached `resolveAuthorityForSession`, which provisioned a `checker`
 * membership — APPROVER — for anyone it did not recognise. Reaching this
 * endpoint was therefore sufficient to approve payments.
 *
 * What it does now: stores a scrypt hash, creates a user with no membership,
 * and returns 201 with no session. The new account can log in and see an empty
 * workspace; every financial route refuses it until someone with authority
 * grants a membership.
 *
 * No session is set here on purpose. Signing someone in as a side effect of
 * registration means an unverified address holds a session, and it was the
 * shape of the original defect.
 *
 * What it also does now (WS1, X5): delivers a confirmation link to the
 * address. Until that link is opened the account is unverified, and a
 * membership grant to an unverified account is refused — so registering
 * someone else's address first gains nothing. Opening the link sets the
 * password, so the mailbox owner wins even if someone else registered it.
 */

const signupSchema = z.object({
  company: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(254),
  region: z.string().trim().min(2).max(80),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(256),
  accepted: z.literal(true),
});

export async function POST(request: Request) {
  if (process.env.NODE_ENV === 'production' && process.env.CUSTOMER_SELF_SIGNUP_ENABLED !== 'true') {
    return NextResponse.json(
      { error: 'Business workspaces are provisioned by Splash in production' },
      { status: 403 },
    );
  }

  const parsed = signupSchema.safeParse(await readJsonBody(request));
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: `A valid company, business email, acceptance, and a password of at least ${MIN_PASSWORD_LENGTH} characters are required`,
      },
      { status: 400 },
    );
  }

  if (!process.env.DATABASE_URL) {
    return NextResponse.json(
      { error: 'Account storage is not configured on this deployment' },
      { status: 503 },
    );
  }

  const { getDb } = await import('@/lib/db/client');
  const db = getDb() as never;

  // Per network, before anything is written or sent.
  const ip = clientIp(request);
  const verdict = await checkRateLimit(db, { ...RATE_LIMITS.signupIp, key: ip });
  if (!verdict.allowed) {
    return rateLimited('Too many sign-ups from this network. Try again shortly.', verdict.retryAfterSeconds);
  }
  await recordHit(db, { bucket: RATE_LIMITS.signupIp.bucket, key: ip });

  let account: AccountIdentity;
  try {
    account = await createAccount(db, {
      email: parsed.data.email,
      password: parsed.data.password,
      name: parsed.data.company,
    });
  } catch (error) {
    if (error instanceof PasswordError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof AccountExistsError) {
      // 201 either way. Telling a caller which addresses are registered turns
      // this endpoint into an account-enumeration oracle, and there is nothing
      // to protect: no session is issued and no authority is granted.
      //
      // The address may have been registered by its owner, or by someone
      // else (X5). The only person who can act on that is whoever reads the
      // mailbox, so if the address is still unproven the link goes out again:
      // the real owner opens it, sets their own password, and whatever the
      // earlier registration held stops working. Limited per address so this
      // cannot be used to flood a mailbox.
      const existing = await findAccount(db, parsed.data.email);
      if (existing && !existing.emailVerifiedAt) {
        const resend = await checkRateLimit(db, { ...RATE_LIMITS.verifyResendEmail, key: existing.email });
        if (resend.allowed) {
          await recordHit(db, { bucket: RATE_LIMITS.verifyResendEmail.bucket, key: existing.email });
          await deliverConfirmation(db, existing);
        }
      }
      return created();
    }
    throw error;
  }

  if (!(await deliverConfirmation(db, account))) {
    return NextResponse.json(
      {
        error: 'The confirmation email could not be sent. Try again shortly, or request a new link from the sign-in page.',
        code: 'delivery_failed',
      },
      { status: 503 },
    );
  }

  return created();
}

/** Issue a link and send it. Delivery failing is logged as the operator
 *  problem it is; the caller gets a plain answer, never a stack trace. */
async function deliverConfirmation(db: never, account: { userId: string; email: string }): Promise<boolean> {
  try {
    const { token } = await issueVerificationToken(db, { userId: account.userId, purpose: 'verify_email' });
    await sendVerificationEmail({ to: account.email, token, kind: 'verify_email' });
    return true;
  } catch (error) {
    console.error('[signup] verification delivery failed', error);
    return false;
  }
}

function created() {
  return NextResponse.json(
    {
      created: true,
      /** Explicit, so a client cannot mistake registration for access. */
      authority: 'none',
      verification: 'sent',
      next: 'Open the confirmation link we emailed to finish creating the account. An administrator must then grant access to a workspace before it can act.',
    },
    { status: 201 },
  );
}
