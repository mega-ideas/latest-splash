import { eq, notInArray } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';

import { approvals, organizations, proposals } from './schema.ts';
import type * as schemaModule from './schema.ts';
import type { UnsignedProposal } from '../agent/types';

/**
 * W1 PR-B — proposal/approval persistence (the cold-start acceptance path).
 *
 * Pure Drizzle functions over an injected database handle so the SAME code
 * runs against DigitalOcean Postgres (node-postgres) in production and
 * pglite in tests. The in-memory store stays the hot read path; this repo
 * is the durable write-through + boot hydration source.
 *
 * UnsignedProposal carries bigint money fields inside explain/simulation —
 * JSON columns can't hold BigInt, so (de)serialization round-trips them
 * through a tagged encoding. Money NEVER becomes a float on this path.
 */

/** Both drizzle drivers satisfy PgDatabase — node-postgres (DigitalOcean)
 *  and pglite (tests) — so the repo runs identically against either. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DrizzleDb = PgDatabase<any, typeof schemaModule, any>;

const BIGINT_TAG = '__splash_bigint__:';

export function encodeJsonWithBigints(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? `${BIGINT_TAG}${v.toString()}` : v)));
}

export function decodeJsonWithBigints<T>(value: unknown): T {
  const revive = (v: unknown): unknown => {
    if (typeof v === 'string' && v.startsWith(BIGINT_TAG)) return BigInt(v.slice(BIGINT_TAG.length));
    if (Array.isArray(v)) return v.map(revive);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, inner] of Object.entries(v)) out[k] = revive(inner);
      return out;
    }
    return v;
  };
  return revive(value) as T;
}

/** Statuses that stay out of boot hydration — finished work. */
const TERMINAL_STATUSES = ['ANCHORED', 'REJECTED', 'FAILED', 'EXPIRED', 'REVERSED'];

export async function ensureOrganization(db: DrizzleDb, orgId: string): Promise<void> {
  await db
    .insert(organizations)
    .values({ id: orgId, name: orgId })
    .onConflictDoNothing();
}

/** Durable write-through: upsert the proposal row + replace its approvals,
 *  atomically. Called after every store mutation. */
export async function upsertProposal(db: DrizzleDb, proposal: UnsignedProposal): Promise<void> {
  await ensureOrganization(db, proposal.orgId);
  await db.transaction(async (tx) => {
    const row = {
      id: proposal.id,
      orgId: proposal.orgId,
      idempotencyKey: proposal.idempotencyKey,
      kind: proposal.kind,
      status: proposal.status,
      tier: proposal.tier,
      corridor: proposal.corridor ?? null,
      createdBy: proposal.createdBy,
      unsignedTxBytes: proposal.unsignedTxBytes ?? null,
      explain: encodeJsonWithBigints(proposal.explain),
      simulation: proposal.simulation ? encodeJsonWithBigints(proposal.simulation) : null,
      settlement: proposal.settlement ? encodeJsonWithBigints(proposal.settlement) : null,
      executionPayload: proposal.executionPayload
        ? encodeJsonWithBigints(proposal.executionPayload)
        : null,
      executionState: proposal.execution?.state ?? null,
      executionError: proposal.execution?.state === 'FAILED' ? proposal.execution.detail : null,
      requiredApprovers: proposal.explain.requiredApprovers,
      version: proposal.version ?? 1,
      approvalHash: proposal.approvalHash ?? null,
      expiresAt: proposal.expiresAt ? new Date(proposal.expiresAt) : null,
      updatedAt: new Date(),
    };
    await tx.insert(proposals).values(row).onConflictDoUpdate({ target: proposals.id, set: row });
    await tx.delete(approvals).where(eq(approvals.proposalId, proposal.id));
    if (proposal.approvals.length > 0) {
      await tx.insert(approvals).values(
        proposal.approvals.map((approval, index) => ({
          id: `${proposal.id}_appr_${index}_${approval.userId}`,
          proposalId: proposal.id,
          userId: approval.userId,
          role: approval.role,
          signatureRef: null,
          signedAt: new Date(approval.signedAt),
        })),
      );
    }
  });
}

function rowToProposal(row: typeof proposals.$inferSelect, approvalRows: (typeof approvals.$inferSelect)[]): UnsignedProposal {
  return {
    id: row.id,
    idempotencyKey: row.idempotencyKey,
    kind: row.kind,
    status: row.status,
    tier: row.tier,
    orgId: row.orgId,
    corridor: row.corridor ?? undefined,
    unsignedTxBytes: row.unsignedTxBytes ?? undefined,
    createdBy: row.createdBy,
    version: row.version ?? 1,
    approvalHash: row.approvalHash ?? undefined,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : undefined,
    approvals: approvalRows.map((approval) => ({
      userId: approval.userId,
      role: approval.role,
      signedAt: approval.signedAt.toISOString(),
    })),
    explain: decodeJsonWithBigints(row.explain),
    simulation: row.simulation ? decodeJsonWithBigints(row.simulation) : undefined,
    settlement: row.settlement ? decodeJsonWithBigints(row.settlement) : undefined,
    executionPayload: row.executionPayload
      ? decodeJsonWithBigints(row.executionPayload)
      : undefined,
  } as UnsignedProposal;
}

/** Boot hydration: every proposal still in flight (non-terminal). */
export async function loadOpenProposals(db: DrizzleDb): Promise<UnsignedProposal[]> {
  const rows: (typeof proposals.$inferSelect)[] = await db
    .select()
    .from(proposals)
    .where(notInArray(proposals.status, TERMINAL_STATUSES));
  const result: UnsignedProposal[] = [];
  for (const row of rows) {
    const approvalRows: (typeof approvals.$inferSelect)[] = await db
      .select()
      .from(approvals)
      .where(eq(approvals.proposalId, row.id));
    result.push(rowToProposal(row, approvalRows));
  }
  return result;
}
