/**
 * What is made from a receipt (v2 brief 5.4 step 5): the link a person shares
 * and the self-billed e-invoice (MyInvois).
 *
 * The link: an unguessable token, kept only as its SHA-256 (migration 0064),
 * that opens ONE payment's receipt for a month and can be revoked. It grants
 * nothing else. A token that is unknown, expired or revoked reads as absent.
 *
 * The e-invoice: made once per payment, for a settled payment, by a Malaysian
 * business to a supplier outside Malaysia, from the receipt and the person's
 * own details (their TIN, contact, state, the exchange rate). A second
 * request answers the same file; `refresh` remakes one older than 72 hours
 * (a fresh issue date) and the history keeps the replaced file's SHA-256, so
 * a file already filed with MyInvois can still be told from the new one. Two
 * remakes racing leave one. Every read takes the org.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { and, eq, isNull } from 'drizzle-orm';

import { paymentEInvoices, paymentReceiptShares } from '../db/schema.ts';
import { buildSelfBilledInvoice, selfBilledProblems } from '../myinvois/self-billed.ts';
import { EINVOICE_GUIDELINE, eInvoiceInputFromReceipt, eInvoiceOffer, type EInvoiceDetails, type PaymentReceipt } from '../transfer/receipt.ts';
import type { DrizzleDb } from './wallet-signing-store.ts';

export const RECEIPT_LINK_TTL_MS = 30 * 24 * 3_600_000;
export const E_INVOICE_FRESH_MS = 72 * 3_600_000;

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

export async function mintReceiptShare(db: DrizzleDb, input: { orgId: string; paymentRef: string; userId: string; now: Date }): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(24).toString('base64url');
  const expiresAt = new Date(input.now.getTime() + RECEIPT_LINK_TTL_MS);
  await db.insert(paymentReceiptShares).values({
    id: `rsh_${randomUUID()}`,
    orgId: input.orgId,
    paymentRef: input.paymentRef,
    tokenHash: sha256(token),
    createdBy: input.userId,
    expiresAt,
    createdAt: input.now,
  });
  return { token, expiresAt };
}

/** The payment a live token opens, or null. */
export async function readReceiptShare(db: DrizzleDb, token: string, now: Date): Promise<{ orgId: string; paymentRef: string } | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const [row] = await db.select().from(paymentReceiptShares).where(eq(paymentReceiptShares.tokenHash, sha256(token))).limit(1);
  if (!row || row.revokedAt || row.expiresAt.getTime() <= now.getTime()) return null;
  return { orgId: row.orgId, paymentRef: row.paymentRef };
}

export async function revokeReceiptShares(db: DrizzleDb, input: { orgId: string; paymentRef: string; now: Date }): Promise<number> {
  const done = await db
    .update(paymentReceiptShares)
    .set({ revokedAt: input.now })
    .where(and(eq(paymentReceiptShares.orgId, input.orgId), eq(paymentReceiptShares.paymentRef, input.paymentRef), isNull(paymentReceiptShares.revokedAt)))
    .returning({ id: paymentReceiptShares.id });
  return done.length;
}

type EInvoiceRow = typeof paymentEInvoices.$inferSelect;

export type EInvoiceView = { fileName: string; document: unknown; sha256: string; generatedAt: string; guideline: string };

const viewOf = (row: EInvoiceRow, receiptNo: string): EInvoiceView => ({
  fileName: `self-billed-${receiptNo}.json`,
  document: row.document,
  sha256: row.sha256,
  generatedAt: row.generatedAt.toISOString(),
  guideline: row.guideline,
});

export async function readEInvoice(db: DrizzleDb, input: { orgId: string; paymentRef: string; receiptNo: string }): Promise<EInvoiceView | null> {
  const [row] = await db.select().from(paymentEInvoices).where(and(eq(paymentEInvoices.orgId, input.orgId), eq(paymentEInvoices.paymentRef, input.paymentRef))).limit(1);
  return row ? viewOf(row, input.receiptNo) : null;
}

type Made =
  | { ok: true; created: boolean; eInvoice: EInvoiceView }
  | { ok: false; status: number; code: string; error: string; problems?: string[] };

export async function makeEInvoice(
  db: DrizzleDb,
  input: {
    orgId: string;
    userId: string;
    receipt: PaymentReceipt;
    payerCountry: string | null;
    supplierCountry: string | null;
    details: EInvoiceDetails;
    refresh?: boolean;
    now: Date;
  },
): Promise<Made> {
  const offer = eInvoiceOffer(input.receipt, { payerCountry: input.payerCountry, supplierCountry: input.supplierCountry });
  if (!offer.offered) {
    const why = {
      not_settled: ['status', 'The e-invoice is made once the payment has settled.'],
      not_malaysian: ['not_malaysian', 'A MyInvois e-invoice is for a business in Malaysia.'],
      supplier_in_malaysia: ['not_foreign', 'The supplier is in Malaysia, so it issues the e-invoice. A self-billed one is only for a foreign supplier.'],
      supplier_country_unknown: ['supplier_country_unknown', "The supplier's country is not on file, so Splash cannot tell whether a self-billed e-invoice applies."],
    }[offer.why];
    return { ok: false, status: 409, code: why[0], error: why[1] };
  }
  const paymentRef = input.receipt.paymentRef;
  const [existing] = await db.select().from(paymentEInvoices).where(and(eq(paymentEInvoices.orgId, input.orgId), eq(paymentEInvoices.paymentRef, paymentRef))).limit(1);
  const fresh = existing && input.now.getTime() - existing.generatedAt.getTime() < E_INVOICE_FRESH_MS;
  if (existing && (!input.refresh || fresh)) return { ok: true, created: false, eInvoice: viewOf(existing, input.receipt.receiptNo) };

  const file = eInvoiceInputFromReceipt(input.receipt, input.details, input.now);
  const problems = selfBilledProblems(file);
  if (problems.length > 0) return { ok: false, status: 422, code: 'incomplete', error: problems[0], problems };
  const document = buildSelfBilledInvoice(file);
  const digest = sha256(JSON.stringify(document));
  const guideline = `${EINVOICE_GUIDELINE.version}, checked ${EINVOICE_GUIDELINE.checkedOn}`;

  if (!existing) {
    try {
      const [row] = await db
        .insert(paymentEInvoices)
        .values({ id: `einv_${randomUUID()}`, orgId: input.orgId, paymentRef, document, sha256: digest, guideline, generatedBy: input.userId, generatedAt: input.now })
        .returning();
      return { ok: true, created: true, eInvoice: viewOf(row, input.receipt.receiptNo) };
    } catch {
      // Another request made it first: theirs is the one.
      const [won] = await db.select().from(paymentEInvoices).where(and(eq(paymentEInvoices.orgId, input.orgId), eq(paymentEInvoices.paymentRef, paymentRef))).limit(1);
      if (won) return { ok: true, created: false, eInvoice: viewOf(won, input.receipt.receiptNo) };
      return { ok: false, status: 409, code: 'conflict', error: 'The e-invoice was being made at the same time. Try again.' };
    }
  }
  // A remake: only the version that was read is replaced, so two remakes leave one, and the replaced file's hash stays in the history.
  const history = [...((existing.history as unknown[]) ?? []), { replacedSha256: existing.sha256, replacedAt: input.now.toISOString(), by: input.userId }];
  const done = await db
    .update(paymentEInvoices)
    .set({ document, sha256: digest, guideline, generatedBy: input.userId, generatedAt: input.now, history })
    .where(and(eq(paymentEInvoices.id, existing.id), eq(paymentEInvoices.sha256, existing.sha256)))
    .returning();
  if (done.length === 0) {
    const [won] = await db.select().from(paymentEInvoices).where(eq(paymentEInvoices.id, existing.id)).limit(1);
    return { ok: true, created: false, eInvoice: viewOf(won, input.receipt.receiptNo) };
  }
  return { ok: true, created: true, eInvoice: viewOf(done[0], input.receipt.receiptNo) };
}
