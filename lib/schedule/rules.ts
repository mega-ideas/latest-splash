/**
 * Scheduled batches (v2 Phase 3), the rules that need no database: when a
 * schedule is next due, the states a run goes through and the words for each,
 * the reasons an automatic run hands back to people, and the allowance the
 * owners are offered. Pure and client-safe: the Scheduled tab, the History
 * page and the server all read the same table, so a state is worded once.
 *
 * Two modes, chosen per schedule by an owner:
 *
 *   ask    "Ask me first" (the default). At the due time Splash prepares the
 *          batch and asks for approval; nothing is paid until the owners'
 *          passkeys sign it.
 *   auto   "Pay automatically within my limits". At the due time Splash pays
 *          the batch with no one present, but only inside an allowance the
 *          owners signed, to recipients the owners verified, who were paid
 *          before. Anything that fails a check is handed back to "ask", and
 *          the owners are told why in plain words.
 */
import { formatUsdc } from '../fees/copy.ts';
import { timeLeftWords } from '../team-rules/words.ts';

export const SCHEDULE_MODES = ['ask', 'auto'] as const;
export type ScheduleMode = (typeof SCHEDULE_MODES)[number];

export const CADENCES = ['once', 'weekly', 'monthly'] as const;
export type Cadence = (typeof CADENCES)[number];

export const SCHEDULE_STATUSES = ['active', 'stopped', 'completed', 'deleted'] as const;
export type ScheduleStatus = (typeof SCHEDULE_STATUSES)[number];

export const RUN_STATUSES = ['scheduled', 'waiting_approval', 'approved', 'paid', 'skipped', 'failed', 'lapsed'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;
export const MINUTE_MS = 60_000;

/** The day-before notice goes out this long before the due time. */
export const NOTICE_LEAD_MS = DAY_MS;
/** A run Splash could not start within this long of its due time is not run late: it lapses, and nothing is paid. */
export const LATE_LIMIT_MS = DAY_MS;
/** How long the owners have to approve a prepared batch: the whole of the signing layer's longest request (24 hours). */
export const APPROVAL_WINDOW_MS = DAY_MS;
/** The soonest an automatic schedule may fall due, so the owners can read the notice first. */
export const AUTO_MIN_LEAD_MS = HOUR_MS;
/** The soonest an "ask me first" schedule may fall due. */
export const ASK_MIN_LEAD_MS = 5 * MINUTE_MS;
/** The furthest ahead a schedule may start. */
export const MAX_START_AHEAD_MS = 366 * DAY_MS;
/** A claim on a run is held this long; a runner that died frees it. */
export const RUN_CLAIM_LEASE_MS = 10 * MINUTE_MS;
/** A payment submitted to the network and not confirmed this long ago is read back from the chain by its digest. */
export const SUBMIT_LEASE_MS = 5 * MINUTE_MS;
/** Most payments in one scheduled batch (the batch page's own cap). */
export const SCHEDULE_MAX_ITEMS = 20;

// ─── When a schedule is due ──────────────────────────────────────────────────

const daysInMonth = (year: number, month0: number) => new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();

/**
 * The nth time a schedule falls due (n = 0 is the first). Weekly is every seven
 * days at the same UTC time; monthly is the same day of the month at the same
 * UTC time, and a short month uses its last day (the 31st runs on the 30th, or
 * the 28th or 29th). Once has no second time (NaN).
 */
export function occurrenceMs(cadence: Cadence, firstDueMs: number, n: number): number {
  if (!Number.isInteger(n) || n < 0) return Number.NaN;
  if (cadence === 'once') return n === 0 ? firstDueMs : Number.NaN;
  if (cadence === 'weekly') return firstDueMs + n * 7 * DAY_MS;
  const first = new Date(firstDueMs);
  const month0 = first.getUTCMonth() + n;
  const year = first.getUTCFullYear() + Math.floor(month0 / 12);
  const m = ((month0 % 12) + 12) % 12;
  const day = Math.min(first.getUTCDate(), daysInMonth(year, m));
  return Date.UTC(year, m, day, first.getUTCHours(), first.getUTCMinutes(), first.getUTCSeconds());
}

/** The first time the schedule falls due strictly after `afterMs`, or null when it never will again (a "once" that has passed). */
export function nextDueAfter(cadence: Cadence, firstDueMs: number, afterMs: number): number | null {
  if (cadence === 'once') return firstDueMs > afterMs ? firstDueMs : null;
  let n = 0;
  if (afterMs >= firstDueMs) {
    n = cadence === 'weekly' ? Math.floor((afterMs - firstDueMs) / (7 * DAY_MS)) : Math.max(0, Math.floor((afterMs - firstDueMs) / (31 * DAY_MS)) - 1);
  }
  for (let guard = 0; guard < 2000; guard += 1, n += 1) {
    const at = occurrenceMs(cadence, firstDueMs, n);
    if (at > afterMs) return at;
  }
  return null;
}

/** The calendar day (UTC) a due time falls on: with the schedule's id, the key a run is made once under. */
export function dueDateOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The key a run's batch and payments are made under: stable for one schedule and one due date, so doing it twice is doing it once. */
export function runKey(scheduleId: string, dueDate: string): string {
  return `${scheduleId.replace(/[^A-Za-z0-9]/g, '').slice(-32)}-${dueDate}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "16:00 UTC on 3 Nov", the way the rest of the dashboard words a moment. */
export function stampWords(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC on ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

export const CADENCE_WORDS: Record<Cadence, string> = { once: 'Once', weekly: 'Every week', monthly: 'Every month' };

/** "Every month, from 3 Nov" / "Once, 16:00 UTC on 3 Nov". */
export function cadenceSummary(cadence: Cadence, firstDueMs: number): string {
  if (cadence === 'once') return `Once, ${stampWords(firstDueMs)}`;
  const d = new Date(firstDueMs);
  const time = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
  if (cadence === 'weekly') return `Every ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getUTCDay()]} at ${time}`;
  return `On day ${d.getUTCDate()} of every month at ${time}`;
}

export const MODE_WORDS: Record<ScheduleMode, { label: string; blurb: string }> = {
  ask: { label: 'Ask me first', blurb: 'At the due time Splash prepares the payment and asks for approval. Nothing is paid until a person signs it with their passkey.' },
  auto: { label: 'Pay automatically within my limits', blurb: 'At the due time Splash pays with no one present, but only inside the allowance your owners signed. Anything outside it comes back to you for approval.' },
};

// ─── The states of a run, in words ───────────────────────────────────────────

/** The groups History uses. */
export type RunGroup = 'paid' | 'in_progress' | 'failed' | 'not_paid';
export type RunTone = 'ok' | 'wait' | 'bad';

export const RUN_STATE: Record<RunStatus, { label: string; tone: RunTone; group: RunGroup; says: string }> = {
  scheduled: { label: 'Scheduled', tone: 'wait', group: 'in_progress', says: 'It has not fallen due yet.' },
  waiting_approval: { label: 'Waiting for approval', tone: 'wait', group: 'in_progress', says: 'It is prepared and waiting for a person to sign it. Nothing is paid until they do.' },
  approved: { label: 'Approved', tone: 'wait', group: 'in_progress', says: 'It is approved and on its way. Splash is paying it now.' },
  paid: { label: 'Paid', tone: 'ok', group: 'paid', says: 'It was paid.' },
  skipped: { label: 'Skipped', tone: 'bad', group: 'not_paid', says: 'It was skipped. Nothing was paid.' },
  failed: { label: 'Did not go through', tone: 'bad', group: 'failed', says: 'It could not be completed.' },
  lapsed: { label: 'Not approved in time', tone: 'bad', group: 'not_paid', says: 'It was not approved in time, so it did not go out. Nothing was paid, and nothing is owed for it.' },
};

export const LAPSED_REASON = 'Nobody approved it before the request ran out, so it did not go out. Nothing was paid. There is no late fee or penalty.';
export const NOT_STARTED_REASON = 'Splash could not start this run within a day of its due time, so it was not run late. Nothing was paid. There is no late fee or penalty.';

export function runIsOpen(status: RunStatus): boolean {
  return status === 'scheduled' || status === 'waiting_approval' || status === 'approved';
}

// ─── Why an automatic run was handed back ────────────────────────────────────

/**
 * Every reason an automatic run can be handed back to "ask me first", with the
 * sentence an owner reads. The first four are about the business or the
 * switch; the rest are about this run's payments.
 */
export const FALLBACK_CODES = [
  'auto_paused',
  'payer_unavailable',
  'not_owner_created',
  'rule_unreadable',
  'no_allowance',
  'allowance_ended',
  'allowance_not_started',
  'allowance_ends_soon',
  'over_payment_limit',
  'over_window',
  'daily_cap',
  'recipient_not_verified',
  'above_approval_line',
  'exchange_or_bank',
  'new_recipient',
  'recipient_changed',
  'recipient_not_cleared',
  'fee_changed',
  'balance_short',
  'policy_unreadable',
] as const;
export type FallbackCode = (typeof FALLBACK_CODES)[number];

export const FALLBACK_TEXT: Record<FallbackCode, string> = {
  auto_paused: 'Automatic payments are paused for your business, so this one needs your approval.',
  payer_unavailable: 'Automatic payments are not switched on for your business here, so this one needs your approval.',
  not_owner_created: 'This schedule was not set up by an owner who is still an owner, so it needs your approval.',
  rule_unreadable: 'Splash could not read your automatic-payment allowance from the network, so this one needs your approval.',
  no_allowance: 'You have not given Splash an allowance to pay automatically, so this one needs your approval.',
  allowance_ended: 'The allowance for automatic payments has ended or was taken back, so this one needs your approval.',
  allowance_not_started: 'The allowance for automatic payments has not started yet, so this one needs your approval.',
  allowance_ends_soon: 'The allowance for automatic payments ends before this run could be paid, so it needs your approval.',
  over_payment_limit: 'One payment is more than the limit for a single automatic payment, so this run needs your approval.',
  over_window: 'This run is more than is left of the allowance for now, so it needs your approval.',
  daily_cap: 'This run would take today’s automatic payments over your daily limit, so it needs your approval.',
  recipient_not_verified: 'A recipient is not on your list of verified recipients, so this run needs your approval.',
  above_approval_line: 'With what was already paid to a recipient, the total is above the amount an owner must approve, so this run needs your approval.',
  exchange_or_bank: 'A payee is an exchange account, a bank account or another chain. Those are paid by the owners, so this run needs your approval.',
  new_recipient: 'A recipient has not been paid before. A first payment is never automatic, so this run needs your approval.',
  recipient_changed: 'A recipient changed since you set this schedule up, so this run needs your approval.',
  recipient_not_cleared: 'A recipient is not cleared by screening right now, so this run needs your approval.',
  fee_changed: 'Splash’s fee for a payment is now higher than the fee you were shown, so this run needs your approval.',
  balance_short: 'Your wallet does not hold enough USDC for this run and its fees, so it needs your attention.',
  policy_unreadable: 'Splash could not read your spending policy, so this run needs your approval.',
};

/** The reason, with the payee it is about when it names one. */
export function fallbackWords(code: FallbackCode, who?: string | null): string {
  const text = FALLBACK_TEXT[code];
  return who ? `${who}: ${text}` : text;
}

export const FALLBACK_NOTICE_TAIL = 'It was not paid automatically. Nothing has been paid; it is waiting for your approval.';

/** One run, in a sentence the Scheduled tab and the notices use. */
export function runSentence(run: { status: RunStatus; reason?: string | null }): string {
  const state = RUN_STATE[run.status];
  return run.reason?.trim() ? `${state.label}. ${run.reason.trim()}` : `${state.label}. ${state.says}`;
}

// ─── The allowance an owner is offered ───────────────────────────────────────

/**
 * The defaults the owners start from when they give Splash an allowance for
 * automatic payments, in whole USDC. They are a starting point the owners
 * edit, and Sebastian reviews them before mainnet (docs/v2/phase3-scheduled-
 * batches.md). The most a stolen key could move in a month is the monthly
 * cap, and only to recipients the owners verified.
 */
export const ALLOWANCE_DEFAULTS = {
  perPaymentUsdc: 2_000,
  dailyUsdc: 5_000,
  monthlyUsdc: 20_000,
  expiresInDays: 90,
} as const;

/** An allowance outlives no more than a year (the spending rules' own limit). */
export const ALLOWANCE_MAX_DAYS = 366;

/**
 * The most one automatic payment to a recipient, with what was paid it already,
 * may reach: 10,000 USDC, the amount an owner must approve. Whatever second-
 * approval amount the business's own policy says, an automatic payment is held
 * to the lower of the two, so the policy can never be set to lift this line.
 */
export const AUTO_APPROVAL_CEILING_MINOR = 10_000_000_000n;

export type AllowanceForm = { perPaymentMinor: bigint; dailyMinor: bigint; monthlyMinor: bigint; expiresInDays: number };

/** What is wrong with an allowance an owner typed, in words; an empty list means it can be asked for. */
export function allowanceProblems(form: AllowanceForm, policyPerPaymentMaxMinor?: bigint | null): string[] {
  const out: string[] = [];
  if (form.perPaymentMinor <= 0n) out.push('Set a limit for one payment above zero.');
  if (form.dailyMinor <= 0n) out.push('Set a daily limit above zero.');
  if (form.monthlyMinor <= 0n) out.push('Set a monthly limit above zero.');
  if (form.dailyMinor > 0n && form.perPaymentMinor > form.dailyMinor) out.push('The limit for one payment cannot be more than the daily limit.');
  if (form.monthlyMinor > 0n && form.dailyMinor > form.monthlyMinor) out.push('The daily limit cannot be more than the monthly limit.');
  if (form.perPaymentMinor > AUTO_APPROVAL_CEILING_MINOR) {
    out.push(`The limit for one payment cannot be more than ${formatUsdc(AUTO_APPROVAL_CEILING_MINOR)} USDC, the amount an owner must always approve.`);
  }
  if (policyPerPaymentMaxMinor != null && form.perPaymentMinor > policyPerPaymentMaxMinor) {
    out.push(`The limit for one payment cannot be more than your business’s own limit of ${formatUsdc(policyPerPaymentMaxMinor)} USDC.`);
  }
  if (!Number.isInteger(form.expiresInDays) || form.expiresInDays < 1) out.push('Say how many days the allowance lasts.');
  else if (form.expiresInDays > ALLOWANCE_MAX_DAYS) out.push('An allowance lasts at most a year. Give it again then.');
  return out;
}

/** The allowance in a sentence, for the owners signing it. */
export function allowanceSentence(form: AllowanceForm): string {
  return `Splash may pay verified recipients you have paid before: up to ${formatUsdc(form.perPaymentMinor)} USDC a payment, ${formatUsdc(form.dailyMinor)} USDC a day and ${formatUsdc(form.monthlyMinor)} USDC a month, for ${form.expiresInDays} days. You can take it back at any time.`;
}

// ─── Words for a moment ahead ────────────────────────────────────────────────

export function dueInWords(dueMs: number, nowMs: number): string {
  const left = dueMs - nowMs;
  return left > 0 ? `in ${timeLeftWords(left)}` : 'now';
}
