import { and, asc, eq, isNull, notInArray, type SQL } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';

import { approvals, consumedApprovals, organizations, proposals } from './schema.ts';
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

/**
 * Statuses a proposal has finished in. With `execution_state IS NULL` (nothing
 * recorded as carried out), the complement is a proposal still in flight:
 * `isProposalInFlight` in lib/queue/proposal-state.ts, and the predicate of the
 * partial unique index `proposals_open_idempotency_unique` (drizzle/0025).
 * tests/proposal-idempotency.test.mjs holds the three to one another.
 */
const FINISHED_STATUSES = ['ANCHORED', 'REJECTED', 'FAILED', 'EXPIRED', 'REVERSED', 'SETTLED'];

function inFlight(): SQL {
  return and(notInArray(proposals.status, FINISHED_STATUSES), isNull(proposals.executionState))!;
}

/** Create the org row if it is missing. For the paths that create a tenant on
 *  purpose (an administrative grant, policy seeding for a member's own org) —
 *  never for an id that arrived with a proposal. */
export async function ensureOrganization(db: DrizzleDb, orgId: string): Promise<void> {
  await db
    .insert(organizations)
    .values({ id: orgId, name: orgId })
    .onConflictDoNothing();
}

/**
 * Durable write-through: upsert the proposal row + replace its approvals,
 * atomically. Called after every store mutation.
 *
 * The org must already exist. This used to call ensureOrganization first,
 * which made writing a proposal a way to create a tenant: Zeke's tools took
 * `orgId` from the model, so any string it produced — a guess,
 * 'demo-business', or another company's `org-<domain>` id that a later signup
 * from that domain would land in — became an organizations row with
 * proposals already filed under it. Now the FK refuses the write, and the
 * store reports it through `writeFailed`.
 */
export async function upsertProposal(db: DrizzleDb, proposal: UnsignedProposal): Promise<void> {
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

/**
 * Spend a proposal's approval: true for exactly one caller, ever.
 *
 * An insert against the primary key, so the database decides — two processes
 * acting on the same approval at once cannot both win, and nothing on the
 * write-through path can clear it afterwards.
 */
export async function consumeApprovalRecord(
  db: DrizzleDb,
  input: { proposalId: string; orgId: string; consumedBy: string; consumedAt?: Date },
): Promise<boolean> {
  const rows = await db
    .insert(consumedApprovals)
    .values({
      proposalId: input.proposalId,
      orgId: input.orgId,
      consumedBy: input.consumedBy,
      consumedAt: input.consumedAt ?? new Date(),
    })
    .onConflictDoNothing({ target: consumedApprovals.proposalId })
    .returning({ proposalId: consumedApprovals.proposalId });
  return rows.length === 1;
}

type ProposalRow = typeof proposals.$inferSelect;
type ApprovalRow = typeof approvals.$inferSelect;

/** In-flight proposals matching `where`, each with its approvals, in one
 *  statement: one consistent read, however many there are. */
async function loadInFlight(db: DrizzleDb, where: SQL): Promise<UnsignedProposal[]> {
  const rows: { proposal: ProposalRow; approval: ApprovalRow | null }[] = await db
    .select({ proposal: proposals, approval: approvals })
    .from(proposals)
    .leftJoin(approvals, eq(approvals.proposalId, proposals.id))
    .where(where)
    .orderBy(asc(proposals.createdAt), asc(proposals.id), asc(approvals.signedAt), asc(approvals.id));
  const grouped = new Map<string, { row: ProposalRow; approvals: ApprovalRow[] }>();
  for (const { proposal, approval } of rows) {
    const entry = grouped.get(proposal.id) ?? { row: proposal, approvals: [] };
    if (approval) entry.approvals.push(approval);
    grouped.set(proposal.id, entry);
  }
  return [...grouped.values()].map(({ row, approvals: approvalRows }) => rowToProposal(row, approvalRows));
}

/**
 * Boot hydration: every proposal still in flight.
 *
 * It was every non-terminal proposal, then one more query per proposal for its
 * approvals. Non-terminal took in each approval ever carried out (SUBMITTED,
 * with an outcome recorded, is where they rest) and every draft nobody acted
 * on, so the boot read grew with the table's history. Now it is the work in
 * flight, in one statement. Anything past its expiry is lapsed when the store
 * takes it (InMemoryProposalStore.hydrate), and the lapse is written back, so
 * it does not come back on the next boot.
 */
export async function loadOpenProposals(db: DrizzleDb): Promise<UnsignedProposal[]> {
  return loadInFlight(db, inFlight());
}

/**
 * The proposal in flight for one payment, if there is one. At most one: the
 * partial unique index allows no more, and this reads through it.
 */
export async function loadOpenProposalByKey(
  db: DrizzleDb,
  orgId: string,
  idempotencyKey: string,
): Promise<UnsignedProposal | null> {
  const found = await loadInFlight(
    db,
    and(inFlight(), eq(proposals.orgId, orgId), eq(proposals.idempotencyKey, idempotencyKey))!,
  );
  return found[0] ?? null;
}
