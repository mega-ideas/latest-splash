/**
 * The one way to read or write a transfer.
 *
 * Two backends, one API. Postgres when `DATABASE_URL` is configured — which is
 * every deployed environment, since `lib/env.ts` requires it for authority and
 * persistence — and the in-process map only when it is not, which is local
 * development and CI.
 *
 * ─── Why the fallback is narrow, and says so ────────────────────────────────
 *
 * The in-memory store is not a cache and not a mode anyone should choose. It
 * exists so `npm run dev` works without a database, and it announces itself
 * once per process so nobody mistakes a working demo for a working deployment.
 * It is NOT a fallback for a database that is configured but unreachable: that
 * case must fail, because silently continuing into a store that forgets
 * everything is how a settled payment stops existing.
 *
 * ─── Every read is scoped ───────────────────────────────────────────────────
 *
 * `orgId` is the first argument of every read, and it is not optional. The
 * record this replaces had no org id at all: one global map, every tenant, no
 * scoping — `listTransfers()` returned everybody's. That was a tenant-isolation
 * bug hidden by there being one tenant.
 *
 * Cross-tenant reach exists for the staff console and is spelled `*ForStaff`,
 * so granting it is a visible act at the call site rather than an argument
 * somebody forgot to pass.
 */
import { operations, type AuditReceipt, type TransferIntentRecord } from './operations.ts';
import * as repo from './repository/transfers.ts';

let announced = false;

function usingPostgres(): boolean {
  if (process.env.DATABASE_URL) return true;
  if (!announced) {
    announced = true;
    console.warn(
      '[transfers] DATABASE_URL is not set, so transfers live in this process and ' +
        'disappear when it restarts. Local development only — every deployed ' +
        'environment requires it.',
    );
  }
  return false;
}

async function db() {
  const { getDb } = await import('../db/client.ts');
  return getDb() as never;
}

/** Repository row -> the record shape every caller already uses. */
function toRecord(row: repo.TransferRow): TransferIntentRecord {
  return {
    ...(row.metadata as Partial<TransferIntentRecord>),
    id: row.id,
    orgId: row.orgId,
    state: row.state as TransferIntentRecord['state'],
    recipientName: row.recipientName,
    targetCurrency: row.targetCurrency,
    targetAmount: row.targetAmount,
    sourceAmountUsd: row.sourceAmountUsd,
    quoteId: row.quoteId,
    exchangeRate: row.exchangeRate,
    deliveryTier: row.deliveryTier as TransferIntentRecord['deliveryTier'],
    recipientId: row.recipientId,
    invoiceId: row.invoiceId,
    suiTxDigest: row.suiTxDigest,
    receiptObjectId: row.receiptObjectId,
    walrusBlobId: row.walrusBlobId,
    auditAnchorId: row.auditAnchorId,
    failureReason: row.failureReason,
    failedAtState: row.failedAtState,
    demo: row.demo,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  } as TransferIntentRecord;
}

/**
 * The fields with a column of their own. Everything else on the record is one
 * settlement's own detail and rides in `settlement_metadata` — see the
 * migration for why that is one jsonb rather than twenty sparse columns.
 */
const COLUMN_FIELDS = new Set([
  'id', 'orgId', 'state', 'recipientName', 'targetCurrency', 'targetAmount',
  'sourceAmountUsd', 'quoteId', 'exchangeRate', 'deliveryTier', 'recipientId',
  'invoiceId', 'suiTxDigest', 'receiptObjectId', 'walrusBlobId', 'auditAnchorId',
  'failureReason', 'failedAtState', 'demo', 'createdAt', 'updatedAt',
]);

function splitMetadata(record: Partial<TransferIntentRecord>): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!COLUMN_FIELDS.has(key) && value !== undefined) metadata[key] = value;
  }
  return metadata;
}

export async function persistTransfer(record: TransferIntentRecord): Promise<TransferIntentRecord> {
  if (!usingPostgres()) {
    operations.transfers.set(record.id, record);
    return record;
  }
  const row = await repo.insertTransfer(await db(), {
    id: record.id,
    orgId: record.orgId,
    state: record.state,
    recipientName: record.recipientName,
    targetCurrency: record.targetCurrency,
    targetAmount: record.targetAmount,
    sourceAmountUsd: record.sourceAmountUsd,
    quoteId: record.quoteId,
    exchangeRate: record.exchangeRate,
    deliveryTier: record.deliveryTier,
    recipientId: record.recipientId,
    invoiceId: record.invoiceId,
    suiTxDigest: record.suiTxDigest,
    receiptObjectId: record.receiptObjectId,
    walrusBlobId: record.walrusBlobId,
    auditAnchorId: record.auditAnchorId,
    failureReason: record.failureReason,
    failedAtState: record.failedAtState,
    demo: record.demo,
    metadata: splitMetadata(record),
  });
  return toRecord(row);
}

/** Read one transfer belonging to `orgId`. A foreign id reads as missing. */
export async function readTransfer(
  orgId: string,
  intentId: string,
): Promise<TransferIntentRecord | null> {
  if (!usingPostgres()) {
    const record = operations.transfers.get(intentId) ?? null;
    return record && record.orgId === orgId ? record : null;
  }
  const row = await repo.getTransfer(await db(), orgId, intentId);
  return row ? toRecord(row) : null;
}

/** Cross-tenant read. Staff console and internal settlement callbacks only. */
export async function readTransferForStaff(
  intentId: string,
): Promise<TransferIntentRecord | null> {
  if (!usingPostgres()) return operations.transfers.get(intentId) ?? null;
  const row = await repo.getTransferForStaff(await db(), intentId);
  return row ? toRecord(row) : null;
}

export async function listTransfersFor(orgId: string, limit = 100): Promise<TransferIntentRecord[]> {
  if (!usingPostgres()) {
    return [...operations.transfers.values()]
      .filter((t) => t.orgId === orgId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }
  const rows = await repo.listTransfers(await db(), orgId, limit);
  return rows.map(toRecord);
}

/** Every transfer, for the staff console. Named so it cannot be reached by accident. */
export async function listTransfersForStaff(limit = 200): Promise<TransferIntentRecord[]> {
  if (!usingPostgres()) {
    return [...operations.transfers.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }
  const rows = await repo.listAllTransfers(await db(), limit);
  return rows.map(toRecord);
}

/**
 * What one write to a transfer may carry.
 *
 * The transfer's own fields, plus the handful that belong to the audit receipt
 * alone. They are one type because they are one row: the receipt is composed
 * from the transfer (see below), so a settlement that records a digest and an
 * evidence blob is a single write, not two into two stores that can disagree.
 */
export type TransferPatch = Partial<TransferIntentRecord> & Partial<ReceiptOnly>;

/**
 * Keep the in-process audit receipt in step with the transfer.
 *
 * `updateTransferIntent` carried this as a side effect, and deleting it froze
 * every transfer's status history at AUTHORIZED — the customer's tracker in
 * `components/transfer/StepStatus.tsx` reads that history for its stage
 * timestamps, so the payment would have kept moving while the page showed it
 * stuck at the first step.
 *
 * The durable record of a transition is the `intent_transitions` row the
 * repository writes, and on the Postgres path the history is read back from
 * those rows. This keeps the in-process backend — which has no transitions
 * table and no jsonb to put the receipt-only fields in — telling the same story.
 *
 * Idempotent by construction: it appends only when the recorded head differs,
 * so a retried patch does not log the same state twice.
 */
function mirrorToAuditReceipt(intentId: string, patch: TransferPatch): void {
  const receipt = operations.auditReceipts.get(intentId) ?? {
    transferIntentId: intentId,
    statusHistory: [],
  };
  if (patch.state && patch.state !== receipt.statusHistory.at(-1)?.state) {
    receipt.statusHistory.push({ state: patch.state, at: new Date().toISOString() });
  }
  if (patch.suiTxDigest) receipt.suiTxDigest = patch.suiTxDigest;
  if (patch.sweepJobId) receipt.sweepJobId = patch.sweepJobId;
  for (const field of RECEIPT_ONLY_FIELDS) {
    if (patch[field] !== undefined) (receipt as Record<string, unknown>)[field] = patch[field];
  }
  operations.auditReceipts.set(intentId, receipt);
}

export async function patchTransfer(
  intentId: string,
  patch: TransferPatch,
  actor?: string,
): Promise<void> {
  if (!usingPostgres()) {
    const record = operations.transfers.get(intentId);
    if (!record) return;
    Object.assign(record, patch, { updatedAt: new Date().toISOString() });
    operations.transfers.set(intentId, record);
    mirrorToAuditReceipt(intentId, patch);
    return;
  }
  const metadata = splitMetadata(patch);
  const row = await repo.patchTransfer(
    await db(),
    intentId,
    {
      state: patch.state,
      suiTxDigest: patch.suiTxDigest,
      receiptObjectId: patch.receiptObjectId,
      walrusBlobId: patch.walrusBlobId,
      auditAnchorId: patch.auditAnchorId,
      failureReason: patch.failureReason,
      failedAtState: patch.failedAtState,
      recipientId: patch.recipientId,
      invoiceId: patch.invoiceId,
      exchangeRate: patch.exchangeRate,
      targetAmount: patch.targetAmount,
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    },
    actor,
  );
  // Only after the write landed. A patch against an id that does not exist
  // must not leave a history entry for a transfer nobody has.
  if (row) mirrorToAuditReceipt(intentId, patch);
}

/* ─── The audit receipt ───────────────────────────────────────────────────────
 *
 * It is not a second record. It is a view of the transfer.
 *
 * It has always been keyed by a transfer intent id, one per transfer, and
 * nearly every field on it is a field the transfer already has: the invoice,
 * the Walrus blob, the Seal policy, the settlement digest, the audit hash and
 * anchor, the composed actions, the funding route. The authorize route wrote
 * `result.digest` into the transfer and then wrote it again into the receipt,
 * two lines apart — two stores holding the same fact, free to disagree the
 * moment one write succeeds and the other does not.
 *
 * So there is no `audit_receipts` table and there should not be one. A receipt
 * is composed from the transfer row, the handful of receipt-only fields that
 * ride in `settlement_metadata`, and `intent_transitions` for the history.
 * One writer, one source of truth, and an audit trail that cannot drift from
 * the payment it describes.
 *
 * ─── Reconstructing the opening entry ───────────────────────────────────────
 *
 * `intent_transitions` records changes, so it has no row for the state a
 * transfer was created in. The opening entry is recovered from the transfer's
 * own `createdAt` and the first transition's `fromState` — or, for a transfer
 * that has not moved yet, its current state. That reproduces exactly what the
 * appended history used to hold.
 */

/** The fields that belong to the receipt alone and live in `settlement_metadata`. */
type ReceiptOnly = Pick<
  AuditReceipt,
  'memwalRecordId' | 'extractionSnapshot' | 'approvedBy' | 'approvedAt' | 'auditAnchorDigest' | 'evidence'
>;

const RECEIPT_ONLY_FIELDS: Array<keyof ReceiptOnly> = [
  'memwalRecordId',
  'extractionSnapshot',
  'approvedBy',
  'approvedAt',
  'auditAnchorDigest',
  'evidence',
];

type TransitionRow = { fromState: string | null; toState: string; createdAt: Date | string };

function statusHistoryFrom(
  record: TransferIntentRecord,
  transitions: TransitionRow[],
): AuditReceipt['statusHistory'] {
  const at = (value: Date | string) => (value instanceof Date ? value.toISOString() : value);
  return [
    { state: transitions[0]?.fromState ?? record.state, at: record.createdAt },
    ...transitions.map((t) => ({ state: t.toState, at: at(t.createdAt) })),
  ];
}

function toAuditReceipt(record: TransferIntentRecord, transitions: TransitionRow[]): AuditReceipt {
  // `toRecord` spreads `settlement_metadata` onto the record, so the
  // receipt-only fields arrive here as loose properties on it.
  const extra = record as unknown as ReceiptOnly;
  return {
    transferIntentId: record.id,
    invoiceId: record.invoiceId,
    walrusBlobId: record.walrusBlobId,
    sealPolicyId: record.sealPolicyId,
    suiTxDigest: record.suiTxDigest ?? undefined,
    sweepJobId: record.sweepJobId,
    auditHash: record.auditHash,
    auditAnchorId: record.auditAnchorId,
    paymentIntentId: record.paymentIntentId,
    intentCreateDigest: record.intentCreateDigest,
    smartTreasuryId: record.smartTreasuryId,
    composedActions: record.composedActions,
    demo: record.demo,
    funding: {
      sessionId: record.fundingSessionId,
      source: record.fundingSource,
      method: record.fundingMethod,
      provider: record.fundingProvider,
      asset: record.fundingAsset,
      rail: record.fundingRail,
      sourceChain: record.fundingSourceChain,
      feeTier: record.fundingFeeTier,
      kytStatus: record.fundingKytStatus,
      normalizeVenue: record.fundingNormalizeVenue,
      effectiveSlippageBps: record.fundingEffectiveSlippageBps,
    },
    memwalRecordId: extra.memwalRecordId,
    extractionSnapshot: extra.extractionSnapshot,
    approvedBy: extra.approvedBy,
    approvedAt: extra.approvedAt,
    auditAnchorDigest: extra.auditAnchorDigest,
    evidence: extra.evidence,
    statusHistory: statusHistoryFrom(record, transitions),
  };
}

async function auditReceiptFrom(record: TransferIntentRecord | null): Promise<AuditReceipt | null> {
  if (!record) return null;
  if (!usingPostgres()) {
    // No transitions table here, so the history is the one the mirror appended.
    const mirrored = operations.auditReceipts.get(record.id);
    return { ...toAuditReceipt(record, []), ...(mirrored ?? {}) };
  }
  return toAuditReceipt(record, await repo.listTransitions(await db(), record.id));
}

/** The audit trail for one transfer, scoped to the org that owns it. */
export async function readAuditReceipt(
  orgId: string,
  intentId: string,
): Promise<AuditReceipt | null> {
  return auditReceiptFrom(await readTransfer(orgId, intentId));
}

/** Cross-tenant. The public receipt-share page and internal jobs only. */
export async function readAuditReceiptForStaff(intentId: string): Promise<AuditReceipt | null> {
  return auditReceiptFrom(await readTransferForStaff(intentId));
}

/**
 * Record receipt detail against a transfer.
 *
 * A thin name over `patchTransfer`, for call sites whose subject is the trail
 * rather than the payment — an approver, an extraction snapshot. It writes the
 * same row, which is the point: fields the transfer already owns go to their
 * own columns and the six that belong to the receipt alone go to
 * `settlement_metadata`, so the digest on the receipt is the digest on the
 * payment by construction rather than by agreement.
 */
export async function patchAuditReceipt(
  intentId: string,
  patch: Partial<AuditReceipt>,
): Promise<void> {
  const { funding, statusHistory, transferIntentId, ...rest } = patch;
  void funding; // flattened onto the transfer as fundingMethod, fundingRail, …
  void statusHistory; // derived from intent_transitions; never written directly
  void transferIntentId; // the key, not a field
  await patchTransfer(intentId, rest);
}

/** The reconstruction, reachable on its own so a test can hold it to the
 *  history the appended version produced. */
export const __testing = { statusHistoryFrom };

export async function findTransferByIdempotencyKey(
  orgId: string,
  key: string,
): Promise<TransferIntentRecord | null> {
  if (!usingPostgres()) {
    const hit = [...operations.transfers.values()].find(
      (t) => t.orgId === orgId && (t as { idempotencyKey?: string }).idempotencyKey === key,
    );
    return hit ?? null;
  }
  const row = await repo.findByIdempotencyKey(await db(), orgId, key);
  return row ? toRecord(row) : null;
}
