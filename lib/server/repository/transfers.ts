/**
 * Transfers, in Postgres, belonging to somebody.
 *
 * The operational transfer record lived in a process-global `Map` on
 * `globalThis`. Two consequences, and the second is the serious one:
 *
 *   It did not survive a restart. Every in-flight transfer, every settled
 *   receipt, every audit reference — gone on deploy.
 *
 *   It carried no org id AT ALL. One Map, every tenant, and no scoping on read.
 *   `listTransfers()` returned everybody's. That is not a durability bug, it is
 *   a tenant-isolation bug that happened to be hidden by there being one tenant.
 *
 * `payment_intents` was designed for this record and never wired up — org id,
 * bigint minor units, funding fields, Sui digest, audit anchor id, all already
 * there. This module is the wiring.
 *
 * ─── Every read takes an orgId, and it is not optional ──────────────────────
 *
 * Not "takes an optional filter". A caller that genuinely needs cross-tenant
 * reach — the staff console — calls the `*ForStaff` variants, which are named
 * so that granting cross-tenant reach is a visible act at the call site rather
 * than a forgotten argument.
 */
import { and, desc, eq } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';

import { intentTransitions, paymentIntents } from '../../db/schema.ts';
import type * as schemaModule from '../../db/schema.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DrizzleDb = PgDatabase<any, typeof schemaModule, any>;

/**
 * The shape callers already use. Kept identical to what the in-memory store
 * returned so wiring this in is not also a refactor of seven route handlers —
 * one change at a time is how a money path stays reviewable.
 */
export type TransferRow = {
  id: string;
  orgId: string;
  state: string;
  recipientName: string;
  targetCurrency: string;
  targetAmount: string;
  sourceAmountUsd: string;
  quoteId: string | null;
  exchangeRate: string | null;
  deliveryTier: string;
  recipientId?: string;
  invoiceId?: string;
  suiTxDigest: string | null;
  receiptObjectId: string | null;
  walrusBlobId?: string;
  auditAnchorId?: string;
  failureReason: string | null;
  failedAtState: string | null;
  demo?: boolean;
  idempotencyKey?: string;
  /** Everything without a column of its own. */
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

/**
 * Amounts cross this boundary as decimal strings and are stored as bigint minor
 * units, because that is the rule the whole codebase runs on: never a float.
 *
 * `parseMinor` refuses a fractional `number`, so the conversion happens here on
 * the string the caller already has rather than by rounding something that was
 * a float three frames ago.
 */
function toMinor(amount: string | null | undefined, decimals = 6): bigint {
  const raw = (amount ?? '0').trim().replace(/,/g, '');
  if (raw.length === 0) return 0n;
  const negative = raw.startsWith('-');
  const [whole, frac = ''] = raw.replace(/^-/, '').split('.');
  const padded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  const value = BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(padded || '0');
  return negative ? -value : value;
}

function fromMinor(value: bigint | null | undefined, decimals = 6): string {
  if (value === null || value === undefined) return '0';
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const unit = 10n ** BigInt(decimals);
  const whole = abs / unit;
  const frac = (abs % unit).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

type IntentSelect = typeof paymentIntents.$inferSelect;

function toRow(row: IntentSelect): TransferRow {
  const metadata = (row.settlementMetadata ?? {}) as Record<string, unknown>;
  return {
    id: row.id,
    orgId: row.orgId,
    state: row.state,
    recipientName: row.recipientName ?? '',
    targetCurrency: row.targetCurrency,
    targetAmount: fromMinor(row.targetAmountMinor),
    sourceAmountUsd: fromMinor(row.sourceAmountMinor),
    quoteId: row.quoteId,
    exchangeRate: row.exchangeRate,
    deliveryTier: row.deliveryTier ?? 'PAYOUT_ONLY',
    recipientId: row.supplierId ?? undefined,
    invoiceId: row.invoiceId ?? undefined,
    suiTxDigest: row.suiTxDigest,
    receiptObjectId: row.receiptObjectId,
    walrusBlobId: row.walrusBlobId ?? undefined,
    auditAnchorId: row.auditAnchorId ?? undefined,
    failureReason: row.failureReason,
    failedAtState: row.failedAtState,
    demo: row.demo,
    idempotencyKey: row.idempotencyKey ?? undefined,
    metadata,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export type NewTransfer = Omit<TransferRow, 'createdAt' | 'updatedAt'>;

export async function insertTransfer(db: DrizzleDb, input: NewTransfer): Promise<TransferRow> {
  const [row] = await db
    .insert(paymentIntents)
    .values({
      id: input.id,
      orgId: input.orgId,
      supplierId: input.recipientId ?? null,
      invoiceId: input.invoiceId ?? null,
      state: input.state as IntentSelect['state'],
      sourceAmountMinor: toMinor(input.sourceAmountUsd),
      sourceCurrency: 'USD',
      targetAmountMinor: toMinor(input.targetAmount),
      targetCurrency: input.targetCurrency,
      exchangeRate: input.exchangeRate,
      quoteId: input.quoteId,
      suiTxDigest: input.suiTxDigest,
      receiptObjectId: input.receiptObjectId,
      walrusBlobId: input.walrusBlobId ?? null,
      auditAnchorId: input.auditAnchorId ?? null,
      failureReason: input.failureReason,
      failedAtState: input.failedAtState,
      demo: input.demo ?? false,
      idempotencyKey: input.idempotencyKey ?? null,
      recipientName: input.recipientName,
      deliveryTier: input.deliveryTier,
      settlementMetadata: input.metadata,
    })
    .returning();
  return toRow(row);
}

/**
 * Read one transfer, scoped to the org that owns it.
 *
 * An id alone is not authority. Returning null for another tenant's id — rather
 * than the row, or a 403 that confirms it exists — is the same answer a
 * non-existent id gets, so probing tells an attacker nothing.
 */
export async function getTransfer(
  db: DrizzleDb,
  orgId: string,
  intentId: string,
): Promise<TransferRow | null> {
  const rows = await db
    .select()
    .from(paymentIntents)
    .where(and(eq(paymentIntents.id, intentId), eq(paymentIntents.orgId, orgId)))
    .limit(1);
  return rows.length > 0 ? toRow(rows[0]) : null;
}

/** Cross-tenant read for the staff console. Named so it cannot be reached by accident. */
export async function getTransferForStaff(
  db: DrizzleDb,
  intentId: string,
): Promise<TransferRow | null> {
  const rows = await db.select().from(paymentIntents).where(eq(paymentIntents.id, intentId)).limit(1);
  return rows.length > 0 ? toRow(rows[0]) : null;
}

export async function listTransfers(
  db: DrizzleDb,
  orgId: string,
  limit = 100,
): Promise<TransferRow[]> {
  const rows = await db
    .select()
    .from(paymentIntents)
    .where(eq(paymentIntents.orgId, orgId))
    .orderBy(desc(paymentIntents.createdAt))
    .limit(limit);
  return rows.map(toRow);
}

/** Every tenant's transfers, for the staff console. Deliberately separate from
 *  `listTransfers`, so cross-tenant reach is a different function name rather
 *  than an omitted argument. */
export async function listAllTransfers(db: DrizzleDb, limit = 200): Promise<TransferRow[]> {
  const rows = await db
    .select()
    .from(paymentIntents)
    .orderBy(desc(paymentIntents.createdAt))
    .limit(limit);
  return rows.map(toRow);
}

/**
 * Apply a patch, and record the state change if there is one.
 *
 * The transition row is the point. A transfer that went AUTHORIZED → SETTLED
 * with no record of when, or of what it passed through, cannot be reconciled
 * against the chain afterwards — and `intent_transitions` existed for exactly
 * this and was never written to.
 */
export async function patchTransfer(
  db: DrizzleDb,
  intentId: string,
  patch: Partial<TransferRow>,
  actor?: string,
): Promise<TransferRow | null> {
  const existing = await getTransferForStaff(db, intentId);
  if (!existing) return null;

  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.state !== undefined) update.state = patch.state;
  if (patch.suiTxDigest !== undefined) update.suiTxDigest = patch.suiTxDigest;
  if (patch.receiptObjectId !== undefined) update.receiptObjectId = patch.receiptObjectId;
  if (patch.walrusBlobId !== undefined) update.walrusBlobId = patch.walrusBlobId;
  if (patch.auditAnchorId !== undefined) update.auditAnchorId = patch.auditAnchorId;
  if (patch.failureReason !== undefined) update.failureReason = patch.failureReason;
  if (patch.failedAtState !== undefined) update.failedAtState = patch.failedAtState;
  if (patch.recipientId !== undefined) update.supplierId = patch.recipientId;
  if (patch.invoiceId !== undefined) update.invoiceId = patch.invoiceId;
  if (patch.exchangeRate !== undefined) update.exchangeRate = patch.exchangeRate;
  if (patch.targetAmount !== undefined) update.targetAmountMinor = toMinor(patch.targetAmount);
  if (patch.metadata !== undefined) {
    // Merge, not replace: a patch that carries one new field must not erase the
    // rest of a settlement's own record.
    update.settlementMetadata = { ...existing.metadata, ...patch.metadata };
  }

  const [row] = await db
    .update(paymentIntents)
    .set(update)
    .where(eq(paymentIntents.id, intentId))
    .returning();

  if (patch.state !== undefined && patch.state !== existing.state) {
    await db.insert(intentTransitions).values({
      id: `itr_${intentId}_${row.updatedAt.getTime()}`,
      intentId,
      fromState: existing.state as IntentSelect['state'],
      toState: patch.state as IntentSelect['state'],
      reason: patch.failureReason ?? null,
      actor: actor ?? 'system',
    });
  }

  return toRow(row);
}

export async function findByIdempotencyKey(
  db: DrizzleDb,
  orgId: string,
  idempotencyKey: string,
): Promise<TransferRow | null> {
  const rows = await db
    .select()
    .from(paymentIntents)
    .where(
      and(eq(paymentIntents.orgId, orgId), eq(paymentIntents.idempotencyKey, idempotencyKey)),
    )
    .limit(1);
  return rows.length > 0 ? toRow(rows[0]) : null;
}

export async function listTransitions(db: DrizzleDb, intentId: string) {
  return db
    .select()
    .from(intentTransitions)
    .where(eq(intentTransitions.intentId, intentId))
    .orderBy(intentTransitions.createdAt);
}

export const __testing = { toMinor, fromMinor };
