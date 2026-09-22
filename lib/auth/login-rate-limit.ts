import type { PgDatabase } from 'drizzle-orm/pg-core';

import type * as schemaModule from '../db/schema.ts';
import { RATE_LIMITS, checkRateLimit, clearHits, countHits, recordHit } from '../server/rate-limit.ts';

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
 * its own `login_attempts` table it used to be. That table is legacy and is
 * no longer written; a later migration drops it.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DrizzleDb = PgDatabase<any, typeof schemaModule, any>;

const EMAIL_RULE = RATE_LIMITS.loginFailureEmail;
const IP_RULE = RATE_LIMITS.loginFailureIp;

export const EMAIL_LIMIT = EMAIL_RULE.limit;
export const EMAIL_WINDOW_MS = EMAIL_RULE.windowMs;
export const IP_LIMIT = IP_RULE.limit;
export const IP_WINDOW_MS = IP_RULE.windowMs;

export type RateLimitVerdict =
  | { allowed: true }
  | { allowed: false; scope: 'email' | 'ip'; retryAfterSeconds: number };

const norm = (email: string) => email.trim().toLowerCase();

/**
 * Whether this attempt may proceed. Call BEFORE verifying the password —
 * checking afterwards would let an attacker keep testing candidates while the
 * limiter only ever counted attempts it had already answered.
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

/** Record a failed attempt, in both buckets. Called only on failure. */
export async function recordFailedLogin(
  db: DrizzleDb,
  input: { email: string; ip: string; now?: Date },
): Promise<void> {
  await recordHit(db, { bucket: EMAIL_RULE.bucket, key: norm(input.email), now: input.now });
  await recordHit(db, { bucket: IP_RULE.bucket, key: input.ip, now: input.now });
}

/** Clear an email's failures after a successful login. */
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
