import { createHash, randomBytes } from 'node:crypto';

import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';

import { emailVerificationTokens, users } from '../db/schema.ts';
import type * as schemaModule from '../db/schema.ts';
import { assertPasswordPolicy, hashPassword } from './password.ts';

/**
 * Proving a mailbox, and what proving it earns.
 *
 * The defect this closes (X5, account pre-hijacking): signup never proved the
 * address, and a membership grant only asked that an account exist. An
 * attacker who registered `cfo@victim.example` first was who the
 * administrator's grant landed on, and the real CFO's own signup returned
 * 201 and changed nothing.
 *
 * The rule now: **the mailbox owner wins.** A token is delivered to the
 * address and nowhere else. Whoever opens it sets the password — not
 * confirms the one on file, *sets* it — and the account's credential version
 * moves, which ends every session minted before that moment. So if someone
 * else registered the address, their password stops working the instant the
 * real owner verifies, and nothing they held survives.
 *
 * The same primitive carries password reset: a link delivered to the mailbox
 * is the same proof, and earns the same three things — a new password, a
 * proven address, and the death of every earlier session.
 *
 * Tokens are 32 CSPRNG bytes; only their SHA-256 is stored; each is single
 * use, bound to one user and one purpose, and dead after thirty minutes.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DrizzleDb = PgDatabase<any, typeof schemaModule, any>;

export const VERIFICATION_PURPOSES = ['verify_email', 'reset_password'] as const;
export type VerificationPurpose = (typeof VERIFICATION_PURPOSES)[number];

/** Thirty minutes: long enough to find the email, short enough that a link
 *  forwarded or logged somewhere is worthless by the time anyone finds it. */
export const TOKEN_TTL_MS = 30 * 60 * 1000;
/** 256 bits of CSPRNG output. Guessing one is not a strategy. */
export const TOKEN_BYTES = 32;
/** Spent and stale rows are pruned once they are this far past expiry. */
const PRUNE_AFTER_MS = 24 * 60 * 60 * 1000;

/** The shape of 32 base64url bytes. Anything else is not one of ours and
 *  does not deserve a database round trip. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export class VerificationTokenError extends Error {
  readonly code = 'invalid_token';

  constructor(message = 'This link is invalid, has expired, or was already used. Request a new one.') {
    super(message);
    this.name = 'VerificationTokenError';
  }
}

export function isVerificationPurpose(value: unknown): value is VerificationPurpose {
  return typeof value === 'string' && (VERIFICATION_PURPOSES as readonly string[]).includes(value);
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Mint a token for one user and one purpose. The raw token is returned once,
 * to be put in a link; the row keeps only its hash.
 */
export async function issueVerificationToken(
  db: DrizzleDb,
  input: { userId: string; purpose: VerificationPurpose; now?: Date },
): Promise<{ token: string; expiresAt: Date }> {
  const now = input.now ?? new Date();
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  const expiresAt = new Date(now.getTime() + TOKEN_TTL_MS);

  // Prune as we write, so the table stays small without a scheduled job.
  await db
    .delete(emailVerificationTokens)
    .where(lt(emailVerificationTokens.expiresAt, new Date(now.getTime() - PRUNE_AFTER_MS)));

  await db.insert(emailVerificationTokens).values({
    id: `evt_${randomBytes(9).toString('base64url')}`,
    userId: input.userId,
    tokenHash: hashToken(token),
    purpose: input.purpose,
    expiresAt,
    createdAt: now,
  });

  return { token, expiresAt };
}

/**
 * Spend a token. Unknown, expired, already used, or issued for a different
 * purpose are all the same refusal — which of them it was is not something a
 * caller holding a bad link needs to learn.
 *
 * Checking and marking are one UPDATE, so two requests racing on the same
 * link cannot both win.
 */
export async function consumeVerificationToken(
  db: DrizzleDb,
  input: { token: string; purpose: VerificationPurpose; now?: Date },
): Promise<{ userId: string }> {
  const now = input.now ?? new Date();
  const token = typeof input.token === 'string' ? input.token.trim() : '';
  if (!TOKEN_SHAPE.test(token)) throw new VerificationTokenError();

  const rows = await db
    .update(emailVerificationTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(emailVerificationTokens.tokenHash, hashToken(token)),
        eq(emailVerificationTokens.purpose, input.purpose),
        isNull(emailVerificationTokens.usedAt),
        gt(emailVerificationTokens.expiresAt, now),
      ),
    )
    .returning({ userId: emailVerificationTokens.userId });

  if (rows.length !== 1) throw new VerificationTokenError();
  return { userId: rows[0].userId };
}

export type ProvenAccount = { userId: string; email: string; name: string; credentialVersion: number };

/**
 * What opening a delivered link earns, in one statement: the password becomes
 * the one entered now, the address is marked proven (keeping the first time
 * it was, if it already had been), and the credential version moves so every
 * session minted before this moment is refused on its next read.
 */
async function applyMailboxProof(
  db: DrizzleDb,
  input: { userId: string; password: string; now: Date },
): Promise<ProvenAccount> {
  const passwordHash = await hashPassword(input.password);
  const rows = await db
    .update(users)
    .set({
      passwordHash,
      emailVerifiedAt: sql`coalesce(${users.emailVerifiedAt}, ${input.now}::timestamptz)`,
      credentialVersion: sql`${users.credentialVersion} + 1`,
      updatedAt: input.now,
    })
    .where(eq(users.id, input.userId))
    .returning({
      userId: users.id,
      email: users.email,
      name: users.name,
      credentialVersion: users.credentialVersion,
    });
  const row = rows[0];
  // The token was bound to a user that no longer exists. Nothing to prove.
  if (!row) throw new VerificationTokenError();
  return row;
}

/**
 * Verify an address and set its password. The weak-password check runs
 * first, before the single-use token is spent on a password that is refused.
 */
export async function completeEmailVerification(
  db: DrizzleDb,
  input: { token: string; password: string; now?: Date },
): Promise<ProvenAccount> {
  const now = input.now ?? new Date();
  assertPasswordPolicy(input.password);
  const { userId } = await consumeVerificationToken(db, { token: input.token, purpose: 'verify_email', now });
  return applyMailboxProof(db, { userId, password: input.password, now });
}

/** Reset a password from a delivered link. Same proof, same consequences. */
export async function completePasswordReset(
  db: DrizzleDb,
  input: { token: string; password: string; now?: Date },
): Promise<ProvenAccount> {
  const now = input.now ?? new Date();
  assertPasswordPolicy(input.password);
  const { userId } = await consumeVerificationToken(db, { token: input.token, purpose: 'reset_password', now });
  return applyMailboxProof(db, { userId, password: input.password, now });
}
