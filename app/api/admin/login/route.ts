import { NextResponse } from 'next/server';

import { beginLoginAttempt, clientIp, loginAttemptSucceeded } from '@/lib/auth/login-rate-limit';
import { setAdminSessionCookie, validateAdminCredentials } from '@/lib/server/admin-auth';
import { readJsonBody } from '@/lib/server/http';

/** One message for every wrong pair. Which half was wrong is not the caller's
 *  business, and saying would confirm the staff address. */
const INVALID = 'Invalid staff credentials';

/**
 * Staff sign-in.
 *
 * C5 (pre-audit fix, 13 Nov 2026): the staff console approves KYB, which
 * verifies a business on chain, so its sign-in gets the same failed-attempt
 * limits as a customer's (lib/auth/login-rate-limit.ts: five per address per
 * 15 minutes, twenty per network per hour), consulted before the password is
 * checked, as app/api/auth/login/route.ts does.
 *
 * The address bucket is keyed `staff:<address>`, so a customer account that
 * shares the staff address never locks the console and the console never
 * locks it. The network bucket is shared on purpose: one source guessing
 * passwords is one source, whichever form it uses. The address is trimmed and
 * lowercased BEFORE the prefix is added, because validateAdminCredentials
 * accepts any padding and case: without that, ` staff@…` would be a fresh
 * bucket that still signs in.
 *
 * Without a database there is nowhere to count failures. Production refuses
 * staff sign-in rather than run unlimited (lib/env.ts already refuses to boot
 * without DATABASE_URL; this holds if that check is ever bypassed). A
 * development machine without one signs in as it always has.
 */
export async function POST(request: Request) {
  const body = await readJsonBody(request);
  const email = String(body.email ?? '');
  const password = String(body.password ?? '');

  if (!process.env.DATABASE_URL) {
    if (process.env.NODE_ENV === 'production') {
      console.error('[admin-auth] Refusing staff sign-in: DATABASE_URL is not configured, so failed attempts cannot be limited.');
      return NextResponse.json({ error: INVALID }, { status: 401 });
    }
    const session = validateAdminCredentials(email, password);
    if (!session) return NextResponse.json({ error: INVALID }, { status: 401 });
    await setAdminSessionCookie();
    return NextResponse.json({ session });
  }

  const { getDb } = await import('@/lib/db/client');
  const db = getDb();
  const ip = clientIp(request);
  const key = `staff:${email.trim().toLowerCase()}`;

  // Before the password check, not after: a limiter consulted afterwards
  // still lets an attacker test every candidate it then declines to answer.
  // The attempt is counted as a failure now and taken back on success, so
  // guesses sent together cannot all read the same count. One message for
  // both scopes, and the same for any address, so a refusal says nothing
  // about which address is the staff one.
  const verdict = await beginLoginAttempt(db, { email: key, ip });
  if (!verdict.allowed) {
    return NextResponse.json(
      { error: 'Too many failed attempts. Try again shortly.' },
      { status: 429, headers: { 'Retry-After': String(verdict.retryAfterSeconds) } },
    );
  }

  const session = validateAdminCredentials(email, password);
  // A wrong pair is already counted: beginLoginAttempt recorded it.
  if (!session) return NextResponse.json({ error: INVALID }, { status: 401 });

  await loginAttemptSucceeded(db, verdict.attempt);

  // Cookie is `secure` in production (HTTPS) and non-secure only in local dev,
  // derived from NODE_ENV inside setAdminSessionCookie — never from the
  // client-supplied Host header.
  await setAdminSessionCookie();

  return NextResponse.json({ session });
}
