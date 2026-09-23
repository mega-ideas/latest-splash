/**
 * Payout runs, in Postgres, belonging to somebody.
 *
 * A batch is a payroll run: many recipients paid under one authorization, one
 * settlement digest, one replay key. It lived in a `Map` on `globalThis`, so it
 * did not survive a restart — and the record an operator needs most, when a run
 * half-completes, is the one that vanished on deploy.
 *
 * ─── The replay key is the point ────────────────────────────────────────────
 *
 * `deriveIdempotencyKey` exists so the common accident — the response leg
 * drops, the dashboard shows "Batch failed", the operator re-submits the same
 * file — does not pay every recipient a second time out of the shared pool.
 *
 * That guard was a `Map` lookup. A restart between the two submissions emptied
 * it, and the retry paid everyone again. Restarts and retries are correlated:
 * a deploy is exactly when a request fails and an operator tries once more.
 *
 * And it was scoped by `account_id`, which is not a tenant key — an org without
 * a provisioned on-chain account falls back to a value shared with every other
 * such org (see drizzle/0008 and the ledger repository). Scoped by org here.
 *
 * `claim` inserts and lets the UNIQUE INDEX decide, rather than reading first
 * and then writing. Two submissions of the same file arriving together would
 * both find nothing and both insert — the exact double payment the key exists
 * to prevent, in the window a read-then-write leaves open.
 */
import { and, desc, eq } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';

import { batchRuns } from '../../db/schema.ts';
import type * as schemaModule from '../../db/schema.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DrizzleDb = PgDatabase<any, typeof schemaModule, any>;

export type BatchRunRow = {
  id: string;
  orgId: string;
  accountId?: string;
  state: string;
  rowCount: number;
  acceptedRows: number;
  blockedRows: number;
  totalAmount: string;
  targetCurrency?: string;
  idempotencyKey: string;
  digest: string | null;
  packageId: string | null;
  proposalId?: string;
  demo?: boolean;
  createdAt: string;
  updatedAt: string;
};

const DECIMALS = 6;

function toMinor(amount: string | null | undefined): bigint {
  const raw = (amount ?? '0').trim().replace(/,/g, '');
  if (raw.length === 0) return 0n;
  const negative = raw.startsWith('-');
  const [whole, frac = ''] = raw.replace(/^-/, '').split('.');
  const padded = (frac + '0'.repeat(DECIMALS)).slice(0, DECIMALS);
  const value = BigInt(whole || '0') * 10n ** BigInt(DECIMALS) + BigInt(padded || '0');
  return negative ? -value : value;
}

function fromMinor(value: bigint | null | undefined): string {
  if (value === null || value === undefined) return '0';
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const unit = 10n ** BigInt(DECIMALS);
  const frac = (abs % unit).toString().padStart(DECIMALS, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${abs / unit}${frac ? `.${frac}` : ''}`;
}

type BatchSelect = typeof batchRuns.$inferSelect;

function toRow(row: BatchSelect): BatchRunRow {
  return {
    id: row.id,
    orgId: row.orgId,
    accountId: row.accountId ?? undefined,
    state: row.state,
    rowCount: row.rowCount,
    acceptedRows: row.acceptedRows,
    blockedRows: row.blockedRows,
    totalAmount: fromMinor(row.totalAmountMinor),
    targetCurrency: row.targetCurrency ?? undefined,
    idempotencyKey: row.idempotencyKey,
    digest: row.digest,
    packageId: row.packageId,
    proposalId: row.proposalId ?? undefined,
    demo: row.demo,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export type NewBatchRun = Omit<BatchRunRow, 'createdAt' | 'updatedAt' | 'digest' | 'packageId'> & {
  digest?: string | null;
  packageId?: string | null;
};

/**
 * Claim this run's replay key, or hand back the run that already holds it.
 *
 * `{ claimed: false }` means this exact file was already submitted by this org
 * — the caller returns that run rather than paying everybody a second time.
 */
export async function claimBatchRun(
  db: DrizzleDb,
  input: NewBatchRun,
): Promise<{ claimed: boolean; run: BatchRunRow }> {
  const inserted = await db
    .insert(batchRuns)
    .values({
      id: input.id,
      orgId: input.orgId,
      accountId: input.accountId ?? null,
      state: input.state,
      rowCount: input.rowCount,
      acceptedRows: input.acceptedRows,
      blockedRows: input.blockedRows,
      totalAmountMinor: toMinor(input.totalAmount),
      currency: 'USD',
      targetCurrency: input.targetCurrency ?? null,
      idempotencyKey: input.idempotencyKey,
      digest: input.digest ?? null,
      packageId: input.packageId ?? null,
      proposalId: input.proposalId ?? null,
      demo: input.demo ?? false,
    })
    // The index decides, not a prior read. A conflict means somebody already
    // holds this key — including a request still in flight one millisecond ago.
    .onConflictDoNothing({ target: [batchRuns.orgId, batchRuns.idempotencyKey] })
    .returning();

  if (inserted.length > 0) return { claimed: true, run: toRow(inserted[0]) };

  const existing = await findByIdempotencyKey(db, input.orgId, input.idempotencyKey);
  if (!existing) {
    // The insert conflicted and yet nothing holds the key. Refuse rather than
    // guess: a batch that cannot prove it is not a duplicate must not settle.
    throw new Error('Batch idempotency key conflicted but no run holds it');
  }
  return { claimed: false, run: existing };
}

export async function findByIdempotencyKey(
  db: DrizzleDb,
  orgId: string,
  idempotencyKey: string,
): Promise<BatchRunRow | null> {
  const rows = await db
    .select()
    .from(batchRuns)
    .where(and(eq(batchRuns.orgId, orgId), eq(batchRuns.idempotencyKey, idempotencyKey)))
    .limit(1);
  return rows.length > 0 ? toRow(rows[0]) : null;
}

/** One run belonging to `orgId`. A foreign id reads as missing. */
export async function getBatchRun(
  db: DrizzleDb,
  orgId: string,
  batchId: string,
): Promise<BatchRunRow | null> {
  const rows = await db
    .select()
    .from(batchRuns)
    .where(and(eq(batchRuns.id, batchId), eq(batchRuns.orgId, orgId)))
    .limit(1);
  return rows.length > 0 ? toRow(rows[0]) : null;
}

/** Cross-tenant. The settlement callback, which holds a run it just created. */
export async function getBatchRunForStaff(
  db: DrizzleDb,
  batchId: string,
): Promise<BatchRunRow | null> {
  const rows = await db.select().from(batchRuns).where(eq(batchRuns.id, batchId)).limit(1);
  return rows.length > 0 ? toRow(rows[0]) : null;
}

export async function listBatchRuns(
  db: DrizzleDb,
  orgId: string,
  limit = 100,
): Promise<BatchRunRow[]> {
  const rows = await db
    .select()
    .from(batchRuns)
    .where(eq(batchRuns.orgId, orgId))
    .orderBy(desc(batchRuns.createdAt))
    .limit(limit);
  return rows.map(toRow);
}

/** Every tenant's runs, for the staff console. Named so it cannot be reached
 *  by accident. */
export async function listAllBatchRuns(db: DrizzleDb, limit = 200): Promise<BatchRunRow[]> {
  const rows = await db.select().from(batchRuns).orderBy(desc(batchRuns.createdAt)).limit(limit);
  return rows.map(toRow);
}

export async function patchBatchRun(
  db: DrizzleDb,
  batchId: string,
  patch: Partial<BatchRunRow>,
): Promise<BatchRunRow | null> {
  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.state !== undefined) update.state = patch.state;
  if (patch.digest !== undefined) update.digest = patch.digest;
  if (patch.packageId !== undefined) update.packageId = patch.packageId;
  if (patch.proposalId !== undefined) update.proposalId = patch.proposalId;
  if (patch.demo !== undefined) update.demo = patch.demo;

  const rows = await db.update(batchRuns).set(update).where(eq(batchRuns.id, batchId)).returning();
  return rows.length > 0 ? toRow(rows[0]) : null;
}

export const __testing = { toMinor, fromMinor };
