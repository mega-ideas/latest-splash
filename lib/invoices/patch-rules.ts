/**
 * Get paid (v2 brief 5.8): who may change an invoice the business sent, and
 * what a change needs. PATCH /api/invoices/:id asks this before it writes.
 *
 *   role       owners, finance admins, approvers and makers change invoices;
 *              viewers, auditors and developers read them;
 *   status     forward only (lib/invoices/status.ts);
 *   paid       by hand means a payment the business has seen: the request
 *              carries the reference it received, which is kept as the
 *              received reference (0059), set once with "paid" and never
 *              rewritten after. The reference on file is the one the payer
 *              was asked to quote, and what the payer reported is their
 *              claim; neither is evidence. A USDC payment matched on Sui is
 *              its own evidence;
 *   transfer   the business's own, and bound once.
 *
 * Pure: the route resolves the role from the membership and whether the
 * transfer is the org's, and passes them in.
 */
import type { UserRole } from '../agent/types.ts';
import type { InvoiceStatusV2 } from '../server/operations.ts';
import { ISSUER_SETTABLE, canMoveInvoice } from './status.ts';

export const INVOICE_WRITE_ROLES: readonly UserRole[] = ['OWNER', 'FINANCE_ADMIN', 'APPROVER', 'MAKER'];

/** The shortest payment reference accepted, as on the pay link. */
export const MIN_REFERENCE_LENGTH = 4;
/** The longest, as on the pay link (lib/invoices/pay-report.ts). */
export const MAX_REFERENCE_LENGTH = 64;
/** A reference as a bank prints one: letters, digits, spaces and a few separators. */
export const REFERENCE_FORM = /^[\p{L}\p{N}][\p{L}\p{N} ._/#:-]*$/u;

export type InvoicePatch = {
  status?: string;
  paymentReference?: string;
  transferIntentId?: string;
};

export type InvoiceNow = {
  status: string;
  paymentReference?: string | null;
  payerReportedReference?: string | null;
  usdcTxDigest?: string | null;
  transferIntentId?: string | null;
};

export type PatchRefusal = { status: number; error: string; code: string };

export function checkInvoicePatch(input: {
  role: UserRole | string;
  current: InvoiceNow;
  patch: InvoicePatch;
  /** True when `patch.transferIntentId` is one of this org's transfers. */
  transferOwned: boolean;
}): PatchRefusal | null {
  const { role, current, patch } = input;
  if (!(INVOICE_WRITE_ROLES as readonly string[]).includes(role)) {
    return { status: 403, error: 'Your role can read invoices but not change them.', code: 'role' };
  }
  const next = patch.status as InvoiceStatusV2 | undefined;
  if (next !== undefined && !ISSUER_SETTABLE.includes(next)) {
    return { status: 400, error: 'That status is not one the business sets.', code: 'status' };
  }
  if (next && !canMoveInvoice(current.status as InvoiceStatusV2, next)) {
    return { status: 409, error: `A ${current.status} invoice cannot be marked ${next}.`, code: 'status' };
  }
  // The reference is the evidence for "paid": given once, in the same
  // request that marks it paid, and never rewritten or emptied after.
  if (patch.paymentReference !== undefined) {
    if (current.status === 'paid' || current.status === 'settled') {
      return { status: 409, error: 'This invoice is already paid. The reference it was marked paid with stays as it is.', code: 'reference' };
    }
    if (next !== 'paid') {
      return { status: 409, error: 'A payment reference is added when the invoice is marked paid.', code: 'reference' };
    }
  }
  if (next === 'paid' && current.status !== 'paid' && !current.usdcTxDigest) {
    const reference = patch.paymentReference?.trim() ?? '';
    if (reference.length < MIN_REFERENCE_LENGTH || reference.length > MAX_REFERENCE_LENGTH || !REFERENCE_FORM.test(reference)) {
      return { status: 422, error: `Add the reference of the payment you received, as your bank shows it: ${MIN_REFERENCE_LENGTH} to ${MAX_REFERENCE_LENGTH} letters, digits, spaces or . _ / # : -`, code: 'reference' };
    }
  }
  if (patch.transferIntentId) {
    if (!input.transferOwned) return { status: 404, error: 'Transfer not found.', code: 'transfer' };
    if (current.transferIntentId && patch.transferIntentId !== current.transferIntentId) {
      return { status: 409, error: 'This invoice is already bound to a transfer.', code: 'transfer' };
    }
  }
  return null;
}
