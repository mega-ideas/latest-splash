import { eq } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';

import { orgPolicies } from '../db/schema.ts';
import { ensureOrganization } from '../db/proposal-repo.ts';
import type * as schemaModule from '../db/schema.ts';
import type { OrgPolicy, ProposalKind } from '../agent/types.ts';

/**
 * Track A §1.2 — the org policy record is SERVER-OWNED. It is loaded from the
 * database when persistence is on, and from this module's explicit server-side
 * defaults when it is off (local demo without DATABASE_URL). It is never, in
 * any mode, accepted from a request body.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DrizzleDb = PgDatabase<any, typeof schemaModule, any>;

export class PolicyMissingError extends Error {
  constructor(orgId: string) {
    super(`no persisted policy record for org ${orgId} — refusing to default to permissive`);
    this.name = 'PolicyMissingError';
  }
}

const PROPOSAL_KINDS: ProposalKind[] = [
  'PAYMENT', 'INTERNAL_TRANSFER', 'FX_CONVERT', 'TREASURY_ALLOCATE',
  'TREASURY_REDEEM', 'BATCH_PAYOUT', 'NETTING_SETTLE', 'X402_PAYMENT',
];

/** The one server-side default, stated once. USD micro units. */
export function serverDefaultOrgPolicy(orgId: string): OrgPolicy {
  return {
    orgId,
    tier1ThresholdUsd: BigInt(5_000_000),
    dualApprovalThresholdUsd: BigInt(50_000_000),
    whitelistedAutoKinds: ['TREASURY_ALLOCATE'],
    operatingMinimumByCorridor: { MY_PH: BigInt(5_000_000_000) },
    perCorridorState: {},
    globalState: 'ARMED',
  };
}

function rowToPolicy(row: typeof orgPolicies.$inferSelect): OrgPolicy {
  const kinds = Array.isArray(row.whitelistedAutoKinds) ? row.whitelistedAutoKinds : [];
  const minimums = (row.operatingMinimumByCorridor ?? {}) as Record<string, string>;
  return {
    orgId: row.orgId,
    tier1ThresholdUsd: row.tier1ThresholdUsdMicro,
    dualApprovalThresholdUsd: row.dualApprovalThresholdUsdMicro,
    whitelistedAutoKinds: kinds.filter((kind): kind is ProposalKind => PROPOSAL_KINDS.includes(kind as ProposalKind)),
    operatingMinimumByCorridor: Object.fromEntries(
      Object.entries(minimums).map(([corridor, amount]) => [corridor, BigInt(amount)]),
    ),
    perCorridorState: (row.perCorridorState ?? {}) as Record<string, 'ARMED' | 'PAUSED'>,
    globalState: row.globalState === 'PAUSED' ? 'PAUSED' : 'ARMED',
  };
}

function policyToRow(policy: OrgPolicy) {
  return {
    orgId: policy.orgId,
    tier1ThresholdUsdMicro: policy.tier1ThresholdUsd,
    dualApprovalThresholdUsdMicro: policy.dualApprovalThresholdUsd,
    whitelistedAutoKinds: policy.whitelistedAutoKinds,
    operatingMinimumByCorridor: Object.fromEntries(
      Object.entries(policy.operatingMinimumByCorridor).map(([corridor, amount]) => [corridor, amount.toString()]),
    ),
    perCorridorState: policy.perCorridorState,
    globalState: policy.globalState,
  };
}

/**
 * Load the org's policy record. On the DB path a missing row is provisioned
 * ONCE from the server defaults (explicit, logged) — after that the database
 * row is the only authority. `db: null` is the DB-less demo path.
 */
export async function loadOrgPolicy(db: DrizzleDb | null, orgId: string): Promise<OrgPolicy> {
  if (!db) return serverDefaultOrgPolicy(orgId);

  const rows = await db.select().from(orgPolicies).where(eq(orgPolicies.orgId, orgId)).limit(1);
  if (rows.length > 0) return rowToPolicy(rows[0]);

  const seeded = serverDefaultOrgPolicy(orgId);
  console.warn(`[org-policy] provisioning server-default policy record for org ${orgId}`);
  await ensureOrganization(db, orgId);
  await db.insert(orgPolicies).values(policyToRow(seeded)).onConflictDoNothing();
  const reread = await db.select().from(orgPolicies).where(eq(orgPolicies.orgId, orgId)).limit(1);
  if (reread.length === 0) throw new PolicyMissingError(orgId);
  return rowToPolicy(reread[0]);
}
