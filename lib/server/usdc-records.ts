import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';

import { stablecoinOutflows, stepUpCodes, suppliers, users } from '@/lib/db/schema';
import type { UsdcRecord } from '@/lib/payments/usdc-records';

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
 * What wallet activity needs to name its movements: this workspace's
 * transfers by transaction digest, and its wallet recipients by address.
 */
export async function loadActivityLabels(db: Db, orgId: string, digests: string[]) {
  const outflowsByDigest = new Map<string, { kind: string; recipientName: string | null; resource: string | null; feeMinor: bigint }>();
  const recipientsByAddress = new Map<string, string>();

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
  return { outflowsByDigest, recipientsByAddress };
}
