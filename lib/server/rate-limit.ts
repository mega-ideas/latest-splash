import { and, eq, gte, lt, sql } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';

import { rateLimitHits } from '../db/schema.ts';
import type * as schemaModule from '../db/schema.ts';

/**
 * The one rate limiter.
 *
 * A rule is a named bucket, a window and a limit; a key is the thing being
 * limited within it — an address, a network, a signed-in user. Hits live in
 * Postgres (`rate_limit_hits`), not Redis: Redis is cache-only here by rule,
 * and a limit that evaporates when a cache restarts is a pause an attacker
 * can trigger, not a limit. Rows are pruned as they are read, so there is no
 * scheduled job to forget.
 *
 * Every limited route goes through `enforceRateLimit`, which answers the
 * 429 or records the hit. The login limiter (`lib/auth/login-rate-limit.ts`)
 * is a thin layer over the same functions with a different rule — failures
 * count and a success clears — rather than a second implementation.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DrizzleDb = PgDatabase<any, typeof schemaModule, any>;

export type RateLimitRule = { bucket: string; limit: number; windowMs: number };

export type RateLimitVerdict = { allowed: true } | { allowed: false; retryAfterSeconds: number };

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** Every rule in one place, named for what it protects. */
export const RATE_LIMITS = {
  /* ── Accounts (WS1) ─────────────────────────────────────────────────── */
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
  /** Login FAILURES — recorded only when the password is wrong, cleared on
   *  success. Per address stops guessing one account; per network stops one
   *  source spraying a common password across many. */
  loginFailureEmail: { bucket: 'login-failure:email', limit: 5, windowMs: 15 * MINUTE },
  loginFailureIp: { bucket: 'login-failure:ip', limit: 20, windowMs: HOUR },

  /* ── Money, documents, model credits (WS7) ─────────────────────────── */
  /** The public pay link: marks an invoice paid and creates a recipient. */
  payLinkIp: { bucket: 'pay-link:ip', limit: 20, windowMs: 15 * MINUTE },
  // A payer checking for their USDC payment: each check reads the issuer's
  // wallet from the Sui indexer. Public, so bounded by network.
  payLinkUsdcIp: { bucket: 'pay-link-usdc:ip', limit: 30, windowMs: 15 * MINUTE },
  // The issuer matching all open invoices against one read of its wallet.
  invoiceUsdcSyncUser: { bucket: 'invoice-usdc-sync:user', limit: 30, windowMs: 15 * MINUTE },
  /** Zeke chat spends model credits per message. */
  copilotChatUser: { bucket: 'copilot-chat:user', limit: 30, windowMs: HOUR },
  /** The read-only copilot surfaces (suggestions, summary), per user and per network. */
  copilotUser: { bucket: 'copilot:user', limit: 120, windowMs: HOUR },
  copilotIp: { bucket: 'copilot:ip', limit: 300, windowMs: HOUR },
  /** Invoice extraction feeds a document to the model. */
  extractInvoiceUser: { bucket: 'extract-invoice:user', limit: 20, windowMs: HOUR },
  /** A Seal access decision is a key-server round trip. */
  sealAccessIp: { bucket: 'seal-access:ip', limit: 60, windowMs: 15 * MINUTE },
  /** Writes to the operational store. */
  invoiceCreateUser: { bucket: 'invoice-create:user', limit: 60, windowMs: HOUR },
  recipientCreateUser: { bucket: 'recipient-create:user', limit: 60, windowMs: HOUR },
  // Each quote reserves allowance and reads the sender's coins from a fullnode.
  stablecoinQuoteUser: { bucket: 'stablecoin-quote:user', limit: 30, windowMs: 15 * MINUTE },
  stablecoinSubmitUser: { bucket: 'stablecoin-submit:user', limit: 30, windowMs: 15 * MINUTE },
  // Each request sends a WhatsApp message; the per-subject cooldown stops a
  // double-click, this stops a loop.
  stepUpRequestUser: { bucket: 'step-up-request:user', limit: 10, windowMs: 15 * MINUTE },
  // Wrong codes are also capped per code (5); this caps them per person.
  stepUpVerifyUser: { bucket: 'step-up-verify:user', limit: 60, windowMs: 15 * MINUTE },
  // The public demo x402 seller simulates and broadcasts on each paid call.
  x402DemoIp: { bucket: 'x402-demo:ip', limit: 60, windowMs: 15 * MINUTE },
  // Wallet activity pages through the Sui indexer (up to four queries each).
  stablecoinActivityUser: { bucket: 'stablecoin-activity:user', limit: 60, windowMs: 15 * MINUTE },
  // The records export reads every transfer the workspace ever quoted.
  stablecoinExportUser: { bucket: 'stablecoin-export:user', limit: 20, windowMs: HOUR },
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

/** Forget a key's hits in one bucket — what a successful login does. */
export async function clearHits(db: DrizzleDb, input: { bucket: string; key: string }): Promise<void> {
  await db.delete(rateLimitHits).where(and(eq(rateLimitHits.bucket, input.bucket), eq(rateLimitHits.key, input.key)));
}

/** Hits for a key inside the window, for tests and the health surface. */
export async function countHits(
  db: DrizzleDb,
  input: { bucket: string; key: string; windowMs: number; now?: Date },
): Promise<number> {
  const now = input.now ?? new Date();
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(rateLimitHits)
    .where(
      and(
        eq(rateLimitHits.bucket, input.bucket),
        eq(rateLimitHits.key, input.key),
        gte(rateLimitHits.hitAt, new Date(now.getTime() - input.windowMs)),
      ),
    );
  return Number(rows[0]?.n ?? 0);
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

let warnedNoDatabase = false;

/**
 * The database the limiter writes to. Production always has one —
 * lib/env.ts refuses to boot without DATABASE_URL — so the only way to reach
 * the `null` branch is a development machine without a cluster, where the
 * limits are skipped once, loudly.
 */
async function defaultDb(): Promise<DrizzleDb | null> {
  if (!process.env.DATABASE_URL) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('rate limiting needs DATABASE_URL, and production cannot run without it');
    }
    if (!warnedNoDatabase) {
      warnedNoDatabase = true;
      console.warn('[rate-limit] DATABASE_URL is not set; limits are not enforced on this development machine');
    }
    return null;
  }
  const { getDb } = await import('../db/client.ts');
  return getDb() as unknown as DrizzleDb;
}

/**
 * Apply a rule to one request. Returns the 429 to send, or null when the
 * request may proceed — in which case the hit is already recorded. Routes
 * read as:
 *
 *   const limited = await enforceRateLimit({ rule: RATE_LIMITS.payLinkIp, key: clientIp(request) });
 *   if (limited) return limited;
 */
export async function enforceRateLimit(input: {
  rule: RateLimitRule;
  key: string;
  /** Injected by tests; routes leave it out and get the app database. */
  db?: DrizzleDb | null;
  now?: Date;
  message?: string;
}): Promise<Response | null> {
  const db = input.db === undefined ? await defaultDb() : input.db;
  if (!db) return null;

  const verdict = await checkRateLimit(db, { ...input.rule, key: input.key, now: input.now });
  if (!verdict.allowed) {
    return rateLimited(input.message ?? 'Too many requests. Try again shortly.', verdict.retryAfterSeconds);
  }
  await recordHit(db, { bucket: input.rule.bucket, key: input.key, now: input.now });
  return null;
}

/**
 * The client address, from the proxy headers the app already trusts for
 * origin checks. Falls back to a constant rather than to something
 * attacker-controlled: an unknown source shares one bucket, which is
 * restrictive, and being wrong in the restrictive direction is the right way
 * to be wrong here.
 */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return request.headers.get('x-real-ip')?.trim() || 'unknown';
}
