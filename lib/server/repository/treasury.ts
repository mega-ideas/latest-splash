import 'server-only';

import { and, asc, eq, lte } from 'drizzle-orm';

import { treasuryAccrualState, treasuryLedgers, withdrawalNotices } from '@/lib/db/schema';

/**
 * Postgres access for treasury balances, withdrawal notices and the accrual
 * baseline.
 *
 * Amounts are `bigint` in the column and `bigint` here. The store above
 * converts at its boundary, because the existing `UserTreasuryLedger` API is in
 * `number` micro-USD and changing that would cascade through the quote engine
 * for no gain — a JS number holds micro-USD exactly up to ~$9 billion, which is
 * a ceiling worth stating and not worth engineering around today.
 */

export type LedgerRow = {
  orgId: string;
  availableMicro: bigint;
  treasuryPrincipalMicro: bigint;
  treasuryYieldMicro: bigint;
  updatedAt: Date;
};

export type NoticeRow = {
  id: string;
  orgId: string;
  amountMicro: bigint;
  requestedAt: Date;
  availableAt: Date;
  state: string;
};

type Db = { select: (...args: never[]) => never };
/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyDb = any;

const ACCRUAL_ROW = 'usdy';

export async function findLedger(db: Db, orgId: string): Promise<LedgerRow | null> {
  const rows = await (db as AnyDb)
    .select()
    .from(treasuryLedgers)
    .where(eq(treasuryLedgers.orgId, orgId))
    .limit(1);
  return (rows[0] as LedgerRow) ?? null;
}

export async function upsertLedger(db: Db, row: {
  orgId: string;
  availableMicro: bigint;
  treasuryPrincipalMicro: bigint;
  treasuryYieldMicro: bigint;
  updatedAt: Date;
}): Promise<void> {
  await (db as AnyDb)
    .insert(treasuryLedgers)
    .values(row)
    .onConflictDoUpdate({
      target: treasuryLedgers.orgId,
      set: {
        availableMicro: row.availableMicro,
        treasuryPrincipalMicro: row.treasuryPrincipalMicro,
        treasuryYieldMicro: row.treasuryYieldMicro,
        updatedAt: row.updatedAt,
      },
    });
}

/** Every org's ledger. Used by the accrual job, which pays yield to all of them. */
export async function listLedgersForStaff(db: Db): Promise<LedgerRow[]> {
  return (await (db as AnyDb).select().from(treasuryLedgers)) as LedgerRow[];
}

export async function insertNotice(db: Db, row: NoticeRow): Promise<void> {
  await (db as AnyDb).insert(withdrawalNotices).values(row);
}

export async function findNotice(db: Db, id: string): Promise<NoticeRow | null> {
  const rows = await (db as AnyDb)
    .select()
    .from(withdrawalNotices)
    .where(eq(withdrawalNotices.id, id))
    .limit(1);
  return (rows[0] as NoticeRow) ?? null;
}

export async function setNoticeState(db: Db, id: string, state: string): Promise<void> {
  await (db as AnyDb)
    .update(withdrawalNotices)
    .set({ state })
    .where(eq(withdrawalNotices.id, id));
}

export async function listNoticesForOrg(db: Db, orgId: string): Promise<NoticeRow[]> {
  return (await (db as AnyDb)
    .select()
    .from(withdrawalNotices)
    .where(eq(withdrawalNotices.orgId, orgId))
    .orderBy(asc(withdrawalNotices.requestedAt))) as NoticeRow[];
}

/** The settlement sweep: everything pending and due, across every tenant. */
export async function listDueNotices(db: Db, due: Date): Promise<NoticeRow[]> {
  return (await (db as AnyDb)
    .select()
    .from(withdrawalNotices)
    .where(
      and(eq(withdrawalNotices.state, 'PENDING'), lte(withdrawalNotices.availableAt, due)),
    )
    .orderBy(asc(withdrawalNotices.availableAt))) as NoticeRow[];
}

export async function listAllNoticesForStaff(db: Db): Promise<NoticeRow[]> {
  return (await (db as AnyDb)
    .select()
    .from(withdrawalNotices)
    .orderBy(asc(withdrawalNotices.requestedAt))) as NoticeRow[];
}

export async function readAccrualBaseline(db: Db): Promise<bigint | null> {
  const rows = await (db as AnyDb)
    .select()
    .from(treasuryAccrualState)
    .where(eq(treasuryAccrualState.id, ACCRUAL_ROW))
    .limit(1);
  return (rows[0]?.lastAccruedPriceMicros as bigint | null) ?? null;
}

export async function writeAccrualBaseline(db: Db, price: bigint | null): Promise<void> {
  await (db as AnyDb)
    .insert(treasuryAccrualState)
    .values({ id: ACCRUAL_ROW, lastAccruedPriceMicros: price, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: treasuryAccrualState.id,
      set: { lastAccruedPriceMicros: price, updatedAt: new Date() },
    });
}
