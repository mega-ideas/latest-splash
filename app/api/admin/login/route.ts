import { NextResponse } from 'next/server';

import { beginLoginAttempt, clientIp, loginAttemptSucceeded } from '@/lib/auth/login-rate-limit';
import { setAdminSessionCookie, validateAdminCredentials } from '@/lib/server/admin-auth';
import { readJsonBody } from '@/lib/server/http';

/** One message for every wrong pair. Which half was wrong is not the caller's
 *  business, and saying would confirm the staff address. */
const INVALID = 'Invalid staff credentials';

/** The longest an address can be (RFC 5321), as the customer route uses. */
const MAX_EMAIL_LENGTH = 254;

/**
 * Staff sign-in.
 *
 * C5 (pre-audit fix, 13 Nov 2026): the staff console approves KYB, which
 * verifies a business on chain, so its sign-in gets the same failed-attempt
 * limits as a customer's (lib/auth/login-rate-limit.ts: five per address per
 * 15 minutes, twenty per network per hour), consulted before the password is
 * checked, as app/api/auth/login/route.ts does.
 *
 * Staff address failures are counted in a bucket of their own
 * (`login-failure-staff:email`, the `staff` realm of the limiter), not the
 * customer one, so staff and customer failures never share an address
 * bucket: no address typed into either form, whatever its spelling or
 * prefix, is counted against the other form's addresses. A customer account
 * that shares the staff address never locks the console and the console
 * never locks it. (Keys spelled `staff:<address>` inside the customer bucket
 * did not hold: the customer form takes `staff:<ADMIN_EMAIL>` as an address.)
 * The network bucket is shared on purpose: one source guessing passwords is
 * one source, whichever form it uses. The limiter trims and lowercases the
 * address, because validateAdminCredentials accepts any padding and case:
 * without that, ` staff@…` would be a fresh bucket that still signs in.
 *
 * The cost, accepted by Sky on 15 Nov 2026: the console has one login
 * (ADMIN_EMAIL), and its address bucket does not care where a failure came
 * from. So five wrong passwords from anywhere in 15 minutes refuse the right
 * one from everywhere, including the staff's own network, for up to 15
 * minutes, until the oldest failure ages out; an anonymous caller can keep
 * that up with five requests every 15 minutes (twenty an hour, inside one
 * network's limit). The login page prefills an address, which makes guessing
 * it unnecessary. And because the network bucket is shared, twenty customer
 * failures behind the same office NAT refuse staff sign-in from there for up
 * to an hour. The alternatives were set out and not taken: keying the staff
 * address bucket by address and network, so a remote caller cannot close it
 * for other networks; delaying rather than refusing for the staff key; giving
 * staff a network bucket of their own. Recovery is to wait out the window, or
 * to delete the `login-failure-staff:email` rows from rate_limit_hits.
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

  // No address is longer than 254 characters (RFC 5321), the customer route
  // refuses one, and the limiter cannot store one: its key goes into a btree
  // index that refuses a row over 2704 bytes, which made the route throw.
  // Such an address can never be the staff one, so it gets the answer any
  // wrong pair gets, before the limiter is touched. The password is not
  // capped: ADMIN_PASSWORD has no length rule, and it never reaches the
  // database.
  if (email.length > MAX_EMAIL_LENGTH) {
    return NextResponse.json({ error: INVALID }, { status: 401 });
  }

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

  // Before the password check, not after: a limiter consulted afterwards
  // still lets an attacker test every candidate it then declines to answer.
  // The attempt is counted as a failure now and taken back on success, so
  // guesses sent together cannot all read the same count. One message for
  // both scopes, and the same for any address, so a refusal says nothing
  // about which address is the staff one.
  const verdict = await beginLoginAttempt(db, { email, ip, realm: 'staff' });
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
