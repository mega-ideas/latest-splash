/**
 * The summary an owner reads before the owners sign the allowance that lets a
 * schedule pay automatically (v2 Phase 3), in plain words:
 *
 *   "Splash will pay these 4 payments each time they fall due, up to 2,000 USDC
 *    each, from 12 Nov until 10 Feb (UTC). Nothing is paid without your limits.
 *    You can stop this anytime."
 *
 * It shows the exact payments the owner resent, how often each schedule runs and
 * how many runs fall before the end, the most for one payment, the daily and
 * monthly caps, the recipients, the end date, the warning window and how to stop.
 * It also says what the limits would REFUSE: a payment above the most for one
 * payment, a payee never paid before, a run bigger than the daily or monthly
 * limit, a schedule whose next time is after the end. A run is paid whole or
 * handed back whole, so one such payment marks its schedule, and the headline
 * says "up to" when any schedule would come back to the owners.
 *
 * The figures are not computed on the page alone. `automaticSummary` takes the
 * same `AllowanceForm` the allowance request is built from (`parseAllowanceInput`,
 * then `allowanceRule`) and reads the per-payment maximum, the monthly cap and
 * the end date from that rule's own terms. Both the page and the server build the
 * summary, and `summaryDigest` is what the owner's confirmation carries: the
 * server builds its own from the schedules as they are now and refuses a
 * difference (tests/scheduled-summary-confirm.test.mjs).
 *
 * Every date is a UTC date and says so. Pure and client-safe.
 */
import { formatUsdcBound } from '../fees/copy.ts';
import { SKIP_LABEL, STOP_LABEL } from './notice.ts';
import { allowanceTerms, dayMonthWords, dayMonthYearWords, graceWords, nextDueAfter, type AllowanceForm, type Cadence } from './rules.ts';
import type { ItemView, ScheduleView } from './views.ts';

/** Why a payment, or the run it belongs to, would not be paid automatically. */
export type SummaryReason = 'over_payment_limit' | 'new_payee' | 'over_daily' | 'over_monthly' | 'after_end';

/** One payment, as the owner resent it. `schedule` names the schedule it belongs to. */
export type SummaryPaymentInput = { position: number; name: string; masked: string; amountMinor: string; feeMinor: string; reference: string; schedule?: string; firstPayment: boolean };
export type SummaryPayment = SummaryPaymentInput & { reasons: SummaryReason[]; notes: string[] };

/** One schedule that pays automatically and is running. */
export type SummaryScheduleInput = { name: string; cadence: Cadence; cadenceText: string; firstDueMs: number; nextDueMs: number | null; paymentCount: number; runTotalMinor: string };
export type SummarySchedule = {
  name: string;
  cadenceText: string;
  /** How many times it falls due before the allowance ends. */
  runs: number;
  paymentCount: number;
  /** What one run moves with Splash's fee. */
  runTotalMinor: string;
  /** Would every run be paid automatically? False when a payment in it, the run's size or its timing is outside the limits. */
  pays: boolean;
  reasons: SummaryReason[];
  notes: string[];
};

export type AutomaticSummary = {
  /** The one sentence at the top of the screen. */
  headline: string;
  paymentCount: number;
  payments: SummaryPayment[];
  schedules: SummarySchedule[];
  /** Payments made in all if every run of every schedule that pays automatically goes ahead. */
  paymentsInAll: number;
  /** Schedules whose runs would come to the owners for approval instead. */
  unpaidSchedules: number;
  /** Each recipient once, in the order they are paid. */
  recipients: string[];
  /** The most for one payment, the daily limit and the monthly limit, in USDC minor units. */
  perPaymentMinor: string;
  dailyMinor: string;
  monthlyMinor: string;
  /** When automatic payments may begin (the first run), or null when no schedule pays automatically yet. */
  startsAtMs: number | null;
  /** When the allowance ends: midnight UTC after its last day. */
  endsAtMs: number;
  /** "10 Feb 2027 (UTC)": the last day it is in force. */
  endsOnText: string;
  graceMinutes: number;
  graceText: string;
  stopText: string;
  /** The screen's sentences, in the order they are read. The signing request carries them for every owner who signs. */
  lines: string[];
};

export type SummaryInput = {
  payments: SummaryPaymentInput[];
  schedules: SummaryScheduleInput[];
  /** The values the allowance request is built from. */
  form: AllowanceForm;
  graceMinutes: number;
  /** The clock the request is made at: the end date is the end of the UTC day this plus the days the allowance lasts falls on. */
  nowMs: number;
  /** When the earliest automatic schedule next falls due, or null when none does. */
  firstPaymentMs: number | null;
};

export const STOP_TEXT = `You can stop this anytime: choose ${SKIP_LABEL} or ${STOP_LABEL} in Scheduled, or Pause all automatic payments to stop every schedule at once. Your owners can also take the allowance back.`;

export const MONTHLY_CAVEAT = 'If your schedules together pay more than the monthly limit in a month, the runs that do not fit come to you for approval.';

const usdc = (minor: bigint) => `${formatUsdcBound(minor)} USDC`;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const MAX_RUNS = 400;

/** How many times a schedule falls due from its next time until the allowance ends. */
function runsBefore(s: SummaryScheduleInput, endsAtMs: number): number {
  let n = 0;
  let due = s.nextDueMs;
  while (due !== null && due < endsAtMs && n < MAX_RUNS) {
    n += 1;
    due = nextDueAfter(s.cadence, s.firstDueMs, due);
  }
  return n;
}

export function automaticSummary(input: SummaryInput): AutomaticSummary {
  const { form, graceMinutes, nowMs, firstPaymentMs } = input;
  // The figures come from the terms the request carries, not from a second calculation.
  const terms = allowanceTerms(form, nowMs);
  const perMax = terms.perPaymentMaxMinor;
  const daily = form.dailyMinor;
  const monthly = terms.cap.limitMinor;
  const endsAtMs = Number(terms.expiresAtMs);
  const lastDayMs = endsAtMs - 1;
  const startsAtMs = firstPaymentMs === null ? null : Math.max(firstPaymentMs, nowMs);
  const per = usdc(perMax);
  const endsOnText = `${dayMonthYearWords(lastDayMs)} (UTC)`;

  const payments: SummaryPayment[] = input.payments.map((p) => {
    const reasons: SummaryReason[] = [];
    const notes: string[] = [];
    if (BigInt(p.amountMinor) > perMax) {
      reasons.push('over_payment_limit');
      notes.push(`More than the ${per} limit for one payment, so this run would come to you for approval.`);
    }
    if (p.firstPayment) {
      reasons.push('new_payee');
      notes.push('Has not been paid before. A first payment is never automatic, so this run would come to you for approval.');
    }
    return { ...p, reasons, notes };
  });

  const schedules: SummarySchedule[] = input.schedules.map((s) => {
    const runs = runsBefore(s, endsAtMs);
    const total = BigInt(s.runTotalMinor);
    const reasons: SummaryReason[] = [];
    const notes: string[] = [];
    if (total > daily) {
      reasons.push('over_daily');
      notes.push(`One run moves ${usdc(total)} with Splash’s fee, more than the daily limit of ${usdc(daily)}, so each run would come to you for approval.`);
    }
    if (total > monthly) {
      reasons.push('over_monthly');
      notes.push(`One run moves ${usdc(total)} with Splash’s fee, more than the monthly limit of ${usdc(monthly)}, so each run would come to you for approval.`);
    }
    if (runs === 0 && s.nextDueMs !== null) {
      reasons.push('after_end');
      notes.push(`Its next time, ${dayMonthWords(s.nextDueMs)} (UTC), is after the allowance ends, so it would not be paid automatically.`);
    }
    const paymentReasons = payments.some((p) => p.schedule === s.name && p.reasons.length > 0);
    return { name: s.name, cadenceText: s.cadenceText, runs, paymentCount: s.paymentCount, runTotalMinor: s.runTotalMinor, pays: reasons.length === 0 && !paymentReasons, reasons, notes };
  });

  const count = payments.length;
  const unpaidSchedules = schedules.filter((s) => !s.pays).length;
  const paymentsInAll = schedules.filter((s) => s.pays).reduce((n, s) => n + s.paymentCount * s.runs, 0);
  const repeats = schedules.some((s) => s.runs > 1);
  const tail = 'Nothing is paid without your limits. You can stop this anytime.';
  const dates = startsAtMs === null ? '' : `from ${dayMonthWords(startsAtMs)} until ${dayMonthWords(lastDayMs)} (UTC)`;
  let headline: string;
  if (count === 0 || startsAtMs === null) {
    headline = `No schedule pays automatically yet. A schedule you set to pay automatically would be paid only inside these limits: up to ${per} each, until ${dayMonthWords(lastDayMs)} (UTC). ${tail}`;
  } else {
    const when = repeats ? (count === 1 ? 'each time it falls due' : 'each time they fall due') : count === 1 ? 'when it falls due' : 'when they fall due';
    const back =
      unpaidSchedules > 0
        ? ` ${plural(unpaidSchedules, 'schedule', 'schedules')} would come to you for approval instead of being paid automatically (marked below).`
        : '';
    const what = unpaidSchedules > 0 ? `up to ${plural(count, 'payment', 'payments')}` : count === 1 ? 'this payment' : `these ${count} payments`;
    headline = `Splash will pay ${what} ${when}, up to ${per} each, ${dates}.${back} ${tail}`;
  }

  const recipients = [...new Set(payments.map((p) => p.name))];
  const graceText = graceWords(graceMinutes);
  const lines = [
    headline,
    ...schedules.map((s) => `${s.name}: ${s.cadenceText}. ${plural(s.runs, 'run', 'runs')} before the allowance ends, ${plural(s.paymentCount, 'payment', 'payments')} each run, ${usdc(BigInt(s.runTotalMinor))} a run with Splash’s fee.${s.notes.length ? ` ${s.notes.join(' ')}` : ''}`),
    ...payments.map((p) => `${p.name}: ${usdc(BigInt(p.amountMinor))}${p.reference ? `, reference ${p.reference}` : ''}${p.notes.length ? `. ${p.notes.join(' ')}` : ''}`),
    `The most for one payment: ${per}.`,
    `The most in a day: ${usdc(daily)}. The most in a month: ${usdc(monthly)}.`,
    recipients.length > 0 ? `Recipients: ${recipients.join(', ')}.` : 'Recipients: none yet.',
    `The allowance ends at the end of ${endsOnText}.`,
    MONTHLY_CAVEAT,
    graceText,
    STOP_TEXT,
  ];
  return {
    headline,
    paymentCount: count,
    payments,
    schedules,
    paymentsInAll,
    unpaidSchedules,
    recipients,
    perPaymentMinor: perMax.toString(),
    dailyMinor: daily.toString(),
    monthlyMinor: monthly.toString(),
    startsAtMs,
    endsAtMs,
    endsOnText,
    graceMinutes,
    graceText,
    stopText: STOP_TEXT,
    lines,
  };
}

/**
 * What the owner confirms, as one string: the payments, how often they run, the
 * limits, the end and the window. Not the clock: the date the first payment
 * starts from, and the sentences, follow from these.
 */
export function summaryFacts(s: AutomaticSummary): string {
  return JSON.stringify({
    v: 1,
    payments: s.payments.map((p) => [p.schedule ?? '', p.position, p.name, p.masked, p.amountMinor, p.feeMinor, p.reference, p.reasons.join(',')]),
    schedules: s.schedules.map((x) => [x.name, x.cadenceText, x.runs, x.paymentCount, x.runTotalMinor, x.reasons.join(',')]),
    limits: [s.perPaymentMinor, s.dailyMinor, s.monthlyMinor],
    endsAtMs: s.endsAtMs,
    graceMinutes: s.graceMinutes,
  });
}

/** The digest of what the owner saw. The request carries it; the server builds its own summary and compares. */
export async function summaryDigest(s: AutomaticSummary): Promise<string> {
  const bytes = new TextEncoder().encode(summaryFacts(s));
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

type ViewForSummary = Pick<ScheduleView, 'name' | 'mode' | 'status' | 'nextDueAt' | 'cadence' | 'cadenceText' | 'firstDueAt'> & {
  items: Array<Pick<ItemView, 'position' | 'name' | 'masked' | 'amountMinor' | 'feeMinor' | 'reference' | 'firstPayment'>>;
};

/**
 * The payments the allowance is for: those of the schedules that pay
 * automatically and are running, with the earliest of their next times. An
 * "ask me first" schedule, a stopped one and a finished one are not in it.
 */
export function paymentsOfSchedules(views: ViewForSummary[]): { payments: SummaryPaymentInput[]; schedules: SummaryScheduleInput[]; firstPaymentMs: number | null } {
  const payments: SummaryPaymentInput[] = [];
  const schedules: SummaryScheduleInput[] = [];
  let first: number | null = null;
  for (const v of views) {
    if (v.mode !== 'auto' || v.status !== 'active') continue;
    for (const i of v.items) {
      payments.push({ position: i.position, name: i.name, masked: i.masked, amountMinor: i.amountMinor, feeMinor: i.feeMinor, reference: i.reference, schedule: v.name, firstPayment: i.firstPayment });
    }
    const due = v.nextDueAt ? Date.parse(v.nextDueAt) : Number.NaN;
    const nextDueMs = Number.isFinite(due) ? due : null;
    const runTotal = v.items.reduce((n, i) => n + BigInt(i.amountMinor) + BigInt(i.feeMinor), 0n);
    schedules.push({ name: v.name, cadence: v.cadence, cadenceText: v.cadenceText, firstDueMs: Date.parse(v.firstDueAt), nextDueMs, paymentCount: v.items.length, runTotalMinor: runTotal.toString() });
    if (nextDueMs !== null && (first === null || nextDueMs < first)) first = nextDueMs;
  }
  return { payments, schedules, firstPaymentMs: payments.length > 0 ? first : null };
}
