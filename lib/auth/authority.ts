import { and, eq } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';

import { memberships, users } from '../db/schema.ts';
import type * as schemaModule from '../db/schema.ts';
import { loadOrgPolicy } from '../policy/org-policy.ts';
import type { OrgPolicy, UserRole } from '../agent/types.ts';
import type { CustomerSession } from './customer-session.ts';

/**
 * Track A §1.2 — the single server-side authority resolver for every
 * financial route. Invariant #8: the client is never authoritative.
 *
 * Server derives (never accepts from the request body):
 * - userId / orgId — from the authenticated session and the users table
 * - role           — from the membership row, NOT the claim
 * - policy         — from the org's persisted policy record
 *
 * This resolver FAILS CLOSED. An authenticated identity with no membership
 * gets no authority — not a default role, not a provisioned one. Previously
 * the catch block below called `provisionOperatorMembership(db, email,
 * 'checker')`, and `checker` maps to APPROVER, which is in APPROVAL_ROLES. So
 * the complete path from an unauthenticated stranger to approving a payment
 * was:
 *
 *   POST /api/auth/signup (any email, password never stored)
 *     → createSignupSession → a valid session cookie
 *     → resolveAuthorityForSession → UnauthorizedError → caught
 *     → provisionOperatorMembership('checker') → mapDbRole → APPROVER
 *     → APPROVAL_ROLES.has('APPROVER') → approves payments
 *
 * The comment on that catch block described it as "explicit, logged — not a
 * permissive default". It logged, and it was a permissive default: logging an
 * escalation does not stop it. Both are gone.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DrizzleDb = PgDatabase<any, typeof schemaModule, any>;

export interface AuthorityContext {
  orgId: string;
  userId: string;
  role: UserRole;
  policy: OrgPolicy;
  resolvedAt: string;
}

export class UnauthorizedError extends Error {
  constructor(message = 'no membership for the authenticated identity') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

/** The org every desk proposal is booked under today (see lib/agent/oxwal.ts). */
export const DEFAULT_ORG_ID = 'demo-business';

/** DB role enum (maker/checker/admin/viewer) → proposal-domain UserRole. */
const DB_ROLE_MAP: Record<string, UserRole> = {
  maker: 'MAKER',
  checker: 'APPROVER',
  admin: 'OWNER',
  viewer: 'VIEWER',
};

export function mapDbRole(role: string): UserRole {
  return DB_ROLE_MAP[role] ?? 'VIEWER';
}

/**
 * Pure, DB-injected resolution — the SAME code runs against Postgres in
 * production and pglite in tests (14.12: role is provably DB-derived, re-read
 * on every request, never cached, never claimed).
 *
 * Two rows are required: an identity, and a membership granting it a role in
 * an organisation. A user with no membership raises UnauthorizedError, which
 * is the intended outcome for everyone who has signed up and not yet been
 * granted anything.
 */
export async function resolveAuthorityFromDb(db: DrizzleDb, email: string): Promise<AuthorityContext> {
  const normalized = email.trim().toLowerCase();

  const rows = await db
    .select({
      userId: users.id,
      orgId: memberships.orgId,
      role: memberships.role,
    })
    .from(users)
    .innerJoin(memberships, eq(memberships.userId, users.id))
    .where(eq(users.email, normalized))
    .limit(1);

  if (rows.length === 0) {
    throw new UnauthorizedError(`no membership for ${normalized}`);
  }

  const membership = rows[0];
  const policy = await loadOrgPolicy(db, membership.orgId);
  return {
    orgId: membership.orgId,
    userId: membership.userId,
    role: mapDbRole(membership.role),
    policy,
    resolvedAt: new Date().toISOString(),
  };
}

/**
 * Entry point for routes.
 *
 * There is no DB-less path any more. `resolveAuthorityLocal` used to return
 * `OXWAL_OPERATOR_ROLE ?? 'APPROVER'` for any authenticated session whenever
 * DATABASE_URL was unset — so the bypass did not even need the database, and
 * an unconfigured deployment was the most permissive one. Authority now comes
 * from a membership row or it does not come at all.
 */
export async function resolveAuthorityForSession(session: CustomerSession): Promise<AuthorityContext> {
  if (!process.env.DATABASE_URL) {
    throw new UnauthorizedError(
      'DATABASE_URL is not configured, so no membership can be read. Authority is never assumed.',
    );
  }

  const { getDb } = await import('../db/client.ts');
  const db = getDb() as unknown as DrizzleDb;
  return resolveAuthorityFromDb(db, session.email);
}

/**
 * A grant that was refused, and why. `no_account`: nobody has signed up with
 * that address. `unverified_email`: someone has, but nobody has proven they
 * read the mailbox — and until they do, the address is not evidence of who
 * holds the account.
 */
export class GrantRefusedError extends Error {
  readonly code: 'no_account' | 'unverified_email';

  constructor(code: 'no_account' | 'unverified_email', message: string) {
    super(message);
    this.name = 'GrantRefusedError';
    this.code = code;
  }
}

/**
 * Grant a membership. Administrative, and never reachable from the auth path.
 *
 * This exists for seeding an organisation's first member and for the
 * invitation flow. It takes an explicit role because there is no safe default
 * — the old signature defaulted to `checker`, which is APPROVER, so a caller
 * that passed nothing granted payment-approval authority.
 *
 * It grants only to an account whose mailbox has been proven. This closes
 * X5: signup never proved the address, and a grant only asked that a row
 * exist, so whoever registered `cfo@victim.example` first was who the
 * administrator's grant landed on. Now the row has to carry
 * `email_verified_at`, which only a link delivered to the mailbox — or a
 * provider token asserting `email_verified` — can set.
 *
 * It no longer creates the account on the way to granting, either. It used
 * to insert a password-less `users` row for an unknown address, which made a
 * typo in a grant form into a real identity. A grant is not a registration:
 * an unknown address is refused, and nothing is written.
 *
 * tests/auth-fail-closed.test.mjs asserts that no module under the auth path
 * calls this.
 */
export async function grantMembership(
  db: DrizzleDb,
  input: { email: string; orgId: string; role: 'maker' | 'checker' | 'admin' | 'viewer'; grantedBy?: string },
): Promise<void> {
  const normalized = input.email.trim().toLowerCase();

  const existing = await db
    .select({ id: users.id, emailVerifiedAt: users.emailVerifiedAt })
    .from(users)
    .where(eq(users.email, normalized))
    .limit(1);
  const account = existing[0];
  if (!account) {
    throw new GrantRefusedError('no_account', `no account exists for ${normalized}; they must sign up first`);
  }
  if (!account.emailVerifiedAt) {
    throw new GrantRefusedError(
      'unverified_email',
      `${normalized} has not verified their email address; nothing can be granted to an address nobody has proven`,
    );
  }

  const { ensureOrganization } = await import('../db/proposal-repo.ts');
  await ensureOrganization(db, input.orgId);

  await db
    .insert(memberships)
    .values({
      id: `mem_${account.id}_${input.orgId}`,
      userId: account.id,
      orgId: input.orgId,
      role: input.role,
      grantedBy: input.grantedBy ?? null,
    })
    .onConflictDoNothing();
}

/** Read a user's membership in one organisation, or null. */
export async function findMembership(
  db: DrizzleDb,
  input: { email: string; orgId: string },
): Promise<{ userId: string; role: string } | null> {
  const normalized = input.email.trim().toLowerCase();
  const rows = await db
    .select({ userId: users.id, role: memberships.role })
    .from(users)
    .innerJoin(memberships, eq(memberships.userId, users.id))
    .where(and(eq(users.email, normalized), eq(memberships.orgId, input.orgId)))
    .limit(1);
  return rows[0] ?? null;
}
