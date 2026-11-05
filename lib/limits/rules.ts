/**
 * A business's limits on automatic payments, and how an owner gets a higher one
 * (v2 Phase 3, Sky's decision).
 *
 * Every business has four limits: the most for one automatic payment, the most
 * in a day, the most in a month, and how long an allowance lasts. A NEW business
 * starts at DEFAULT_LIMITS, or lower, at what its own answers to three questions
 * work out to (lib/limits/start.ts). These are starting points, not ceilings:
 * they go up on request and approval, and an owner can lower them at once. A
 * business that existed before keeps the figures it already ran on (migration
 * 0086).
 *
 *   - an owner LOWERS a limit whenever they like: it applies at once and nothing is asked;
 *   - an owner ASKS Splash for a higher one: Splash staff approve it, approve a
 *     smaller figure, or decline with a reason, and an approved higher limit
 *     starts 24 hours after approval (the notice Splash keeps for its own
 *     changes), and the owner can cancel it before then;
 *   - a very large grant (LARGE_GRANT_LINES) needs two different Splash staff;
 *   - nothing is offered past LIMIT_SANITY_MAX, a guard against a typo and not a policy.
 *
 * What this does NOT touch: the second-approval line (10,000 USDC by default,
 * the SpendPolicy's own), which only owners edit and which this path never
 * raises: an automatic payment above it still waits for an owner, whatever the
 * limit here says (AUTO_APPROVAL_CEILING_MINOR in lib/schedule/rules.ts); and the
 * owners' own spending rules, which stay instant.
 *
 * Pure and client-safe. Money is whole USDC minor units (6 decimals) as bigint;
 * days are a whole number carried in the same bigint, so one request shape
 * serves all four limits.
 */
import { formatUsdcBound } from '../fees/copy.ts';
import { ALLOWANCE_DEFAULTS, ALLOWANCE_MAX_DAYS, stampWords, type AllowanceForm } from '../schedule/rules.ts';
import { parseAmountMinor } from '../transfer/plan.ts';

export const LIMIT_KINDS = ['per_payment', 'daily', 'monthly', 'days'] as const;
export type LimitKind = (typeof LIMIT_KINDS)[number];
export const isLimitKind = (v: unknown): v is LimitKind => typeof v === 'string' && (LIMIT_KINDS as readonly string[]).includes(v);

/** Every limit's value: USDC minor units for the three amounts, a number of days for `days`. */
export type LimitValues = Record<LimitKind, bigint>;

const USDC = 1_000_000n;

/**
 * What a new business starts at, and what a business with no answers on file has (Sky's decision, replacing round
 * three's 2,000 / 5,000 / 20,000 USDC). They are STARTING POINTS: a proposal worked out from a business's own answers
 * is capped at them (lib/limits/start.ts), and a limit goes up or down on request and approval. None is a ceiling.
 *
 *   per_payment  50,000 USDC
 *   daily        100,000 USDC
 *   monthly      500,000 USDC. Sky left the monthly start to be worked out from the business's answers; this is the
 *                round-three figure, kept as the cap of that working and as the start of a business with no answers.
 *   days         ALLOWANCE_DEFAULTS.expiresInDays
 *
 * A business that existed before these figures keeps the ones it ran on (migration 0086 writes them as rows).
 */
export const DEFAULT_LIMITS: Readonly<LimitValues> = Object.freeze({
  per_payment: 50_000n * USDC,
  daily: 100_000n * USDC,
  monthly: 500_000n * USDC,
  days: BigInt(ALLOWANCE_DEFAULTS.expiresInDays),
});

/**
 * The most a limit can be asked for or granted: a guard against a typo or a corrupt row, NOT a policy ceiling. Staff
 * decide how much to grant, and a very large grant needs two of them (LARGE_GRANT_LINES). Only the length of an
 * allowance is a true ceiling: an allowance lasts at most a year (ALLOWANCE_MAX_DAYS).
 */
export const LIMIT_SANITY_MAX: Readonly<LimitValues> = Object.freeze({
  per_payment: 1_000_000n * USDC,
  daily: 10_000_000n * USDC,
  monthly: 100_000_000n * USDC,
  days: BigInt(ALLOWANCE_MAX_DAYS),
});

/**
 * THE TWO LINES (Sky approved following the recommendation). A raise that takes the daily limit above 250,000 USDC, or
 * the monthly limit above 2,500,000 USDC, needs TWO different Splash staff approvals, one from compliance and one from
 * operations. One person never approves twice. The first approval is recorded and starts nothing; the 24 hour notice
 * starts only after the second. A grant at or below a line needs one approval, as before.
 *
 * These two figures are written here and nowhere else in code: the service, the queue and the page all follow this
 * file. The database check that holds the rule (migration 0086) has to repeat them as numbers, so a change here is
 * made together with a new migration.
 */
export const LARGE_GRANT_LINES: Readonly<{ daily: bigint; monthly: bigint }> = Object.freeze({
  daily: 250_000n * USDC,
  monthly: 2_500_000n * USDC,
});

/** Does granting `granted` for `kind` need two different Splash staff? Only the daily and monthly limits have a line. */
export function needsTwoApprovals(kind: LimitKind, granted: bigint): boolean {
  if (kind === 'daily') return granted > LARGE_GRANT_LINES.daily;
  if (kind === 'monthly') return granted > LARGE_GRANT_LINES.monthly;
  return false;
}

/**
 * The daily limit automatic runs are held to when the owners never set one of their own: the 5,000 USDC the Automatic
 * form has always started from (ALLOWANCE_DEFAULTS), not the business's limit. A limit Splash raised, or a business
 * that started higher, does not raise what the owners never chose.
 */
export const UNCHOSEN_DAILY_CAP: bigint = BigInt(ALLOWANCE_DEFAULTS.dailyUsdc) * USDC;

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
  monthly: { label: 'In a month', says: 'The most Splash will pay automatically in any 30 days, all payments together.', unit: 'usdc' },
  days: { label: 'How long an allowance lasts', says: 'The longest an allowance you give Splash can run before you give it again.', unit: 'days' },
};

/** A value as a reader says it: "2,000 USDC", "90 days". */
export function formatLimit(kind: LimitKind, units: bigint): string {
  if (kind === 'days') return `${units.toString()} ${units === 1n ? 'day' : 'days'}`;
  return `${formatUsdcBound(units)} USDC`;
}

/** A value as the text a person would type into the figure field: "2000", "1500.5", "90" (no commas, no unit). */
export function limitInputValue(kind: LimitKind, units: bigint): string {
  if (kind === 'days') return units.toString();
  const whole = units / USDC;
  const cents = (units % USDC).toString().padStart(6, '0').replace(/0+$/, '');
  return cents ? `${whole}.${cents}` : whole.toString();
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

/** Why a figure is not offered at all, in words. Empty when it is inside the sanity maximum and above the floor. */
function bounds(kind: LimitKind, units: bigint): string[] {
  if (units < LIMIT_FLOORS[kind]) return [kind === 'days' ? 'A limit is at least one day.' : 'A limit is above zero.'];
  if (units > LIMIT_SANITY_MAX[kind]) return [ceilingWords(kind)];
  return [];
}

/**
 * What is said when a figure is past the sanity maximum. For an amount this is not a policy ("Splash will not give you
 * more"): it is a check that the figure is not a typo. For the length of an allowance it is the true ceiling.
 */
export function ceilingWords(kind: LimitKind): string {
  const top = formatLimit(kind, LIMIT_SANITY_MAX[kind]);
  if (kind === 'days') return `An allowance lasts at most ${top}. Give it again then.`;
  return `Splash does not offer more than ${top} for this limit. If that is the figure you meant, contact Splash; if not, check it for a typo.`;
}

/**
 * What the request sheet says about how much can be asked for, instead of a ceiling: Splash reads every request and
 * decides how much to grant, and a very large one needs two people at Splash, so it can take longer.
 */
export function askNote(kind: LimitKind): string {
  if (kind === 'days') return ceilingWords(kind);
  const lines = kind === 'daily' ? ` Above ${formatLimit(kind, LARGE_GRANT_LINES.daily)} a day` : kind === 'monthly' ? ` Above ${formatLimit(kind, LARGE_GRANT_LINES.monthly)} a month` : '';
  const two = lines ? `${lines} two people at Splash have to agree, so it can take longer.` : '';
  const line = kind === 'per_payment' ? ' An automatic payment above your second-approval line still waits for an owner, whatever this limit says.' : '';
  return `Splash reads every request and decides how much to grant.${two}${line}`;
}

/** Is `requested` a figure an owner may ask for, given what the limit is now? Words for each reason it is not; empty when it is. */
export function raiseProblems(kind: LimitKind, requested: bigint, current: bigint): string[] {
  const out = bounds(kind, requested);
  if (out.length > 0) return out;
  if (requested <= current) return [`That is not higher than your limit of ${formatLimit(kind, current)}. To lower a limit, choose Lower.`];
  return [];
}

/** Is `granted` a figure staff may approve? It is above the current limit, inside the sanity maximum, and no more than what was asked for. */
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

/**
 * Is `restored` a figure an owner may put a limit back to? Higher than it is now, and no higher than the most the
 * business has held (`held`): going past that is a request to Splash, not a restore.
 */
export function restoreProblems(kind: LimitKind, restored: bigint, current: bigint, held: bigint): string[] {
  if (restored <= current) return [`That is not higher than your limit of ${formatLimit(kind, current)}. To lower a limit, choose Lower.`];
  if (restored > held) return [`Your business has held ${formatLimit(kind, held)} at most, so you can put it back to that and no higher. For more than that, ask Splash.`];
  return [];
}

/**
 * Lowering a limit to under a tenth of what it is looks like a missing zero ("2" for "2,000"). The page asks the owner to
 * look again before sending it; the owner can put it back at once either way.
 */
export function lowerNeedsConfirm(kind: LimitKind, lowered: bigint, current: bigint): boolean {
  void kind;
  return lowered * 10n < current;
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
 * The daily limit automatic runs are held to: the one the owners set, or, when they have set none, the 5,000 USDC the
 * Automatic form starts from (a limit Splash raised, or a business that started higher, does not raise what the owners
 * never chose), and never more than the business's own.
 */
export function effectiveDailyCap(ownerCapMinor: bigint | null, limits: LimitValues): bigint {
  return stricter(ownerCapMinor ?? stricter(UNCHOSEN_DAILY_CAP, limits.daily), limits.daily);
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
      return `You asked for ${asked}. Splash is reviewing it, and your limit stays ${formatLimit(kind, current)} until it answers. If approved it starts after a 24 hour notice.`;
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
