import { and, asc, eq, gt, isNull, notInArray } from 'drizzle-orm';

import { findCredential } from '../auth/passkey.ts';
import { invoices } from '../db/schema.ts';
import { explorerTxUrl, normaliseSuiAddress } from '../payments/stablecoin-lane.ts';
import { findInvoicePayment, invoiceUsdcAmountMinor, PAYMENT_CLOCK_TOLERANCE_MS, type IncomingMovement } from '../payments/usdc-invoice.ts';
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
  /** The wallet the payer was shown, pinned the first time (migration 0024). */
  usdcReceiveAddress: string | null;
};

type ReadActivity = (address: string, before?: string | null) => Promise<ActivityPage>;

/** Pages of a wallet's activity back to `since` (or at most MAX_READS pages). */
const MAX_READS = 3;
async function readSince(address: string, since: Date, read: ReadActivity): Promise<ActivityPage> {
  const movements: IncomingMovement[] = [];
  let before: string | null = null;
  for (let i = 0; i < MAX_READS; i += 1) {
    const page = await read(address, before);
    if (!page.available) return page;
    movements.push(...page.movements);
    const oldest = page.movements.at(-1)?.timestamp;
    const pastSince = oldest ? Date.parse(oldest) < since.getTime() - PAYMENT_CLOCK_TOLERANCE_MS : false;
    if (!page.olderCursor || pastSince) break;
    before = page.olderCursor;
  }
  return { available: true, movements, olderCursor: null };
}

const liveRead: ReadActivity = (address, before) => readUsdcActivity(address, { limit: 50, before });

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
      usdcReceiveAddress: invoices.usdcReceiveAddress,
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

/**
 * What the pay page shows: the wallet and the exact amount, or null. The
 * wallet is pinned on the invoice the first time it is shown, so a later
 * change of main admin or passkey cannot strand a payment already sent.
 */
export async function invoiceUsdcTerms(db: Db, row: InvoiceUsdcRow, rpId: string) {
  if (row.amountMinor <= 0n) return null;
  let address: string | null = row.usdcReceiveAddress;
  if (!address) {
    const resolved = await issuerUsdcAddress(db, row.orgId, rpId);
    if (!resolved) return null;
    const [pinned] = await db
      .update(invoices)
      .set({ usdcReceiveAddress: resolved })
      .where(and(eq(invoices.id, row.id), isNull(invoices.usdcReceiveAddress)))
      .returning({ address: invoices.usdcReceiveAddress });
    // Pinned a moment ago by another request: use what it pinned.
    const [current] = pinned
      ? [pinned]
      : await db.select({ address: invoices.usdcReceiveAddress }).from(invoices).where(eq(invoices.id, row.id)).limit(1);
    address = (current?.address as string | null) ?? resolved;
    row.usdcReceiveAddress = address;
  }
  return { address, amountMinor: invoiceUsdcAmountMinor(row.id, row.amountMinor) };
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
  deps: { rpId: string; read?: ReadActivity; now?: () => Date },
): Promise<UsdcCheck> {
  if (row.usdcTxDigest) return paid({ usdcTxDigest: row.usdcTxDigest, usdcPayerAddress: row.usdcPayerAddress, usdcPaidAt: row.usdcPaidAt });
  const terms = await invoiceUsdcTerms(db, row, deps.rpId);
  if (!terms) return { status: 'NO_WALLET' };

  const activity = await readSince(terms.address, row.createdAt, deps.read ?? liveRead);
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
  const [{ getDb }, { relyingPartyId }, { exactUsdc }, { plainUsdc }] = await Promise.all([
    import('../db/client.ts'),
    import('../auth/passkey.ts'),
    import('../payments/usdc-invoice.ts'),
    import('../payments/usdc-records.ts'),
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
  // Reported paid (by bank) or settled: offering USDC now invites paying twice.
  if (row.status === 'paid' || row.status === 'settled') return null;
  const terms = await invoiceUsdcTerms(db, row, relyingPartyId());
  return terms
    ? {
        paid: null,
        // `amount` to read (with separators), `amountPlain` to copy into a wallet.
        terms: { address: terms.address, amount: exactUsdc(terms.amountMinor), amountPlain: plainUsdc(terms.amountMinor) },
      }
    : null;
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
  deps: { rpId: string; read?: ReadActivity; now?: () => Date },
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
      usdcReceiveAddress: invoices.usdcReceiveAddress,
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

  // Back as far as the oldest open invoice. An invoice pinned to an earlier
  // wallet (main admin changed since) is checked on its own by the payer's check.
  const activity = await readSince(address, open[0].createdAt, deps.read ?? liveRead);
  if (!activity.available) return { status: 'UNAVAILABLE', reason: activity.reason };

  const now = (deps.now ?? (() => new Date()))();
  const used = new Set<string>();
  const paidNow: Array<{ invoiceId: string; digest: string }> = [];
  const alreadyUsed: string[] = [];
  for (const invoice of open) {
    if (invoice.usdcReceiveAddress && invoice.usdcReceiveAddress !== address) continue;
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
