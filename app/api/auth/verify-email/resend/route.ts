import { NextResponse } from 'next/server';
import { z } from 'zod';

import { findAccount } from '@/lib/auth/accounts';
import { issueVerificationToken } from '@/lib/auth/email-verification';
import { sendVerificationEmail } from '@/lib/auth/email-transport';
import { clientIp } from '@/lib/auth/login-rate-limit';
import { readJsonBody } from '@/lib/server/http';
import { RATE_LIMITS, checkRateLimit, rateLimited, recordHit } from '@/lib/server/rate-limit';

/**
 * Send the confirmation link again.
 *
 * The answer is 202 whether or not the address is registered, and whether
 * or not it is already proven: telling a caller which addresses have
 * unconfirmed accounts is an enumeration oracle. The only observable
 * difference is in the mailbox, which only its owner can see.
 *
 * This is also how the real owner of a pre-registered address (X5) takes it
 * back: the link reaches them, not whoever registered it, and opening it
 * replaces the password. Limited per address so it cannot flood a mailbox,
 * and per network so it cannot be used to spend delivery quota.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({ email: z.string().trim().email().max(254) });

export async function POST(request: Request) {
  const parsed = schema.safeParse(await readJsonBody(request));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Enter a valid business email address' }, { status: 400 });
  }

  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ error: 'Account storage is not configured on this deployment' }, { status: 503 });
  }

  const { getDb } = await import('@/lib/db/client');
  const db = getDb() as never;
  const email = parsed.data.email.toLowerCase();
  const ip = clientIp(request);

  const perAddress = await checkRateLimit(db, { ...RATE_LIMITS.verifyResendEmail, key: email });
  if (!perAddress.allowed) {
    return rateLimited('A link was sent recently. Check your inbox, then try again shortly.', perAddress.retryAfterSeconds);
  }
  const perNetwork = await checkRateLimit(db, { ...RATE_LIMITS.verifyResendIp, key: ip });
  if (!perNetwork.allowed) {
    return rateLimited('Too many requests from this network. Try again shortly.', perNetwork.retryAfterSeconds);
  }
  await recordHit(db, { bucket: RATE_LIMITS.verifyResendEmail.bucket, key: email });
  await recordHit(db, { bucket: RATE_LIMITS.verifyResendIp.bucket, key: ip });

  const account = await findAccount(db, email);
  if (account && !account.emailVerifiedAt) {
    try {
      const { token } = await issueVerificationToken(db, { userId: account.userId, purpose: 'verify_email' });
      await sendVerificationEmail({ to: account.email, token, kind: 'verify_email' });
    } catch (error) {
      // Delivery failing is an operator problem, logged as one. The caller
      // learns nothing either way.
      console.error('[verify-email] resend delivery failed', error);
    }
  }

  return NextResponse.json(
    {
      accepted: true,
      message: 'If that address has an unconfirmed account, a new link is on its way. It expires in 30 minutes.',
    },
    { status: 202, headers: { 'Cache-Control': 'no-store' } },
  );
}
