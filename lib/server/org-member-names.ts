/**
 * The members of ONE business with their names and roles, for the Wallet
 * page. The join on the membership is the tenant boundary: a user who is not
 * a member of this business is never returned, whatever id is asked for.
 */
import 'server-only';

import { and, eq } from 'drizzle-orm';

import { memberships, users } from '@/lib/db/schema';
import { plainTitle } from '@/lib/team/declined-by';
import type { DrizzleDb } from '@/lib/server/wallet-signing-store';

/** `title` is the member's own job title as plain words, or null (then the role word is the title). */
export type OrgMember = { userId: string; name: string; role: string; title: string | null };

export async function orgMembers(db: DrizzleDb, orgId: string): Promise<OrgMember[]> {
  const rows = await db
    .select({ userId: users.id, name: users.name, role: memberships.role, title: memberships.title })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.orgId, orgId)));
  return rows.map((r: { userId: string; name: string; role: string; title: string | null }) => ({ userId: r.userId, name: r.name, role: String(r.role), title: plainTitle(r.title) }));
}

/** Names of the given members of this business; anyone else is simply absent. */
export async function orgMemberNames(db: DrizzleDb, orgId: string, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const wanted = new Set(ids);
  return new Map((await orgMembers(db, orgId)).filter((m) => wanted.has(m.userId)).map((m) => [m.userId, m.name]));
}
