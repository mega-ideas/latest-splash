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

/**
 * Four groups, and a row is in exactly one:
 *   paid         it arrived;
 *   in_progress  it is still moving or waiting for a person;
 *   failed       something broke, so it did not complete (and what to do is said);
 *   not_paid     a person said no, took it back, or the time to sign ran out.
 */
export type Group = 'paid' | 'in_progress' | 'failed' | 'not_paid';
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
  /** Why there is no receipt to open, when there is none. */
  noReceipt: string | null;
  /** For a failed row only: what happened and what to do next, in plain words. */
  explain: Explain | null;
  /** True while the row can still change by itself (in progress, or failed with a return on its way), so the page keeps asking. */
  mayChange: boolean;
};

export type Explain = { why: string; next: string };

const usdc = (minor: string) => `${formatUsdc(BigInt(minor))} USDC`;
const path = (segment: string) => encodeURIComponent(segment);

const TRANSFER: Record<string, { label: string; tone: Tone; group: Group }> = {
  settled: { label: 'Paid', tone: 'ok', group: 'paid' },
  on_the_way: { label: 'On its way', tone: 'wait', group: 'in_progress' },
  awaiting_signatures: { label: 'Waiting for signatures', tone: 'wait', group: 'in_progress' },
  asked_owners: { label: 'Waiting for an owner', tone: 'wait', group: 'in_progress' },
  failed: { label: 'Did not go through', tone: 'bad', group: 'failed' },
  declined: { label: 'Declined by an owner', tone: 'bad', group: 'not_paid' },
  expired: { label: 'Expired before it was signed', tone: 'bad', group: 'not_paid' },
  withdrawn: { label: 'Withdrawn', tone: 'bad', group: 'not_paid' },
};

const BATCH: Record<string, { label: string; tone: Tone; group: Group }> = {
  settled: { label: 'Paid', tone: 'ok', group: 'paid' },
  on_the_way: { label: 'On its way', tone: 'wait', group: 'in_progress' },
  awaiting_signatures: { label: 'Waiting for signatures', tone: 'wait', group: 'in_progress' },
  prepared: { label: 'Waiting for an owner to start the signatures', tone: 'wait', group: 'in_progress' },
  failed: { label: 'Did not go through', tone: 'bad', group: 'failed' },
  expired: { label: 'Expired before it was signed', tone: 'bad', group: 'not_paid' },
  declined: { label: 'Declined by the owners', tone: 'bad', group: 'not_paid' },
  withdrawn: { label: 'Withdrawn', tone: 'bad', group: 'not_paid' },
};

const WITHDRAWAL: Record<string, { label: string; tone: Tone; group: Group }> = {
  paid_out: { label: 'In your bank', tone: 'ok', group: 'paid' },
  partner_received: { label: 'On its way to your bank', tone: 'wait', group: 'in_progress' },
  sent: { label: 'On its way to your bank', tone: 'wait', group: 'in_progress' },
  awaiting_signatures: { label: 'Waiting for signatures', tone: 'wait', group: 'in_progress' },
  preparing: { label: 'Being prepared', tone: 'wait', group: 'in_progress' },
  failed: { label: 'Did not go through', tone: 'bad', group: 'failed' },
  returned: { label: 'Returned to your wallet', tone: 'bad', group: 'failed' },
  cancelled: { label: 'Cancelled', tone: 'bad', group: 'not_paid' },
};

const WALLET_KIND: Record<string, string> = { splash_business: 'Splash business', SELF_CUSTODY: 'Self-custody wallet', EXCHANGE: 'Exchange account', CROSS_CHAIN: 'Another chain', wallet: 'Wallet' };

const UNKNOWN = { label: 'Status not known', tone: 'wait' as Tone, group: 'in_progress' as Group };

/** Why a row has no receipt to open: it is not signed yet, it was never paid, or this person may not open it. */
const missingReceipt = (group: Group): string => (group === 'in_progress' ? 'The receipt opens once the owners have signed.' : 'No payment was made, so there is no receipt.');

/**
 * What a failed row says: what happened, then what to do, each one sentence a
 * person can act on. It states the fact and does not apologise. It names no
 * system state, code or address; the receipt of a paid row has those.
 */
const EXPLAIN = {
  payment: {
    why: 'The payment could not be completed, so it was not sent to the payee.',
    next: 'Check the payee’s details and your balance, then make the payment again. If it fails a second time, contact support.',
  },
  batch: {
    why: 'The batch could not be completed. A batch goes as one transaction, so none of its payments were sent.',
    next: 'Check your balance and the rows in the batch, then prepare the batch again.',
  },
  withdrawalFailed: {
    why: 'The bank payout did not go through, so the USDC did not reach your bank. It comes back to your wallet.',
    next: 'Wait until this row reads Returned to your wallet, then check the bank details and start the withdrawal again. If it does not change, contact support.',
  },
  withdrawalReturned: {
    why: 'The bank payout did not go through, and the USDC is back in your wallet.',
    next: 'Check the bank details, then start the withdrawal again.',
  },
  earlierFailed: {
    why: 'The transfer did not complete, so the recipient was not paid.',
    next: 'Open the record to see the details, then make the transfer again.',
  },
  earlierRefunding: {
    why: 'The transfer could not be completed, and the money is being sent back to you.',
    next: 'Nothing is needed from you. The money reaches you when the refund is done.',
  },
  earlierRefunded: {
    why: 'The transfer could not be completed, and the money was sent back to you.',
    next: 'Open the record to see the details, then make the transfer again if you still need to pay.',
  },
} as const satisfies Record<string, Explain>;

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
    noReceipt: receipt ? null : missingReceipt(s.group),
    explain: s.group === 'failed' ? { ...EXPLAIN.payment } : null,
    mayChange: s.group === 'in_progress',
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
    noReceipt: receipt ? null : missingReceipt(s.group),
    explain: s.group === 'failed' ? { ...EXPLAIN.batch } : null,
    mayChange: s.group === 'in_progress',
  };
}

function withdrawalEntry(w: WithdrawalRow, restricted: boolean): HistoryEntry {
  const s = WITHDRAWAL[w.status] ?? UNKNOWN;
  // The list shows a viewer their withdrawals, but the receipt is an owner's or a staff member's to open.
  const sent = w.status === 'sent' || w.status === 'partner_received' || w.status === 'paid_out';
  const receipt = sent && !restricted;
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
    noReceipt: receipt ? null : sent ? 'Only an owner or a staff member can open a withdrawal’s receipt.' : missingReceipt(s.group),
    explain: s.group !== 'failed' ? null : w.status === 'returned' ? { ...EXPLAIN.withdrawalReturned } : { ...EXPLAIN.withdrawalFailed },
    // A failed withdrawal becomes Returned once the USDC is back, so it is still worth asking about.
    mayChange: s.group === 'in_progress' || w.status === 'failed',
  };
}

const EARLIER_PAID = new Set(['SETTLED', 'DISBURSED', 'CREDITED']);
/** An earlier transfer has no state a person chose: it either completed, is moving, or broke (and was or is being refunded). */
const EARLIER_FAILED = new Set(['FAILED', 'REFUNDED', 'REFUNDING']);

function earlierEntry(e: EarlierRow): HistoryEntry {
  const group: Group = EARLIER_PAID.has(e.state) ? 'paid' : EARLIER_FAILED.has(e.state) ? 'failed' : 'in_progress';
  const status = group === 'paid' ? { label: 'Paid', tone: 'ok' as Tone } : group === 'failed' ? { label: 'Did not go through', tone: 'bad' as Tone } : { label: 'On its way', tone: 'wait' as Tone };
  const explain: Explain | null = group !== 'failed' ? null : e.state === 'REFUNDING' ? { ...EXPLAIN.earlierRefunding } : e.state === 'REFUNDED' ? { ...EXPLAIN.earlierRefunded } : { ...EXPLAIN.earlierFailed };
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
    noReceipt: null,
    explain,
    // A refund in progress ends as Refunded.
    mayChange: group === 'in_progress' || e.state === 'REFUNDING',
  };
}

export function buildHistory(input: { transfers: TransferRow[]; batches: BatchRow[]; withdrawals: WithdrawalRow[]; earlier: EarlierRow[]; restricted?: boolean }): HistoryEntry[] {
  const restricted = input.restricted === true;
  return [...input.transfers.map(transferEntry), ...input.batches.map(batchEntry), ...input.withdrawals.map((w) => withdrawalEntry(w, restricted)), ...input.earlier.map(earlierEntry)].sort((a, b) => b.date.localeCompare(a.date));
}

export type Source = 'payments' | 'batches' | 'withdrawals' | 'earlier';
export type Lists = {
  transfers: TransferRow[];
  batches: BatchRow[];
  withdrawals: WithdrawalRow[];
  earlier: EarlierRow[];
  restricted: boolean;
  /** The lists that have answered at least once (a viewer's 403 is an answer). Absent on lists built by hand: every list is then taken to have answered. */
  held?: Source[];
};
type Answer<T> = { ok: boolean; status: number; items: T[] };

/**
 * What the four lists answered, folded into what the page shows. A list that
 * did not answer keeps what it held before (so a payment on its way does not
 * vanish from a refresh that failed) and is named, so the page never presents
 * a shorter list as complete. `missing` names the failed lists that have never
 * answered: nothing was kept for them, so the counts leave them out. A viewer's
 * 403 is not a failure: it is the business's rule about what they may see.
 * With nothing loaded before and every list failing there is no list at all,
 * and the page says so.
 */
export function mergeLists(
  previous: Lists | null,
  answers: { transfers: Answer<TransferRow>; batches: Answer<BatchRow>; withdrawals: Answer<WithdrawalRow>; earlier: Answer<EarlierRow> },
): { lists: Lists | null; failed: Source[]; missing: Source[] } {
  const failed: Source[] = [];
  const missing: Source[] = [];
  const held = new Set<Source>();
  const heldBefore = (source: Source) => previous !== null && (previous.held === undefined || previous.held.includes(source));
  const pick = <T>(source: Source, answer: Answer<T>, before: T[] | undefined): T[] => {
    if (answer.ok) {
      held.add(source);
      return answer.items;
    }
    if (answer.status === 403) {
      held.add(source);
      return [];
    }
    failed.push(source);
    if (heldBefore(source)) held.add(source);
    else missing.push(source);
    return before ?? [];
  };
  const restricted = answers.transfers.status === 403 || answers.batches.status === 403;
  const lists: Lists = {
    transfers: pick('payments', answers.transfers, previous?.transfers),
    batches: pick('batches', answers.batches, previous?.batches),
    withdrawals: pick('withdrawals', answers.withdrawals, previous?.withdrawals),
    earlier: pick('earlier', answers.earlier, previous?.earlier),
    restricted: restricted || (previous?.restricted === true && [answers.transfers, answers.batches].some((a) => !a.ok && a.status !== 403)),
    held: [...held],
  };
  if (failed.length === 4 && previous === null) return { lists: null, failed, missing };
  if (failed.length === 4 && previous) return { lists: previous, failed, missing };
  return { lists, failed, missing };
}

const SOURCE_WORDS: Record<Source, string> = { payments: 'Payments', batches: 'Batches', withdrawals: 'Withdrawals', earlier: 'Earlier transfers' };

const named = (sources: Source[]): string => {
  const names = sources.map((f) => SOURCE_WORDS[f].toLowerCase());
  const joined = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${joined.charAt(0).toUpperCase()}${joined.slice(1)}`;
};

/**
 * The sentence above the list when a list did not answer. The counts and the
 * list are never quietly shorter. A list that answered before is said to be
 * the last one loaded; a list that never answered is said to be missing from
 * the counts, so the page never tells the person a count is complete when a
 * whole list is absent from it.
 */
export function failureNote(failed: Source[], missing: Source[] = []): string {
  if (failed.length === 0) return '';
  const refreshed = failed.filter((f) => !missing.includes(f));
  const parts: string[] = [];
  if (refreshed.length === 4) parts.push('Your history could not be refreshed, so the counts and the list below are from the last time it loaded.');
  else if (refreshed.length > 0) parts.push(`${named(refreshed)} could not be refreshed. The counts and the list below still show what was loaded before for them.`);
  const never = failed.filter((f) => missing.includes(f));
  if (never.length > 0) parts.push(`${named(never)} could not be loaded, so they are missing from the counts and the list below.`);
  return parts.join(' ');
}

export function filterHistory(entries: HistoryEntry[], input: { group: Group | 'all'; query: string }): HistoryEntry[] {
  const q = input.query.trim().toLowerCase();
  return entries.filter((e) => (input.group === 'all' || e.group === input.group) && (q === '' || [e.title, e.reference, e.detail, e.amountText].join(' ').toLowerCase().includes(q)));
}

/** What was sent this month is only what was paid, in USDC, in the calendar month (UTC) of `now`. */
export function summaryOf(entries: HistoryEntry[], now: Date): { sentThisMonthMinor: string; inProgress: number; failed: number; notPaid: number; total: number } {
  const month = now.toISOString().slice(0, 7);
  let sent = 0n;
  for (const e of entries) if (e.group === 'paid' && e.amountMinor !== null && e.date.slice(0, 7) === month) sent += BigInt(e.amountMinor);
  return { sentThisMonthMinor: sent.toString(), inProgress: entries.filter((e) => e.group === 'in_progress').length, failed: entries.filter((e) => e.group === 'failed').length, notPaid: entries.filter((e) => e.group === 'not_paid').length, total: entries.length };
}

/**
 * The colour of a count at the top of History: attention only when there is
 * something to look at (a payment still on its way, one that failed), and the
 * quiet ink otherwise. A zero is not news. Not paid is never an alarm: a person
 * said no or the time ran out, and there is nothing to fix. Failing and waiting
 * take different colours, and every count also has its words.
 */
export function statTones(summary: { inProgress: number; failed: number; notPaid: number }): { inProgress: string; failed: string; notPaid: string } {
  const quiet = 'text-[#326273]';
  return {
    inProgress: summary.inProgress > 0 ? 'text-[var(--gold-ink)]' : quiet,
    failed: summary.failed > 0 ? 'text-[var(--error)]' : quiet,
    notPaid: quiet,
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
