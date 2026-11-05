/**
 * Subscription billing, the pure half (Amendment A1 §6; v2 Phase 2). Behind
 * FEATURE_SUBSCRIPTION_BILLING, which is OFF: built and tested, not enabled.
 *
 * A plan is a row in `subscription_plans` (name, price in USDC minor units,
 * interval = one calendar month, UTC). Subscribing is the business wallet's
 * own multisig signing `0x2::allowance::new<Balance<USDC>>` with:
 *
 *   spender                  the Splash finance multisig (never the operator)
 *   rate limit               `monthly_rate_limit(price)`: the chain lets the
 *                            finance multisig draw at most the plan price per
 *                            civil (UTC) month of the allowance
 *   expiration_timestamp_ms  the end of the term, 00:00 UTC on the first day
 *                            of the month after it (exclusive, as on chain)
 *   lifetime cap             none, unless the plan sets one
 *
 * The AllowanceCap goes to the business wallet, which alone can revoke it.
 * Cancelling is revoking; a plan change is a revoke and a new allowance in
 * one transaction the wallet signs. Splash never holds a key to the wallet.
 *
 * Client-safe: the Settings line and the calendar maths only.
 */
import { formatUsdcBound } from '../fees/copy.ts';

/** The only billing interval: one calendar month, UTC. */
export const SUBSCRIPTION_INTERVAL = 'calendar_month_utc' as const;
/** How long a failed pull leaves the subscription in grace before it lapses. */
export const GRACE_PERIOD_MS = 7 * 86_400_000;
/** The prefix every billing allowance's name carries (at most 128 bytes in all). */
export const BILLING_ALLOWANCE_PREFIX = 'splash-billing:';

/** The env flag. Only the exact string `true` turns billing on. */
export function subscriptionBillingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.FEATURE_SUBSCRIPTION_BILLING ?? '').trim() === 'true';
}

/** The calendar month (UTC) a moment falls in: `2026-10`. */
export function billingPeriod(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** 00:00 UTC on the first day of the month `ms` falls in, plus `months`. */
export function monthStartUtc(ms: number, months = 0): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1);
}

/**
 * The end of a term of `termMonths` calendar months that starts in the month
 * of `startMs` (the current month counts as the first): 00:00 UTC on the
 * first day of the month after the last. Exclusive, as the allowance's
 * `expiration_timestamp_ms` is.
 */
export function termEndUtc(startMs: number, termMonths: number): number {
  if (!Number.isInteger(termMonths) || termMonths < 1 || termMonths > 36) throw new RangeError('a term is 1 to 36 calendar months');
  return monthStartUtc(startMs, termMonths);
}

/** The allowance name for a plan: `splash-billing:<plan id>`. */
export function billingAllowanceName(planId: string): string {
  const name = `${BILLING_ALLOWANCE_PREFIX}${planId}`;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(planId) || new TextEncoder().encode(name).length > 128) throw new RangeError('a plan id is 1 to 64 letters, digits, - or _');
  return name;
}

/** Settings → Billing: what the allowance lets Splash do, from the plan's price. */
export function allowanceCopy(priceMinor: bigint): string {
  if (priceMinor <= 0n) throw new RangeError('a plan price is above zero');
  return `Splash can draw up to ${formatUsdcBound(priceMinor)} USDC per calendar month (UTC) for your plan. Revoke any time.`;
}
