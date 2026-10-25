/**
 * The Pay invoices flow (v2 brief 5.8): intake, Zeke's reading, the duplicate
 * check, the verified recipient, the schedule, approval, paid, receipt and
 * the self-billed e-invoice.
 *
 * One status column carries it, and it only moves forward, with two named
 * exceptions: a person may take a scheduled invoice back to review to change
 * it, and a payment the payment flow closed without paying (cancelled,
 * expired, refused) puts the invoice back to scheduled. Paid and cancelled
 * are final.
 *
 * Shared by the server (which enforces it) and the page (which explains it).
 */

export const BILL_STATUSES = ['review', 'scheduled', 'approving', 'paid', 'cancelled'] as const;
export type BillStatus = (typeof BILL_STATUSES)[number];

export const BILL_TRANSITIONS: Record<BillStatus, readonly BillStatus[]> = {
  review: ['scheduled', 'cancelled'],
  scheduled: ['review', 'approving', 'cancelled'],
  approving: ['paid', 'scheduled'],
  paid: [],
  cancelled: [],
};

export function canMove(from: BillStatus, to: BillStatus): boolean {
  return BILL_TRANSITIONS[from].includes(to);
}

export const BILL_STATUS_LABEL: Record<BillStatus, string> = {
  review: 'To review',
  scheduled: 'Scheduled',
  approving: 'Waiting for approval',
  paid: 'Paid',
  cancelled: 'Cancelled',
};

/** What a step needs from the invoice, as the page and the server both see it. */
export type BillFacts = {
  status: BillStatus;
  confirmed: boolean;
  sameNumber: boolean;
  sameAmount: boolean;
  duplicateAcknowledged: boolean;
  recipientMatched: boolean;
  recipientVerified: boolean;
  /** A self-custody wallet whose owner has not signed the ownership proof (brief 4.7). */
  recipientOwnershipUnproven?: boolean;
  scheduled: boolean;
  foreignSupplier: boolean;
  eInvoiceMade: boolean;
};

/** Why an invoice cannot be scheduled yet, in the order a person would fix them. Empty when it can. */
export function scheduleBlockers(f: BillFacts): string[] {
  const out: string[] = [];
  if (!f.confirmed) out.push('Check and confirm what Zeke read.');
  if (f.sameNumber) out.push('This invoice number is already in your list, from this supplier or to this recipient. Cancel one of the two.');
  if (f.sameAmount && !f.duplicateAcknowledged) out.push('Say why this is not a duplicate of the invoice with the same amount.');
  if (!f.recipientMatched) out.push('Choose the verified recipient this invoice pays.');
  else if (f.recipientOwnershipUnproven) out.push('The supplier has not proved it owns this wallet yet. It is paid once it signs the ownership proof.');
  else if (!f.recipientVerified) out.push('The recipient is not verified yet.');
  return out;
}

export const BILL_STEPS = ['read', 'duplicates', 'recipient', 'schedule', 'approve', 'paid', 'receipt'] as const;
export type BillStep = (typeof BILL_STEPS)[number];
export const BILL_STEP_LABEL: Record<BillStep, string> = {
  read: 'Reading',
  duplicates: 'Duplicates',
  recipient: 'Recipient',
  schedule: 'Schedule',
  approve: 'Approve',
  paid: 'Paid',
  receipt: 'Receipt',
};

export type StepState = 'done' | 'current' | 'blocked' | 'todo';

export function billSteps(f: BillFacts): Array<{ step: BillStep; state: StepState }> {
  const done: Record<BillStep, boolean> = {
    read: f.confirmed,
    duplicates: f.confirmed && !f.sameNumber && (!f.sameAmount || f.duplicateAcknowledged),
    recipient: f.recipientMatched && f.recipientVerified,
    schedule: f.status === 'scheduled' || f.status === 'approving' || f.status === 'paid',
    approve: f.status === 'paid',
    paid: f.status === 'paid',
    receipt: f.status === 'paid' && (!f.foreignSupplier || f.eInvoiceMade),
  };
  let currentGiven = false;
  return BILL_STEPS.map((step) => {
    if (f.status === 'cancelled') return { step, state: done[step] ? 'done' : 'todo' };
    if (done[step]) return { step, state: 'done' as const };
    if (!currentGiven) {
      currentGiven = true;
      const blocked = step === 'duplicates' && f.sameNumber;
      return { step, state: blocked ? 'blocked' as const : 'current' as const };
    }
    return { step, state: 'todo' as const };
  });
}
