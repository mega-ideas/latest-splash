import { and, eq, inArray, isNull, notInArray, or, sql } from 'drizzle-orm';
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
 *  atomically. Called after every store mutation.
 *
 *  `executed_at` is deliberately NOT in the row: it is the single-use marker
 *  `claimProposalExecution` sets, and the in-memory proposal does not know it.
 *  Writing it from here would clear the marker on the next mutation and let
 *  one approval release a second payment. */
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

export type ExecutionClaim = 'claimed' | 'already-claimed' | 'missing';

/**
 * Spend an approved proposal's authority — once.
 *
 * An approval releases ONE payment. The replay that carries it out can run
 * more than once: a duplicate webhook delivery, two approvers answering
 * together, two instances holding the same proposal. The transfer route has no
 * idempotency key of its own, so without this a second replay pays again.
 *
 * The `isNull(executedAt)` in the UPDATE's WHERE clause is the guarantee, the
 * same shape as `recordDecision`'s: two replays arriving together would both
 * pass a prior read, and exactly one of them can win this write.
 *
 * `missing` means the row is not there for this org — a write-through that
 * failed, or a proposal from somewhere else. The caller refuses either way.
 */
export async function claimProposalExecution(
  db: DrizzleDb,
  input: { proposalId: string; orgId: string; at: Date },
): Promise<ExecutionClaim> {
  const scope = and(eq(proposals.id, input.proposalId), eq(proposals.orgId, input.orgId));
  const claimed = await db
    .update(proposals)
    .set({ executedAt: input.at, updatedAt: input.at })
    .where(and(scope, isNull(proposals.executedAt)))
    .returning({ id: proposals.id });
  if (claimed.length > 0) return 'claimed';

  const existing = await db
    .select({ executedAt: proposals.executedAt })
    .from(proposals)
    .where(scope)
    .limit(1);
  return existing[0]?.executedAt ? 'already-claimed' : 'missing';
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
    // Read back as well as written. Without it, a proposal carried out before
    // a restart came back with no outcome: a failed attempt read the same as
    // one still in flight. Only a failure's detail is stored; `executed_at` is
    // read here and never written by `upsertProposal` (see above).
    execution: row.executionState
      ? {
          state: row.executionState as NonNullable<UnsignedProposal['execution']>['state'],
          detail: row.executionError ?? '',
          at: (row.executedAt ?? row.updatedAt).toISOString(),
        }
      : undefined,
  } as UnsignedProposal;
}

/**
 * Every proposal in `orgId` whose idempotency key is `baseKey` or begins
 * `baseKey#` — the candidates for that payment's key generations
 * (lib/queue/proposal-state.ts), whatever their status.
 *
 * Boot hydration loads only open proposals, but the unique index on
 * (org_id, idempotency_key) holds the finished ones too, so the generation a
 * new proposal takes has to be decided against this, not the hot store alone.
 * `starts_with` rather than LIKE: a key carries free text, and LIKE would read
 * a payee name's `%` or `_` as a wildcard.
 */
export async function loadProposalKeyFamily(
  db: DrizzleDb,
  orgId: string,
  baseKey: string,
): Promise<UnsignedProposal[]> {
  const rows: (typeof proposals.$inferSelect)[] = await db
    .select()
    .from(proposals)
    .where(
      and(
        eq(proposals.orgId, orgId),
        or(eq(proposals.idempotencyKey, baseKey), sql`starts_with(${proposals.idempotencyKey}, ${`${baseKey}#`})`),
      ),
    );
  if (rows.length === 0) return [];
  const approvalRows: (typeof approvals.$inferSelect)[] = await db
    .select()
    .from(approvals)
    .where(
      inArray(
        approvals.proposalId,
        rows.map((row) => row.id),
      ),
    );
  return rows.map((row) => rowToProposal(row, approvalRows.filter((approval) => approval.proposalId === row.id)));
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
