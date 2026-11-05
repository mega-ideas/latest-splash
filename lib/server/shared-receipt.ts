/**
 * The receipt a share link opens (v2 brief 5.4 step 5), without signing in.
 *
 * The token opens ONE payment's receipt, for a month, until revoked
 * (lib/server/receipt-documents.ts). Only a settled payment's receipt is
 * shown, and it is the same receipt the business sees (lib/server/
 * payment-receipts.ts): nothing more is read for a stranger. Whatever is not
 * a live token, or has no database behind it, reads as absent.
 */
import 'server-only';

import { receiptDepsFor } from '@/lib/server/wallet-transfers-deps';
import { paymentReceiptFor } from '@/lib/server/payment-receipts';
import { readReceiptShare } from '@/lib/server/receipt-documents';
import type { PaymentReceipt } from '@/lib/transfer/receipt';

export async function sharedReceiptFor(token: string, now: Date = new Date()): Promise<PaymentReceipt | null> {
  if (!process.env.DATABASE_URL) return null;
  const { getDb } = await import('@/lib/db/client');
  const db = getDb() as unknown as Parameters<typeof readReceiptShare>[0];
  const share = await readReceiptShare(db, token, now);
  if (!share) return null;
  const made = await paymentReceiptFor(await receiptDepsFor(db, share.orgId), share.paymentRef, 'shared-link');
  return made.ok && made.receipt.final ? made.receipt : null;
}
