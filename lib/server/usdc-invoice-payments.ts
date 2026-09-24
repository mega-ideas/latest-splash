import { and, asc, eq, gt, isNull, notInArray } from 'drizzle-orm';

import { findCredential } from '../auth/passkey.ts';
import { invoices } from '../db/schema.ts';
import { explorerTxUrl, normaliseSuiAddress } from '../payments/stablecoin-lane.ts';
import { findInvoicePayment, invoiceUsdcAmountMinor, type IncomingMovement } from '../payments/usdc-invoice.ts';
import { mainAdmin } from './step-up.ts';
import { readUsdcActivity, type ActivityPage } from './wallet-activity.ts';

/**
 * Invoices paid in USDC on Sui, to the issuer's own Splash wallet.
 *
 * The issuer's receiving address is its main admin's Splash wallet — the Sui
 * address of their passkey, the same person who approves payments. Splash
 * shows it to the payer with the exact amount (lib/payments/usdc-invoice.ts),
 * and when asked, reads that wallet's USDC activity from chain to find the
 * transfer. It never holds the money and never moves any.
 *
 * Recording a payment is one conditional UPDATE: it only lands on an invoice
 * not already paid in USDC, and the unique index on the digest refuses the
 * same transaction for a second invoice. A retry, a double click or two
 * payers racing all end in one paid invoice and one transaction.
 */

// Structural, not nominal: node-postgres in the app, PGlite in the tests.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

export type InvoiceUsdcRow = {
  id: string;
  orgId: string;
  amountMinor: bigint;
  status: string;
  createdAt: Date;
  usdcTxDigest: string | null;
  usdcPaidAt: Date | null;
  usdcPayerAddress: string | null;
};

export type UsdcCheck =
  | { status: 'PAID'; digest: string; payer: string | null; paidAt: string; explorerUrl: string }
  | { status: 'NOT_SEEN'; expectedMinor: bigint; address: string }
  | { status: 'NO_WALLET' }
  | { status: 'ALREADY_USED' }
  | { status: 'UNAVAILABLE'; reason: string };

export async function invoiceUsdcBySlug(db: Db, slug: string): Promise<InvoiceUsdcRow | null> {
  const [row] = await db
    .select({
      id: invoices.id,
      orgId: invoices.orgId,
      amountMinor: invoices.amountMinor,
      status: invoices.status,
      createdAt: invoices.createdAt,
      usdcTxDigest: invoices.usdcTxDigest,
      usdcPaidAt: invoices.usdcPaidAt,
      usdcPayerAddress: invoices.usdcPayerAddress,
    })
    .from(invoices)
    .where(eq(invoices.payLinkSlug, slug))
    .limit(1);
  return row ? { ...row, amountMinor: BigInt(row.amountMinor) } : null;
}

/** Where this issuer receives USDC, or null when its main admin has no Splash wallet yet. */
export async function issuerUsdcAddress(db: Db, orgId: string, rpId: string): Promise<string | null> {
  const admin = await mainAdmin(db, orgId);
  if (!admin) return null;
  const credential = await findCredential(db, { userId: admin.userId, rpId });
  return credential ? normaliseSuiAddress(credential.suiAddress) : null;
}

/** What the pay page shows: the wallet and the exact amount, or null. */
export async function invoiceUsdcTerms(db: Db, row: InvoiceUsdcRow, rpId: string) {
  if (row.amountMinor <= 0n) return null;
  const address = await issuerUsdcAddress(db, row.orgId, rpId);
  return address ? { address, amountMinor: invoiceUsdcAmountMinor(row.id, row.amountMinor) } : null;
}

function paid(row: { usdcTxDigest: string; usdcPayerAddress: string | null; usdcPaidAt: Date | null }): UsdcCheck {
  return {
    status: 'PAID',
    digest: row.usdcTxDigest,
    payer: row.usdcPayerAddress,
    paidAt: (row.usdcPaidAt ?? new Date()).toISOString(),
    explorerUrl: explorerTxUrl('mainnet', row.usdcTxDigest),
  };
}

function uniqueViolation(error: unknown): boolean {
  const codes = [(error as { code?: string })?.code, (error as { cause?: { code?: string } })?.cause?.code];
  return codes.includes('23505');
}

/**
 * Has this invoice been paid in USDC? Reads the issuer's wallet from chain and
 * records the matching transfer, once.
 */
export async function checkInvoiceUsdcPayment(
  db: Db,
  row: InvoiceUsdcRow,
  deps: { rpId: string; read?: (address: string) => Promise<ActivityPage>; now?: () => Date },
): Promise<UsdcCheck> {
  if (row.usdcTxDigest) return paid({ usdcTxDigest: row.usdcTxDigest, usdcPayerAddress: row.usdcPayerAddress, usdcPaidAt: row.usdcPaidAt });
  const terms = await invoiceUsdcTerms(db, row, deps.rpId);
  if (!terms) return { status: 'NO_WALLET' };

  const read = deps.read ?? ((address: string) => readUsdcActivity(address, { limit: 50 }));
  const activity = await read(terms.address);
  if (!activity.available) return { status: 'UNAVAILABLE', reason: activity.reason };
  const match = findInvoicePayment(activity.movements, terms.amountMinor, row.createdAt);
  if (!match) return { status: 'NOT_SEEN', expectedMinor: terms.amountMinor, address: terms.address };

  return recordInvoiceUsdcPayment(db, row, match, (deps.now ?? (() => new Date()))());
}

/**
 * Record `match` as the transfer that paid `row`, once: a conditional UPDATE
 * that only lands on an invoice not already paid in USDC, with the unique
 * index refusing a transaction that already paid another invoice.
 */
export async function recordInvoiceUsdcPayment(
  db: Db,
  row: Pick<InvoiceUsdcRow, 'id' | 'status'>,
  match: IncomingMovement,
  now: Date,
): Promise<UsdcCheck> {
  try {
    const updated = await db
      .update(invoices)
      .set({
        // A settled invoice stays settled; anything earlier is now paid.
        status: row.status === 'settled' ? 'settled' : 'paid',
        usdcTxDigest: match.digest,
        usdcPaidAt: now,
        usdcPayerAddress: match.counterparty,
        updatedAt: now,
      })
      .where(and(eq(invoices.id, row.id), isNull(invoices.usdcTxDigest)))
      .returning({ id: invoices.id });
    if (updated.length === 0) {
      // Someone recorded it a moment ago: report what they recorded.
      const [current] = await db
        .select({ usdcTxDigest: invoices.usdcTxDigest, usdcPayerAddress: invoices.usdcPayerAddress, usdcPaidAt: invoices.usdcPaidAt })
        .from(invoices)
        .where(eq(invoices.id, row.id))
        .limit(1);
      return current?.usdcTxDigest ? paid(current) : { status: 'UNAVAILABLE', reason: 'The invoice changed while it was being checked. Check again.' };
    }
  } catch (error) {
    // The same transaction already paid a different invoice.
    if (uniqueViolation(error)) return { status: 'ALREADY_USED' };
    throw error;
  }
  return paid({ usdcTxDigest: match.digest, usdcPayerAddress: match.counterparty, usdcPaidAt: now });
}

/**
 * What a payer sees for this pay link: the wallet and the exact amount, or the
 * transfer that already paid it. Null when the issuer has no Splash wallet yet,
 * or there is no database. Shared by the pay page and its API.
 */
export async function publicUsdcForSlug(slug: string) {
  if (!process.env.DATABASE_URL) return null;
  const [{ getDb }, { relyingPartyId }, { exactUsdc }] = await Promise.all([
    import('../db/client.ts'),
    import('../auth/passkey.ts'),
    import('../payments/usdc-invoice.ts'),
  ]);
  const db = getDb();
  const row = await invoiceUsdcBySlug(db, slug);
  if (!row) return null;
  if (row.usdcTxDigest) {
    return {
      paid: { digest: row.usdcTxDigest, explorerUrl: explorerTxUrl('mainnet', row.usdcTxDigest), paidAt: row.usdcPaidAt?.toISOString() ?? null },
      terms: null,
    };
  }
  const terms = await invoiceUsdcTerms(db, row, relyingPartyId());
  return terms ? { paid: null, terms: { address: terms.address, amount: exactUsdc(terms.amountMinor) } } : null;
}

export type InvoiceSyncResult =
  | { status: 'NO_WALLET' }
  | { status: 'UNAVAILABLE'; reason: string }
  | { status: 'SYNCED'; checked: number; paid: Array<{ invoiceId: string; digest: string }>; alreadyUsed: string[] };

/**
 * The issuer's side of the same check: every open invoice at once, against one
 * read of the main admin's Splash wallet. A payer who never presses "check"
 * still gets their invoice marked paid. Each transfer is assigned to at most
 * one invoice (oldest invoice first), and recorded through the same
 * conditional update as the payer's check.
 */
export async function syncOrgInvoiceUsdcPayments(
  db: Db,
  orgId: string,
  deps: { rpId: string; read?: (address: string) => Promise<ActivityPage>; now?: () => Date },
): Promise<InvoiceSyncResult> {
  const address = await issuerUsdcAddress(db, orgId, deps.rpId);
  if (!address) return { status: 'NO_WALLET' };

  const open: InvoiceUsdcRow[] = (await db
    .select({
      id: invoices.id,
      orgId: invoices.orgId,
      amountMinor: invoices.amountMinor,
      status: invoices.status,
      createdAt: invoices.createdAt,
      usdcTxDigest: invoices.usdcTxDigest,
      usdcPaidAt: invoices.usdcPaidAt,
      usdcPayerAddress: invoices.usdcPayerAddress,
    })
    .from(invoices)
    .where(and(
      eq(invoices.orgId, orgId),
      isNull(invoices.usdcTxDigest),
      notInArray(invoices.status, ['paid', 'settled']),
      gt(invoices.amountMinor, 0n),
    ))
    .orderBy(asc(invoices.createdAt))
    .limit(500)).map((r: InvoiceUsdcRow) => ({ ...r, amountMinor: BigInt(r.amountMinor) }));
  if (open.length === 0) return { status: 'SYNCED', checked: 0, paid: [], alreadyUsed: [] };

  const read = deps.read ?? ((a: string) => readUsdcActivity(a, { limit: 50 }));
  const activity = await read(address);
  if (!activity.available) return { status: 'UNAVAILABLE', reason: activity.reason };

  const now = (deps.now ?? (() => new Date()))();
  const used = new Set<string>();
  const paidNow: Array<{ invoiceId: string; digest: string }> = [];
  const alreadyUsed: string[] = [];
  for (const invoice of open) {
    const expected = invoiceUsdcAmountMinor(invoice.id, invoice.amountMinor);
    const match = findInvoicePayment(activity.movements.filter((m) => !used.has(m.digest)), expected, invoice.createdAt);
    if (!match) continue;
    used.add(match.digest);
    const result = await recordInvoiceUsdcPayment(db, invoice, match, now);
    if (result.status === 'PAID') paidNow.push({ invoiceId: invoice.id, digest: result.digest });
    else if (result.status === 'ALREADY_USED') alreadyUsed.push(invoice.id);
  }
  return { status: 'SYNCED', checked: open.length, paid: paidNow, alreadyUsed };
}
