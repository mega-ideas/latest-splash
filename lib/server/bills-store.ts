/**
 * Supplier invoices the business pays (v2 brief 5.8; migration 0057). The
 * one way to read or write `payable_invoices`.
 *
 * Scope (WS2): every function takes the org, every query filters on it, and
 * another org's row reads as missing. There is no in-memory fallback: with no
 * DATABASE_URL the routes refuse (lib/server/bills-route.ts).
 *
 * Every status change is a guarded UPDATE on the status it leaves, so two
 * requests that race cannot both move it, and a closed invoice (paid,
 * cancelled) never changes again. `history` is appended to in the same
 * statement, never rewritten.
 */
import { randomUUID } from 'node:crypto';

import { and, desc, eq, inArray, isNull, ne, sql, type SQL } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';

import type { BillStatus } from '../bills/flow.ts';
import type { BillExtraction } from '../bills/extract.ts';
import { payableInvoices } from '../db/schema.ts';
import type * as schemaModule from '../db/schema.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type BillsDb = PgDatabase<any, typeof schemaModule, any>;

export type BillHistoryEntry = { at: string; by: string; action: string; note?: string };

export type BillRow = {
  id: string;
  orgId: string;
  intakeKey: string;
  status: BillStatus;
  documentName: string | null;
  documentSha256: string;
  documentText: string | null;
  extraction: BillExtraction;
  payeeName: string | null;
  payeeKey: string | null;
  invoiceNumber: string | null;
  invoiceNumberKey: string | null;
  amountMinor: bigint | null;
  currency: string | null;
  dueDate: string | null;
  invoiceDate: string | null;
  payeeCountry: string | null;
  confirmedBy: string | null;
  confirmedAt: Date | null;
  duplicateAckBy: string | null;
  duplicateAckReason: string | null;
  duplicateAckAt: Date | null;
  recipientId: string | null;
  matchedBy: string | null;
  matchedAt: Date | null;
  scheduledFor: string | null;
  scheduledBy: string | null;
  scheduledAt: Date | null;
  paymentIntentId: string | null;
  approvalRequestedBy: string | null;
  approvalRequestedAt: Date | null;
  paidAt: Date | null;
  suiDigest: string | null;
  receiptNo: string | null;
  approvers: string[] | null;
  myinvois: Record<string, unknown> | null;
  myinvoisSha256: string | null;
  myinvoisGeneratedAt: Date | null;
  myinvoisGeneratedBy: string | null;
  history: BillHistoryEntry[];
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
};

type Select = typeof payableInvoices.$inferSelect;
type Patch = Partial<Omit<typeof payableInvoices.$inferInsert, 'id' | 'orgId' | 'history' | 'createdAt'>>;

function toRow(row: Select): BillRow {
  return {
    ...row,
    status: row.status as BillStatus,
    extraction: row.extraction as BillExtraction,
    amountMinor: row.amountMinor === null ? null : BigInt(row.amountMinor),
    approvers: (row.approvers as string[] | null) ?? null,
    myinvois: (row.myinvois as Record<string, unknown> | null) ?? null,
    history: (row.history as BillHistoryEntry[]) ?? [],
  };
}

export function uniqueViolation(error: unknown): boolean {
  const codes = [(error as { code?: string })?.code, (error as { cause?: { code?: string } })?.cause?.code];
  return codes.includes('23505');
}

export type NewBill = {
  orgId: string;
  intakeKey: string;
  documentName: string | null;
  documentSha256: string;
  documentText: string | null;
  extraction: BillExtraction;
  createdBy: string;
  at: Date;
};

/** Insert, or `null` when a unique index (intake key, open document) already holds one. */
export async function insertBill(db: BillsDb, input: NewBill): Promise<BillRow | null> {
  try {
    const [row] = await db.insert(payableInvoices).values({
      id: `bill_${randomUUID()}`,
      orgId: input.orgId,
      intakeKey: input.intakeKey,
      status: 'review',
      documentName: input.documentName,
      documentSha256: input.documentSha256,
      documentText: input.documentText,
      extraction: input.extraction,
      history: [{ at: input.at.toISOString(), by: input.createdBy, action: 'intake' }],
      createdBy: input.createdBy,
      createdAt: input.at,
      updatedAt: input.at,
    }).returning();
    return toRow(row);
  } catch (error) {
    if (uniqueViolation(error)) return null;
    throw error;
  }
}

export async function readBill(db: BillsDb, orgId: string, id: string): Promise<BillRow | null> {
  const [row] = await db.select().from(payableInvoices).where(and(eq(payableInvoices.orgId, orgId), eq(payableInvoices.id, id))).limit(1);
  return row ? toRow(row) : null;
}

export async function readBillByIntake(db: BillsDb, orgId: string, intakeKey: string): Promise<BillRow | null> {
  const [row] = await db.select().from(payableInvoices).where(and(eq(payableInvoices.orgId, orgId), eq(payableInvoices.intakeKey, intakeKey))).limit(1);
  return row ? toRow(row) : null;
}

export async function readOpenBillByDocument(db: BillsDb, orgId: string, sha256: string): Promise<BillRow | null> {
  const [row] = await db.select().from(payableInvoices)
    .where(and(eq(payableInvoices.orgId, orgId), eq(payableInvoices.documentSha256, sha256), ne(payableInvoices.status, 'cancelled')))
    .limit(1);
  return row ? toRow(row) : null;
}

export async function readBillByIntent(db: BillsDb, orgId: string, paymentIntentId: string): Promise<BillRow | null> {
  const [row] = await db.select().from(payableInvoices)
    .where(and(eq(payableInvoices.orgId, orgId), eq(payableInvoices.paymentIntentId, paymentIntentId)))
    .limit(1);
  return row ? toRow(row) : null;
}

export async function listBills(db: BillsDb, orgId: string, limit = 200): Promise<BillRow[]> {
  const rows = await db.select().from(payableInvoices).where(eq(payableInvoices.orgId, orgId)).orderBy(desc(payableInvoices.createdAt)).limit(limit);
  return rows.map(toRow);
}

/** For updateBillIf: only while no e-invoice has been made. */
export const noEInvoiceYet = (): SQL => isNull(payableInvoices.myinvois);

export type GuardedUpdate =
  | { ok: true; row: BillRow }
  | { ok: false; reason: 'not_found' | 'status' | 'unique'; row: BillRow | null };

/**
 * Change one invoice of `orgId`, only while its status is one of `from`.
 * Appends `entry` to its history in the same statement.
 */
export async function updateBillIf(
  db: BillsDb,
  orgId: string,
  id: string,
  from: readonly BillStatus[],
  patch: Patch,
  entry: BillHistoryEntry,
  extra?: SQL,
): Promise<GuardedUpdate> {
  try {
    const [row] = await db.update(payableInvoices)
      .set({
        ...patch,
        history: sql`${payableInvoices.history} || ${JSON.stringify([entry])}::jsonb`,
        updatedAt: new Date(entry.at),
      })
      .where(and(eq(payableInvoices.orgId, orgId), eq(payableInvoices.id, id), inArray(payableInvoices.status, [...from]), extra))
      .returning();
    if (row) return { ok: true, row: toRow(row) };
  } catch (error) {
    if (uniqueViolation(error)) return { ok: false, reason: 'unique', row: await readBill(db, orgId, id) };
    throw error;
  }
  const current = await readBill(db, orgId, id);
  return { ok: false, reason: current ? 'status' : 'not_found', row: current };
}
