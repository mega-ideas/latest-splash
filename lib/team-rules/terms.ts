/**
 * A spending rule read as a whole (v2 §4.2). On the chain a rule is one or
 * more allowances. After a change made while the person has already paid in
 * today's window, `carriedIssue` (lib/server/spend-rules.ts) leaves two: a short
 * bridge, whose cap and lifetime cap are what is honestly left today and which
 * ends when the window renews, and the rule itself, which starts at that
 * renewal. Reading the bridge as the rule says the wrong cap, a lifetime total
 * nobody set and an end date that is today. This module reads the allowances
 * together, so the list, the summary, the Change sheet and the Wallet page all
 * say the same, true thing. It decides nothing and invents no number. Pure and
 * client-safe.
 *
 * A bridge is told by its shape, never guessed from amounts: an allowance that
 * is active now and ends exactly when a not-yet-started allowance of the same
 * rule begins.
 */
import { expiryField } from './form.ts';
import type { RuleLike } from './view.ts';

export type WindowLike = { period: string; limitMinor: string; spentMinor: string; remainingMinor: string; endsAtMs?: string | null; rolledOver?: boolean };
export type AllowanceLike = {
  current: boolean;
  state: string;
  startsAtMs?: string | null;
  expiresAtMs?: string | null;
  lifetimeCapMinor?: string | null;
  lifetimeRemainingMinor?: string | null;
  currentSpendMinor?: string;
  window?: WindowLike | null;
};

export type RuleTerms = {
  /** The period of the rule's own cap. */
  period: 'day' | 'month' | null;
  /** The rule's own cap for that period, not a bridge's. */
  capMinor: string | null;
  /** The window that limits a payment now: the bridge's while there is one. */
  window: WindowLike | null;
  /** The rule was changed after spending in this window: a bridge limits today and the full cap starts at `fullFromMs`. */
  bridged: boolean;
  fullFromMs: string | null;
  /** The lifetime total the owner set, summed over the rule's pieces; null when the owner set none. */
  lifetimeCapMinor: string | null;
  lifetimeRemainingMinor: string | null;
  /** The last moment of the rule: the latest end of any piece. */
  expiresAtMs: string | null;
  /** Charged under the rule's allowances as they stand (principal plus each payment's fee bound). */
  paidMinor: string;
  /** The owner's lifetime total is all spent. */
  usedUp: boolean;
};

const big = (v: string | null | undefined): bigint | null => (v && /^\d+$/.test(v) ? BigInt(v) : null);
const FAR = BigInt(Number.MAX_SAFE_INTEGER);

export function ruleTerms(allowances: AllowanceLike[]): RuleTerms | null {
  const mine = allowances.filter((a) => a.current);
  if (mine.length === 0) return null;
  // One from an earlier wallet cannot pay (not `current`); an expired piece only counts when nothing else is left.
  const open = mine.filter((a) => a.state !== 'expired');
  const live = open.length > 0 ? open : mine;
  const bridges = live.filter((a) => a.state === 'active' && a.expiresAtMs && live.some((b) => b !== a && b.state === 'not_started' && b.startsAtMs === a.expiresAtMs));
  const body = live.filter((a) => !bridges.includes(a));
  const endOf = (a: AllowanceLike) => big(a.expiresAtMs) ?? FAR;
  // The rule is its longest-running piece, the active one when two end together.
  const defining = body.reduce((best, a) => (endOf(a) > endOf(best) || (endOf(a) === endOf(best) && a.state === 'active' && best.state !== 'active') ? a : best));
  const bridge = bridges[0] ?? null;
  const now = bridge ?? body.find((a) => a.state === 'active') ?? defining;
  const w = defining.window ?? null;

  let lifetimeCap: bigint | null = null;
  let lifetimeLeft: bigint | null = null;
  if (defining.lifetimeCapMinor != null) {
    lifetimeCap = 0n;
    lifetimeLeft = 0n;
    for (const a of live) {
      lifetimeCap += big(a.lifetimeCapMinor) ?? 0n;
      lifetimeLeft += big(a.lifetimeRemainingMinor) ?? 0n;
    }
  }
  let expires: bigint | null = null;
  for (const a of live) {
    const e = big(a.expiresAtMs);
    if (e !== null && (expires === null || e > expires)) expires = e;
  }
  const paid = live.reduce((n, a) => n + (big(a.currentSpendMinor) ?? 0n), 0n);

  return {
    period: w ? (w.period === 'month' ? 'month' : 'day') : null,
    capMinor: w ? w.limitMinor : null,
    window: now.window ?? null,
    bridged: bridge !== null,
    fullFromMs: bridge ? bridge.expiresAtMs ?? null : null,
    lifetimeCapMinor: lifetimeCap === null ? null : lifetimeCap.toString(),
    lifetimeRemainingMinor: lifetimeLeft === null ? null : lifetimeLeft.toString(),
    expiresAtMs: expires === null ? null : expires.toString(),
    paidMinor: paid.toString(),
    usedUp: lifetimeCap !== null && lifetimeLeft === 0n,
  };
}

const plainUsdc = (minor: string) => {
  const m = BigInt(minor);
  const whole = m / 1_000_000n;
  const frac = (m % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${whole}${frac ? `.${frac.padEnd(2, '0')}` : '.00'}`;
};

/**
 * What the Change sheet opens with: the rule as it stands, whole. The cap and
 * the end date are the rule's own, never a bridge's; a lifetime total only when
 * the owner set one (the sum, so asking for it again leaves what is left as it
 * is). Amounts are plain numbers a person can edit.
 */
export function changeInitial(rule: Pick<RuleLike, 'userId' | 'perPaymentMaxMinor' | 'allowances'>, now: Date): Record<string, string> {
  const t = ruleTerms(rule.allowances);
  const expires = t ? expiryField(t.expiresAtMs, now) : undefined;
  return {
    staffUserId: rule.userId as string,
    perPayment: plainUsdc(rule.perPaymentMaxMinor),
    ...(t?.period && t.capMinor ? { period: t.period, cap: plainUsdc(t.capMinor) } : {}),
    ...(t?.lifetimeCapMinor ? { lifetimeCap: plainUsdc(t.lifetimeCapMinor) } : {}),
    ...(expires ? { expires } : {}),
  };
}
