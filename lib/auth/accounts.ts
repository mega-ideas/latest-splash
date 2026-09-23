import { eq, sql } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';

import { users } from '../db/schema.ts';
import type * as schemaModule from '../db/schema.ts';
import { hashPassword, needsRehash, verifyPassword } from './password.ts';

/**
 * Real user accounts: create one, and verify a password against one.
 *
 * What this replaces: `lib/server/customer-auth.ts` compared the submitted
 * email and password against `CUSTOMER_EMAIL` / `CUSTOMER_PASSWORD` — one
 * credential pair for the whole deployment, stored in plaintext in the
 * environment, so "the user" was whoever held the .env file. Signup did not
 * even do that: it validated the password's shape and threw it away, then
 * minted a session.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DrizzleDb = PgDatabase<any, typeof schemaModule, any>;

export type AccountIdentity = { userId: string; email: string; name: string; credentialVersion: number };
export type AccountStatus = AccountIdentity & { emailVerifiedAt: Date | null };

const norm = (email: string) => email.trim().toLowerCase();

export function userIdFromEmail(email: string): string {
  return `op_${norm(email)}`;
}

export class AccountExistsError extends Error {
  constructor(email: string) {
    super(`an account already exists for ${email}`);
    this.name = 'AccountExistsError';
  }
}

/**
 * Create an unverified account with a hashed password and NO membership.
 *
 * The absence of a membership is the point. Such a user can log in and reach
 * an empty workspace; `resolveAuthorityForSession` raises UnauthorizedError
 * for them, so every financial route refuses. Authority arrives later, from
 * `grantMembership`, as a deliberate act by someone who already has it.
 */
export async function createAccount(
  db: DrizzleDb,
  input: { email: string; password: string; name?: string },
): Promise<AccountIdentity> {
  const email = norm(input.email);
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existing.length > 0) throw new AccountExistsError(email);

  // Throws PasswordError on a weak password, before anything is written.
  const passwordHash = await hashPassword(input.password);
  const userId = userIdFromEmail(email);
  const name = input.name?.trim() || email.split('@')[0] || 'member';

  await db.insert(users).values({ id: userId, email, name, passwordHash }).onConflictDoNothing();
  return { userId, email, name, credentialVersion: 1 };
}

/**
 * Verify a password. Returns the identity on success, null on every failure.
 *
 * Deliberately uniform: an unknown email and a wrong password are the same
 * answer, and both do the same work. Returning early for an unknown address
 * would make the response measurably faster and turn this into an account
 * enumeration oracle, so a miss verifies against a dummy hash instead.
 */
export async function verifyAccountPassword(
  db: DrizzleDb,
  input: { email: string; password: string },
): Promise<AccountIdentity | null> {
  const email = norm(input.email);
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      passwordHash: users.passwordHash,
      credentialVersion: users.credentialVersion,
    })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  const row = rows[0];
  if (!row?.passwordHash) {
    // Spend comparable time so "no such user" and "wrong password" are not
    // distinguishable by how long the answer took.
    await verifyPassword(input.password, await dummyHash());
    return null;
  }

  const ok = await verifyPassword(input.password, row.passwordHash);
  if (!ok) return null;

  // A cost increase reaches existing accounts here, on the one occasion the
  // plaintext is available and already known to be correct.
  if (needsRehash(row.passwordHash)) {
    try {
      await db.update(users).set({ passwordHash: await hashPassword(input.password) }).where(eq(users.id, row.id));
    } catch {
      // An upgrade failure must not fail the login that just succeeded.
    }
  }

  return { userId: row.id, email: row.email, name: row.name, credentialVersion: row.credentialVersion };
}

/**
 * A valid hash of a value nobody can supply, computed once. Verifying against
 * it costs the same as a real check, which is what keeps the timing uniform.
 */
let dummy: Promise<string> | null = null;
function dummyHash(): Promise<string> {
  dummy ??= hashPassword(`absent-account-${Math.random()}-${Date.now()}-padding`);
  return dummy;
}

/**
 * Mark an address proven.
 *
 * Reached from exactly two places: the zkLogin route, when the provider's
 * token carries the boolean claim `email_verified: true`, and
 * `lib/auth/email-verification.ts`, when a link delivered to the mailbox is
 * opened. The first proof time is kept — proving an address twice does not
 * move the date it was first proven.
 */
export async function markEmailVerified(db: DrizzleDb, email: string, now = new Date()): Promise<void> {
  await db
    .update(users)
    .set({ emailVerifiedAt: sql`coalesce(${users.emailVerifiedAt}, ${now}::timestamptz)`, updatedAt: now })
    .where(eq(users.email, norm(email)));
}

export async function findAccount(db: DrizzleDb, email: string): Promise<AccountStatus | null> {
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      credentialVersion: users.credentialVersion,
      emailVerifiedAt: users.emailVerifiedAt,
    })
    .from(users)
    .where(eq(users.email, norm(email)))
    .limit(1);
  const row = rows[0];
  return row
    ? {
        userId: row.id,
        email: row.email,
        name: row.name,
        credentialVersion: row.credentialVersion,
        emailVerifiedAt: row.emailVerifiedAt,
      }
    : null;
}

/**
 * The credential version on the row, or null when there is no such account.
 *
 * It moves with everything that changes what mints a session — a password
 * set through verification or reset, and the verification itself. A session
 * carries the version it was minted under; a reader that finds a different
 * number treats the session as absent. That is how "verification ends every
 * existing session" is enforced without a session table to sweep.
 */
export async function readCredentialVersion(db: DrizzleDb, email: string): Promise<number | null> {
  const rows = await db
    .select({ credentialVersion: users.credentialVersion })
    .from(users)
    .where(eq(users.email, norm(email)))
    .limit(1);
  return rows[0]?.credentialVersion ?? null;
}

/**
 * Whether a session was minted under the account's current credentials.
 *
 * A session with no version at all is refused too: it predates versioning,
 * and every session that predates it was minted before anyone had proven a
 * mailbox.
 */
export async function sessionCredentialIsCurrent(
  db: DrizzleDb,
  session: { email: string; credentialVersion?: number },
): Promise<boolean> {
  if (typeof session.credentialVersion !== 'number') return false;
  const current = await readCredentialVersion(db, session.email);
  return current !== null && current === session.credentialVersion;
}
