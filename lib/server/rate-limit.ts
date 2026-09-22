import { and, eq, gte, lt } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';

import { rateLimitHits } from '../db/schema.ts';
import type * as schemaModule from '../db/schema.ts';

export { clientIp } from '../auth/login-rate-limit.ts';

/**
 * A rate limit, generalised: a named bucket, a key within it, a window and a
 * limit. Postgres-backed for the reason `lib/auth/login-rate-limit.ts` gives
 * — a limit that evaporates when a cache restarts is a pause an attacker can
 * trigger, not a limit — and pruned as it is read, so no scheduled job.
 *
 * The login limiter is left as it is: it counts failures only and clears on
 * success, which is a different rule, and this module exists so that every
 * other route does not grow its own copy of the pattern.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DrizzleDb = PgDatabase<any, typeof schemaModule, any>;

export type RateLimitRule = { bucket: string; limit: number; windowMs: number };

export type RateLimitVerdict = { allowed: true } | { allowed: false; retryAfterSeconds: number };

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** Every rule in one place, named for what it protects. */
export const RATE_LIMITS = {
  /** Account creation per network: ten an hour is a busy office, not a script. */
  signupIp: { bucket: 'signup:ip', limit: 10, windowMs: HOUR },
  /** Re-sending the confirmation link to one address. Also caps how often a
   *  signup for an already-registered, still-unproven address can re-send. */
  verifyResendEmail: { bucket: 'verify-resend:email', limit: 3, windowMs: 15 * MINUTE },
  verifyResendIp: { bucket: 'verify-resend:ip', limit: 20, windowMs: HOUR },
  /** Consuming a verification link. Tokens are unguessable; this bounds the
   *  work a flood can cause, not the odds of a guess. */
  verifyEmailIp: { bucket: 'verify-email:ip', limit: 20, windowMs: 15 * MINUTE },
  /** Requesting a password reset for one address, and per network. */
  recoveryEmail: { bucket: 'recovery:email', limit: 3, windowMs: 15 * MINUTE },
  recoveryIp: { bucket: 'recovery:ip', limit: 20, windowMs: HOUR },
  /** Consuming a reset link. */
  resetPasswordIp: { bucket: 'reset-password:ip', limit: 20, windowMs: 15 * MINUTE },
} as const satisfies Record<string, RateLimitRule>;

/**
 * Whether this hit may proceed. Call BEFORE doing the work, and record the
 * hit with `recordHit` when it proceeds — a limiter consulted afterwards has
 * already answered the request it then declines to count.
 */
export async function checkRateLimit(
  db: DrizzleDb,
  input: RateLimitRule & { key: string; now?: Date },
): Promise<RateLimitVerdict> {
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - input.windowMs);

  // Prune this bucket as we read it: a row outside the window can never
  // affect a verdict again.
  await db.delete(rateLimitHits).where(and(eq(rateLimitHits.bucket, input.bucket), lt(rateLimitHits.hitAt, since)));

  const rows = await db
    .select({ hitAt: rateLimitHits.hitAt })
    .from(rateLimitHits)
    .where(and(eq(rateLimitHits.bucket, input.bucket), eq(rateLimitHits.key, input.key), gte(rateLimitHits.hitAt, since)))
    .orderBy(rateLimitHits.hitAt);

  if (rows.length >= input.limit) {
    // The window frees up when the OLDEST counted hit ages out.
    const retryAt = rows[0].hitAt.getTime() + input.windowMs;
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((retryAt - now.getTime()) / 1000)) };
  }
  return { allowed: true };
}

export async function recordHit(db: DrizzleDb, input: { bucket: string; key: string; now?: Date }): Promise<void> {
  const now = input.now ?? new Date();
  await db.insert(rateLimitHits).values({
    id: `rl_${now.getTime()}_${Math.random().toString(36).slice(2, 10)}`,
    bucket: input.bucket,
    key: input.key,
    hitAt: now,
  });
}

/** The 429 every limited route answers with. A plain Response, so this
 *  module stays importable under `node --test` without Next's runtime. */
export function rateLimited(message: string, retryAfterSeconds: number): Response {
  return new Response(JSON.stringify({ error: message, code: 'rate_limited' }), {
    status: 429,
    headers: {
      'Content-Type': 'application/json',
      'Retry-After': String(retryAfterSeconds),
      'Cache-Control': 'no-store',
    },
  });
}
