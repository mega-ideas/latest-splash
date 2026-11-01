/**
 * The summary an owner reads before the owners sign the allowance that lets a
 * schedule pay automatically (v2 Phase 3), in plain words:
 *
 *   "Splash will pay these 4 payments, up to 2,000 USDC each, from 12 Nov until
 *    10 Feb. Nothing is paid without your limits. You can stop this anytime."
 *
 * It shows the exact payments the owner resent, the most for one payment, the
 * daily and monthly caps, the recipients, the end date, the warning window and
 * how to stop.
 *
 * The figures are not computed on the page. `automaticSummary` takes the same
 * `AllowanceForm` the allowance request is built from (`parseAllowanceInput`,
 * then `allowanceRule`), and reads the per-payment maximum, the monthly cap and
 * the end date from that rule itself. The server builds the summary the same
 * way from the rule it issues, and tests/scheduled-summary.test.mjs pins that
 * the two cannot differ and that what the network holds after the owners sign
 * is what was shown.
 *
 * Pure and client-safe.
 */
import { formatUsdcBound } from '../fees/copy.ts';
import { SKIP_LABEL, STOP_LABEL } from './notice.ts';
import { allowanceTerms, dayMonthWords, dayMonthYearWords, graceWords, type AllowanceForm } from './rules.ts';
import type { ItemView, ScheduleView } from './views.ts';

/** One payment, as the owner resent it. `schedule` names the schedule it belongs to. */
export type SummaryPayment = { position: number; name: string; masked: string; amountMinor: string; reference: string; schedule?: string };

export type AutomaticSummary = {
  /** The one sentence at the top of the screen. */
  headline: string;
  paymentCount: number;
  payments: SummaryPayment[];
  /** Each recipient once, in the order they are paid. */
  recipients: string[];
  /** The most for one payment, the daily limit and the monthly limit, in USDC minor units. */
  perPaymentMinor: string;
  dailyMinor: string;
  monthlyMinor: string;
  /** When automatic payments may begin (the first run), or null when no schedule pays automatically yet. */
  startsAtMs: number | null;
  /** When the allowance ends. */
  endsAtMs: number;
  graceMinutes: number;
  graceText: string;
  stopText: string;
  /** The screen's sentences, in the order they are read. */
  lines: string[];
};

export type SummaryInput = {
  payments: SummaryPayment[];
  /** The values the allowance request is built from. */
  form: AllowanceForm;
  graceMinutes: number;
  /** The clock the request is made at: the end date is this plus the days the allowance lasts. */
  nowMs: number;
  /** When the earliest automatic schedule next falls due, or null when none does. */
  firstPaymentMs: number | null;
};

export const STOP_TEXT = `You can stop this anytime: choose ${SKIP_LABEL} or ${STOP_LABEL} in Scheduled, or Pause all automatic payments to stop every schedule at once. Your owners can also take the allowance back.`;

const usdc = (minor: bigint) => `${formatUsdcBound(minor)} USDC`;

export function automaticSummary(input: SummaryInput): AutomaticSummary {
  const { payments, form, graceMinutes, nowMs, firstPaymentMs } = input;
  // The figures come from the terms the request carries, not from a second calculation.
  const terms = allowanceTerms(form, nowMs);
  const endsAtMs = Number(terms.expiresAtMs);
  const startsAtMs = firstPaymentMs === null ? null : Math.max(firstPaymentMs, nowMs);
  const count = payments.length;
  const per = usdc(terms.perPaymentMaxMinor);
  const until = dayMonthWords(endsAtMs);
  const tail = 'Nothing is paid without your limits. You can stop this anytime.';
  const headline =
    count === 0 || startsAtMs === null
      ? `No schedule pays automatically yet. A schedule you set to pay automatically would be paid only inside these limits: up to ${per} each, until ${until}. ${tail}`
      : `Splash will pay ${count === 1 ? 'this payment' : `these ${count} payments`}, up to ${per} each, from ${dayMonthWords(startsAtMs)} until ${until}. ${tail}`;
  const recipients = [...new Set(payments.map((p) => p.name))];
  const graceText = graceWords(graceMinutes);
  const lines = [
    headline,
    ...payments.map((p) => `${p.name}: ${usdc(BigInt(p.amountMinor))}${p.reference ? `, reference ${p.reference}` : ''}`),
    `The most for one payment: ${per}.`,
    `The most in a day: ${usdc(form.dailyMinor)}. The most in a month: ${usdc(terms.cap.limitMinor)}.`,
    recipients.length > 0 ? `Recipients: ${recipients.join(', ')}.` : 'Recipients: none yet.',
    `The allowance ends on ${dayMonthYearWords(endsAtMs)}.`,
    graceText,
    STOP_TEXT,
  ];
  return {
    headline,
    paymentCount: count,
    payments: payments.map((p) => ({ ...p })),
    recipients,
    perPaymentMinor: terms.perPaymentMaxMinor.toString(),
    dailyMinor: form.dailyMinor.toString(),
    monthlyMinor: terms.cap.limitMinor.toString(),
    startsAtMs,
    endsAtMs,
    graceMinutes,
    graceText,
    stopText: STOP_TEXT,
    lines,
  };
}

type ViewForSummary = Pick<ScheduleView, 'name' | 'mode' | 'status' | 'nextDueAt'> & { items: Array<Pick<ItemView, 'position' | 'name' | 'masked' | 'amountMinor' | 'reference'>> };

/**
 * The payments the allowance is for: those of the schedules that pay
 * automatically and are running, with the earliest of their next times. An
 * "ask me first" schedule, a stopped one and a finished one are not in it.
 */
export function paymentsOfSchedules(views: ViewForSummary[]): { payments: SummaryPayment[]; firstPaymentMs: number | null } {
  const payments: SummaryPayment[] = [];
  let first: number | null = null;
  for (const v of views) {
    if (v.mode !== 'auto' || v.status !== 'active') continue;
    for (const i of v.items) payments.push({ position: i.position, name: i.name, masked: i.masked, amountMinor: i.amountMinor, reference: i.reference, schedule: v.name });
    const due = v.nextDueAt ? Date.parse(v.nextDueAt) : Number.NaN;
    if (Number.isFinite(due) && (first === null || due < first)) first = due;
  }
  return { payments, firstPaymentMs: payments.length > 0 ? first : null };
}
