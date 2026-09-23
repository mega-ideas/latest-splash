/**
 * The one way to read or write a beneficiary.
 *
 * Same two-backend shape as `transfers-store.ts` and `ledger-store.ts`:
 * Postgres when `DATABASE_URL` is configured, the in-process map only when it
 * is not.
 *
 * Every read takes an `orgId` and it is not optional. `listRecipients()`
 * returned every tenant's beneficiaries and `deleteRecipient(id)` deleted any
 * of them; both are now scoped, and the cross-tenant variants are spelled
 * `*ForStaff` so reaching for one is visible at the call site.
 */
import { operations, type RecipientRecord } from './operations.ts';
import * as repo from './repository/recipients.ts';

let announced = false;

function usingPostgres(): boolean {
  if (process.env.DATABASE_URL) return true;
  if (!announced) {
    announced = true;
    console.warn(
      '[recipients] DATABASE_URL is not set, so beneficiaries live in this ' +
        'process and disappear when it restarts. Local development only.',
    );
  }
  return false;
}

async function db() {
  const { getDb } = await import('../db/client.ts');
  return getDb() as never;
}

function toRecord(row: repo.RecipientRow): RecipientRecord {
  return {
    id: row.id,
    orgId: row.orgId,
    name: row.name,
    country: row.country,
    bank: row.bank,
    swift: row.swift,
    account: row.account,
    tier: row.tier as RecipientRecord['tier'],
    kybStatus: row.kybStatus,
    orgEmail: row.orgEmail,
    createdVia: row.createdVia,
    sweepConfig: row.sweepConfig as RecipientRecord['sweepConfig'],
    kybInviteSent: row.kybInviteSent,
    travelRule: row.travelRule as RecipientRecord['travelRule'],
    demo: row.demo,
    createdAt: row.createdAt,
  };
}

export async function persistRecipient(record: RecipientRecord): Promise<RecipientRecord> {
  if (!usingPostgres()) {
    operations.recipients.set(record.id, record);
    return record;
  }
  return toRecord(
    await repo.insertRecipient(await db(), {
      id: record.id,
      orgId: record.orgId,
      name: record.name,
      country: record.country,
      bank: record.bank,
      swift: record.swift,
      account: record.account,
      tier: record.tier,
      kybStatus: record.kybStatus,
      orgEmail: record.orgEmail,
      createdVia: record.createdVia,
      sweepConfig: record.sweepConfig as Record<string, unknown> | undefined,
      kybInviteSent: record.kybInviteSent,
      travelRule: record.travelRule,
      demo: record.demo,
    }),
  );
}

/** One beneficiary belonging to `orgId`. A foreign id reads as missing. */
export async function readRecipient(
  orgId: string,
  recipientId: string,
): Promise<RecipientRecord | null> {
  if (!usingPostgres()) {
    const record = operations.recipients.get(recipientId) ?? null;
    return record && record.orgId === orgId ? record : null;
  }
  const row = await repo.getRecipient(await db(), orgId, recipientId);
  return row ? toRecord(row) : null;
}

/**
 * Cross-tenant read.
 *
 * The settlement path uses it holding a transfer whose owner is already
 * established, and the public pay page uses it for an issuer the payer was
 * given a link to. Named so neither is an accident.
 */
export async function readRecipientForStaff(
  recipientId: string,
): Promise<RecipientRecord | null> {
  if (!usingPostgres()) return operations.recipients.get(recipientId) ?? null;
  const row = await repo.getRecipientForStaff(await db(), recipientId);
  return row ? toRecord(row) : null;
}

export async function listRecipientsFor(orgId: string, limit = 200): Promise<RecipientRecord[]> {
  if (!usingPostgres()) {
    return [...operations.recipients.values()]
      .filter((r) => r.orgId === orgId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }
  const rows = await repo.listRecipients(await db(), orgId, limit);
  return rows.map(toRecord);
}

/** Delete, scoped. `false` means it was not there OR was not theirs. */
export async function removeRecipient(orgId: string, recipientId: string): Promise<boolean> {
  if (!usingPostgres()) {
    const record = operations.recipients.get(recipientId);
    if (!record || record.orgId !== orgId) return false;
    operations.recipients.delete(recipientId);
    return true;
  }
  return repo.deleteRecipient(await db(), orgId, recipientId);
}

/**
 * The issuer behind a public pay link.
 *
 * Scoped to the invoice's own org. This was briefly a global name match,
 * because `InvoiceRecord` had no org id and the issuer's name was the only
 * key there was — two tenants both called "Acme Trading" resolved to
 * whichever sorted first, and the page could show one org's KYB status
 * against the other's invoice. The invoice carries an `orgId` now, so the
 * match happens inside it.
 */
export async function findIssuerForPayLink(
  orgId: string,
  issuerName: string,
): Promise<RecipientRecord | null> {
  const wanted = issuerName.trim().toLowerCase();
  if (!usingPostgres()) {
    return (
      [...operations.recipients.values()].find(
        (r) => r.orgId === orgId && r.name.trim().toLowerCase() === wanted,
      ) ?? null
    );
  }
  const row = await repo.findRecipientByEmailOrName(await db(), orgId, { name: issuerName });
  return row ? toRecord(row) : null;
}

/**
 * The beneficiary an invoice link refers to, creating one if this org has none.
 *
 * Matched within the org. The version this replaces matched across all of them,
 * so two tenants' "Acme Trading" resolved to whichever sorted first — and an
 * invoice would have linked to a stranger's beneficiary record.
 */
export async function upsertRecipientFromInvoice(input: {
  orgId: string;
  name: string;
  orgEmail?: string;
}): Promise<RecipientRecord> {
  const { buildRecipient } = await import('./operations.ts');
  if (!usingPostgres()) {
    const email = input.orgEmail?.trim().toLowerCase();
    const existing = [...operations.recipients.values()].find(
      (r) =>
        r.orgId === input.orgId &&
        (email ? r.orgEmail?.toLowerCase() === email : r.name.toLowerCase() === input.name.toLowerCase()),
    );
    if (existing) return existing;
  } else {
    const hit = await repo.findRecipientByEmailOrName(await db(), input.orgId, input);
    if (hit) return toRecord(hit);
  }
  return persistRecipient(
    buildRecipient({
      orgId: input.orgId,
      name: input.name,
      orgEmail: input.orgEmail,
      country: 'XX',
      tier: 'PAYOUT_ONLY',
      kybStatus: 'none',
      createdVia: 'invoice_link',
      kybInviteSent: true,
    }),
  );
}
