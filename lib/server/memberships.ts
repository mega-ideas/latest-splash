import { desc, eq } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';

import { memberships, organizations, users } from '../db/schema.ts';
import type * as schemaModule from '../db/schema.ts';
import { GrantRefusedError, grantMembership } from '../auth/authority.ts';
import type { AccountRow, MembershipRole } from '../membership-roles.ts';

/**
 * Reading and writing memberships for the staff console.
 *
 * Phase 3 removed every implicit grant: signup creates a user with no
 * membership, and `resolveAuthorityForSession` fails closed for anyone without
 * one. That is correct, and it left a real gap — `grantMembership()` existed
 * with no caller, so the only way to give a new account access was to open a
 * SQL client. A control nobody can operate gets worked around.
 *
 * This is the operator surface for it. It does not introduce a second grant
 * path: it calls the same `grantMembership` the tests assert against, so there
 * is still exactly one function that can create a membership.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DrizzleDb = PgDatabase<any, typeof schemaModule, any>;

/**
 * Roles, their meanings and the row shape live in `lib/membership-roles.ts`,
 * which imports nothing. They are re-exported here so a caller that already
 * has this module does not need a second import — but the console imports
 * them from the pure module, because this one reaches `pg`.
 */
export {
  MEMBERSHIP_ROLES,
  ROLE_MEANING,
  APPROVING_ROLES,
  isMembershipRole,
  canApprove,
} from '../membership-roles.ts';
export type { MembershipRole, AccountRow } from '../membership-roles.ts';

/**
 * Every account and its membership, newest first.
 *
 * A left join, not an inner one: accounts WITHOUT a membership are the ones an
 * operator is here to act on, and an inner join would hide exactly those.
 */
export async function listAccounts(db: DrizzleDb, limit = 200): Promise<AccountRow[]> {
  const rows = await db
    .select({
      userId: users.id,
      email: users.email,
      name: users.name,
      createdAt: users.createdAt,
      passwordHash: users.passwordHash,
      emailVerifiedAt: users.emailVerifiedAt,
      orgId: memberships.orgId,
      role: memberships.role,
      grantedBy: memberships.grantedBy,
      grantedAt: memberships.createdAt,
    })
    .from(users)
    .leftJoin(memberships, eq(memberships.userId, users.id))
    .orderBy(desc(users.createdAt))
    .limit(limit);

  return rows.map((row) => ({
    userId: row.userId,
    email: row.email,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    // Never the hash itself — only whether one exists.
    hasPassword: Boolean(row.passwordHash),
    emailVerified: Boolean(row.emailVerifiedAt),
    membership:
      row.orgId && row.role
        ? {
            orgId: row.orgId,
            role: row.role as MembershipRole,
            grantedBy: row.grantedBy,
            // The left join makes every membership column nullable to the
            // type system even though a row with an orgId always has one.
            grantedAt: (row.grantedAt ?? row.createdAt).toISOString(),
          }
        : null,
  }));
}

export async function listOrganizations(db: DrizzleDb): Promise<Array<{ id: string; name: string }>> {
  return db.select({ id: organizations.id, name: organizations.name }).from(organizations).orderBy(organizations.id);
}

export class MembershipAdminError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'MembershipAdminError';
    this.code = code;
  }
}

/**
 * Grant a role to an existing account.
 *
 * The account must already exist. This deliberately cannot create one: an
 * operator typing an email into a grant form and having a user appear is how a
 * typo becomes a real account with real authority, and there would be no
 * password on it either way.
 */
export async function grantRole(
  db: DrizzleDb,
  input: { email: string; orgId: string; role: MembershipRole; grantedBy: string },
): Promise<void> {
  const email = input.email.trim().toLowerCase();

  const existing = await db
    .select({ id: users.id, emailVerifiedAt: users.emailVerifiedAt })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (existing.length === 0) {
    throw new MembershipAdminError(
      `no account exists for ${email}. They must sign up before they can be granted access.`,
      'no_account',
    );
  }
  if (!existing[0].emailVerifiedAt) {
    // X5. An account nobody has proven is not evidence of who holds it: an
    // attacker who registered this address first would receive the grant.
    throw new MembershipAdminError(
      `${email} has not verified their email address. Ask them to open the verification link (they can request a new one from the sign-in page) before granting access.`,
      'unverified_email',
    );
  }

  const current = await db
    .select({ orgId: memberships.orgId })
    .from(memberships)
    .where(eq(memberships.userId, existing[0].id))
    .limit(1);
  if (current.length > 0) {
    throw new MembershipAdminError(
      `${email} already has a membership. Revoke it before granting a different one.`,
      'already_member',
    );
  }

  // The same function the fail-closed tests assert against. One grant path.
  // It re-checks verification itself; a refusal from it is surfaced in the
  // console's own vocabulary rather than leaking as a 500.
  try {
    await grantMembership(db, {
      email,
      orgId: input.orgId,
      role: input.role,
      grantedBy: input.grantedBy,
    });
  } catch (error) {
    if (error instanceof GrantRefusedError) throw new MembershipAdminError(error.message, error.code);
    throw error;
  }
}

/**
 * Remove a membership.
 *
 * A hard delete, unlike a revoked passkey. A membership is current authority,
 * not evidence: an approval that already happened is anchored with the
 * approver's address and its own record, and it does not depend on this row
 * still existing. Leaving a tombstone here would mean a revoked member still
 * appears in the org's member list.
 */
export async function revokeRole(db: DrizzleDb, input: { email: string }): Promise<void> {
  const email = input.email.trim().toLowerCase();
  const rows = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (rows.length === 0) throw new MembershipAdminError(`no account exists for ${email}`, 'no_account');

  await db.delete(memberships).where(eq(memberships.userId, rows[0].id));
}
