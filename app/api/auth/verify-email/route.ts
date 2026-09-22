import { NextResponse } from 'next/server';
import { z } from 'zod';

import { VerificationTokenError, completeEmailVerification } from '@/lib/auth/email-verification';
import { clientIp } from '@/lib/auth/login-rate-limit';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, PasswordError } from '@/lib/auth/password';
import { readJsonBody } from '@/lib/server/http';
import { RATE_LIMITS, checkRateLimit, rateLimited, recordHit } from '@/lib/server/rate-limit';

/**
 * Prove a mailbox, and set the password that goes with it.
 *
 * The link this consumes was delivered to the address and nowhere else, so
 * whoever holds the token holds the mailbox. They choose the password now —
 * they do not confirm the one on file, because the one on file may have been
 * chosen by someone who registered the address before them (X5). Setting it
 * moves the account's credential version, which ends every session minted
 * before this moment.
 *
 * No session is minted here, and nothing is granted: proving an address is
 * identity, and authority is a separate, deliberate grant that this
 * verification merely makes possible.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({
  token: z.string().trim().min(40).max(128),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH),
});

const INVALID_LINK = 'This link is invalid, has expired, or was already used. Request a new one from the sign-in page.';

export async function POST(request: Request) {
  const parsed = schema.safeParse(await readJsonBody(request));
  if (!parsed.success) {
    return NextResponse.json(
      { error: `A verification link and a password of at least ${MIN_PASSWORD_LENGTH} characters are required` },
      { status: 400 },
    );
  }

  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ error: 'Account storage is not configured on this deployment' }, { status: 503 });
  }

  const { getDb } = await import('@/lib/db/client');
  const db = getDb() as never;

  const ip = clientIp(request);
  const verdict = await checkRateLimit(db, { ...RATE_LIMITS.verifyEmailIp, key: ip });
  if (!verdict.allowed) {
    return rateLimited('Too many attempts from this network. Try again shortly.', verdict.retryAfterSeconds);
  }
  await recordHit(db, { bucket: RATE_LIMITS.verifyEmailIp.bucket, key: ip });

  try {
    const account = await completeEmailVerification(db, { token: parsed.data.token, password: parsed.data.password });
    console.info('[verify-email] mailbox proven', { email: account.email });
    return NextResponse.json(
      {
        verified: true,
        email: account.email,
        next: 'Sign in with the password you just set. An administrator must still grant access to a workspace before this account can act.',
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    if (error instanceof PasswordError) {
      return NextResponse.json({ error: error.message, code: 'weak_password' }, { status: 400 });
    }
    if (error instanceof VerificationTokenError) {
      return NextResponse.json(
        { error: INVALID_LINK, code: error.code },
        { status: 400, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    throw error;
  }
}
