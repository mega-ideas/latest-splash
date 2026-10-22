/**
 * Postgres access for daily audit batches.
 *
 * A batch spans every tenant, so nothing here takes an org: the table has no
 * `org_id` (see migration 0031). Who may read is decided above this module —
 * the store's readers are `*ForStaff`, and the routes in front of them require
 * the staff session.
 *
 * ─── One batch per business date ────────────────────────────────────────────
 *
 * `recordDailyAuditBatch` inserts and lets the unique index on
 * `business_date` decide, then reads the day back. Two cron runs for the same
 * date — two instances, a retry, at the same moment — both get the batch that
 * was kept, never a second root for the day. Read-then-write would let both
 * read nothing and both write.
 */
import { desc, eq } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';

import { dailyAuditBatches } from '../../db/schema.ts';
import type * as schemaModule from '../../db/schema.ts';
import type { AuditBatchLeaf, DailyAuditBatch } from '../audit-batches.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DrizzleDb = PgDatabase<any, typeof schemaModule, any>;

type Select = typeof dailyAuditBatches.$inferSelect;

function toBatch(row: Select): DailyAuditBatch {
  return {
    id: row.id,
    date: row.businessDate,
    merkleRoot: row.merkleRoot,
    settlementCount: row.settlementCount,
    leaves: row.leaves as AuditBatchLeaf[],
    walrusBlobId: row.walrusBlobId,
    walrusMode: row.walrusMode as DailyAuditBatch['walrusMode'],
    sealPolicyId: row.sealPolicyId,
    sealMode: row.sealMode as DailyAuditBatch['sealMode'],
    ciphertextHash: row.ciphertextHash,
    anchorObjectId: row.anchorObjectId,
    anchorDigest: row.anchorDigest,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function readBatchByDate(db: DrizzleDb, date: string): Promise<DailyAuditBatch | null> {
  const rows = await db.select().from(dailyAuditBatches).where(eq(dailyAuditBatches.businessDate, date)).limit(1);
  return rows.length > 0 ? toBatch(rows[0]) : null;
}

export async function readBatchById(db: DrizzleDb, batchId: string): Promise<DailyAuditBatch | null> {
  const rows = await db.select().from(dailyAuditBatches).where(eq(dailyAuditBatches.id, batchId)).limit(1);
  return rows.length > 0 ? toBatch(rows[0]) : null;
}

/** Every batch, newest business date first. */
export async function listBatches(db: DrizzleDb, limit = 366): Promise<DailyAuditBatch[]> {
  const rows = await db.select().from(dailyAuditBatches).orderBy(desc(dailyAuditBatches.businessDate)).limit(limit);
  return rows.map(toBatch);
}

/**
 * Record the day's batch, or learn which one was recorded first. Always
 * returns the batch the database kept for `batch.date`.
 */
export async function recordDailyAuditBatch(db: DrizzleDb, batch: DailyAuditBatch): Promise<DailyAuditBatch> {
  await db
    .insert(dailyAuditBatches)
    .values({
      id: batch.id,
      businessDate: batch.date,
      merkleRoot: batch.merkleRoot,
      settlementCount: batch.settlementCount,
      leaves: batch.leaves,
      walrusBlobId: batch.walrusBlobId,
      walrusMode: batch.walrusMode,
      sealPolicyId: batch.sealPolicyId,
      sealMode: batch.sealMode,
      ciphertextHash: batch.ciphertextHash,
      anchorObjectId: batch.anchorObjectId,
      anchorDigest: batch.anchorDigest,
      createdAt: new Date(batch.createdAt),
      updatedAt: new Date(batch.createdAt),
    })
    // Any conflict: the id is derived from the date, so the primary key and
    // the business-date index guard the same thing.
    .onConflictDoNothing();
  const kept = await readBatchByDate(db, batch.date);
  if (!kept) throw new Error(`Daily audit batch for ${batch.date} was neither recorded nor found.`);
  return kept;
}
