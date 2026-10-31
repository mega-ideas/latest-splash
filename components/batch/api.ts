/**
 * Client calls and shapes for batch payouts (v2 brief 5.6). The shapes are the
 * server's own (type imports only, erased at build); a network failure is
 * `status: 0`, which the page words as "could not reach Splash", never as a
 * refusal of the batch.
 */
import type { BatchReview, BatchView, RowReview } from '@/lib/server/wallet-batches';
import type { BatchReceipt } from '@/lib/server/batch-receipts';
import type { SigningView } from '../transfer/api';

export { call, errorText } from '../transfer/api';
export type { Answer, Context } from '../transfer/api';
export type { BatchReview, BatchView, RowReview, BatchReceipt, SigningView };

/** The intent id of one batch: made once for a sheet, and again whenever the sheet changes. */
export function newBatchKey(random: (bytes: number) => Uint8Array = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))): string {
  return `batch_${Array.from(random(12), (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export type StepNumber = 1 | 2 | 3 | 4 | 5;

/** What the person approved on the Review step, held on their own device: the signing screen checks the transaction's own bytes against it. */
export type ApprovedRow = { recipient: string; amountMinor: string; maxFeeMinor: string; payeeName: string };
