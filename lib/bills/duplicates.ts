/**
 * The duplicate check for supplier invoices (v2 brief 5.8).
 *
 * Three levels, from certain to possible:
 *   same document    the same file or text again: intake returns the invoice
 *                    already on file instead of a second one;
 *   same number      the same supplier and invoice number as another open or
 *                    paid invoice: it cannot be scheduled. The database
 *                    enforces this too (a partial unique index over
 *                    scheduled, approving and paid), so two people racing
 *                    cannot both schedule it;
 *   same amount      the same supplier and amount within 45 days under a
 *                    different number: a person says why it is not a
 *                    duplicate before it can be scheduled.
 */
const SUFFIXES = /\b(inc|incorporated|ltd|limited|corp|corporation|co|company|llc|pte|sdn|bhd|pt|tbk|plc|gmbh|the)\b/g;

/** A supplier's name reduced to what identifies it: case, punctuation and company suffixes removed. */
export function payeeKey(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
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
  amountMinor: bigint | null;
  currency: string | null;
  invoiceDate: string | null;
  createdAt: Date;
};

export type DuplicateFinding =
  | { kind: 'same_number'; billId: string; status: string }
  | { kind: 'same_amount'; billId: string; status: string };

export const SAME_AMOUNT_WINDOW_DAYS = 45;

function dayOf(c: DuplicateCandidate): number {
  const d = c.invoiceDate ? Date.parse(`${c.invoiceDate}T00:00:00Z`) : NaN;
  return Number.isFinite(d) ? d : c.createdAt.getTime();
}

/** What `bill` duplicates among `others` (the same org's invoices; cancelled ones never count). */
export function findDuplicates(bill: DuplicateCandidate, others: DuplicateCandidate[]): DuplicateFinding[] {
  const out: DuplicateFinding[] = [];
  if (!bill.payeeKey) return out;
  for (const other of others) {
    if (other.id === bill.id || other.status === 'cancelled' || other.payeeKey !== bill.payeeKey) continue;
    if (bill.invoiceNumberKey && other.invoiceNumberKey === bill.invoiceNumberKey) {
      out.push({ kind: 'same_number', billId: other.id, status: other.status });
      continue;
    }
    if (
      bill.amountMinor !== null && other.amountMinor === bill.amountMinor && other.currency === bill.currency
      && Math.abs(dayOf(other) - dayOf(bill)) <= SAME_AMOUNT_WINDOW_DAYS * 86_400_000
    ) {
      out.push({ kind: 'same_amount', billId: other.id, status: other.status });
    }
  }
  return out;
}
