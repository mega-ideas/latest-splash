/**
 * What the person approved on the Review step, held on their own device, set
 * against what the transaction they are about to sign says (read from its own
 * bytes by reviewOnDevice, never from the server's description). A server that
 * swapped the payee, the amount or the fee bound between Review and signing
 * is caught here, before the passkey is asked.
 */
import { normalizeSuiAddress } from '@mysten/sui/utils';

export type ApprovedPayment = { recipient: string | null; amountMinor: string; maxFeeMinor: string };

/** The part of a device review this check reads. */
export type ReviewedActions = { actions: Array<{ type: string; recipient?: string; amountMinor?: string | null; maxFeeMinor?: string | null }> };

/** The first way the transaction differs from the payment that was approved, or null when it is the same payment. */
export function differsFromApproved(review: ReviewedActions, expected: ApprovedPayment): string | null {
  const open = review.actions.find((a) => a.type === 'open_intent');
  const pay = review.actions.find((a) => a.type === 'pay_intent');
  if (!open || !pay) return 'This transaction does not pay the way the payment you approved does.';
  if (expected.recipient) {
    try {
      if (normalizeSuiAddress(open.recipient ?? '') !== normalizeSuiAddress(expected.recipient)) return 'This transaction pays a different address from the one you approved.';
    } catch {
      return 'This transaction pays a different address from the one you approved.';
    }
  }
  if (open.amountMinor !== expected.amountMinor) return 'This transaction pays a different amount from the one you approved.';
  if (pay.maxFeeMinor !== expected.maxFeeMinor) return 'This transaction allows a different Splash fee from the one you approved.';
  return null;
}

/**
 * The same check for a batch (v2 brief 5.6): the transaction must pay exactly
 * the payments approved on the review step, in that order, no more and no
 * fewer, each to the address, for the amount and with the fee bound approved.
 * Read from the transaction's own bytes by reviewOnDevice.
 */
export function differsFromApprovedBatch(review: ReviewedActions, expected: ApprovedPayment[]): string | null {
  const opens = review.actions.filter((a) => a.type === 'open_intent');
  const pays = review.actions.filter((a) => a.type === 'pay_intent');
  if (opens.length !== expected.length || pays.length !== expected.length) {
    return `This transaction makes ${opens.length} payments, and the batch you approved has ${expected.length}.`;
  }
  for (let i = 0; i < expected.length; i += 1) {
    const e = expected[i];
    const n = i + 1;
    if (e.recipient) {
      try {
        if (normalizeSuiAddress(opens[i].recipient ?? '') !== normalizeSuiAddress(e.recipient)) return `Payment ${n} goes to a different address from the one you approved.`;
      } catch {
        return `Payment ${n} goes to a different address from the one you approved.`;
      }
    }
    if (opens[i].amountMinor !== e.amountMinor) return `Payment ${n} is a different amount from the one you approved.`;
    if (pays[i].maxFeeMinor !== e.maxFeeMinor) return `Payment ${n} allows a different Splash fee from the one you approved.`;
  }
  return null;
}

