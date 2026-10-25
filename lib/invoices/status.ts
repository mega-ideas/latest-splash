/**
 * Get paid (v2 brief 5.8): where an invoice the business sent can go next.
 *
 *   draft     made, not shared yet
 *   sent      the pay link was shared
 *   viewed    the payer opened it
 *   reported  the payer says they paid by bank; the business has not seen it
 *   overdue   past due and unpaid
 *   paid      the business has the money: a USDC payment matched on Sui, or
 *             a bank payment the business confirmed with its reference
 *   settled   reconciled and closed
 *
 * Forward only. Before this, PATCH /api/invoices/:id took any status, so a
 * settled invoice could be set back to draft, and the public pay link marked
 * an invoice paid on the payer's word (SECURITY.md WS7-3 recorded it): now
 * the payer's word is "reported", and only the business, or a matched Sui
 * payment, makes it paid.
 */
import type { InvoiceStatusV2 } from '../server/operations.ts';

export const INVOICE_TRANSITIONS: Record<InvoiceStatusV2, readonly InvoiceStatusV2[]> = {
  draft: ['sent', 'paid'],
  sent: ['viewed', 'reported', 'overdue', 'paid'],
  viewed: ['reported', 'overdue', 'paid'],
  reported: ['paid', 'overdue'],
  overdue: ['reported', 'paid'],
  paid: ['settled'],
  settled: [],
};

export function canMoveInvoice(from: InvoiceStatusV2, to: InvoiceStatusV2): boolean {
  return from === to || INVOICE_TRANSITIONS[from].includes(to);
}

/** Statuses the business may set from the dashboard. "reported" is the payer's, from the pay link. */
export const ISSUER_SETTABLE: readonly InvoiceStatusV2[] = ['sent', 'paid', 'settled', 'overdue'];

/** While these, a payer may tell the business they paid. */
export const PAYER_MAY_REPORT: readonly InvoiceStatusV2[] = ['draft', 'sent', 'viewed', 'overdue'];

export const INVOICE_STATUS_LABEL: Record<InvoiceStatusV2, string> = {
  draft: 'Draft',
  sent: 'Sent',
  viewed: 'Viewed',
  reported: 'Payer says paid',
  overdue: 'Overdue',
  paid: 'Paid',
  settled: 'Settled',
};

/** Still owed: counts toward "open". */
export function invoiceOpen(status: InvoiceStatusV2): boolean {
  return status !== 'paid' && status !== 'settled';
}
