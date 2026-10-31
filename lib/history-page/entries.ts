/**
 * History (v2 brief 5.9): every payment, batch and withdrawal of one business
 * as a receipt the person can open, in the words a person uses.
 *
 * The lists come from the business's own routes (payments, batches,
 * withdrawals, and the earlier transfers of the first product); this only
 * words and orders them. It states no fee: the list knows the most a fee could
 * be, and what the chain charged is on each receipt. Pure and client-safe.
 */
import { formatUsdc } from '../fees/copy.ts';

export type Group = 'paid' | 'in_progress' | 'not_paid';
export type Tone = 'ok' | 'wait' | 'bad';

export type TransferRow = { id: string; paymentRef: string; status: string; payeeKind: string; payeeName: string; payeeMasked: string | null; payeeCountry: string | null; amountMinor: string; reference: string | null; createdAt: string };
export type BatchRow = { id: string; label: string | null; status: string; rowCount: number; totalMinor: string; createdAt: string };
export type WithdrawalRow = { id: string; status: string; destination: { label: string; last4: string } | null; amountMinor: string; currency: string; createdAt: string };
export type EarlierRow = { id: string; recipientName: string; targetCurrency: string; targetAmount: string; sourceAmountUsd: string | number; state: string; createdAt: string };

export type HistoryEntry = {
  key: string;
  kind: 'payment' | 'batch' | 'withdrawal' | 'earlier';
  title: string;
  detail: string;
  /** USDC minor units sent; null for an earlier transfer, which was in dollars. */
  amountMinor: string | null;
  amountText: string;
  reference: string;
  group: Group;
  status: { label: string; tone: Tone };
  date: string;
  /** The receipt, when there is one to open. */
  href: string | null;
};

const usdc = (minor: string) => `${formatUsdc(BigInt(minor))} USDC`;
const path = (segment: string) => encodeURIComponent(segment);

const TRANSFER: Record<string, { label: string; tone: Tone; group: Group }> = {
  settled: { label: 'Paid', tone: 'ok', group: 'paid' },
  on_the_way: { label: 'On its way', tone: 'wait', group: 'in_progress' },
  awaiting_signatures: { label: 'Waiting for signatures', tone: 'wait', group: 'in_progress' },
  asked_owners: { label: 'Waiting for an owner', tone: 'wait', group: 'in_progress' },
  failed: { label: 'Did not go through', tone: 'bad', group: 'not_paid' },
  declined: { label: 'Declined by an owner', tone: 'bad', group: 'not_paid' },
  expired: { label: 'Expired before it was signed', tone: 'bad', group: 'not_paid' },
  withdrawn: { label: 'Withdrawn', tone: 'bad', group: 'not_paid' },
};

const BATCH: Record<string, { label: string; tone: Tone; group: Group }> = {
  settled: { label: 'Paid', tone: 'ok', group: 'paid' },
  on_the_way: { label: 'On its way', tone: 'wait', group: 'in_progress' },
  awaiting_signatures: { label: 'Waiting for signatures', tone: 'wait', group: 'in_progress' },
  prepared: { label: 'Waiting for an owner to start the signatures', tone: 'wait', group: 'in_progress' },
  failed: { label: 'Did not go through', tone: 'bad', group: 'not_paid' },
  expired: { label: 'Expired before it was signed', tone: 'bad', group: 'not_paid' },
};

const WITHDRAWAL: Record<string, { label: string; tone: Tone; group: Group }> = {
  paid_out: { label: 'In your bank', tone: 'ok', group: 'paid' },
  partner_received: { label: 'On its way to your bank', tone: 'wait', group: 'in_progress' },
  sent: { label: 'On its way to your bank', tone: 'wait', group: 'in_progress' },
  awaiting_signatures: { label: 'Waiting for signatures', tone: 'wait', group: 'in_progress' },
  preparing: { label: 'Being prepared', tone: 'wait', group: 'in_progress' },
  failed: { label: 'Did not go through', tone: 'bad', group: 'not_paid' },
  returned: { label: 'Returned to your wallet', tone: 'bad', group: 'not_paid' },
  cancelled: { label: 'Cancelled', tone: 'bad', group: 'not_paid' },
};

const WALLET_KIND: Record<string, string> = { splash_business: 'Splash business', SELF_CUSTODY: 'Self-custody wallet', EXCHANGE: 'Exchange account', CROSS_CHAIN: 'Another chain', wallet: 'Wallet' };

const UNKNOWN = { label: 'Status not known', tone: 'wait' as Tone, group: 'in_progress' as Group };

function transferEntry(t: TransferRow): HistoryEntry {
  const s = TRANSFER[t.status] ?? UNKNOWN;
  const receipt = t.status === 'settled' || t.status === 'on_the_way';
  return {
    key: `payment:${t.id}`,
    kind: 'payment',
    title: t.payeeName,
    detail: [WALLET_KIND[t.payeeKind] ?? 'Payment', t.payeeMasked, t.payeeCountry].filter(Boolean).join(' · '),
    amountMinor: t.amountMinor,
    amountText: usdc(t.amountMinor),
    reference: t.reference ?? '',
    group: s.group,
    status: { label: s.label, tone: s.tone },
    date: t.createdAt,
    href: receipt ? `/dashboard/history/${path(t.paymentRef)}` : null,
  };
}

function batchEntry(b: BatchRow): HistoryEntry {
  const s = BATCH[b.status] ?? UNKNOWN;
  const receipt = b.status === 'settled' || b.status === 'on_the_way';
  return {
    key: `batch:${b.id}`,
    kind: 'batch',
    title: b.label?.trim() ? b.label.trim() : `Batch of ${b.rowCount} payments`,
    detail: `${b.rowCount} ${b.rowCount === 1 ? 'payment' : 'payments'} in one transaction`,
    amountMinor: b.totalMinor,
    amountText: usdc(b.totalMinor),
    reference: '',
    group: s.group,
    status: { label: s.label, tone: s.tone },
    date: b.createdAt,
    href: receipt ? `/dashboard/history/batch/${path(b.id)}` : null,
  };
}

function withdrawalEntry(w: WithdrawalRow): HistoryEntry {
  const s = WITHDRAWAL[w.status] ?? UNKNOWN;
  const receipt = w.status === 'sent' || w.status === 'partner_received' || w.status === 'paid_out';
  return {
    key: `withdrawal:${w.id}`,
    kind: 'withdrawal',
    title: `Withdrawal to ${w.destination?.label ?? 'your bank'}`,
    detail: [w.destination ? `••${w.destination.last4}` : null, w.currency].filter(Boolean).join(' · '),
    amountMinor: w.amountMinor,
    amountText: usdc(w.amountMinor),
    reference: '',
    group: s.group,
    status: { label: s.label, tone: s.tone },
    date: w.createdAt,
    href: receipt ? `/dashboard/history/${path(w.id)}` : null,
  };
}

const EARLIER_PAID = new Set(['SETTLED', 'DISBURSED', 'CREDITED']);
const EARLIER_NOT = new Set(['FAILED', 'REFUNDED', 'REFUNDING']);

function earlierEntry(e: EarlierRow): HistoryEntry {
  const group: Group = EARLIER_PAID.has(e.state) ? 'paid' : EARLIER_NOT.has(e.state) ? 'not_paid' : 'in_progress';
  const status = group === 'paid' ? { label: 'Paid', tone: 'ok' as Tone } : group === 'not_paid' ? { label: 'Did not go through', tone: 'bad' as Tone } : { label: 'On its way', tone: 'wait' as Tone };
  return {
    key: `earlier:${e.id}`,
    kind: 'earlier',
    title: e.recipientName,
    detail: `Earlier transfer · ${e.targetCurrency} ${e.targetAmount}`,
    amountMinor: null,
    amountText: `USD ${e.sourceAmountUsd}`,
    reference: '',
    group,
    status,
    date: e.createdAt,
    href: `/dashboard/audit/${path(e.id)}`,
  };
}

export function buildHistory(input: { transfers: TransferRow[]; batches: BatchRow[]; withdrawals: WithdrawalRow[]; earlier: EarlierRow[] }): HistoryEntry[] {
  return [...input.transfers.map(transferEntry), ...input.batches.map(batchEntry), ...input.withdrawals.map(withdrawalEntry), ...input.earlier.map(earlierEntry)].sort((a, b) => b.date.localeCompare(a.date));
}

export function filterHistory(entries: HistoryEntry[], input: { group: Group | 'all'; query: string }): HistoryEntry[] {
  const q = input.query.trim().toLowerCase();
  return entries.filter((e) => (input.group === 'all' || e.group === input.group) && (q === '' || [e.title, e.reference, e.detail, e.amountText].join(' ').toLowerCase().includes(q)));
}

/** What was sent this month is only what was paid, in USDC, in the calendar month (UTC) of `now`. */
export function summaryOf(entries: HistoryEntry[], now: Date): { sentThisMonthMinor: string; inProgress: number; notPaid: number; total: number } {
  const month = now.toISOString().slice(0, 7);
  let sent = 0n;
  for (const e of entries) if (e.group === 'paid' && e.amountMinor !== null && e.date.slice(0, 7) === month) sent += BigInt(e.amountMinor);
  return { sentThisMonthMinor: sent.toString(), inProgress: entries.filter((e) => e.group === 'in_progress').length, notPaid: entries.filter((e) => e.group === 'not_paid').length, total: entries.length };
}

/**
 * The colour of a count at the top of History: an alarm only when there is
 * something to look at (a payment still on its way, one that was not paid), and
 * the quiet ink otherwise. A zero is not news.
 */
export function statTones(summary: { inProgress: number; notPaid: number }): { inProgress: string; notPaid: string } {
  const quiet = 'text-[#326273]';
  return {
    inProgress: summary.inProgress > 0 ? 'text-[var(--gold-ink)]' : quiet,
    notPaid: summary.notPaid > 0 ? 'text-[var(--error)]' : quiet,
  };
}

const TYPE: Record<HistoryEntry['kind'], string> = { payment: 'Payment', batch: 'Batch', withdrawal: 'Withdrawal', earlier: 'Earlier transfer' };

/** A cell that starts like a formula is made text, so a spreadsheet never runs what a supplier typed. */
function cell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) || safe !== value ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function historyCsv(entries: HistoryEntry[]): string {
  const rows = entries.map((e) => [e.date.slice(0, 10), TYPE[e.kind], e.title, e.reference, e.amountMinor === null ? e.amountText : formatUsdc(BigInt(e.amountMinor)).replaceAll(',', ''), e.status.label, e.href ?? ''].map(cell).join(','));
  return ['Date,Type,Payee,Reference,Amount sent (USDC),Status,Receipt', ...rows].join('\r\n');
}
