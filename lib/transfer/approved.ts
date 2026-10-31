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

