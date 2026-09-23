import { eq } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';

import { organizations } from '../db/schema.ts';
import type * as schemaModule from '../db/schema.ts';
import {
  assertTransition,
  coarseKybStatus,
  toKybLifecycleState,
  type KybActor,
  type KybLifecycleState,
} from './kyb-state.ts';

/**
 * Persistence for the org KYB lifecycle (wallet spec §3).
 *
 * The pure rules live in kyb-state.ts; this module is the only thing that
 * touches the database, mirroring the loadOrgPolicy shape in
 * lib/policy/org-policy.ts (`db: null` = the DB-less demo path).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DrizzleDb = PgDatabase<any, typeof schemaModule, any>;

/**
 * Is the KYB money gate enforced?
 *
 * Default OFF. Turning this on without every org having a real lifecycle row
 * would put the demo workspace — which `resolveAuthorityForSession`
 * auto-provisions with kyb_lifecycle defaulting to REGISTERED — into read-only
 * and break the `splash@demo` login. Enable it only once orgs are seeded.
 */
export function kybGateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.FEATURE_KYB_GATE === 'true';
}

/**
 * What to assume when the state cannot be read.
 *
 * This used to be a single ACTIVE for both "no DATABASE_URL" and "no row",
 * justified by the gate being opt-in and DATABASE_URL being required in
 * production. The first half of that reasoning held; the second did not. A
 * MISSING ROW is reachable in production with the gate on and the database
 * connected — an org id that does not exist, a row not yet created, a typo in
 * a request — and it read as ACTIVE, meaning fully KYB-approved and cleared to
 * move money. An unknown org was the most trusted kind.
 *
 * Split in two. With the gate OFF nothing here is enforcing anything and the
 * permissive answer keeps local development and the demo working. With the
 * gate ON, an org we cannot read is an org that has done nothing, and
 * REGISTERED is the truthful answer — it blocks money movement, which is the
 * point of a gate.
 */
const DEMO_STATE_WITH_GATE_OFF: KybLifecycleState = 'ACTIVE';
const UNKNOWN_ORG_STATE: KybLifecycleState = 'REGISTERED';

/** The state for an org whose record we could not read, honestly. */
function unreadableState(env: NodeJS.ProcessEnv = process.env): KybLifecycleState {
  return kybGateEnabled(env) ? UNKNOWN_ORG_STATE : DEMO_STATE_WITH_GATE_OFF;
}

async function resolveDb(): Promise<DrizzleDb | null> {
  if (!process.env.DATABASE_URL) return null;
  const { getDb } = await import('../db/client.ts');
  return getDb() as unknown as DrizzleDb;
}

export async function readOrgKybState(orgId: string): Promise<KybLifecycleState> {
  const db = await resolveDb();
  if (!db) return unreadableState();

  const rows = await db
    .select({ lifecycle: organizations.kybLifecycle })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  // Not the same as "no database". This org is not on file, and with the gate
  // on that must not read as approved.
  if (rows.length === 0) return unreadableState();
  return toKybLifecycleState(rows[0].lifecycle);
}

/**
 * Advance an org through the lifecycle. Throws KybTransitionError when the
 * move is illegal or the actor is not permitted to make it — that check is the
 * whole separation-of-duties control, so callers must not bypass it.
 *
 * Writes the coarse legacy `kyb_status` in the same statement so the two
 * columns can never drift.
 */
export async function setOrgKybState(
  orgId: string,
  to: KybLifecycleState,
  actor: KybActor,
): Promise<{ from: KybLifecycleState; to: KybLifecycleState }> {
  const from = await readOrgKybState(orgId);
  assertTransition(from, to, actor);

  const db = await resolveDb();
  if (db) {
    await db
      .update(organizations)
      .set({ kybLifecycle: to, kybStatus: coarseKybStatus(to), updatedAt: new Date() })
      .where(eq(organizations.id, orgId));
  }

  console.info('[org-kyb] transition', { orgId, from, to, actor });
  return { from, to };
}

/**
 * The full KYB_ADMIN_APPROVED → on-chain verify → ACTIVE sequence (spec §3.3).
 *
 * Ordering matters and is deliberate:
 *   1. transition to KYB_ADMIN_APPROVED first, so the accountable decision is
 *      recorded even if the chain call later fails;
 *   2. call `business_account::verify_business` (AdminCap-gated);
 *   3. only then ACTIVE — money movement unlocks strictly after the chain
 *      agrees the account is verified.
 *
 * If step 2 throws, the org is left at KYB_ADMIN_APPROVED — approved, but NOT
 * able to move money. That is the correct failure posture: never activate on an
 * unverified account.
 */
export async function approveOrgKybOnChain(input: {
  orgId: string;
  riskScore: number;
}): Promise<{ digest: string; businessAccountId: string; state: KybLifecycleState }> {
  const from = await readOrgKybState(input.orgId);
  // Idempotent re-approval of an already-active org is a no-op, not an error.
  if (from === 'ACTIVE') {
    return { digest: '', businessAccountId: await resolveBusinessAccountId(input.orgId), state: 'ACTIVE' };
  }

  if (from !== 'KYB_ADMIN_APPROVED') {
    await setOrgKybState(input.orgId, 'KYB_ADMIN_APPROVED', 'ADMIN');
  }

  const businessAccountId = await resolveBusinessAccountId(input.orgId);
  const { verifyBusinessOnSui } = await import('../server/sui-settlement.ts');
  const verified = await verifyBusinessOnSui({ businessAccountId, riskScore: input.riskScore });

  await setOrgKybState(input.orgId, 'ACTIVE', 'ADMIN');
  return { digest: verified.digest, businessAccountId, state: 'ACTIVE' };
}

/**
 * The org's on-chain BusinessAccount. Per-org first so verifying one tenant can
 * never flip another's account; the env value is a single-tenant fallback for
 * the demo workspace only.
 */
export async function resolveBusinessAccountId(orgId: string): Promise<string> {
  const db = await resolveDb();
  if (db) {
    const rows = await db
      .select({ id: organizations.suiBusinessAccountId })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    const stored = rows[0]?.id?.trim();
    if (stored) return stored;
  }

  const fallback = (process.env.SPLASH_BUSINESS_ACCOUNT_ID ?? '').trim();
  if (!fallback) {
    throw new Error(
      `No on-chain BusinessAccount for org ${orgId}. Set organizations.sui_business_account_id, ` +
      'or SPLASH_BUSINESS_ACCOUNT_ID for the single-tenant demo workspace.',
    );
  }
  return fallback;
}

/** Record the org's on-chain BusinessAccount object id (wallet spec §2.3). */
export async function setOrgBusinessAccountId(orgId: string, objectId: string): Promise<void> {
  const db = await resolveDb();
  if (!db) return;
  await db
    .update(organizations)
    .set({ suiBusinessAccountId: objectId, updatedAt: new Date() })
    .where(eq(organizations.id, orgId));
}
