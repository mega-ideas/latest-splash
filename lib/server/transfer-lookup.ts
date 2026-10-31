/**
 * The payment started from Transfer that a signing request pays, for ONE
 * business.
 *
 * An owner's payment carries its signing request on its own row. A staff
 * member's payment is an ask first: the owners' accept opens the request and
 * writes it back to the row, but a row from before that write-back, or one
 * whose write-back did not land, still reaches its request through the ask.
 * Receipts, share links and invoice settlement all find a payment this way.
 */
import { and, eq } from 'drizzle-orm';

import { walletApprovalAsks, walletTransfers } from '../db/schema.ts';
import type { DrizzleDb } from './wallet-signing-store.ts';

export type TransferRow = typeof walletTransfers.$inferSelect;

export async function transferForRequest(db: Pick<DrizzleDb, 'select'>, orgId: string, requestId: string): Promise<TransferRow | null> {
  const [direct] = await db.select().from(walletTransfers).where(and(eq(walletTransfers.orgId, orgId), eq(walletTransfers.signingRequestId, requestId))).limit(1);
  if (direct) return direct;
  const [ask] = await db.select({ id: walletApprovalAsks.id }).from(walletApprovalAsks).where(and(eq(walletApprovalAsks.orgId, orgId), eq(walletApprovalAsks.signingRequestId, requestId))).limit(1);
  if (!ask) return null;
  const [viaAsk] = await db.select().from(walletTransfers).where(and(eq(walletTransfers.orgId, orgId), eq(walletTransfers.askId, ask.id))).limit(1);
  return viaAsk ?? null;
}
