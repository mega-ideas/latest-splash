import { NextResponse } from 'next/server';
import { z } from 'zod';

import { VerificationTokenError, completePasswordReset } from '@/lib/auth/email-verification';
import { clientIp } from '@/lib/auth/login-rate-limit';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, PasswordError } from '@/lib/auth/password';
import { readJsonBody } from '@/lib/server/http';
import { RATE_LIMITS, checkRateLimit, rateLimited, recordHit } from '@/lib/server/rate-limit';

/**
 * Finish a password reset from a delivered link.
 *
 * Same primitive as email verification, same consequences: the password
 * becomes the one entered now, the mailbox counts as proven (a link opened
 * from it is that proof), and the credential version moves so every earlier
 * session ends. No session is minted here; the owner signs in with the
 * password they just chose.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({
  token: z.string().trim().min(40).max(128),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH),
});

const INVALID_LINK = 'This link is invalid, has expired, or was already used. Request a new one.';

export async function POST(request: Request) {
  const parsed = schema.safeParse(await readJsonBody(request));
  if (!parsed.success) {
    return NextResponse.json(
      { error: `A reset link and a password of at least ${MIN_PASSWORD_LENGTH} characters are required` },
      { status: 400 },
    );
  }

  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ error: 'Account storage is not configured on this deployment' }, { status: 503 });
  }

  const { getDb } = await import('@/lib/db/client');
  const db = getDb() as never;

  const ip = clientIp(request);
  const verdict = await checkRateLimit(db, { ...RATE_LIMITS.resetPasswordIp, key: ip });
  if (!verdict.allowed) {
    return rateLimited('Too many attempts from this network. Try again shortly.', verdict.retryAfterSeconds);
  }
  await recordHit(db, { bucket: RATE_LIMITS.resetPasswordIp.bucket, key: ip });

  try {
    const account = await completePasswordReset(db, { token: parsed.data.token, password: parsed.data.password });
    console.info('[reset-password] password replaced', { email: account.email });
    return NextResponse.json(
      { reset: true, email: account.email, next: 'Sign in with your new password.' },
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
