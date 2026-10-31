/**
 * Who a spender address on a business's SpendPolicy is to Splash now (v2
 * §4.2, offboarding). A spending rule lives on chain: removing a member, or
 * making them a viewer, does not stop it, because create_intent and
 * pay_intent are public functions their own device can call. So the index
 * says, for each rule, whether its holder still may pay under one:
 *
 *   member        an address of a current maker, checker or owner here
 *   viewer        an address of a current viewer: may not pay
 *   removed       an address of a member who was removed (until an executed
 *                 change takes that spender off the policy; a re-hire does
 *                 not clear it, the owners do)
 *   not_a_member  nobody here holds that address
 *
 * Reads Postgres only. Every read takes the org.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { normalizeSuiAddress } from '@mysten/sui/utils';

import { memberships, passkeyCredentials, walletOffboardedSpenders } from '../db/schema.ts';
import type { DrizzleDb, StoredRequest } from './wallet-signing-store.ts';

export type Standing = 'member' | 'viewer' | 'removed' | 'not_a_member';
export type StandingOf = (address: string) => Standing;

export async function readSpenderStanding(db: DrizzleDb, orgId: string): Promise<StandingOf> {
  const people = await db.select({ userId: memberships.userId, role: memberships.role }).from(memberships).where(eq(memberships.orgId, orgId));
  const roleOf = new Map(people.map((p) => [p.userId, String(p.role)]));
  const keys = people.length
    ? await db.select({ userId: passkeyCredentials.userId, address: passkeyCredentials.suiAddress }).from(passkeyCredentials).where(inArray(passkeyCredentials.userId, people.map((p) => p.userId)))
    : [];
  const byAddress = new Map<string, string>();
  for (const k of keys) {
    const role = roleOf.get(k.userId);
    const address = normalizeSuiAddress(k.address);
    // An address two people somehow share counts as the weaker standing.
    if (role && (byAddress.get(address) === undefined || role === 'viewer')) byAddress.set(address, role);
  }
  const gone = await db
    .select({ address: walletOffboardedSpenders.address })
    .from(walletOffboardedSpenders)
    .where(and(eq(walletOffboardedSpenders.orgId, orgId), isNull(walletOffboardedSpenders.resolvedAt)));
  const removed = new Set(gone.map((g) => normalizeSuiAddress(g.address)));
  return (address: string) => {
    const a = normalizeSuiAddress(address);
    if (removed.has(a)) return 'removed';
    const role = byAddress.get(a);
    if (role === undefined) return 'not_a_member';
    return role === 'viewer' ? 'viewer' : 'member';
  };
}

/**
 * After a spending-rule change executes: every spender it took off the
 * policy is no longer an offboarding to-do. Idempotent.
 */
export async function resolveOffboardedSpenders(db: DrizzleDb, request: Pick<StoredRequest, 'orgId' | 'purpose' | 'status' | 'summary'>, now: Date = new Date()): Promise<number> {
  if (request.status !== 'executed' || request.purpose !== 'spend_rule') return 0;
  const actions = ((request.summary as { description?: { actions?: Array<{ type: string; spender?: string }> } } | null)?.description?.actions ?? []);
  const removed = [...new Set(actions.filter((a) => a.type === 'remove_spender' && a.spender).map((a) => normalizeSuiAddress(a.spender as string)))];
  if (removed.length === 0) return 0;
  const done = await db
    .update(walletOffboardedSpenders)
    .set({ resolvedAt: now })
    .where(and(eq(walletOffboardedSpenders.orgId, request.orgId), inArray(walletOffboardedSpenders.address, removed), isNull(walletOffboardedSpenders.resolvedAt)))
    .returning({ id: walletOffboardedSpenders.id });
  return done.length;
}
