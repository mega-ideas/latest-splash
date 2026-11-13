import type { PgDatabase } from 'drizzle-orm/pg-core';

import type * as schemaModule from '../db/schema.ts';
import {
  RATE_LIMITS,
  checkRateLimit,
  clearHits,
  countHits,
  deleteHit,
  recordHit,
  reserveHit,
} from '../server/rate-limit.ts';

export { clientIp } from '../server/rate-limit.ts';

/**
 * Login rate limiting: 5 failures per email per 15 minutes, 20 per IP per
 * hour.
 *
 * Two windows because they stop different things. The per-email limit stops
 * an attacker guessing one account's password. The per-IP limit stops one
 * source spraying a common password across many accounts, which the per-email
 * limit alone never sees — each individual account stays under its own
 * threshold.
 *
 * Only FAILURES are recorded. Counting successes would lock out the one person
 * who is legitimately signing in repeatedly, and a successful login clears the
 * email's failures, so a user who mistypes twice and then succeeds starts
 * clean.
 *
 * This is a thin layer over lib/server/rate-limit.ts — the same buckets, the
 * same table, the same pruning — rather than the second implementation on
 * a table of its own it used to be. That table was dropped by migration 0080.
 *
 * Routes use `beginLoginAttempt` and `loginAttemptSucceeded`. An attempt is
 * counted as a failure BEFORE the password is checked and taken back when it
 * succeeds: checking the count, then the password, then recording the failure
 * let every request in flight read the same count, so a client sending its
 * guesses together had all of them checked (found reviewing C5, pre-audit
 * fix, 13 Nov 2026). `checkLoginRateLimit`, `recordFailedLogin` and
 * `clearLoginFailures` remain for tests and the health surface; they count the
 * customer realm.
 *
 * Staff sign-in passes `realm: 'staff'`, which counts its address failures
 * in a bucket of its own (`login-failure-staff:email`). The network bucket is
 * shared by both realms.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DrizzleDb = PgDatabase<any, typeof schemaModule, any>;

const EMAIL_RULE = RATE_LIMITS.loginFailureEmail;
const STAFF_EMAIL_RULE = RATE_LIMITS.loginFailureStaffEmail;
const IP_RULE = RATE_LIMITS.loginFailureIp;

/**
 * Whose sign-in an attempt is. Staff addresses are counted in a bucket of
 * their own, so no string a customer submits as an address can reach the
 * staff count, nor the other way round: within one bucket every key is
 * whatever the caller typed, and a prefix such as `staff:` can be typed too.
 */
export type LoginRealm = 'customer' | 'staff';

const emailRule = (realm: LoginRealm = 'customer') => (realm === 'staff' ? STAFF_EMAIL_RULE : EMAIL_RULE);

export const EMAIL_LIMIT = EMAIL_RULE.limit;
export const EMAIL_WINDOW_MS = EMAIL_RULE.windowMs;
export const IP_LIMIT = IP_RULE.limit;
export const IP_WINDOW_MS = IP_RULE.windowMs;

export type RateLimitVerdict =
  | { allowed: true }
  | { allowed: false; scope: 'email' | 'ip'; retryAfterSeconds: number };

const norm = (email: string) => email.trim().toLowerCase();

/** An attempt let through, already counted as a failure in both buckets. */
export type LoginAttempt = { emailBucket: string; email: string; emailHitId: string; ipHitId: string };

export type LoginAttemptVerdict =
  | { allowed: true; attempt: LoginAttempt }
  | { allowed: false; scope: 'email' | 'ip'; retryAfterSeconds: number };

/**
 * Start a sign-in attempt. Call BEFORE verifying the password.
 *
 * The attempt is recorded as a failure in both buckets and then counted, so
 * requests in flight together cannot all read the same count: at most five
 * per address and twenty per network ever reach the password check, however
 * they are timed (see `reserveHit`). A refused attempt is not counted.
 *
 * When the password is wrong there is nothing more to do: the failure is
 * already recorded. When it is right, call `loginAttemptSucceeded`. If the
 * check throws, the attempt stays counted as a failure, which errs closed.
 */
export async function beginLoginAttempt(
  db: DrizzleDb,
  input: { email: string; ip: string; realm?: LoginRealm; now?: Date },
): Promise<LoginAttemptVerdict> {
  const email = norm(input.email);
  const rule = emailRule(input.realm);
  const byEmail = await reserveHit(db, { ...rule, key: email, now: input.now });
  if (!byEmail.allowed) return { allowed: false, scope: 'email', retryAfterSeconds: byEmail.retryAfterSeconds };

  const byIp = await reserveHit(db, { ...IP_RULE, key: input.ip, now: input.now });
  if (!byIp.allowed) {
    await deleteHit(db, byEmail.hitId);
    return { allowed: false, scope: 'ip', retryAfterSeconds: byIp.retryAfterSeconds };
  }

  return { allowed: true, attempt: { emailBucket: rule.bucket, email, emailHitId: byEmail.hitId, ipHitId: byIp.hitId } };
}

/**
 * The attempt signed in: clear the address's failures, as a success always
 * has, and take back the network hit this attempt recorded, since only
 * failures count. The network's earlier failures stay.
 */
export async function loginAttemptSucceeded(db: DrizzleDb, attempt: LoginAttempt): Promise<void> {
  await clearHits(db, { bucket: attempt.emailBucket, key: attempt.email });
  await deleteHit(db, attempt.ipHitId);
}

/**
 * Whether an attempt would be let through now, without recording anything.
 * For tests and the health surface: a route that checks with this and then
 * records lets a burst through (see `beginLoginAttempt`).
 */
export async function checkLoginRateLimit(
  db: DrizzleDb,
  input: { email: string; ip: string; now?: Date },
): Promise<RateLimitVerdict> {
  const byEmail = await checkRateLimit(db, { ...EMAIL_RULE, key: norm(input.email), now: input.now });
  if (!byEmail.allowed) return { allowed: false, scope: 'email', retryAfterSeconds: byEmail.retryAfterSeconds };

  const byIp = await checkRateLimit(db, { ...IP_RULE, key: input.ip, now: input.now });
  if (!byIp.allowed) return { allowed: false, scope: 'ip', retryAfterSeconds: byIp.retryAfterSeconds };

  return { allowed: true };
}

/** Record a failed attempt, in both buckets. For tests and seeding; routes
 *  record through `beginLoginAttempt`. */
export async function recordFailedLogin(
  db: DrizzleDb,
  input: { email: string; ip: string; now?: Date },
): Promise<void> {
  await recordHit(db, { bucket: EMAIL_RULE.bucket, key: norm(input.email), now: input.now });
  await recordHit(db, { bucket: IP_RULE.bucket, key: input.ip, now: input.now });
}

/** Clear an email's failures. Routes clear through `loginAttemptSucceeded`. */
export async function clearLoginFailures(db: DrizzleDb, email: string): Promise<void> {
  await clearHits(db, { bucket: EMAIL_RULE.bucket, key: norm(email) });
}

/** Count failures in the window, for tests and the health surface. */
export async function countRecentFailures(
  db: DrizzleDb,
  input: { email?: string; ip?: string; now?: Date },
): Promise<number> {
  if (input.email) {
    return countHits(db, { bucket: EMAIL_RULE.bucket, key: norm(input.email), windowMs: EMAIL_RULE.windowMs, now: input.now });
  }
  return countHits(db, { bucket: IP_RULE.bucket, key: input.ip ?? '', windowMs: IP_RULE.windowMs, now: input.now });
}
