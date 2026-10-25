/**
 * The hand-off from Pay invoices to the payment flow (v2 brief 5.8 into 5.4).
 *
 * Approving and paying a supplier's invoice is a payment like any other: the
 * Transfer flow (brief 5.4) builds it, takes the quote, collects the owners'
 * signatures (or runs it under a staff member's spending rule, with an
 * owner's approval above the threshold) and settles it on Sui. Pay invoices
 * does none of that itself. It hands the confirmed invoice to that flow
 * through this hook, and records what the flow reports back.
 *
 * STATUS: the 5.4 payment flow is not on this branch yet. Until it registers
 * itself with `registerBillPaymentFlow`, `billPaymentFlow()` returns the
 * flow below that refuses with PAYMENT_FLOW_NOT_WIRED: nothing is created,
 * nothing is marked approved, and the page says so. It never pretends.
 *
 * What the flow must do with a request:
 *   - treat `idempotencyKey` (the invoice id) as its key: the same key twice
 *     returns the same payment intent, never a second payment;
 *   - pay `recipientId` as stored for `orgId` (verified, on file), for exactly
 *     `amountMicros` of `currency`, and nothing printed on the invoice;
 *   - when the payment settles, call `recordBillSettlement` (lib/server/bills.ts)
 *     with the intent id and the Sui digest; when it closes unpaid, call
 *     `recordBillPaymentClosed`.
 */

export type BillPaymentRequest = {
  orgId: string;
  /** The invoice id. The payment flow's idempotency key. */
  idempotencyKey: string;
  billId: string;
  requestedBy: { userId: string; role: string };
  recipientId: string;
  /** Six decimals, in `currency`. */
  amountMicros: bigint;
  currency: string;
  /** YYYY-MM-DD: the day the business asked for it to be paid. */
  payOn: string;
  /** For the payment's reference and the receipt. */
  supplierInvoiceNumber: string;
  payee: string;
};

export type BillPaymentHandoff =
  | { ok: true; paymentIntentId: string }
  | { ok: false; code: 'PAYMENT_FLOW_NOT_WIRED' | 'REFUSED'; status: number; error: string };

export interface BillPaymentFlow {
  readonly wired: boolean;
  start(request: BillPaymentRequest): Promise<BillPaymentHandoff>;
}

export const NOT_WIRED_MESSAGE =
  'Approving from Invoices is not connected to Transfer on this server yet. The invoice stays scheduled; nothing was sent for approval.';

export const notWiredPaymentFlow: BillPaymentFlow = {
  wired: false,
  async start() {
    return { ok: false, code: 'PAYMENT_FLOW_NOT_WIRED', status: 501, error: NOT_WIRED_MESSAGE };
  },
};

const KEY = Symbol.for('splash.billPaymentFlow');
type Holder = { [KEY]?: BillPaymentFlow };

/** Called once by the 5.4 payment flow when it is on the server. */
export function registerBillPaymentFlow(flow: BillPaymentFlow): void {
  (globalThis as Holder)[KEY] = flow;
}

export function billPaymentFlow(): BillPaymentFlow {
  return (globalThis as Holder)[KEY] ?? notWiredPaymentFlow;
}
