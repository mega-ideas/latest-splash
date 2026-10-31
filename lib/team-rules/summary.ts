/**
 * A spending rule in plain words (v2 §4.2, decision D2): what the person can
 * pay alone, and what goes to the owners. Pure and client-safe. It words what
 * the chain and the index already decided (the rule's allowance, the policy's
 * limits); it decides nothing and invents no number.
 *
 * What the chain does, which these sentences must not contradict
 * (docs/v2/phase1-move-design.md "pay_intent"):
 *
 * - a payment above the smaller of the rule's and the business's per-payment
 *   maximum cannot be opened by the person, so it goes to the owners;
 * - the allowance counts each payment plus the most its fee could be, against
 *   the day's or month's cap and the lifetime cap;
 * - only a recipient on the business's verified list can be paid alone (the
 *   list is the business's, not the person's);
 * - a payment whose amount plus what the person has paid that recipient over
 *   the running-total window passes the second-approval threshold needs an
 *   owner's approval: above it, never "at or above".
 */
import { formatUsdc } from '../fees/copy.ts';
import { plural, timeLeftWords, windowWords } from './words.ts';
import type { PolicyLike, RuleLike } from './view.ts';

export { timeLeftWords };

export type RuleSummary = { alone: string[]; approval: string[] };

type Terms = {
  perPaymentMinor: bigint;
  period: 'day' | 'month' | null;
  capMinor: bigint | null;
  lifetimeCapMinor: bigint | null;
  lifetimeLeftMinor: bigint | null;
  expiresAtMs: number | null;
  /** Verified recipients and bank accounts on the business's policy; null when there is no policy to count. */
  recipients: number | null;
  thresholdMinor: bigint | null;
  windowMs: bigint | null;
  policyMaxMinor: bigint | null;
};

const usdc = (minor: bigint) => `${formatUsdc(minor)} USDC`;
const lastDay = (expiresAtMs: number) => new Date(expiresAtMs - 1).toISOString().slice(0, 10);

function words(t: Terms): RuleSummary {
  // A payment over the business's own maximum is refused whatever the rule says.
  const perPayment = t.policyMaxMinor !== null && t.policyMaxMinor < t.perPaymentMinor ? t.policyMaxMinor : t.perPaymentMinor;
  const per = t.period === 'month' ? 'a month' : 'a day';
  const alone: string[] = [`Pay up to ${usdc(perPayment)} in one payment.`];
  const approval: string[] = [`A payment over ${usdc(perPayment)} goes to the owners to pay.`];
  if (t.capMinor !== null && t.period) {
    alone.push(`Pay up to ${usdc(t.capMinor)} ${per} in all, counting the most each payment’s fee could be.`);
    approval.push(`A payment that would take them past ${usdc(t.capMinor)} ${per} goes to the owners to pay.`);
  }
  if (t.recipients !== null) {
    alone.push(
      t.recipients > 0
        ? `Pay the ${plural(t.recipients, 'recipient', 'recipients')} you have verified.`
        : 'No recipient is verified yet, so every payment goes to the owners until you verify one.',
    );
    approval.push('A payment to anyone who is not a verified recipient goes to the owners to pay.');
  }
  if (t.lifetimeCapMinor !== null) {
    alone.push(`No more than ${usdc(t.lifetimeCapMinor)} in all under this rule${t.lifetimeLeftMinor !== null ? ` (${usdc(t.lifetimeLeftMinor)} left)` : ''}.`);
  }
  if (t.expiresAtMs !== null) alone.push(`Until ${lastDay(t.expiresAtMs)} (UTC).`);
  if (t.thresholdMinor !== null && t.windowMs !== null) {
    approval.push(`A payment that would take what they have paid one recipient over ${windowWords(t.windowMs)} above ${usdc(t.thresholdMinor)} needs an owner’s approval before it is paid.`);
  }
  return { alone, approval };
}

const asBig = (v: string | null | undefined): bigint | null => (v && /^\d+$/.test(v) ? BigInt(v) : null);

/** The recipients a person can pay alone: verified wallets and exchange accounts, and bank accounts bound to a partner deposit address. */
const recipientCount = (policy: PolicyLike | null): number | null => (policy ? policy.recipients.length + policy.beneficiaries.length : null);

/**
 * A live rule, from the index and the policy. A rule that cannot pay says so
 * and sends everything to the owners; one held by someone who left still works
 * on the chain until it is taken back, and says that.
 */
export function ruleSummary(rule: RuleLike, policy: PolicyLike | null, now: Date): RuleSummary {
  void now;
  const who = rule.name ?? 'This person';
  const standing = rule.standing ?? 'member';
  if (standing !== 'member') {
    const label = standing === 'viewer' ? 'Belongs to a viewer' : 'Belongs to someone who left';
    return { alone: [], approval: [`${who}’s rule still works on the chain until you take it back (${label}). Take it back so every payment goes to the owners.`] };
  }
  const labels: Record<string, string> = { expired: 'Expired', not_started: 'Starts later', no_allowance: 'Taken back' };
  if (rule.status !== 'active') {
    return { alone: [], approval: [`${who} cannot pay on their own right now (${labels[rule.status] ?? 'Not active'}). Every payment goes to the owners.`] };
  }
  const current = rule.allowances.find((a) => a.current && a.state === 'active') ?? rule.allowances.find((a) => a.current) ?? null;
  const w = current?.window ?? null;
  return words({
    perPaymentMinor: BigInt(rule.perPaymentMaxMinor),
    period: w ? (w.period === 'month' ? 'month' : 'day') : null,
    capMinor: w ? asBig(w.limitMinor) : null,
    lifetimeCapMinor: asBig(current?.lifetimeCapMinor),
    lifetimeLeftMinor: asBig(current?.lifetimeRemainingMinor),
    expiresAtMs: current?.expiresAtMs ? Number(current.expiresAtMs) : null,
    recipients: recipientCount(policy),
    thresholdMinor: policy ? asBig(policy.secondApprovalThresholdMinor) : null,
    windowMs: policy ? asBig(policy.runningWindowMs) : null,
    policyMaxMinor: policy ? asBig(policy.perPaymentMaxMinor) : null,
  });
}

/** The rule an owner is about to ask for, from the exact body the route will take. */
export function reviewSummary(
  body: { perPaymentMaxMinor: string; cap: { period: 'day' | 'month'; limitMinor: string }; expiresAtMs: string; lifetimeCapMinor?: string; recipients?: { add: Array<unknown> } },
  policy: PolicyLike | null,
  name: string | null,
): RuleSummary {
  void name;
  const base = recipientCount(policy);
  return words({
    perPaymentMinor: BigInt(body.perPaymentMaxMinor),
    period: body.cap.period,
    capMinor: BigInt(body.cap.limitMinor),
    lifetimeCapMinor: body.lifetimeCapMinor ? BigInt(body.lifetimeCapMinor) : null,
    lifetimeLeftMinor: null,
    expiresAtMs: Number(body.expiresAtMs),
    recipients: base === null ? null : base + (body.recipients?.add.length ?? 0),
    thresholdMinor: policy ? asBig(policy.secondApprovalThresholdMinor) : null,
    windowMs: policy ? asBig(policy.runningWindowMs) : null,
    policyMaxMinor: policy ? asBig(policy.perPaymentMaxMinor) : null,
  });
}
