/**
 * Postgres access for intercompany transfers (Splash US → Splash Labuan).
 *
 * The record has always carried its amounts as decimal strings. The columns
 * are bigint micro units, so the conversion happens here, through
 * `lib/money.ts`, and a value that will not parse is refused rather than
 * rounded. What comes back is formatted at six places.
 */
import { desc, eq, gte, lt, and } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';

import { intercompanyTransfers } from '../../db/schema.ts';
import type * as schemaModule from '../../db/schema.ts';
import { MICRO_DECIMALS, formatMinor, parseMinor } from '../../money.ts';
import type { IntercompanyRecord } from '../intercompany.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DrizzleDb = PgDatabase<any, typeof schemaModule, any>;

type Select = typeof intercompanyTransfers.$inferSelect;
type Insert = typeof intercompanyTransfers.$inferInsert;

/** Decimal string to micro units. More than six places is a rounding decision
 *  the record never made, so it is made here explicitly: half-even. */
const toMicro = (amount: string) => parseMinor(amount || '0', MICRO_DECIMALS, 'half-even');

function toRecord(row: Select): IntercompanyRecord & { orgId: string } {
  return {
    id: row.id,
    orgId: row.orgId,
    transferIntentId: row.transferIntentId,
    amountUsd: formatMinor(row.amountUsdMicro, MICRO_DECIMALS),
    amountUsdc: formatMinor(row.amountUsdcMicro, MICRO_DECIMALS),
    usdToUsdcRate: row.usdToUsdcRate,
    maybankRef: row.maybankRef,
    labuanSettlementId: row.labuanSettlementId,
    state: row.state as IntercompanyRecord['state'],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function insertIntercompany(
  db: DrizzleDb,
  record: IntercompanyRecord & { orgId: string },
): Promise<IntercompanyRecord> {
  const [row] = await db
    .insert(intercompanyTransfers)
    .values({
      id: record.id,
      orgId: record.orgId,
      transferIntentId: record.transferIntentId,
      amountUsdMicro: toMicro(record.amountUsd),
      amountUsdcMicro: toMicro(record.amountUsdc),
      usdToUsdcRate: record.usdToUsdcRate,
      maybankRef: record.maybankRef,
      labuanSettlementId: record.labuanSettlementId,
      state: record.state,
      createdAt: new Date(record.createdAt),
      updatedAt: new Date(record.updatedAt),
    })
    .returning();
  return toRecord(row);
}

/** Lifecycle and settlement fields. The owner and the transfer it belongs to
 *  are what the row is, and a patch does not move them. */
export async function patchIntercompany(
  db: DrizzleDb,
  id: string,
  patch: Partial<IntercompanyRecord>,
): Promise<void> {
  const set: Partial<Insert> = { updatedAt: new Date() };
  if (patch.amountUsd !== undefined) set.amountUsdMicro = toMicro(patch.amountUsd);
  if (patch.amountUsdc !== undefined) set.amountUsdcMicro = toMicro(patch.amountUsdc);
  if (patch.usdToUsdcRate !== undefined) set.usdToUsdcRate = patch.usdToUsdcRate;
  if (patch.maybankRef !== undefined) set.maybankRef = patch.maybankRef;
  if (patch.labuanSettlementId !== undefined) set.labuanSettlementId = patch.labuanSettlementId;
  if (patch.state !== undefined) set.state = patch.state;
  await db.update(intercompanyTransfers).set(set).where(eq(intercompanyTransfers.id, id));
}

export async function getByTransfer(db: DrizzleDb, transferIntentId: string): Promise<IntercompanyRecord | null> {
  const rows = await db
    .select()
    .from(intercompanyTransfers)
    .where(eq(intercompanyTransfers.transferIntentId, transferIntentId))
    .limit(1);
  return rows.length > 0 ? toRecord(rows[0]) : null;
}

export async function listIntercompany(db: DrizzleDb, limit = 1000): Promise<IntercompanyRecord[]> {
  const rows = await db
    .select()
    .from(intercompanyTransfers)
    .orderBy(desc(intercompanyTransfers.createdAt))
    .limit(limit);
  return rows.map(toRecord);
}

/** Every row created on one UTC calendar day — the reconciliation's window. */
export async function listForDay(db: DrizzleDb, isoDate: string) {
  const start = new Date(`${isoDate}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return db
    .select({
      amountUsdMicro: intercompanyTransfers.amountUsdMicro,
      amountUsdcMicro: intercompanyTransfers.amountUsdcMicro,
    })
    .from(intercompanyTransfers)
    .where(and(gte(intercompanyTransfers.createdAt, start), lt(intercompanyTransfers.createdAt, end)));
}
