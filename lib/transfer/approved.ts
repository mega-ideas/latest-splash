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
export type ReviewedActions = {
  actions: Array<{ type: string; recipient?: string; amountMinor?: string | null; maxFeeMinor?: string | null; kind?: number; paysFromCommand?: number; intentFromCommand?: number | null }>;
};

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

/** One payment of a batch is five commands, in this order. */
const BATCH_GROUP = ['withdraw', 'open_intent', 'pay_intent', 'anchor_receipt', 'delete_intent'];

/**
 * The same check for a batch (v2 brief 5.6), and as strict as the server's own
 * shape rule: the transaction must be exactly five commands per approved
 * payment (withdraw, open, pay, anchor, delete), in the order of the rows, and
 * nothing else. Each payment must be paid from its OWN withdrawal and intent,
 * the withdrawal must be the amount plus the fee bound, and a bank, another
 * chain or an exchange is never paid here. Each must go to the address, for the
 * amount and with the fee bound approved, and the total withdrawn must equal
 * the approved total. Read from the transaction's own bytes by reviewOnDevice,
 * never from the server's description.
 */
export function differsFromApprovedBatch(review: ReviewedActions, expected: ApprovedPayment[]): string | null {
  const opens = review.actions.filter((a) => a.type === 'open_intent');
  const pays = review.actions.filter((a) => a.type === 'pay_intent');
  if (opens.length !== expected.length || pays.length !== expected.length) {
    return `This transaction makes ${opens.length} payments, and the batch you approved has ${expected.length}.`;
  }
  if (review.actions.length !== expected.length * BATCH_GROUP.length) {
    return 'This transaction has commands the batch you approved does not have, so it is not signed.';
  }
  let withdrawn = 0n;
  let approved = 0n;
  for (let i = 0; i < expected.length; i += 1) {
    const e = expected[i];
    const n = i + 1;
    const at = i * BATCH_GROUP.length;
    const group = review.actions.slice(at, at + BATCH_GROUP.length);
    if (group.some((a, k) => a.type !== BATCH_GROUP[k])) return `Payment ${n} is not made the way the batch you approved makes it.`;
    const [withdraw, open, pay] = group;
    if (pay.paysFromCommand !== at || pay.intentFromCommand !== at + 1) return `Payment ${n} is not paid from its own withdrawal and its own intent.`;
    if (open.kind === 2 || open.kind === 3 || open.kind === 4) return `Payment ${n} is a kind of payment a batch never makes.`;
    if (e.recipient) {
      try {
        if (normalizeSuiAddress(open.recipient ?? '') !== normalizeSuiAddress(e.recipient)) return `Payment ${n} goes to a different address from the one you approved.`;
      } catch {
        return `Payment ${n} goes to a different address from the one you approved.`;
      }
    }
    if (open.amountMinor !== e.amountMinor) return `Payment ${n} is a different amount from the one you approved.`;
    if (pay.maxFeeMinor !== e.maxFeeMinor) return `Payment ${n} allows a different Splash fee from the one you approved.`;
    try {
      const out = BigInt(withdraw.amountMinor ?? '');
      if (out !== BigInt(e.amountMinor) + BigInt(e.maxFeeMinor)) return `Payment ${n} withdraws more than its amount and its fee bound.`;
      withdrawn += out;
      approved += BigInt(e.amountMinor) + BigInt(e.maxFeeMinor);
    } catch {
      return `Payment ${n} withdraws an amount that could not be read.`;
    }
  }
  if (withdrawn !== approved) return 'This transaction takes a different total from your wallet than the batch you approved.';
  return null;
}
