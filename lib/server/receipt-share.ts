import { createPayLinkSlug, type AuditReceipt, type TransferIntentRecord } from './operations';
import { readAuditReceiptForStaff, readTransferForStaff } from './transfers-store';

/**
 * W9.2 — tokenized read-only receipt links ("Share with supplier").
 *
 * Same pattern as the app/pay/[slug] links: an unguessable slug resolves to
 * one record, the public page renders identical facts without login, and the
 * token grants access to NOTHING beyond that single receipt.
 *
 * `display` carries the handful of quote-time facts the intent record does
 * not persist yet (fee, reference, operator) so the shared page shows the
 * SAME numbers the operator saw — minted only by the authenticated owner.
 * In-memory today (like every store here); migrates with the W1 tables.
 */

export type ReceiptShareDisplay = {
  fee?: string;
  reference?: string;
  approvedBy?: string;
  issuedAt?: string;
};

type ShareRecord = { transferIntentId: string; display: ReceiptShareDisplay };

// globalThis-anchored like lib/server/operations.ts: route handlers and
// server components get separate module instances in dev, so a plain
// module-level Map would mint tokens the page bundle cannot see.
type ShareStore = { tokens: Map<string, ShareRecord>; byIntent: Map<string, string> };
const globalStore = globalThis as typeof globalThis & { splashReceiptShares?: ShareStore };
const store: ShareStore = globalStore.splashReceiptShares ?? {
  tokens: new Map<string, ShareRecord>(),
  byIntent: new Map<string, string>(),
};
globalStore.splashReceiptShares = store;

const shareTokens = store.tokens; // token -> record
const intentTokens = store.byIntent; // transferIntentId -> token (idempotent mint)

export async function createReceiptShare(transferIntentId: string, display: ReceiptShareDisplay = {}): Promise<string | null> {
  if (!await readTransferForStaff(transferIntentId)) return null;
  const existing = intentTokens.get(transferIntentId);
  if (existing) {
    const record = shareTokens.get(existing);
    if (record) record.display = { ...record.display, ...display };
    return existing;
  }
  const token = createPayLinkSlug();
  shareTokens.set(token, { transferIntentId, display });
  intentTokens.set(transferIntentId, token);
  return token;
}

export async function findReceiptShare(token: string): Promise<{
  intent: TransferIntentRecord;
  audit: AuditReceipt | null;
  display: ReceiptShareDisplay;
} | null> {
  const record = shareTokens.get(token);
  if (!record) return null;
  const intent = await readTransferForStaff(record.transferIntentId);
  if (!intent) return null;
  return {
    intent,
    audit: await readAuditReceiptForStaff(record.transferIntentId),
    display: record.display,
  };
}
