/**
 * The members of ONE business with their names and roles, for the Wallet
 * page. The join on the membership is the tenant boundary: a user who is not
 * a member of this business is never returned, whatever id is asked for.
 */
import 'server-only';

import { and, eq } from 'drizzle-orm';

import { memberships, users } from '@/lib/db/schema';
import type { DrizzleDb } from '@/lib/server/wallet-signing-store';

export type OrgMember = { userId: string; name: string; role: string };

export async function orgMembers(db: DrizzleDb, orgId: string): Promise<OrgMember[]> {
  const rows = await db
    .select({ userId: users.id, name: users.name, role: memberships.role })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.orgId, orgId)));
  return rows.map((r: { userId: string; name: string; role: string }) => ({ userId: r.userId, name: r.name, role: String(r.role) }));
}

/** Names of the given members of this business; anyone else is simply absent. */
export async function orgMemberNames(db: DrizzleDb, orgId: string, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const wanted = new Set(ids);
  return new Map((await orgMembers(db, orgId)).filter((m) => wanted.has(m.userId)).map((m) => [m.userId, m.name]));
}
