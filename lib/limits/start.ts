/**
 * How a business's limits start (v2 Phase 3, Sky's decision): the three plain-words questions a new business answers, and
 * the one pure function that turns the answers into proposed limits. Nothing here touches a database; the server
 * (lib/server/limit-start.ts) saves the answers with the proposal this returns, and the pages show its words.
 *
 * THE QUESTIONS
 *   1. How much do you expect to transfer each month? (USDC)          monthlyUsdc
 *   2. How many payments do you expect to make each week?              paymentsPerWeek
 *   3. How much will your first transfer into your wallet be? (USDC)   firstTransferUsdc
 *
 * THE FORMULA (FORMULA_VERSION 1; every step rounds UP, so a figure is never lower than the working says)
 *   basis        the larger of the month and the first transfer in. A business that puts 50,000 in first will have
 *                that to move in its first month, whatever it said about the month.
 *   monthly      half as much again as the basis (a month can be busier than the plan), to two significant figures.
 *   average      the month divided by the payments in it (payments a week x 52 / 12).
 *   per payment  twice the average payment (payments vary), to two significant figures, never more than the month.
 *   daily        a tenth of the monthly figure, to two significant figures, never less than one payment and never
 *                more than the month.
 *   minimums     100 USDC a payment, 500 a day, 2,000 a month (STARTING_MINIMUMS): even a very small business can pay
 *                an invoice. All three are below the figures Splash gave every business before (2,000, 5,000, 20,000).
 *   sanity       what the working asks for is never carried past LIMIT_SANITY_MAX.
 *   the cap      the PROPOSAL is the working capped at the starting figures (DEFAULT_LIMITS). What the working asked
 *                for beyond them is kept as `wanted`: Splash staff see it, and the owner can ask for it. Nothing above
 *                the starting figures is granted by this function, ever.
 *
 * THE ANSWERS ARE THE OWNER'S OWN WORDS. They are checked, not trusted: control and direction characters become spaces,
 * space collapses, an answer longer than ANSWER_TEXT_MAX is refused (never cut, because a cut number is a different
 * number), and only a plain number is read. What is refused is never echoed back in the words, and the answers are never
 * put in a log or on the trail.
 *
 * Pure and client-safe. Money is USDC minor units (6 decimals) as bigint.
 */
import { DEFAULT_LIMITS, LIMIT_SANITY_MAX, formatLimit, type LimitKind, type LimitValues } from './rules.ts';

export const FORMULA_VERSION = 1;

/** An answer is at most this many characters once cleaned. */
export const ANSWER_TEXT_MAX = 40;
/** More payments than this a week is not a count of payments. */
export const PAYMENTS_PER_WEEK_MAX = 100_000;
/** More USDC than this in an answer is not an answer (a trillion). */
const AMOUNT_MAX_MINOR = 1_000_000_000_000n * 1_000_000n;

export const START_KINDS = ['per_payment', 'daily', 'monthly'] as const;
export type StartKind = Extract<LimitKind, (typeof START_KINDS)[number]>;
export type StartAmounts = Record<StartKind, bigint>;

const USDC = 1_000_000n;

/** The least the working gives, so that even a small business can pay an invoice. */
export const STARTING_MINIMUMS: Readonly<StartAmounts> = Object.freeze({ per_payment: 100n * USDC, daily: 500n * USDC, monthly: 2_000n * USDC });

export const ANSWER_FIELDS = ['monthlyUsdc', 'paymentsPerWeek', 'firstTransferUsdc'] as const;
export type AnswerField = (typeof ANSWER_FIELDS)[number];
export type RawAnswers = Partial<Record<AnswerField, unknown>>;
export type AnswerProblems = Partial<Record<AnswerField, string>>;

/** The questions, word for word, as the setup page and the Limits screen ask them. */
export const QUESTIONS: Record<AnswerField, { label: string; hint: string }> = {
  monthlyUsdc: { label: 'How much do you expect to transfer each month?', hint: 'In USDC, for example 25,000. A rough figure is fine.' },
  paymentsPerWeek: { label: 'How many payments do you expect to make each week?', hint: 'A whole number, for example 5.' },
  firstTransferUsdc: { label: 'How much will your first transfer into your wallet be?', hint: 'In USDC, for example 10,000.' },
};

/**
 * An answer as typed, made safe to look at: control, zero-width and direction characters become spaces, runs of space
 * become one, the ends are trimmed. It never cuts. Anything that is not a string or a number is nothing.
 */
export function cleanAnswerText(raw: unknown): string {
  const text = typeof raw === 'string' ? raw : typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : '';
  return text
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤⁦-⁩﻿]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

type Parsed<T> = { ok: true; value: T; text: string } | { ok: false; problem: string };

const MISSING: Record<AnswerField, string> = {
  monthlyUsdc: 'Tell us how much you expect to transfer each month, in USDC.',
  paymentsPerWeek: 'Tell us how many payments you expect to make each week.',
  firstTransferUsdc: 'Tell us how much your first transfer into your wallet will be, in USDC.',
};
const NOT_AMOUNT = 'Use numbers only, for example 25,000. You can write k for thousand or m for million.';
const NOT_ABOVE_ZERO = 'Give an amount above zero.';
const TOO_LONG = `Keep the answer to ${ANSWER_TEXT_MAX} characters.`;

function isBlank(raw: unknown): boolean {
  return raw === undefined || raw === null || (typeof raw === 'string' && cleanAnswerText(raw) === '');
}

/** A control, zero-width or direction character inside an answer (plain tabs and line breaks aside): a number is not written with those, and one can make a figure read differently from what it is. */
const hasHiddenCharacters = (raw: unknown): boolean => typeof raw === 'string' && /[\u0000-\u0008\u000e-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/.test(raw);

/** An amount of USDC as a person writes it: 25000, 25,000, $25,000, 25k, 1.5m, 25,000 USDC. Minor units, above zero. */
function parseAmountAnswer(field: AnswerField, raw: unknown): Parsed<bigint> {
  if (isBlank(raw)) return { ok: false, problem: MISSING[field] };
  if (typeof raw !== 'string' && !(typeof raw === 'number' && Number.isFinite(raw))) return { ok: false, problem: NOT_AMOUNT };
  if (hasHiddenCharacters(raw)) return { ok: false, problem: NOT_AMOUNT };
  const text = cleanAnswerText(raw);
  if (text.length > ANSWER_TEXT_MAX) return { ok: false, problem: TOO_LONG };
  if (/^-/.test(text)) return { ok: false, problem: NOT_ABOVE_ZERO };
  const m = /^\$?\s?((?:\d{1,3}(?:,\d{3})+|\d+))(?:\.(\d{1,6}))?\s?([kKmM])?(?:\s(?:usdc|usd))?$/i.exec(text) ?? /^\$?\s?((?:\d{1,3}(?:,\d{3})+|\d+))(?:\.(\d{1,6}))?\s?([kKmM])?(?:usdc|usd)?$/i.exec(text);
  if (!m) return { ok: false, problem: NOT_AMOUNT };
  const whole = BigInt(m[1].replace(/,/g, ''));
  const fraction = BigInt((m[2] ?? '').padEnd(6, '0') || '0');
  const factor = m[3] ? (m[3].toLowerCase() === 'k' ? 1_000n : 1_000_000n) : 1n;
  const minor = (whole * USDC + fraction) * factor;
  if (minor <= 0n) return { ok: false, problem: NOT_ABOVE_ZERO };
  if (minor > AMOUNT_MAX_MINOR) return { ok: false, problem: 'That is more than we can use. Give your best estimate in USDC.' };
  return { ok: true, value: minor, text };
}

/** A count of payments: a whole number from 1 to PAYMENTS_PER_WEEK_MAX. */
function parseCountAnswer(field: AnswerField, raw: unknown): Parsed<number> {
  if (isBlank(raw)) return { ok: false, problem: MISSING[field] };
  if (typeof raw !== 'string' && !(typeof raw === 'number' && Number.isFinite(raw))) return { ok: false, problem: 'Give a whole number of payments, for example 5.' };
  if (hasHiddenCharacters(raw)) return { ok: false, problem: 'Give a whole number of payments, for example 5.' };
  const text = cleanAnswerText(raw);
  if (text.length > ANSWER_TEXT_MAX) return { ok: false, problem: TOO_LONG };
  if (/^-/.test(text)) return { ok: false, problem: 'Give a number of payments above zero.' };
  if (!/^(?:\d{1,3}(?:,\d{3})+|\d+)$/.test(text)) return { ok: false, problem: 'Give a whole number of payments, for example 5.' };
  const n = Number(text.replace(/,/g, ''));
  if (!Number.isSafeInteger(n) || n < 1) return { ok: false, problem: 'Give a number of payments above zero.' };
  if (n > PAYMENTS_PER_WEEK_MAX) return { ok: false, problem: `Give a number of payments up to ${PAYMENTS_PER_WEEK_MAX.toLocaleString('en-US')} a week.` };
  return { ok: true, value: n, text };
}

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;
const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const max = (a: bigint, b: bigint): bigint => (a > b ? a : b);

/** Round UP to two significant figures: 1,846 becomes 1,900; 46,153 becomes 47,000; 7 stays 7. */
function up2(v: bigint): bigint {
  if (v <= 0n) return 0n;
  const digits = v.toString().length;
  if (digits <= 2) return v;
  const unit = 10n ** BigInt(digits - 2);
  return ceilDiv(v, unit) * unit;
}

export type StartProposal =
  | {
      ok: true;
      /** What was read from the answers. */
      parsed: { monthlyMinor: bigint; paymentsPerWeek: number; firstTransferMinor: bigint };
      /** The answers as the owner wrote them, cleaned, each at most ANSWER_TEXT_MAX characters. */
      texts: Record<AnswerField, string>;
      /** The proposal: the working capped at the starting figures. */
      limits: StartAmounts;
      /** What the working asked for, before the cap (never past the sanity maximum). */
      wanted: StartAmounts;
      /** The limits where the working asked for more than the starting figure. */
      cappedKinds: StartKind[];
      formulaVersion: number;
      problems: AnswerProblems;
    }
  | {
      ok: false;
      problems: AnswerProblems;
      /** Nothing is worked out from an answer that cannot be read: these are the starting figures. */
      limits: StartAmounts;
      wanted: StartAmounts;
      cappedKinds: StartKind[];
      formulaVersion: number;
    };

const startingFigures = (): StartAmounts => ({ per_payment: DEFAULT_LIMITS.per_payment, daily: DEFAULT_LIMITS.daily, monthly: DEFAULT_LIMITS.monthly });

/**
 * The answers in, the proposed limits out. Every answer must be usable; if any is not, the result says which, in words,
 * and the figures are the starting ones. See the formula at the top of the file.
 */
export function proposeStart(answers: RawAnswers | null | undefined): StartProposal {
  const source: RawAnswers = answers && typeof answers === 'object' && !Array.isArray(answers) ? answers : {};
  const monthly = parseAmountAnswer('monthlyUsdc', source.monthlyUsdc);
  const perWeek = parseCountAnswer('paymentsPerWeek', source.paymentsPerWeek);
  const first = parseAmountAnswer('firstTransferUsdc', source.firstTransferUsdc);
  const problems: AnswerProblems = {};
  if (!monthly.ok) problems.monthlyUsdc = monthly.problem;
  if (!perWeek.ok) problems.paymentsPerWeek = perWeek.problem;
  if (!first.ok) problems.firstTransferUsdc = first.problem;
  if (!monthly.ok || !perWeek.ok || !first.ok) {
    return { ok: false, problems, limits: startingFigures(), wanted: startingFigures(), cappedKinds: [], formulaVersion: FORMULA_VERSION };
  }

  const month = monthly.value;
  const basis = max(month, first.value);
  const wantedMonthly = up2(ceilDiv(basis * 3n, 2n));
  const average = ceilDiv(month * 12n, BigInt(perWeek.value) * 52n);
  const wantedPayment = min(up2(average * 2n), wantedMonthly);
  const wantedDaily = min(wantedMonthly, max(wantedPayment, up2(ceilDiv(wantedMonthly, 10n))));

  const wanted: StartAmounts = {
    per_payment: min(max(wantedPayment, STARTING_MINIMUMS.per_payment), LIMIT_SANITY_MAX.per_payment),
    daily: min(max(wantedDaily, STARTING_MINIMUMS.daily), LIMIT_SANITY_MAX.daily),
    monthly: min(max(wantedMonthly, STARTING_MINIMUMS.monthly), LIMIT_SANITY_MAX.monthly),
  };
  const limits: StartAmounts = {
    per_payment: min(wanted.per_payment, DEFAULT_LIMITS.per_payment),
    daily: min(wanted.daily, DEFAULT_LIMITS.daily),
    monthly: min(wanted.monthly, DEFAULT_LIMITS.monthly),
  };
  const cappedKinds = START_KINDS.filter((kind) => wanted[kind] > limits[kind]);
  return {
    ok: true,
    parsed: { monthlyMinor: month, paymentsPerWeek: perWeek.value, firstTransferMinor: first.value },
    texts: { monthlyUsdc: monthly.text, paymentsPerWeek: perWeek.text, firstTransferUsdc: first.text },
    limits,
    wanted,
    cappedKinds,
    formulaVersion: FORMULA_VERSION,
    problems: {},
  };
}

/** What is stored with a business's answers: what was read from them, the proposal and what the working asked for. */
export type StoredStart = {
  monthlyMinor: bigint;
  paymentsPerWeek: number;
  firstTransferMinor: bigint;
  texts: Record<AnswerField, string>;
  proposed: StartAmounts;
  wanted: StartAmounts;
  formulaVersion: number;
};

/** The proposal again, from what was stored with the answers, so the words are made one way whether new or read back. */
export function proposalFromStored(s: StoredStart): Extract<StartProposal, { ok: true }> {
  return {
    ok: true,
    parsed: { monthlyMinor: s.monthlyMinor, paymentsPerWeek: s.paymentsPerWeek, firstTransferMinor: s.firstTransferMinor },
    texts: s.texts,
    limits: s.proposed,
    wanted: s.wanted,
    cappedKinds: START_KINDS.filter((kind) => s.wanted[kind] > s.proposed[kind]),
    formulaVersion: s.formulaVersion,
    problems: {},
  };
}

// ─── The words ───────────────────────────────────────────────────────────────

const usdc = (minor: bigint): string => formatLimit('daily', minor);
const KIND_PHRASE: Record<StartKind, string> = { per_payment: 'a payment', daily: 'a day', monthly: 'a month' };
const figuresPhrase = (amounts: StartAmounts, kinds: readonly StartKind[] = START_KINDS): string => {
  const parts = kinds.map((kind) => `${usdc(amounts[kind])} ${KIND_PHRASE[kind]}`);
  return parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
};

/** What the owner told us, as one clause: "you expect to move about 20,000 USDC a month, in about 5 payments a week, and ...". */
export function toldUsWords(p: Extract<StartProposal, { ok: true }>): string {
  const n = p.parsed.paymentsPerWeek;
  return `you expect to move about ${usdc(p.parsed.monthlyMinor)} a month, in about ${n.toLocaleString('en-US')} ${n === 1 ? 'payment' : 'payments'} a week, and that your first transfer into your wallet would be ${usdc(p.parsed.firstTransferMinor)}`;
}

export type StartWords = {
  /** The sentence the Limits screen leads with. */
  headline: string;
  /** What the owner told us, as a clause. */
  toldUs: string;
  /** Said when the working asked for more than the starting figures; null when nothing was held back. */
  capped: string | null;
  /** The proposal, per limit, in words ("1,900 USDC"). */
  proposal: Record<StartKind, string>;
  /** What the working asked for, per limit, in words. */
  wanted: Record<StartKind, string>;
};

/**
 * The words for a proposal. `applied` is true when the business was started at it (a new business) and false when the
 * business already ran on limits and was only shown what a new business like it would start at.
 */
export function startWords(p: Extract<StartProposal, { ok: true }>, opts: { applied: boolean }): StartWords {
  const toldUs = toldUsWords(p);
  const proposal = { per_payment: usdc(p.limits.per_payment), daily: usdc(p.limits.daily), monthly: usdc(p.limits.monthly) };
  const wanted = { per_payment: usdc(p.wanted.per_payment), daily: usdc(p.wanted.daily), monthly: usdc(p.wanted.monthly) };
  const headline = opts.applied
    ? `We started you at ${figuresPhrase(p.limits)} because you told us ${toldUs}.`
    : `You told us ${toldUs}. For that, we would start a new business at ${figuresPhrase(p.limits)}. Your business keeps the limits it already runs on.`;
  const capped = p.cappedKinds.length > 0 ? `You may need more than we start a business at: ${figuresPhrase(p.wanted, p.cappedKinds)}. Ask for higher limits and Splash will look at it.` : null;
  return { headline, toldUs, capped, proposal, wanted };
}

/** Why one limit is what it is, for the row on the Limits screen: "We started you at 1,900 USDC because you told us ...". */
export function startWhy(p: Extract<StartProposal, { ok: true }>, kind: StartKind): string {
  return `We started you at ${usdc(p.limits[kind])} because you told us ${toldUsWords(p)}.`;
}

// ─── Controls and Limits, together ───────────────────────────────────────────

export type ControlsFigures = { perTransferUsd: number; dailyUsd: number };
export type Figure = { label: string; value: string };
export type ControlsAndLimitsWords = {
  controls: { title: string; figures: Figure[]; says: string; unavailable: string | null };
  limits: { title: string; figures: Figure[]; says: string };
  /** Which applies when: stated as the code is. */
  order: string;
  /** The second-approval line, which sits beside both. */
  approvalLine: string;
};

const usd = (n: number): string => `${Math.round(n).toLocaleString('en-US')} USD`;

/**
 * Settings, Controls (a per-transfer and a daily guard-rail in USD) and these Limits (automatic payments, in USDC) are
 * two models and stay two. The page shows them together and says, truthfully, which payments each one holds. Today no
 * payment is held to both: the Controls figures are read by the transfer authorisation and treasury routes, and the
 * Limits by the automatic runner (tests/limits-start-formula.test.mjs reads the code to keep this sentence true). If a
 * path ever applies both, this is the one place that must change, and it should then say the lower one wins.
 */
export function controlsAndLimitsWords(controls: ControlsFigures | null, limits: LimitValues): ControlsAndLimitsWords {
  return {
    controls: {
      title: 'Controls',
      figures: controls ? [{ label: 'Per transfer', value: usd(controls.perTransferUsd) }, { label: 'Per day', value: usd(controls.dailyUsd) }] : [],
      says: 'These guard the payments your team sends, one at a time. You set them in Settings, Controls, and a change applies at once.',
      unavailable: controls ? null : 'Your Controls figures could not be read just now, so they are not shown here. Nothing was changed.',
    },
    limits: {
      title: 'Limits',
      figures: [
        { label: 'One automatic payment', value: formatLimit('per_payment', limits.per_payment) },
        { label: 'In a day', value: formatLimit('daily', limits.daily) },
        { label: 'In a month', value: formatLimit('monthly', limits.monthly) },
      ],
      says: 'These guard the payments Splash makes for you automatically, inside an allowance you gave.',
    },
    order: 'A payment is held to one set, never both: the payments your team sends to Controls, and the payments Splash makes for you automatically to Limits. So there is no order between them. To change one, change it where it is set.',
    approvalLine: 'Whichever limit applies, an automatic payment above your second-approval line waits for an owner.',
  };
}
