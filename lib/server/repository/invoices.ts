/**
 * Invoices, in Postgres, belonging to somebody.
 *
 * `invoices` has had `org_id NOT NULL`, a supplier reference, bigint minor
 * units and a unique pay-link slug since migration 0000. The operational
 * invoice lived in a `Map` on `globalThis` with none of it, and every route
 * read that Map by id alone:
 *
 *   GET   /api/invoices       every tenant's invoices to any caller
 *   GET   /api/invoices/:id   any invoice by id
 *   PATCH /api/invoices/:id   any tenant's invoice MODIFIED by id — status,
 *                             payment reference, the transfer it binds to.
 *                             Write across the tenant boundary, not just read.
 *   /api/copilot/summary      the assistant's "your invoices" was everyone's,
 *   /api/copilot/suggest      so it would describe one customer's overdue
 *                             invoices to another.
 *
 * ─── The slug is the exception, and it is meant to be ───────────────────────
 *
 * `findBySlug` takes no org id. That is correct: a pay link is a capability
 * handed to a payer who has no account, the slug is unguessable, and it
 * resolves to exactly one invoice and nothing else. Every OTHER read is scoped.
 */
import { and, desc, eq } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';

import { invoices } from '../../db/schema.ts';
import type * as schemaModule from '../../db/schema.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DrizzleDb = PgDatabase<any, typeof schemaModule, any>;

export type InvoiceRow = {
  id: string;
  orgId: string;
  issuerOrg: string;
  payerOrgName?: string;
  payerOrgEmail?: string;
  amountUsd: string;
  targetCurrency: string;
  dueDate: string;
  memo?: string;
  status: string;
  payLinkSlug: string;
  paymentReference?: string;
  walrusBlobId?: string;
  sealPolicyId?: string;
  documentSha256?: string;
  transferIntentId?: string;
  recipientId?: string;
  demo?: boolean;
  createdAt: string;
  updatedAt: string;
};

/** USD, two decimals on the wire and six in the column, like every other
 *  amount here. Truncating never credits anybody money they did not send. */
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

type InvoiceSelect = typeof invoices.$inferSelect;

function toRow(row: InvoiceSelect): InvoiceRow {
  return {
    id: row.id,
    orgId: row.orgId,
    issuerOrg: row.issuerOrg,
    payerOrgName: row.payerName ?? undefined,
    payerOrgEmail: row.payerEmail ?? undefined,
    amountUsd: fromMinor(row.amountMinor),
    targetCurrency: row.targetCurrency,
    dueDate: row.dueDate ?? '',
    memo: row.memo ?? undefined,
    status: row.status,
    payLinkSlug: row.payLinkSlug ?? '',
    paymentReference: row.paymentReference ?? undefined,
    walrusBlobId: row.walrusBlobId ?? undefined,
    sealPolicyId: row.sealPolicyId ?? undefined,
    documentSha256: row.documentSha256 ?? undefined,
    transferIntentId: row.transferIntentId ?? undefined,
    recipientId: row.supplierId ?? undefined,
    demo: row.demo,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export type NewInvoice = Omit<InvoiceRow, 'createdAt' | 'updatedAt'>;

export async function insertInvoice(db: DrizzleDb, input: NewInvoice): Promise<InvoiceRow> {
  const [row] = await db
    .insert(invoices)
    .values({
      id: input.id,
      orgId: input.orgId,
      supplierId: input.recipientId ?? null,
      issuerOrg: input.issuerOrg,
      payerName: input.payerOrgName ?? null,
      payerEmail: input.payerOrgEmail ?? null,
      amountMinor: toMinor(input.amountUsd),
      currency: 'USD',
      targetCurrency: input.targetCurrency,
      dueDate: input.dueDate || null,
      status: input.status,
      memo: input.memo ?? null,
      walrusBlobId: input.walrusBlobId ?? null,
      sealPolicyId: input.sealPolicyId ?? null,
      payLinkSlug: input.payLinkSlug,
      paymentReference: input.paymentReference ?? null,
      documentSha256: input.documentSha256 ?? null,
      transferIntentId: input.transferIntentId ?? null,
      demo: input.demo ?? false,
    })
    .returning();
  return toRow(row);
}

/** One invoice belonging to `orgId`. A foreign id reads as missing. */
export async function getInvoice(
  db: DrizzleDb,
  orgId: string,
  invoiceId: string,
): Promise<InvoiceRow | null> {
  const rows = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.id, invoiceId), eq(invoices.orgId, orgId)))
    .limit(1);
  return rows.length > 0 ? toRow(rows[0]) : null;
}

/** Cross-tenant. The audit view, holding a transfer whose owner is established. */
export async function getInvoiceForStaff(
  db: DrizzleDb,
  invoiceId: string,
): Promise<InvoiceRow | null> {
  const rows = await db.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1);
  return rows.length > 0 ? toRow(rows[0]) : null;
}

/**
 * By pay-link slug, and deliberately unscoped.
 *
 * The slug IS the authority here: it is unguessable, it was handed to a payer
 * who has no account, and it resolves to one invoice. Adding an org id would
 * not make it safer, only unusable.
 */
export async function findBySlug(db: DrizzleDb, slug: string): Promise<InvoiceRow | null> {
  const rows = await db.select().from(invoices).where(eq(invoices.payLinkSlug, slug)).limit(1);
  return rows.length > 0 ? toRow(rows[0]) : null;
}

export async function listInvoices(
  db: DrizzleDb,
  orgId: string,
  limit = 200,
): Promise<InvoiceRow[]> {
  const rows = await db
    .select()
    .from(invoices)
    .where(eq(invoices.orgId, orgId))
    .orderBy(desc(invoices.createdAt))
    .limit(limit);
  return rows.map(toRow);
}

/**
 * Patch one invoice, scoped.
 *
 * `orgId` is in the WHERE clause, not checked beforehand: a read-then-write
 * leaves a window where the row could change owner between the two, and the
 * point of this change is that a write cannot cross the tenant boundary.
 */
export async function patchInvoice(
  db: DrizzleDb,
  orgId: string,
  invoiceId: string,
  patch: Partial<InvoiceRow>,
): Promise<InvoiceRow | null> {
  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.status !== undefined) update.status = patch.status;
  if (patch.paymentReference !== undefined) update.paymentReference = patch.paymentReference;
  if (patch.transferIntentId !== undefined) update.transferIntentId = patch.transferIntentId;
  if (patch.payerOrgName !== undefined) update.payerName = patch.payerOrgName;
  if (patch.payerOrgEmail !== undefined) update.payerEmail = patch.payerOrgEmail;
  if (patch.walrusBlobId !== undefined) update.walrusBlobId = patch.walrusBlobId;
  if (patch.sealPolicyId !== undefined) update.sealPolicyId = patch.sealPolicyId;
  if (patch.documentSha256 !== undefined) update.documentSha256 = patch.documentSha256;
  if (patch.recipientId !== undefined) update.supplierId = patch.recipientId;
  if (patch.memo !== undefined) update.memo = patch.memo;

  const rows = await db
    .update(invoices)
    .set(update)
    .where(and(eq(invoices.id, invoiceId), eq(invoices.orgId, orgId)))
    .returning();
  return rows.length > 0 ? toRow(rows[0]) : null;
}

/** Patch by id alone. The public pay link, which arrived by slug and has no
 *  session to scope by — the slug already established which invoice. */
export async function patchInvoiceForStaff(
  db: DrizzleDb,
  invoiceId: string,
  patch: Partial<InvoiceRow>,
): Promise<InvoiceRow | null> {
  const row = await getInvoiceForStaff(db, invoiceId);
  return row ? patchInvoice(db, row.orgId, invoiceId, patch) : null;
}

export const __testing = { toMinor, fromMinor };
