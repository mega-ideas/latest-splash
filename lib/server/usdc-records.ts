import { and, desc, eq, gte, inArray, isNotNull, ne, or } from 'drizzle-orm';

import { invoices, stablecoinOutflows, stepUpCodes, suppliers, users } from '@/lib/db/schema';
import type { UsdcRecord } from '@/lib/payments/usdc-records';
import type { HomeWalletPayment } from '@/lib/dashboard/home';

/**
 * Every USDC transfer a workspace quoted, joined with the names an export
 * needs: the recipient, who asked for it, and who approved it (the approval
 * that was actually spent on it). Reads run one after another — the local
 * dev database serves a single connection.
 */

// Structural, not nominal: node-postgres in the app, PGlite in the tests.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

/** More than any workspace sends in the lane's lifetime so far; a guard, not a page size. */
const MAX_RECORDS = 5_000;

export async function listUsdcRecords(db: Db, orgId: string): Promise<UsdcRecord[]> {
  const rows: Array<typeof stablecoinOutflows.$inferSelect> = await db
    .select()
    .from(stablecoinOutflows)
    .where(eq(stablecoinOutflows.orgId, orgId))
    .orderBy(desc(stablecoinOutflows.createdAt))
    .limit(MAX_RECORDS);
  if (rows.length === 0) return [];

  const supplierIds = [...new Set(rows.map((r) => r.supplierId).filter((id): id is string => Boolean(id)))];
  const names = new Map<string, string>();
  if (supplierIds.length > 0) {
    const found: Array<{ id: string; name: string }> = await db
      .select({ id: suppliers.id, name: suppliers.name })
      .from(suppliers)
      .where(and(eq(suppliers.orgId, orgId), inArray(suppliers.id, supplierIds)));
    for (const s of found) names.set(s.id, s.name);
  }

  // The approval spent on each transfer: purpose STABLECOIN_TRANSFER, keyed by
  // the outflow id, consumed. Newest first, so the first seen per id wins.
  const approvals = new Map<string, { approverUserId: string; method: string; verifiedAt: Date | null }>();
  const approvalRows: Array<{ subjectId: string; approverUserId: string; method: string; verifiedAt: Date | null }> = await db
    .select({ subjectId: stepUpCodes.subjectId, approverUserId: stepUpCodes.approverUserId, method: stepUpCodes.method, verifiedAt: stepUpCodes.verifiedAt })
    .from(stepUpCodes)
    .where(and(
      eq(stepUpCodes.orgId, orgId),
      eq(stepUpCodes.purpose, 'STABLECOIN_TRANSFER'),
      inArray(stepUpCodes.subjectId, rows.map((r) => r.id)),
      isNotNull(stepUpCodes.consumedAt),
    ))
    .orderBy(desc(stepUpCodes.createdAt));
  for (const a of approvalRows) if (!approvals.has(a.subjectId)) approvals.set(a.subjectId, a);

  const userIds = [...new Set([
    ...rows.map((r) => r.requestedBy).filter((id): id is string => Boolean(id)),
    ...[...approvals.values()].map((a) => a.approverUserId),
  ])];
  const people = new Map<string, string>();
  if (userIds.length > 0) {
    const found: Array<{ id: string; name: string | null; email: string }> = await db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(inArray(users.id, userIds));
    for (const u of found) people.set(u.id, u.name ? `${u.name} <${u.email}>` : u.email);
  }

  return rows.map((r) => {
    const approval = approvals.get(r.id);
    return {
      id: r.id,
      kind: r.kind,
      status: r.status,
      createdAt: r.createdAt,
      confirmedAt: r.confirmedAt,
      recipientName: r.supplierId ? names.get(r.supplierId) ?? null : null,
      recipientAddress: r.recipientAddress,
      resource: r.resource,
      principalMinor: BigInt(r.principalMinor),
      feeMinor: BigInt(r.feeMinor),
      senderAddress: r.senderAddress,
      txDigest: r.txDigest,
      auditHash: r.auditHash,
      anchorStatus: r.anchorStatus,
      requestedBy: r.requestedBy ? people.get(r.requestedBy) ?? null : null,
      approvedBy: approval ? people.get(approval.approverUserId) ?? null : null,
      approvalMethod: approval?.method ?? null,
      approvedAt: approval?.verifiedAt ?? null,
      failureReason: r.failureReason,
    };
  });
}

/**
 * What Home needs from this workspace's wallet payments, and no more than
 * that (lib/dashboard/home.ts): every payment confirmed since `since`, for
 * Sent this month, and the `recent` newest payments, for Recent payments,
 * each with its recipient's name. Two bounded queries plus the names, rather
 * than every quote ever made with the export's approval and people joins.
 *
 * A payment is a row with a digest, or one that confirmed or failed. A quote
 * that was never broadcast is not one (isWalletPayment), so it is not read.
 */
export async function listHomeOutflows(
  db: Db,
  orgId: string,
  input: { since: Date; recent: number },
): Promise<HomeWalletPayment[]> {
  const columns = {
    id: stablecoinOutflows.id,
    kind: stablecoinOutflows.kind,
    status: stablecoinOutflows.status,
    supplierId: stablecoinOutflows.supplierId,
    recipientAddress: stablecoinOutflows.recipientAddress,
    principalMinor: stablecoinOutflows.principalMinor,
    txDigest: stablecoinOutflows.txDigest,
    createdAt: stablecoinOutflows.createdAt,
    confirmedAt: stablecoinOutflows.confirmedAt,
  };
  type Row = { id: string; kind: string; status: string; supplierId: string | null; recipientAddress: string; principalMinor: bigint | string; txDigest: string | null; createdAt: Date; confirmedAt: Date | null };

  const confirmed: Row[] = await db
    .select(columns)
    .from(stablecoinOutflows)
    .where(and(
      eq(stablecoinOutflows.orgId, orgId),
      eq(stablecoinOutflows.status, 'CONFIRMED'),
      gte(stablecoinOutflows.confirmedAt, input.since),
    ))
    .limit(MAX_RECORDS);
  const newest: Row[] = await db
    .select(columns)
    .from(stablecoinOutflows)
    .where(and(
      eq(stablecoinOutflows.orgId, orgId),
      or(isNotNull(stablecoinOutflows.txDigest), inArray(stablecoinOutflows.status, ['CONFIRMED', 'FAILED', 'MISMATCH'])),
    ))
    .orderBy(desc(stablecoinOutflows.createdAt))
    .limit(input.recent);

  const byId = new Map<string, Row>();
  for (const row of [...confirmed, ...newest]) byId.set(row.id, row);
  const rows = [...byId.values()];

  const supplierIds = [...new Set(rows.map((r) => r.supplierId).filter((id): id is string => Boolean(id)))];
  const names = new Map<string, string>();
  if (supplierIds.length > 0) {
    const found: Array<{ id: string; name: string }> = await db
      .select({ id: suppliers.id, name: suppliers.name })
      .from(suppliers)
      .where(and(eq(suppliers.orgId, orgId), inArray(suppliers.id, supplierIds)));
    for (const s of found) names.set(s.id, s.name);
  }

  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    status: r.status,
    recipientName: r.supplierId ? names.get(r.supplierId) ?? null : null,
    recipientAddress: r.recipientAddress,
    principalMinor: BigInt(r.principalMinor),
    txDigest: r.txDigest,
    createdAt: r.createdAt,
    confirmedAt: r.confirmedAt,
  }));
}

/**
 * What wallet activity needs to name its movements: this workspace's
 * transfers by transaction digest, and its wallet recipients by address.
 */
export async function loadActivityLabels(db: Db, orgId: string, digests: string[], ownWallet: string | null = null) {
  const outflowsByDigest = new Map<string, { kind: string; recipientName: string | null; resource: string | null; feeMinor: bigint }>();
  const recipientsByAddress = new Map<string, string>();
  // Deposits that paid one of this workspace's invoices (pay link, USDC on Sui).
  const invoicesByDigest = new Map<string, { invoiceId: string; payerName: string | null }>();
  // The caller's own passkey wallet is theirs, not the workspace's: a send
  // they made through Splash in another workspace is not "no record". Only
  // for their own wallet and their own sends, so nothing about anyone
  // else's wallet is revealed.
  const elsewhereDigests = new Set<string>();

  const recipients: Array<{ name: string; walletAddress: string | null }> = await db
    .select({ name: suppliers.name, walletAddress: suppliers.walletAddress })
    .from(suppliers)
    .where(and(eq(suppliers.orgId, orgId), isNotNull(suppliers.walletAddress)));
  for (const r of recipients) if (r.walletAddress) recipientsByAddress.set(r.walletAddress.toLowerCase(), r.name);

  if (digests.length > 0) {
    const rows: Array<{ txDigest: string | null; kind: string; supplierId: string | null; resource: string | null; feeMinor: bigint }> = await db
      .select({ txDigest: stablecoinOutflows.txDigest, kind: stablecoinOutflows.kind, supplierId: stablecoinOutflows.supplierId, resource: stablecoinOutflows.resource, feeMinor: stablecoinOutflows.feeMinor })
      .from(stablecoinOutflows)
      .where(and(eq(stablecoinOutflows.orgId, orgId), inArray(stablecoinOutflows.txDigest, digests)));
    const supplierIds = [...new Set(rows.map((r) => r.supplierId).filter((id): id is string => Boolean(id)))];
    const names = new Map<string, string>();
    if (supplierIds.length > 0) {
      const found: Array<{ id: string; name: string }> = await db
        .select({ id: suppliers.id, name: suppliers.name })
        .from(suppliers)
        .where(and(eq(suppliers.orgId, orgId), inArray(suppliers.id, supplierIds)));
      for (const s of found) names.set(s.id, s.name);
    }
    const paidInvoices: Array<{ id: string; payerName: string | null; usdcTxDigest: string | null }> = await db
      .select({ id: invoices.id, payerName: invoices.payerName, usdcTxDigest: invoices.usdcTxDigest })
      .from(invoices)
      .where(and(eq(invoices.orgId, orgId), inArray(invoices.usdcTxDigest, digests)));
    for (const i of paidInvoices) if (i.usdcTxDigest) invoicesByDigest.set(i.usdcTxDigest, { invoiceId: i.id, payerName: i.payerName });
    if (ownWallet) {
      const elsewhere: Array<{ txDigest: string | null }> = await db
        .select({ txDigest: stablecoinOutflows.txDigest })
        .from(stablecoinOutflows)
        .where(and(
          ne(stablecoinOutflows.orgId, orgId),
          eq(stablecoinOutflows.senderAddress, ownWallet),
          inArray(stablecoinOutflows.txDigest, digests),
        ));
      for (const e of elsewhere) if (e.txDigest) elsewhereDigests.add(e.txDigest);
    }
    for (const r of rows) {
      if (!r.txDigest) continue;
      outflowsByDigest.set(r.txDigest, {
        kind: r.kind,
        recipientName: r.supplierId ? names.get(r.supplierId) ?? null : null,
        resource: r.resource,
        feeMinor: BigInt(r.feeMinor),
      });
    }
  }
  return { outflowsByDigest, recipientsByAddress, invoicesByDigest, elsewhereDigests };
}
