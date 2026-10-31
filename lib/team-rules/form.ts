/**
 * What an owner types in Settings → Team & rules, made into exactly the body
 * the routes take (v2 §4.2), or said field by field why it cannot be. The
 * routes and the chain check everything again; this saves the owners a round
 * of signatures for a rule that could never work. Pure and client-safe.
 *
 * Amounts are USDC with up to six decimals and become minor-unit strings. The
 * business, the wallet and the person's address are never in a body: the
 * server knows them from the session and from the person's own passkey.
 */
import { formatUsdc, formatUsdcBound } from '../fees/copy.ts';
import { principalWithFeeCeiling } from '../fees/schedule.ts';

const UNIT = 1_000_000n;
const U64_MAX = 18_446_744_073_709_551_615n;
const DAY_MS = 86_400_000;
/** A rule lasts at most a year (lib/server/spend-rules.ts MAX_RULE_LIFETIME_MS). */
const MAX_RULE_DAYS = 366;
const HOUR_MS = 3_600_000;

/** `12`, `12.5`, `1,000.25` as minor units; anything else, a negative, or more than the chain holds is null. */
export function parseUsdc(text: string): bigint | null {
  const t = String(text ?? '').trim();
  if (!/^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,6})?$/.test(t)) return null;
  const [whole, fraction = ''] = t.replaceAll(',', '').split('.');
  const minor = BigInt(whole) * UNIT + BigInt(fraction.padEnd(6, '0'));
  return minor <= U64_MAX ? minor : null;
}

const usdc = (minor: bigint) => formatUsdcBound(minor);

export type RuleForm = { staffUserId: string; perPayment: string; period: 'day' | 'month'; cap: string; expires: string; lifetimeCap: string };
export type RuleBody = { staffUserId: string; perPaymentMaxMinor: string; cap: { period: 'day' | 'month'; limitMinor: string }; expiresAtMs: string; lifetimeCapMinor?: string };
type Errors<K extends string> = Partial<Record<K, string>>;

/** The close of a chosen day (UTC) as milliseconds, or null when it is not a real date. */
function endOfDay(date: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const start = Date.UTC(y, mo - 1, d);
  const back = new Date(start);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return start + DAY_MS;
}

/** A sensible end date for a new rule: ninety days from `now`. */
export function defaultExpiry(now: Date): string {
  return new Date(now.getTime() + 90 * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The last day of a rule as the form shows it (UTC): a rule ends at the close of
 * its last day, so the millisecond before the stored time is on that day. Null
 * when there is no end date or it has already passed, so the form falls back to
 * the default for a new rule rather than offering a date it would refuse.
 */
export function expiryField(expiresAtMs: string | null | undefined, now: Date): string | undefined {
  if (!expiresAtMs || !/^\d+$/.test(expiresAtMs)) return undefined;
  const ends = Number(expiresAtMs);
  if (!Number.isFinite(ends) || ends <= now.getTime()) return undefined;
  return new Date(ends - 1).toISOString().slice(0, 10);
}

export function ruleRequest(form: RuleForm, ctx: { now: Date; policyMaxMinor: bigint | null }): { ok: true; body: RuleBody; errors?: undefined } | { ok: false; errors: Errors<keyof RuleForm> } {
  const errors: Errors<keyof RuleForm> = {};
  if (!form.staffUserId.trim()) errors.staffUserId = 'Choose who this is for.';

  const perPayment = parseUsdc(form.perPayment);
  if (form.perPayment.trim() === '') errors.perPayment = 'Enter the most one payment may be.';
  else if (perPayment === null) errors.perPayment = 'Enter an amount in USDC, for example 500.';
  else if (perPayment === 0n) errors.perPayment = 'It must be above zero.';
  else if (ctx.policyMaxMinor !== null && perPayment > ctx.policyMaxMinor) errors.perPayment = `That is more than the business’s limit of ${usdc(ctx.policyMaxMinor)} USDC for any one payment.`;

  const cap = parseUsdc(form.cap);
  if (form.cap.trim() === '') errors.cap = 'Enter a daily or monthly cap.';
  else if (cap === null) errors.cap = 'Enter an amount in USDC, for example 2,000.';
  else if (cap === 0n) errors.cap = 'The cap must be above zero.';
  else if (perPayment !== null && perPayment > 0n && cap < principalWithFeeCeiling(perPayment)) errors.cap = `The cap is lower than the most one payment may be plus its fee (${formatUsdc(principalWithFeeCeiling(perPayment))} USDC), so that payment could never be paid. Raise the cap or lower the payment limit.`;

  const end = endOfDay(form.expires);
  if (end === null) errors.expires = 'Choose the date the rule ends.';
  else if (end <= ctx.now.getTime()) errors.expires = 'The end date must be in the future.';
  else if (end > ctx.now.getTime() + MAX_RULE_DAYS * DAY_MS) errors.expires = 'A rule lasts at most a year. Choose a date within a year from today.';

  let lifetime: bigint | null = null;
  if (form.lifetimeCap.trim() !== '') {
    lifetime = parseUsdc(form.lifetimeCap);
    if (lifetime === null) errors.lifetimeCap = 'Enter an amount in USDC, or leave it empty.';
    else if (lifetime === 0n) errors.lifetimeCap = 'It must be above zero, or leave it empty.';
    else if (perPayment !== null && perPayment > 0n && lifetime < principalWithFeeCeiling(perPayment)) errors.lifetimeCap = `The total is lower than the most one payment may be plus its fee (${formatUsdc(principalWithFeeCeiling(perPayment))} USDC). Raise the total, or leave it empty.`;
  }

  if (Object.keys(errors).length > 0 || perPayment === null || cap === null || end === null) return { ok: false, errors };
  return {
    ok: true,
    body: {
      staffUserId: form.staffUserId.trim(),
      perPaymentMaxMinor: perPayment.toString(),
      cap: { period: form.period, limitMinor: cap.toString() },
      expiresAtMs: String(end),
      ...(lifetime !== null ? { lifetimeCapMinor: lifetime.toString() } : {}),
    },
  };
}

export type PolicyForm = { perPayment: string; threshold: string; windowHours: string };
export type PolicyBody = { perPaymentMaxMinor?: string; secondApprovalThresholdMinor?: string; runningWindowMs?: string };

/**
 * The spending policy: created with a per-payment maximum, or changed (any one
 * of the maximum, the second-approval threshold and the running-total window,
 * which is an hour to thirty days).
 */
export function policyRequest(form: PolicyForm, opts: { creating: boolean }): { ok: true; body: PolicyBody; errors?: undefined } | { ok: false; errors: Errors<keyof PolicyForm | 'form'> } {
  const errors: Errors<keyof PolicyForm | 'form'> = {};
  const body: PolicyBody = {};
  if (opts.creating) {
    const max = parseUsdc(form.perPayment);
    if (max === null || max === 0n) errors.perPayment = 'Enter the most any one payment under a rule may be, above zero.';
    else body.perPaymentMaxMinor = max.toString();
    return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, body };
  }
  if (form.perPayment.trim() !== '') {
    const max = parseUsdc(form.perPayment);
    if (max === null || max === 0n) errors.perPayment = 'Enter an amount in USDC, above zero.';
    else body.perPaymentMaxMinor = max.toString();
  }
  if (form.threshold.trim() !== '') {
    const t = parseUsdc(form.threshold);
    if (t === null) errors.threshold = 'Enter an amount in USDC.';
    else if (t === 0n) errors.threshold = 'It must be above zero.';
    else body.secondApprovalThresholdMinor = t.toString();
  }
  if (form.windowHours.trim() !== '') {
    const h = /^\d+$/.test(form.windowHours.trim()) ? Number(form.windowHours.trim()) : NaN;
    if (!(h >= 1 && h <= 720)) errors.windowHours = 'Choose a window between 1 hour and 30 days (1 to 720 hours).';
    else body.runningWindowMs = String(h * HOUR_MS);
  }
  if (Object.keys(errors).length === 0 && Object.keys(body).length === 0) errors.form = 'Change at least one limit.';
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, body };
}
