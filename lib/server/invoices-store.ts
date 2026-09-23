/**
 * The one way to read or write an invoice.
 *
 * Same two-backend shape as the transfer, ledger and beneficiary stores.
 *
 * Every read takes an `orgId` except `findInvoiceBySlug`, which is the public
 * pay link: the slug is unguessable, was handed to a payer who has no account,
 * and resolves to one invoice. That one is a capability, not a hole.
 */
import { operations, type InvoiceRecord } from './operations.ts';
import * as repo from './repository/invoices.ts';

let announced = false;

function usingPostgres(): boolean {
  if (process.env.DATABASE_URL) return true;
  if (!announced) {
    announced = true;
    console.warn(
      '[invoices] DATABASE_URL is not set, so invoices live in this process and ' +
        'disappear when it restarts. Local development only.',
    );
  }
  return false;
}

async function db() {
  const { getDb } = await import('../db/client.ts');
  return getDb() as never;
}

function toRecord(row: repo.InvoiceRow): InvoiceRecord {
  return {
    id: row.id,
    orgId: row.orgId,
    issuerOrg: row.issuerOrg,
    payerOrgName: row.payerOrgName,
    payerOrgEmail: row.payerOrgEmail,
    amountUsd: row.amountUsd,
    targetCurrency: row.targetCurrency,
    dueDate: row.dueDate,
    memo: row.memo,
    status: row.status as InvoiceRecord['status'],
    payLinkSlug: row.payLinkSlug,
    paymentReference: row.paymentReference,
    walrusBlobId: row.walrusBlobId,
    sealPolicyId: row.sealPolicyId,
    documentSha256: row.documentSha256,
    transferIntentId: row.transferIntentId,
    demo: row.demo,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function persistInvoice(record: InvoiceRecord): Promise<InvoiceRecord> {
  if (!usingPostgres()) {
    operations.invoices.set(record.id, record);
    return record;
  }
  return toRecord(
    await repo.insertInvoice(await db(), {
      id: record.id,
      orgId: record.orgId,
      issuerOrg: record.issuerOrg,
      payerOrgName: record.payerOrgName,
      payerOrgEmail: record.payerOrgEmail,
      amountUsd: record.amountUsd,
      targetCurrency: record.targetCurrency,
      dueDate: record.dueDate,
      memo: record.memo,
      status: record.status,
      payLinkSlug: record.payLinkSlug,
      paymentReference: record.paymentReference,
      walrusBlobId: record.walrusBlobId,
      sealPolicyId: record.sealPolicyId,
      documentSha256: record.documentSha256,
      transferIntentId: record.transferIntentId,
      demo: record.demo,
    }),
  );
}

/** One invoice belonging to `orgId`. A foreign id reads as missing. */
export async function readInvoice(orgId: string, invoiceId: string): Promise<InvoiceRecord | null> {
  if (!usingPostgres()) {
    const record = operations.invoices.get(invoiceId) ?? null;
    return record && record.orgId === orgId ? record : null;
  }
  const row = await repo.getInvoice(await db(), orgId, invoiceId);
  return row ? toRecord(row) : null;
}

/** Cross-tenant. The audit view, which holds a transfer whose owner is settled. */
export async function readInvoiceForStaff(invoiceId: string): Promise<InvoiceRecord | null> {
  if (!usingPostgres()) return operations.invoices.get(invoiceId) ?? null;
  const row = await repo.getInvoiceForStaff(await db(), invoiceId);
  return row ? toRecord(row) : null;
}

/**
 * By pay-link slug. Deliberately unscoped — the slug is the capability.
 */
export async function findInvoiceBySlug(slug: string): Promise<InvoiceRecord | null> {
  if (!usingPostgres()) {
    return [...operations.invoices.values()].find((i) => i.payLinkSlug === slug) ?? null;
  }
  const row = await repo.findBySlug(await db(), slug);
  return row ? toRecord(row) : null;
}

export async function listInvoicesFor(orgId: string, limit = 200): Promise<InvoiceRecord[]> {
  if (!usingPostgres()) {
    return [...operations.invoices.values()]
      .filter((i) => i.orgId === orgId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }
  const rows = await repo.listInvoices(await db(), orgId, limit);
  return rows.map(toRecord);
}

/** Patch, scoped. `null` means it was not there OR was not theirs. */
export async function patchInvoice(
  orgId: string,
  invoiceId: string,
  patch: Partial<InvoiceRecord>,
): Promise<InvoiceRecord | null> {
  if (!usingPostgres()) {
    const record = operations.invoices.get(invoiceId);
    if (!record || record.orgId !== orgId) return null;
    Object.assign(record, patch, { updatedAt: new Date().toISOString() });
    return record;
  }
  const row = await repo.patchInvoice(await db(), orgId, invoiceId, patch);
  return row ? toRecord(row) : null;
}

/**
 * Patch by id alone.
 *
 * The public pay link, which arrived by slug and has no session to scope by —
 * the slug already established which invoice this is. Named so that is a
 * decision at the call site rather than a default.
 */
export async function patchInvoiceForStaff(
  invoiceId: string,
  patch: Partial<InvoiceRecord>,
): Promise<InvoiceRecord | null> {
  if (!usingPostgres()) {
    const record = operations.invoices.get(invoiceId);
    if (!record) return null;
    Object.assign(record, patch, { updatedAt: new Date().toISOString() });
    return record;
  }
  const row = await repo.patchInvoiceForStaff(await db(), invoiceId, patch);
  return row ? toRecord(row) : null;
}
