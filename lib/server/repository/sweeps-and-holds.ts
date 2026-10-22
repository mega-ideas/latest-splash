/**
 * Postgres access for sweep jobs and rate holds.
 *
 * Same shape as the other repositories: this module knows the tables, the
 * store above it (`lib/server/operations.ts`) knows the rules. Records come
 * back in the shape the in-memory store always handed out, so no caller learns
 * which backend answered.
 *
 * ─── Money ──────────────────────────────────────────────────────────────────
 *
 * `amount_usdc_micro` is a bigint column. The record keeps the JS `number` it
 * has always had — routes return it as JSON, and a bigint does not serialise —
 * so the conversion happens here, at the boundary, and refuses anything that
 * is not a safe integer rather than rounding it.
 */
import { and, desc, eq, lte } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';

import { rateHolds, sweepJobs } from '../../db/schema.ts';
import type * as schemaModule from '../../db/schema.ts';
import type { RateHold, SweepJob } from '../operations.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DrizzleDb = PgDatabase<any, typeof schemaModule, any>;

type SweepSelect = typeof sweepJobs.$inferSelect;
type HoldSelect = typeof rateHolds.$inferSelect;

function toMicroColumn(value: number): bigint {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Sweep amount must be an integer number of micro units, got ${value}`);
  }
  return BigInt(value);
}

function fromMicroColumn(value: bigint): number {
  const asNumber = Number(value);
  if (!Number.isSafeInteger(asNumber)) {
    throw new Error(`Sweep amount ${value} is beyond what this record can carry exactly`);
  }
  return asNumber;
}

const iso = (value: Date | null | undefined) => (value ? value.toISOString() : undefined);

function toSweepJob(row: SweepSelect): SweepJob {
  return {
    id: row.id,
    orgId: row.orgId,
    transferIntentId: row.transferIntentId,
    recipientId: row.recipientId,
    partner: row.partner as SweepJob['partner'],
    amountUsdcMicro: fromMicroColumn(row.amountUsdcMicro),
    targetCurrency: row.targetCurrency,
    fxRate: row.fxRate,
    state: row.state as SweepJob['state'],
    heldDurationMs: row.heldDurationMs ?? undefined,
    partnerPayoutRef: row.partnerPayoutRef ?? undefined,
    createdAt: row.createdAt.toISOString(),
    completedAt: iso(row.completedAt),
    demo: row.demo || undefined,
  };
}

export async function insertSweepJob(db: DrizzleDb, job: SweepJob): Promise<SweepJob> {
  const [row] = await db
    .insert(sweepJobs)
    .values({
      id: job.id,
      orgId: job.orgId,
      transferIntentId: job.transferIntentId,
      recipientId: job.recipientId,
      partner: job.partner,
      amountUsdcMicro: toMicroColumn(job.amountUsdcMicro),
      targetCurrency: job.targetCurrency,
      fxRate: job.fxRate,
      state: job.state,
      heldDurationMs: job.heldDurationMs ?? null,
      partnerPayoutRef: job.partnerPayoutRef ?? null,
      completedAt: job.completedAt ? new Date(job.completedAt) : null,
      demo: job.demo ?? false,
      createdAt: new Date(job.createdAt),
    })
    .returning();
  return toSweepJob(row);
}

/**
 * The lifecycle fields only. The amount, the partner, the transfer and the
 * owner are what the job IS; a patch that could rewrite them would let a
 * status update change what is being paid out.
 */
export async function patchSweepJob(
  db: DrizzleDb,
  jobId: string,
  patch: Partial<SweepJob>,
): Promise<SweepJob | null> {
  const set: Partial<typeof sweepJobs.$inferInsert> = { updatedAt: new Date() };
  if (patch.state !== undefined) set.state = patch.state;
  if (patch.heldDurationMs !== undefined) set.heldDurationMs = patch.heldDurationMs;
  if (patch.partnerPayoutRef !== undefined) set.partnerPayoutRef = patch.partnerPayoutRef;
  if (patch.completedAt !== undefined) set.completedAt = new Date(patch.completedAt);
  if (patch.fxRate !== undefined) set.fxRate = patch.fxRate;
  const rows = await db.update(sweepJobs).set(set).where(eq(sweepJobs.id, jobId)).returning();
  return rows.length > 0 ? toSweepJob(rows[0]) : null;
}

export async function getSweepJob(db: DrizzleDb, jobId: string): Promise<SweepJob | null> {
  const rows = await db.select().from(sweepJobs).where(eq(sweepJobs.id, jobId)).limit(1);
  return rows.length > 0 ? toSweepJob(rows[0]) : null;
}

export async function listSweepJobs(db: DrizzleDb, limit = 500): Promise<SweepJob[]> {
  const rows = await db.select().from(sweepJobs).orderBy(desc(sweepJobs.createdAt)).limit(limit);
  return rows.map(toSweepJob);
}

// ── Rate holds ──────────────────────────────────────────────────────────────

function toRateHold(row: HoldSelect): RateHold {
  return {
    id: row.id,
    orgId: row.orgId,
    corridorCurrency: row.corridorCurrency,
    rate: row.rate,
    feeBps: row.feeBps,
    holdUntil: row.holdUntil.toISOString(),
    scheduledExecuteAt: iso(row.scheduledExecuteAt),
    alertRule: (row.alertRule ?? undefined) as RateHold['alertRule'],
    state: row.state as RateHold['state'],
    transferIntentId: row.transferIntentId ?? undefined,
    demo: row.demo || undefined,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function insertRateHold(db: DrizzleDb, hold: RateHold & { orgId: string }): Promise<RateHold> {
  const [row] = await db
    .insert(rateHolds)
    .values({
      id: hold.id,
      orgId: hold.orgId,
      corridorCurrency: hold.corridorCurrency,
      rate: hold.rate,
      feeBps: hold.feeBps,
      holdUntil: new Date(hold.holdUntil),
      scheduledExecuteAt: hold.scheduledExecuteAt ? new Date(hold.scheduledExecuteAt) : null,
      alertRule: hold.alertRule ?? null,
      state: hold.state,
      transferIntentId: hold.transferIntentId ?? null,
      demo: hold.demo ?? false,
      createdAt: new Date(hold.createdAt),
    })
    .returning();
  return toRateHold(row);
}

/**
 * Mark every ACTIVE hold whose time has passed as EXPIRED.
 *
 * The in-memory list did this on read, in place. Here it is one UPDATE, so
 * every instance agrees on which holds are still good.
 */
export async function expireRateHolds(db: DrizzleDb, now = new Date()): Promise<void> {
  await db
    .update(rateHolds)
    .set({ state: 'EXPIRED', updatedAt: now })
    .where(and(eq(rateHolds.state, 'ACTIVE'), lte(rateHolds.holdUntil, now)));
}

/** Every tenant's holds. Staff console only. */
export async function listRateHolds(db: DrizzleDb, limit = 500): Promise<RateHold[]> {
  const rows = await db.select().from(rateHolds).orderBy(desc(rateHolds.createdAt)).limit(limit);
  return rows.map(toRateHold);
}

export async function listRateHoldsFor(db: DrizzleDb, orgId: string, limit = 200): Promise<RateHold[]> {
  const rows = await db
    .select()
    .from(rateHolds)
    .where(eq(rateHolds.orgId, orgId))
    .orderBy(desc(rateHolds.createdAt))
    .limit(limit);
  return rows.map(toRateHold);
}

export async function getRateHoldFor(db: DrizzleDb, orgId: string, holdId: string): Promise<RateHold | null> {
  const rows = await db
    .select()
    .from(rateHolds)
    .where(and(eq(rateHolds.id, holdId), eq(rateHolds.orgId, orgId)))
    .limit(1);
  return rows.length > 0 ? toRateHold(rows[0]) : null;
}
