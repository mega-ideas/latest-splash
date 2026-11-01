/**
 * The store behind scheduled batches (v2 Phase 3, migration 0069): schedules,
 * their runs, the payments of an automatic run, and a business's settings
 * (the kill switch and the daily limit).
 *
 * Every read and write takes the org. The runner's cross-tenant reads end in
 * `ForStaff`: they find the work, and the work is then done with the org's
 * own context. A schedule, run or payment of another business reads as absent.
 *
 * Money is bigint minor units (USDC, 6 decimals). Times are Dates; the
 * caller's clock is passed in, never read here.
 */
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { normalizeSuiAddress } from '@mysten/sui/utils';

import {
  paymentScheduleRunPayments,
  paymentScheduleRuns,
  paymentSchedules,
  scheduledPaymentSettings,
  walletApprovalAsks,
  walletBatchRows,
  walletBatches,
  walletSigningRequests,
  walletTransfers,
} from '../db/schema.ts';
import { GRACE_DEFAULT_MINUTES, type Cadence, type RunStatus, type ScheduleMode, type ScheduleStatus } from '../schedule/rules.ts';
import type { DrizzleDb } from './wallet-signing-store.ts';

/** A recipient and amount as an owner saved them. The address is what the run checks against. */
export type ScheduleItem = {
  position: number;
  payee: { kind: 'recipient'; recipientId: string } | { kind: 'splash_business'; businessId: string };
  name: string;
  address: string;
  country: string | null;
  amountMinor: string;
  reference: string;
  feeKind: number;
  /** The fee the owner was shown for this payment when they saved. */
  feeMinor: string;
};

export type ScheduleRow = typeof paymentSchedules.$inferSelect;
export type RunRow = typeof paymentScheduleRuns.$inferSelect;
export type RunPaymentRow = typeof paymentScheduleRunPayments.$inferSelect;
export type SettingsRow = typeof scheduledPaymentSettings.$inferSelect;

export function itemsOf(row: Pick<ScheduleRow, 'items'>): ScheduleItem[] {
  return Array.isArray(row.items) ? (row.items as ScheduleItem[]) : [];
}

// ─── Schedules ──────────────────────────────────────────────────────────────

export async function insertSchedule(db: DrizzleDb, row: typeof paymentSchedules.$inferInsert): Promise<void> {
  await db.insert(paymentSchedules).values(row);
}

export async function getSchedule(db: DrizzleDb, orgId: string, id: string): Promise<ScheduleRow | null> {
  const [row] = await db.select().from(paymentSchedules).where(and(eq(paymentSchedules.orgId, orgId), eq(paymentSchedules.id, id))).limit(1);
  return row ?? null;
}

export async function getScheduleByKey(db: DrizzleDb, orgId: string, clientKey: string): Promise<ScheduleRow | null> {
  const [row] = await db.select().from(paymentSchedules).where(and(eq(paymentSchedules.orgId, orgId), eq(paymentSchedules.clientKey, clientKey))).limit(1);
  return row ?? null;
}

/** This business's schedules, newest first. A deleted schedule is not listed. */
export async function listSchedules(db: DrizzleDb, orgId: string): Promise<ScheduleRow[]> {
  return db
    .select()
    .from(paymentSchedules)
    .where(and(eq(paymentSchedules.orgId, orgId), sql`${paymentSchedules.status} <> 'deleted'`))
    .orderBy(desc(paymentSchedules.createdAt))
    .limit(100);
}

export async function updateSchedule(
  db: DrizzleDb,
  orgId: string,
  id: string,
  patch: Partial<typeof paymentSchedules.$inferInsert>,
  guard: { from?: ScheduleStatus[] } = {},
): Promise<ScheduleRow | null> {
  const [row] = await db
    .update(paymentSchedules)
    .set(patch)
    .where(and(eq(paymentSchedules.orgId, orgId), eq(paymentSchedules.id, id), ...(guard.from ? [inArray(paymentSchedules.status, guard.from)] : [])))
    .returning();
  return row ?? null;
}

// ─── Runs ───────────────────────────────────────────────────────────────────

export async function getRun(db: DrizzleDb, orgId: string, id: string): Promise<RunRow | null> {
  const [row] = await db.select().from(paymentScheduleRuns).where(and(eq(paymentScheduleRuns.orgId, orgId), eq(paymentScheduleRuns.id, id))).limit(1);
  return row ?? null;
}

export async function getRunForDate(db: DrizzleDb, orgId: string, scheduleId: string, dueDate: string): Promise<RunRow | null> {
  const [row] = await db
    .select()
    .from(paymentScheduleRuns)
    .where(and(eq(paymentScheduleRuns.orgId, orgId), eq(paymentScheduleRuns.scheduleId, scheduleId), eq(paymentScheduleRuns.dueDate, dueDate)))
    .limit(1);
  return row ?? null;
}

/** Make the run for this schedule and due date once. Returns the row and whether this call made it. */
export async function insertRunOnce(db: DrizzleDb, row: typeof paymentScheduleRuns.$inferInsert): Promise<{ run: RunRow; created: boolean }> {
  const inserted = await db.insert(paymentScheduleRuns).values(row).onConflictDoNothing().returning();
  if (inserted[0]) return { run: inserted[0], created: true };
  const existing = (await getRunForDate(db, row.orgId, row.scheduleId, row.dueDate)) as RunRow;
  return { run: existing, created: false };
}

export async function listRuns(db: DrizzleDb, orgId: string, limit = 100): Promise<RunRow[]> {
  return db.select().from(paymentScheduleRuns).where(eq(paymentScheduleRuns.orgId, orgId)).orderBy(desc(paymentScheduleRuns.dueAt)).limit(limit);
}

export async function listRunsOf(db: DrizzleDb, orgId: string, scheduleId: string, limit = 20): Promise<RunRow[]> {
  return db
    .select()
    .from(paymentScheduleRuns)
    .where(and(eq(paymentScheduleRuns.orgId, orgId), eq(paymentScheduleRuns.scheduleId, scheduleId)))
    .orderBy(desc(paymentScheduleRuns.dueAt))
    .limit(limit);
}

/**
 * Change a run, only while it is in one of the states in `from`. Returns the
 * row when this call changed it, null when someone else already had.
 */
export async function moveRun(
  db: DrizzleDb,
  orgId: string,
  id: string,
  patch: Partial<typeof paymentScheduleRuns.$inferInsert>,
  from: RunStatus[],
): Promise<RunRow | null> {
  const [row] = await db
    .update(paymentScheduleRuns)
    .set(patch)
    .where(and(eq(paymentScheduleRuns.orgId, orgId), eq(paymentScheduleRuns.id, id), inArray(paymentScheduleRuns.status, from)))
    .returning();
  return row ?? null;
}

/** Run `fn` in a transaction holding a lock on `key` (released at the end), so two callers working under one key go one after the other. */
export async function withLock<T>(db: DrizzleDb, key: string, fn: (tx: DrizzleDb) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    const t = tx as unknown as DrizzleDb;
    await t.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
    return fn(t);
  });
}

/**
 * Move a run, only while it is in one of the states in `from` and none of its
 * payments has been claimed or paid. One statement under the lock claimPayment
 * takes, so a Skip and the first payment's claim cannot both succeed.
 */
export async function moveRunUnlessPaying(
  db: DrizzleDb,
  orgId: string,
  id: string,
  patch: Partial<typeof paymentScheduleRuns.$inferInsert>,
  from: RunStatus[],
): Promise<RunRow | null> {
  return withLock(db, `scheduled-run|${orgId}`, async (tx) => {
    const [row] = await tx
      .update(paymentScheduleRuns)
      .set(patch)
      .where(
        and(
          eq(paymentScheduleRuns.orgId, orgId),
          eq(paymentScheduleRuns.id, id),
          inArray(paymentScheduleRuns.status, from),
          sql`not exists (select 1 from ${paymentScheduleRunPayments} p where p.run_id = ${paymentScheduleRuns.id} and p.org_id = ${orgId} and p.status in ('submitting', 'paid'))`,
        ),
      )
      .returning();
    return row ?? null;
  });
}

/** Take the lease on a run that is waiting to be started. One caller wins; a lease older than `leaseMs` is free. */
export async function claimRun(db: DrizzleDb, orgId: string, id: string, now: Date, leaseMs: number): Promise<RunRow | null> {
  const [row] = await db
    .update(paymentScheduleRuns)
    .set({ claimedAt: now, updatedAt: now })
    .where(
      and(
        eq(paymentScheduleRuns.orgId, orgId),
        eq(paymentScheduleRuns.id, id),
        eq(paymentScheduleRuns.status, 'scheduled'),
        or(isNull(paymentScheduleRuns.claimedAt), lt(paymentScheduleRuns.claimedAt, new Date(now.getTime() - leaseMs))),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Announce a run's grace window, once: set when its first automatic payment may
 * be claimed and release the lease, only while the run is still waiting to start
 * and has no window. A second caller finds one and gets null. Another business's
 * run reads as absent.
 */
export async function openGraceWindow(db: DrizzleDb, orgId: string, id: string, input: { startsAt: Date; windowVersion: number; now: Date }): Promise<RunRow | null> {
  const [row] = await db
    .update(paymentScheduleRuns)
    .set({ startsAt: input.startsAt, windowVersion: input.windowVersion, claimedAt: null, updatedAt: input.now })
    .where(and(eq(paymentScheduleRuns.orgId, orgId), eq(paymentScheduleRuns.id, id), eq(paymentScheduleRuns.status, 'scheduled'), isNull(paymentScheduleRuns.startsAt)))
    .returning();
  return row ?? null;
}

/** Once only: stamp one of a run's notice columns. True when this call stamped it. */
export async function stampNotice(db: DrizzleDb, orgId: string, id: string, column: 'noticeDayBeforeAt' | 'noticeRunningAt' | 'noticeReceiptAt', now: Date): Promise<boolean> {
  const col = paymentScheduleRuns[column];
  const rows = await db
    .update(paymentScheduleRuns)
    .set({ [column]: now, updatedAt: now })
    .where(and(eq(paymentScheduleRuns.orgId, orgId), eq(paymentScheduleRuns.id, id), isNull(col)))
    .returning({ id: paymentScheduleRuns.id });
  return rows.length > 0;
}

/**
 * The schedule has had its run for `dueAt` made, so it moves on to the next
 * time it falls due, or finishes when there is none. Only if it is still
 * waiting on `dueAt`: a second caller finds it already moved.
 */
export async function advanceSchedule(db: DrizzleDb, sch: ScheduleRow, dueAt: Date, next: Date | null, now: Date): Promise<boolean> {
  const rows = await db
    .update(paymentSchedules)
    .set({ nextDueAt: next, status: next === null && sch.status === 'active' ? 'completed' : sch.status, updatedAt: now })
    .where(and(eq(paymentSchedules.orgId, sch.orgId), eq(paymentSchedules.id, sch.id), eq(paymentSchedules.nextDueAt, dueAt), sql`${paymentSchedules.status} in ('active', 'completed')`))
    .returning({ id: paymentSchedules.id });
  return rows.length > 0;
}

// ─── The payments of an automatic run ───────────────────────────────────────

export async function insertRunPayments(db: DrizzleDb, rows: Array<typeof paymentScheduleRunPayments.$inferInsert>): Promise<void> {
  if (rows.length > 0) await db.insert(paymentScheduleRunPayments).values(rows).onConflictDoNothing();
}

export async function listRunPayments(db: DrizzleDb, orgId: string, runId: string): Promise<RunPaymentRow[]> {
  return db
    .select()
    .from(paymentScheduleRunPayments)
    .where(and(eq(paymentScheduleRunPayments.orgId, orgId), eq(paymentScheduleRunPayments.runId, runId)))
    .orderBy(asc(paymentScheduleRunPayments.position));
}

/**
 * Claim one payment for sending, only while its run is still `approved` (an
 * owner's Skip moves the run, and this then finds nothing) and the payment is
 * still pending. The digest is written first, so a crash after this leaves a
 * row that is read back from the chain, never sent again.
 */
export async function claimPayment(
  db: DrizzleDb,
  orgId: string,
  id: string,
  input: { digest: string; gasBudgetMist: bigint; now: Date },
  /** Asked under the lock, just before the claim: false refuses it. Used to hold the claim to the business's 24-hour network-fee allowance atomically. */
  allow?: (tx: DrizzleDb) => Promise<boolean>,
): Promise<RunPaymentRow | null | 'refused'> {
  // Under the lock a Skip takes too: the two go one after the other, never at once, so a run cannot be skipped with a payment going out.
  return withLock(db, `scheduled-run|${orgId}`, async (tx) => {
    if (allow && !(await allow(tx))) return 'refused' as const;
    return claimPaymentIn(tx, orgId, id, input);
  });
}

async function claimPaymentIn(db: DrizzleDb, orgId: string, id: string, input: { digest: string; gasBudgetMist: bigint; now: Date }): Promise<RunPaymentRow | null> {
  const [row] = await db
    .update(paymentScheduleRunPayments)
    .set({ status: 'submitting', digest: input.digest, gasBudgetMist: input.gasBudgetMist, attemptedAt: input.now, updatedAt: input.now })
    .where(
      and(
        eq(paymentScheduleRunPayments.orgId, orgId),
        eq(paymentScheduleRunPayments.id, id),
        eq(paymentScheduleRunPayments.status, 'pending'),
        // No automatic payment is claimed inside the run's grace window: a run with a start waits for it, to the millisecond.
        sql`exists (select 1 from ${paymentScheduleRuns} r where r.id = ${paymentScheduleRunPayments.runId} and r.org_id = ${orgId} and r.status = 'approved' and (r.starts_at is null or r.starts_at <= ${input.now.toISOString()}::timestamptz))`,
      ),
    )
    .returning();
  return row ?? null;
}

export async function finishPayment(
  db: DrizzleDb,
  orgId: string,
  id: string,
  outcome: { status: 'paid' | 'failed'; digest?: string | null; error?: string | null; now: Date },
  from: Array<'pending' | 'submitting'> = ['submitting'],
): Promise<RunPaymentRow | null> {
  const [row] = await db
    .update(paymentScheduleRunPayments)
    .set({ status: outcome.status, ...(outcome.digest !== undefined ? { digest: outcome.digest } : {}), error: outcome.error ?? null, completedAt: outcome.now, updatedAt: outcome.now })
    .where(and(eq(paymentScheduleRunPayments.orgId, orgId), eq(paymentScheduleRunPayments.id, id), inArray(paymentScheduleRunPayments.status, from)))
    .returning();
  return row ?? null;
}

/**
 * Everything an automatic run paid, is paying, or has set aside to pay, from a
 * time on: the figure the daily limit is held to. A payment of a run that has
 * started but not yet gone out (pending) counts, so a second runner working
 * another schedule of the same business sees what the first has reserved.
 */
export async function autoPaidSince(db: DrizzleDb, orgId: string, since: Date): Promise<bigint> {
  const rows = await db
    .select({ amount: paymentScheduleRunPayments.amountMinor, fee: paymentScheduleRunPayments.maxFeeMinor })
    .from(paymentScheduleRunPayments)
    .where(
      and(
        eq(paymentScheduleRunPayments.orgId, orgId),
        or(
          and(inArray(paymentScheduleRunPayments.status, ['submitting', 'paid']), gte(paymentScheduleRunPayments.attemptedAt, since)),
          and(
            eq(paymentScheduleRunPayments.status, 'pending'),
            sql`exists (select 1 from ${paymentScheduleRuns} r where r.id = ${paymentScheduleRunPayments.runId} and r.org_id = ${orgId} and r.status = 'approved')`,
          ),
        ),
      ),
    );
  return rows.reduce((sum: bigint, r: { amount: bigint; fee: bigint }) => sum + r.amount + r.fee, 0n);
}

/** The gas, in MIST, automatic payments reserved from a time on: it counts toward the business's 24-hour network-fee allowance. */
export async function scheduledGasSince(db: DrizzleDb, orgId: string, since: Date): Promise<bigint> {
  const rows = await db
    .select({ total: sql<string>`coalesce(sum(${paymentScheduleRunPayments.gasBudgetMist}), 0)::text` })
    .from(paymentScheduleRunPayments)
    .where(and(eq(paymentScheduleRunPayments.orgId, orgId), isNotNull(paymentScheduleRunPayments.attemptedAt), gte(paymentScheduleRunPayments.attemptedAt, since)));
  return BigInt(String(rows[0]?.total ?? '0').split('.')[0]);
}

// ─── Settings ───────────────────────────────────────────────────────────────

export async function getSettings(db: DrizzleDb, orgId: string): Promise<SettingsRow | null> {
  const [row] = await db.select().from(scheduledPaymentSettings).where(eq(scheduledPaymentSettings.orgId, orgId)).limit(1);
  return row ?? null;
}

/** The business's grace window in minutes: what an owner set, or 10. */
export async function graceMinutesOf(db: DrizzleDb, orgId: string): Promise<number> {
  const s = await getSettings(db, orgId);
  return s?.graceMinutes ?? GRACE_DEFAULT_MINUTES;
}

export async function saveSettings(
  db: DrizzleDb,
  orgId: string,
  patch: { autoPaused?: boolean; pausedBy?: string | null; pausedAt?: Date | null; dailyCapMinor?: bigint | null; pendingDailyCapMinor?: bigint | null; pendingCapRequestId?: string | null; graceMinutes?: number },
  now: Date,
): Promise<SettingsRow> {
  const values = { orgId, ...patch, createdAt: now, updatedAt: now };
  const [row] = await db
    .insert(scheduledPaymentSettings)
    .values(values)
    .onConflictDoUpdate({ target: scheduledPaymentSettings.orgId, set: { ...patch, updatedAt: now } })
    .returning();
  return row;
}

/**
 * The daily limit in force, and one asked for that is waiting for signatures.
 * A limit asked for becomes the limit only when its signing request executes;
 * a request that ended any other way drops it. (Idempotent: whoever reads it
 * settles it.) `capMinor` is null when the owners have never set one.
 */
export async function dailyCapOf(db: DrizzleDb, orgId: string): Promise<{ capMinor: bigint | null; pending: { capMinor: bigint; requestId: string } | null }> {
  const s = await getSettings(db, orgId);
  if (!s || s.pendingCapRequestId == null || s.pendingDailyCapMinor == null) return { capMinor: s?.dailyCapMinor ?? null, pending: null };
  const [req] = await db
    .select({ status: walletSigningRequests.status })
    .from(walletSigningRequests)
    .where(and(eq(walletSigningRequests.orgId, orgId), eq(walletSigningRequests.id, s.pendingCapRequestId)))
    .limit(1);
  const now = new Date();
  const mine = and(eq(scheduledPaymentSettings.orgId, orgId), eq(scheduledPaymentSettings.pendingCapRequestId, s.pendingCapRequestId));
  if (req?.status === 'executed') {
    await db.update(scheduledPaymentSettings).set({ dailyCapMinor: s.pendingDailyCapMinor, pendingDailyCapMinor: null, pendingCapRequestId: null, updatedAt: now }).where(mine);
    return { capMinor: s.pendingDailyCapMinor, pending: null };
  }
  if (!req || req.status === 'failed' || req.status === 'expired' || req.status === 'cancelled') {
    await db.update(scheduledPaymentSettings).set({ pendingDailyCapMinor: null, pendingCapRequestId: null, updatedAt: now }).where(mine);
    return { capMinor: s.dailyCapMinor ?? null, pending: null };
  }
  return { capMinor: s.dailyCapMinor ?? null, pending: { capMinor: s.pendingDailyCapMinor, requestId: s.pendingCapRequestId } };
}

// ─── Has this address been paid before? ─────────────────────────────────────

/**
 * Has this business already paid this address, and had it arrive? A transfer
 * the owners signed, an ask they approved, a batch that executed, or an
 * earlier scheduled payment. A first payment to a new recipient is never made
 * automatically, so an automatic run asks this of every payee.
 */
export async function paidBefore(db: DrizzleDb, orgId: string, address: string): Promise<boolean> {
  const a = normalizeSuiAddress(address);
  const signed = await db
    .select({ id: walletTransfers.id })
    .from(walletTransfers)
    .innerJoin(walletSigningRequests, and(eq(walletSigningRequests.id, walletTransfers.signingRequestId), eq(walletSigningRequests.orgId, walletTransfers.orgId)))
    .where(and(eq(walletTransfers.orgId, orgId), eq(walletTransfers.address, a), eq(walletSigningRequests.status, 'executed')))
    .limit(1);
  if (signed.length > 0) return true;
  const asked = await db
    .select({ id: walletTransfers.id })
    .from(walletTransfers)
    .innerJoin(walletApprovalAsks, and(eq(walletApprovalAsks.id, walletTransfers.askId), eq(walletApprovalAsks.orgId, walletTransfers.orgId)))
    .where(and(eq(walletTransfers.orgId, orgId), eq(walletTransfers.address, a), eq(walletApprovalAsks.status, 'approved')))
    .limit(1);
  if (asked.length > 0) return true;
  const batched = await db
    .select({ id: walletBatchRows.id })
    .from(walletBatchRows)
    .innerJoin(walletBatches, and(eq(walletBatches.id, walletBatchRows.batchId), eq(walletBatches.orgId, walletBatchRows.orgId)))
    .innerJoin(walletSigningRequests, and(eq(walletSigningRequests.id, walletBatches.signingRequestId), eq(walletSigningRequests.orgId, walletBatches.orgId)))
    .where(and(eq(walletBatchRows.orgId, orgId), eq(walletBatchRows.address, a), eq(walletSigningRequests.status, 'executed')))
    .limit(1);
  if (batched.length > 0) return true;
  const scheduled = await db
    .select({ id: paymentScheduleRunPayments.id })
    .from(paymentScheduleRunPayments)
    .where(and(eq(paymentScheduleRunPayments.orgId, orgId), eq(paymentScheduleRunPayments.address, a), eq(paymentScheduleRunPayments.status, 'paid')))
    .limit(1);
  return scheduled.length > 0;
}

// ─── Cross-tenant, for the runner only ──────────────────────────────────────

/**
 * Schedules that are active and whose next due time is within `horizonMs` of
 * `now` (or already past): the ones the runner has something to do for.
 * Cross-tenant by design; it returns ids, and each is then worked on with its
 * own org's context.
 */
export async function listDueSchedulesForStaff(db: DrizzleDb, now: Date, horizonMs: number): Promise<Array<{ id: string; orgId: string }>> {
  return db
    .select({ id: paymentSchedules.id, orgId: paymentSchedules.orgId })
    .from(paymentSchedules)
    .where(and(eq(paymentSchedules.status, 'active'), isNotNull(paymentSchedules.nextDueAt), lte(paymentSchedules.nextDueAt, new Date(now.getTime() + horizonMs))))
    .orderBy(asc(paymentSchedules.nextDueAt))
    .limit(500);
}

/** Runs that still have work: waiting to start, waiting for approval, or being paid. Cross-tenant, ids only. */
export async function listOpenRunsForStaff(db: DrizzleDb): Promise<Array<{ id: string; orgId: string; status: RunStatus }>> {
  const rows = await db
    .select({ id: paymentScheduleRuns.id, orgId: paymentScheduleRuns.orgId, status: paymentScheduleRuns.status })
    .from(paymentScheduleRuns)
    .where(inArray(paymentScheduleRuns.status, ['scheduled', 'waiting_approval', 'approved']))
    .orderBy(asc(paymentScheduleRuns.dueAt))
    .limit(1000);
  return rows as Array<{ id: string; orgId: string; status: RunStatus }>;
}

export type { Cadence, ScheduleMode };
