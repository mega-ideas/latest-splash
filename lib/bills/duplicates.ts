/**
 * The duplicate check for supplier invoices (v2 brief 5.8).
 *
 * Three levels, from certain to possible:
 *   same document    the same file or text again: intake returns the invoice
 *                    already on file instead of a second one;
 *   same number      the same invoice number as another open or paid
 *                    invoice, from the same supplier OR to the same
 *                    recipient: it cannot be scheduled. "The same supplier"
 *                    is the name a person typed, which can be typed another
 *                    way; "the same recipient" is who is actually paid, which
 *                    cannot. The database enforces both (partial unique
 *                    indexes over scheduled, approving and paid, one on the
 *                    typed name and one on the recipient), so two people
 *                    racing cannot both schedule it;
 *   same amount      the same amount from the same supplier or to the same
 *                    recipient within 45 days under a different number: a
 *                    person says why it is not a duplicate before it can be
 *                    scheduled.
 */
const SUFFIXES = /\b(inc|incorporated|ltd|limited|corp|corporation|co|company|llc|pte|sdn|bhd|pt|tbk|plc|gmbh|the)\b/g;

/**
 * A supplier's name reduced to what identifies it: case, accents, punctuation
 * and Latin company suffixes removed. Letters and digits of any script stay,
 * so "深圳华强电子有限公司" and "บริษัท สยามพาร์ท จำกัด" have a key.
 */
export function payeeKey(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .replace(SUFFIXES, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "INV-0042" and "inv 0042" are the same number. */
export function invoiceNumberKey(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export type DuplicateCandidate = {
  id: string;
  status: string;
  payeeKey: string | null;
  invoiceNumberKey: string | null;
  /** The verified recipient it pays, once matched. */
  recipientId?: string | null;
  amountMinor: bigint | null;
  currency: string | null;
  invoiceDate: string | null;
  createdAt: Date;
};

export type DuplicateFinding =
  | { kind: 'same_number'; billId: string; status: string; by: DuplicateBy }
  | { kind: 'same_amount'; billId: string; status: string; by: DuplicateBy };

/** How the two invoices were found to be the same payee: the name typed, the recipient paid, or both. */
export type DuplicateBy = 'supplier' | 'recipient' | 'both';

function samePayee(a: DuplicateCandidate, b: DuplicateCandidate): DuplicateBy | null {
  const byName = Boolean(a.payeeKey) && a.payeeKey === b.payeeKey;
  const byRecipient = Boolean(a.recipientId) && a.recipientId === b.recipientId;
  return byName && byRecipient ? 'both' : byName ? 'supplier' : byRecipient ? 'recipient' : null;
}

export const SAME_AMOUNT_WINDOW_DAYS = 45;

function dayOf(c: DuplicateCandidate): number {
  const d = c.invoiceDate ? Date.parse(`${c.invoiceDate}T00:00:00Z`) : NaN;
  return Number.isFinite(d) ? d : c.createdAt.getTime();
}

/** What `bill` duplicates among `others` (the same org's invoices; cancelled ones never count). */
export function findDuplicates(bill: DuplicateCandidate, others: DuplicateCandidate[]): DuplicateFinding[] {
  const out: DuplicateFinding[] = [];
  if (!bill.payeeKey && !bill.recipientId) return out;
  for (const other of others) {
    if (other.id === bill.id || other.status === 'cancelled') continue;
    const by = samePayee(bill, other);
    if (!by) continue;
    if (bill.invoiceNumberKey && other.invoiceNumberKey === bill.invoiceNumberKey) {
      out.push({ kind: 'same_number', billId: other.id, status: other.status, by });
      continue;
    }
    if (
      bill.amountMinor !== null && other.amountMinor === bill.amountMinor && other.currency === bill.currency
      && Math.abs(dayOf(other) - dayOf(bill)) <= SAME_AMOUNT_WINDOW_DAYS * 86_400_000
    ) {
      out.push({ kind: 'same_amount', billId: other.id, status: other.status, by });
    }
  }
  return out;
}
