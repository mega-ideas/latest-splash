/**
 * A spending rule in plain words (v2 §4.2, decision D2): what the person can
 * pay alone, and what goes to the owners. Pure and client-safe. It words what
 * the chain and the index already decided (the rule's allowances, the policy's
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
 *
 * A rule is read as a whole (lib/team-rules/terms.ts), not as whichever
 * allowance is live: after a change made following spending, the short bridge
 * for today is not the rule. Who is reading matters too: an owner is told what
 * "you" verified and changed; a staff member reading their own rule is not.
 */
import { formatUsdc } from '../fees/copy.ts';
import { ruleTerms } from './terms.ts';
import { plural, shortAddress, timeLeftWords, windowWords } from './words.ts';
import type { PolicyLike, RuleLike } from './view.ts';

export { timeLeftWords };

export type RuleSummary = {
  alone: string[];
  approval: string[];
  /** Recipients this request makes payable alone by everyone with a rule (a new rule only). */
  added?: string[];
};
export type Viewer = { owner: boolean };

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
  owner: boolean;
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
        ? t.owner
          ? `Pay the ${plural(t.recipients, 'recipient', 'recipients')} you have verified.`
          : `Pay the ${plural(t.recipients, 'verified recipient', 'verified recipients')}.`
        : t.owner
          ? 'No recipient is verified yet, so every payment goes to the owners until you verify one.'
          : 'No recipient is verified yet, so every payment goes to the owners until one is verified.',
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
 * on the chain until it is taken back, and says that. Read for `viewer`: the
 * owner who manages the rule, or the person it belongs to.
 */
export function ruleSummary(rule: RuleLike, policy: PolicyLike | null, now: Date, viewer: Viewer = { owner: true }): RuleSummary {
  void now;
  const who = rule.name ?? 'This person';
  const standing = rule.standing ?? 'member';
  if (standing !== 'member') {
    const label = standing === 'viewer' ? 'Belongs to a viewer' : 'Belongs to someone who left';
    return {
      alone: [],
      approval: [
        viewer.owner
          ? `${who}’s rule still works on the chain until you take it back (${label}). Take it back so every payment goes to the owners.`
          : `${who}’s rule still works on the chain until the owners take it back (${label}).`,
      ],
    };
  }
  const labels: Record<string, string> = { expired: 'Expired', not_started: 'Starts later', no_allowance: 'Taken back' };
  if (rule.status !== 'active') {
    return { alone: [], approval: [`${who} cannot pay on their own right now (${labels[rule.status] ?? 'Not active'}). Every payment goes to the owners.`] };
  }
  const t = ruleTerms(rule.allowances);
  if (t?.usedUp && t.lifetimeCapMinor) {
    return { alone: [], approval: [`${who} has used up the ${usdc(BigInt(t.lifetimeCapMinor))} total for this rule, so every payment goes to the owners until the rule is changed.`] };
  }
  return words({
    perPaymentMinor: BigInt(rule.perPaymentMaxMinor),
    period: t?.period ?? null,
    capMinor: asBig(t?.capMinor),
    lifetimeCapMinor: asBig(t?.lifetimeCapMinor),
    lifetimeLeftMinor: asBig(t?.lifetimeRemainingMinor),
    expiresAtMs: t?.expiresAtMs ? Number(t.expiresAtMs) : null,
    recipients: recipientCount(policy),
    thresholdMinor: policy ? asBig(policy.secondApprovalThresholdMinor) : null,
    windowMs: policy ? asBig(policy.runningWindowMs) : null,
    policyMaxMinor: policy ? asBig(policy.perPaymentMaxMinor) : null,
    owner: viewer.owner,
  });
}

/**
 * The rule an owner is about to ask for, from the exact body the route will
 * take. `additions` names the recipients this request verifies: a recipient is
 * the business's, not the person's, so each one becomes payable alone by
 * everyone with a rule, and the owner is told who before signing.
 */
export function reviewSummary(
  body: { perPaymentMaxMinor: string; cap: { period: 'day' | 'month'; limitMinor: string }; expiresAtMs: string; lifetimeCapMinor?: string; recipients?: { add: Array<unknown> } },
  policy: PolicyLike | null,
  name: string | null,
  additions: Array<{ name: string; address: string }> = [],
): RuleSummary {
  void name;
  const base = recipientCount(policy);
  const summary = words({
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
    owner: true,
  });
  return { ...summary, added: additions.map((a) => `${a.name} (${shortAddress(a.address)})`) };
}

/**
 * The line above the rules list, for the person reading it: an owner is told
 * what they verify and that their own changes are instant; a staff member or
 * approver is told what their own rule lets them do.
 */
export function rulesIntro(input: { owner: boolean; thresholdMinor: string | null }): string {
  const threshold = input.thresholdMinor && /^\d+$/.test(input.thresholdMinor) ? formatUsdc(BigInt(input.thresholdMinor)) : null;
  if (input.owner) {
    return `Inside a rule a staff member pays alone, from their own device, to recipients you have verified. A payment over the cap, over their limit or to anyone else goes to the owners.${threshold ? ` A payment that takes what they have paid one recipient above ${threshold} USDC also needs an owner’s approval, whoever makes it.` : ''} Your own changes take effect at once.`;
  }
  return `Inside your rule you pay alone, from your own device, to the verified recipients. A payment over the cap, over your limit or to anyone else goes to the owners.${threshold ? ` A payment that takes what you have paid one recipient above ${threshold} USDC also needs an owner’s approval, whoever makes it.` : ''}`;
}
