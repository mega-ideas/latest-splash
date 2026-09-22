import { NextResponse } from 'next/server';
import { z } from 'zod';

import { findAccount } from '@/lib/auth/accounts';
import { issueVerificationToken } from '@/lib/auth/email-verification';
import { sendVerificationEmail } from '@/lib/auth/email-transport';
import { clientIp } from '@/lib/auth/login-rate-limit';
import { readJsonBody } from '@/lib/server/http';
import { RATE_LIMITS, checkRateLimit, rateLimited, recordHit } from '@/lib/server/rate-limit';

/**
 * Start a password reset.
 *
 * This used to answer with a support mailbox to write to, because there was
 * no way to prove an address. There is now: the same token primitive that
 * confirms a signup delivers a reset link, and opening it sets a new
 * password, marks the mailbox proven, and ends every earlier session.
 *
 * The answer is 202 whether or not the address is registered — saying would
 * enumerate accounts. The support contact is still returned for the person
 * who has lost the mailbox as well as the password.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const recoverySchema = z.object({
  email: z.string().trim().email().max(254),
});

function recoveryContact() {
  return (
    process.env.CUSTOMER_RECOVERY_EMAIL ||
    process.env.NEXT_PUBLIC_SUPPORT_EMAIL ||
    'support@splash.finance'
  ).trim();
}

export async function POST(request: Request) {
  const parsed = recoverySchema.safeParse(await readJsonBody(request));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Enter a valid business email address', code: 'invalid_recovery_email' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ error: 'Account storage is not configured on this deployment' }, { status: 503 });
  }

  const { getDb } = await import('@/lib/db/client');
  const db = getDb() as never;
  const email = parsed.data.email.toLowerCase();
  const ip = clientIp(request);

  const perAddress = await checkRateLimit(db, { ...RATE_LIMITS.recoveryEmail, key: email });
  if (!perAddress.allowed) {
    return rateLimited('A reset link was sent recently. Check your inbox, then try again shortly.', perAddress.retryAfterSeconds);
  }
  const perNetwork = await checkRateLimit(db, { ...RATE_LIMITS.recoveryIp, key: ip });
  if (!perNetwork.allowed) {
    return rateLimited('Too many requests from this network. Try again shortly.', perNetwork.retryAfterSeconds);
  }
  await recordHit(db, { bucket: RATE_LIMITS.recoveryEmail.bucket, key: email });
  await recordHit(db, { bucket: RATE_LIMITS.recoveryIp.bucket, key: ip });

  const account = await findAccount(db, email);
  if (account) {
    try {
      const { token } = await issueVerificationToken(db, { userId: account.userId, purpose: 'reset_password' });
      await sendVerificationEmail({ to: account.email, token, kind: 'reset_password' });
    } catch (error) {
      console.error('[recovery] reset delivery failed', error);
    }
  }

  return NextResponse.json(
    {
      accepted: true,
      message: 'If that address has an account, a reset link is on its way. It expires in 30 minutes.',
      recoveryEmail: recoveryContact(),
    },
    { status: 202, headers: { 'Cache-Control': 'no-store' } },
  );
}
