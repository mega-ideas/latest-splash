/**
 * A business's limits on automatic payments, and how an owner gets a higher one
 * (v2 Phase 3, Sky's decision).
 *
 * Every business starts with the same four limits: the most for one automatic
 * payment, the most in a day, the most in a month, and how long an allowance
 * lasts (ALLOWANCE_DEFAULTS: 2,000, 5,000, 20,000 USDC and 90 days). An owner:
 *
 *   - LOWERS a limit whenever they like: it applies at once and nothing is asked;
 *   - ASKS Splash for a higher one: Splash staff approve it, approve a smaller
 *     figure, or decline with a reason, and an approved higher limit starts
 *     24 hours after approval (the notice Splash keeps for its own changes), and
 *     the owner can cancel it before then;
 *   - is never offered more than the ceiling in this file, whatever staff say.
 *
 * What this does NOT touch: the second-approval line (10,000 USDC by default,
 * the SpendPolicy's own), which only owners edit and which this path never
 * raises; and the owners' own spending rules, which stay instant.
 *
 * Pure and client-safe. Money is whole USDC minor units (6 decimals) as bigint;
 * days are a whole number carried in the same bigint, so one request shape
 * serves all four limits.
 */
import { formatUsdcBound } from '../fees/copy.ts';
import { ALLOWANCE_DEFAULTS, ALLOWANCE_MAX_DAYS, AUTO_APPROVAL_CEILING_MINOR, stampWords, type AllowanceForm } from '../schedule/rules.ts';
import { parseAmountMinor } from '../transfer/plan.ts';

export const LIMIT_KINDS = ['per_payment', 'daily', 'monthly', 'days'] as const;
export type LimitKind = (typeof LIMIT_KINDS)[number];
export const isLimitKind = (v: unknown): v is LimitKind => typeof v === 'string' && (LIMIT_KINDS as readonly string[]).includes(v);

/** Every limit's value: USDC minor units for the three amounts, a number of days for `days`. */
export type LimitValues = Record<LimitKind, bigint>;

const USDC = 1_000_000n;

/** What every business starts with. The Mode B allowance defaults, written once. */
export const DEFAULT_LIMITS: Readonly<LimitValues> = Object.freeze({
  per_payment: BigInt(ALLOWANCE_DEFAULTS.perPaymentUsdc) * USDC,
  daily: BigInt(ALLOWANCE_DEFAULTS.dailyUsdc) * USDC,
  monthly: BigInt(ALLOWANCE_DEFAULTS.monthlyUsdc) * USDC,
  days: BigInt(ALLOWANCE_DEFAULTS.expiresInDays),
});

/**
 * The most Splash will ever grant, in code. A request above it is refused when
 * it is asked, when staff decide it and again when it would take effect.
 *
 *   per_payment  AUTO_APPROVAL_CEILING_MINOR: the 10,000 USDC an owner must
 *                always approve. An automatic payment is held to the lower of
 *                this and the business's own second-approval line, so no limit
 *                here can lift it.
 *   daily        50,000 USDC: five of those payments in a day.
 *   monthly      500,000 USDC: the on-chain Tier 3 window cap that
 *                VERIFIED_WINDOW_CAP_MINOR mirrors.
 *   days         ALLOWANCE_MAX_DAYS: an allowance lasts at most a year.
 *
 * The daily and monthly figures are Splash's proposal for Sebastian and Sky to
 * review before mainnet (docs/v2/phase3-limits.md).
 */
export const LIMIT_CEILINGS: Readonly<LimitValues> = Object.freeze({
  per_payment: AUTO_APPROVAL_CEILING_MINOR,
  daily: 50_000n * USDC,
  monthly: 500_000n * USDC,
  days: BigInt(ALLOWANCE_MAX_DAYS),
});

/** The least a limit can be lowered to: one cent of USDC, or one day. */
export const LIMIT_FLOORS: Readonly<LimitValues> = Object.freeze({ per_payment: 10_000n, daily: 10_000n, monthly: 10_000n, days: 1n });

/** Splash's own changes wait 24 hours before they take effect, and owners are told when. */
export const LIMIT_NOTICE_MS = 24 * 60 * 60 * 1000;
/** When an approved higher limit starts: 24 hours after it was approved. */
export const effectiveAtMs = (decidedAtMs: number): number => decidedAtMs + LIMIT_NOTICE_MS;

/** What the request form says happens next, word for word (Sky's sentence). */
export const WHAT_HAPPENS_NEXT = 'Splash reviews this. If approved it starts after a 24 hour notice.';

export const REASON_MIN = 10;
export const REASON_MAX = 500;
export const DECLINE_REASON_MIN = 10;

export const LIMIT_WORDS: Record<LimitKind, { label: string; says: string; unit: 'usdc' | 'days' }> = {
  per_payment: { label: 'One automatic payment', says: 'The most Splash will pay in a single automatic payment.', unit: 'usdc' },
  daily: { label: 'In a day', says: 'The most Splash will pay automatically in 24 hours, all payments together.', unit: 'usdc' },
  monthly: { label: 'In a month', says: 'The most an allowance lets Splash pay automatically in a calendar month.', unit: 'usdc' },
  days: { label: 'How long an allowance lasts', says: 'The longest an allowance you give Splash can run before you give it again.', unit: 'days' },
};

/** A value as a reader says it: "2,000 USDC", "90 days". */
export function formatLimit(kind: LimitKind, units: bigint): string {
  if (kind === 'days') return `${units.toString()} ${units === 1n ? 'day' : 'days'}`;
  return `${formatUsdcBound(units)} USDC`;
}

/** What an owner typed: whole days, or an amount of USDC, as the number it means; null when it is neither. */
export function parseLimitValue(kind: LimitKind, raw: unknown): bigint | null {
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  if (kind === 'days') {
    if (!/^[0-9]{1,4}$/.test(text)) return null;
    const n = BigInt(text);
    return n >= 1n ? n : null;
  }
  return parseAmountMinor(text);
}

/** Why a figure is not offered at all, in words. Empty when it is inside the ceiling and above the floor. */
function bounds(kind: LimitKind, units: bigint): string[] {
  if (units < LIMIT_FLOORS[kind]) return [kind === 'days' ? 'A limit is at least one day.' : 'A limit is above zero.'];
  if (units > LIMIT_CEILINGS[kind]) return [ceilingWords(kind)];
  return [];
}

/** The ceiling, in the sentence an owner reads when they go past it. */
export function ceilingWords(kind: LimitKind): string {
  const top = formatLimit(kind, LIMIT_CEILINGS[kind]);
  switch (kind) {
    case 'per_payment':
      return `Splash cannot raise this above ${top}. It is the most Splash pays without an owner approving the payment, and a limit cannot lift it.`;
    case 'days':
      return `An allowance lasts at most ${top}. Give it again then.`;
    default:
      return `Splash does not offer more than ${top} for this limit.`;
  }
}

/** Is `requested` a figure an owner may ask for, given what the limit is now? Words for each reason it is not; empty when it is. */
export function raiseProblems(kind: LimitKind, requested: bigint, current: bigint): string[] {
  const out = bounds(kind, requested);
  if (out.length > 0) return out;
  if (requested <= current) return [`That is not higher than your limit of ${formatLimit(kind, current)}. To lower a limit, use Lower this limit.`];
  return [];
}

/** Is `granted` a figure staff may approve? It is above the current limit, inside the ceiling, and no more than what was asked for. */
export function grantProblems(kind: LimitKind, granted: bigint, requested: bigint, current: bigint): string[] {
  const out = bounds(kind, granted);
  if (out.length > 0) return out;
  if (granted <= current) return [`The figure must be higher than the business’s limit of ${formatLimit(kind, current)}, or the request should be declined.`];
  if (granted > requested) return [`The figure cannot be more than the ${formatLimit(kind, requested)} the owner asked for.`];
  return [];
}

/** Is `lowered` a figure an owner may lower to? Below the limit now, and not below the floor. */
export function lowerProblems(kind: LimitKind, lowered: bigint, current: bigint): string[] {
  if (lowered < LIMIT_FLOORS[kind]) return [kind === 'days' ? 'A limit is at least one day.' : 'A limit is above zero.'];
  if (lowered >= current) return [`That is not lower than your limit of ${formatLimit(kind, current)}. To get a higher limit, ask Splash for one.`];
  return [];
}

/** A reason in the owner's own words: not blank, not a one-word shrug, not an essay. Words for what is wrong; empty when it is fine. */
export function reasonProblems(raw: unknown, min = REASON_MIN): string[] {
  const text = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  if (text.length < min) return [`Say why in a sentence of at least ${min} characters, so the person reading it can decide.`];
  if (text.length > REASON_MAX) return [`Keep the reason to ${REASON_MAX} characters or fewer.`];
  return [];
}
export const cleanReason = (raw: unknown): string => (typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '');

// ─── Where a limit has to hold ───────────────────────────────────────────────

/**
 * The problems with an allowance an owner asked for, against the business's
 * current limits. Empty when it fits. The page and the server both call it, so
 * what the form refuses and what the server refuses are the same sentences.
 */
export function allowanceLimitProblems(form: AllowanceForm, limits: LimitValues): string[] {
  const out: string[] = [];
  const hint = ' You can ask Splash for a higher limit in Settings, Limits.';
  if (form.perPaymentMinor > limits.per_payment) out.push(`The limit for one payment cannot be more than your business’s limit of ${formatLimit('per_payment', limits.per_payment)}.${hint}`);
  if (form.dailyMinor > limits.daily) out.push(`The daily limit cannot be more than your business’s limit of ${formatLimit('daily', limits.daily)}.${hint}`);
  if (form.monthlyMinor > limits.monthly) out.push(`The monthly limit cannot be more than your business’s limit of ${formatLimit('monthly', limits.monthly)}.${hint}`);
  if (Number.isInteger(form.expiresInDays) && BigInt(form.expiresInDays) > limits.days) out.push(`An allowance cannot last more than your business’s limit of ${formatLimit('days', limits.days)}.${hint}`);
  return out;
}

/** The smaller of two limits; the stricter one holds. */
export const stricter = (a: bigint, b: bigint): bigint => (a < b ? a : b);

/**
 * The daily limit automatic runs are held to: the one the owners set, or, when they have set none, the standard 5,000
 * USDC (a limit Splash raised does not raise what the owners never chose), and never more than the business's own.
 */
export function effectiveDailyCap(ownerCapMinor: bigint | null, limits: LimitValues): bigint {
  return stricter(ownerCapMinor ?? stricter(DEFAULT_LIMITS.daily, limits.daily), limits.daily);
}

// ─── A request, in words ─────────────────────────────────────────────────────

export const REQUEST_STATUSES = ['pending', 'approved', 'declined', 'cancelled', 'applied'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export type RequestFacts = {
  status: RequestStatus;
  requestedValue: bigint;
  grantedValue: bigint | null;
  effectiveAtMs: number | null;
  declineReason: string | null;
};

/** What a request is doing now, as one of: asked, waiting out its notice, in force, declined, cancelled. */
export type RequestPhase = 'asked' | 'waiting' | 'in_force' | 'declined' | 'cancelled';

export function requestPhase(r: RequestFacts, nowMs: number): RequestPhase {
  switch (r.status) {
    case 'pending':
      return 'asked';
    case 'approved':
      return r.effectiveAtMs != null && r.effectiveAtMs <= nowMs ? 'in_force' : 'waiting';
    case 'applied':
      return 'in_force';
    case 'declined':
      return 'declined';
    default:
      return 'cancelled';
  }
}

/** One sentence on a request for the owner, in plain words. */
export function requestSentence(kind: LimitKind, r: RequestFacts, current: bigint, nowMs: number): string {
  const asked = formatLimit(kind, r.requestedValue);
  switch (requestPhase(r, nowMs)) {
    case 'asked':
      return `You asked for ${asked}. Splash is reviewing it. Your limit stays ${formatLimit(kind, current)} until then. ${WHAT_HAPPENS_NEXT}`;
    case 'waiting': {
      const granted = r.grantedValue ?? r.requestedValue;
      const smaller = granted < r.requestedValue ? ` Splash approved ${formatLimit(kind, granted)}, less than the ${asked} you asked for.` : ` Splash approved ${formatLimit(kind, granted)}.`;
      return `${smaller.trim()} It starts ${stampWords(r.effectiveAtMs ?? nowMs)}, after a 24 hour notice. Until then your limit stays ${formatLimit(kind, current)}. You can cancel before it starts.`;
    }
    case 'in_force':
      return `Splash approved ${formatLimit(kind, r.grantedValue ?? r.requestedValue)} and it is now your limit.`;
    case 'declined':
      return `Splash declined the request for ${asked}.${r.declineReason ? ` ${r.declineReason}` : ''}`;
    default:
      return `You cancelled the request for ${asked}.`;
  }
}
