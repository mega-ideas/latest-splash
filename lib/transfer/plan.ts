/**
 * Steps 3 and 4 of Transfer, as rules (v2 brief 5.4): is there enough in the
 * Splash Wallet, what is the shortfall, which fee goes back as max_fee, and
 * who has to approve.
 *
 * Approval (brief 5.4 step 4, decisions D2 and 4 of 24 Oct 2026):
 *
 *   owners           the owners' multisig: the payment becomes a request the
 *                    quorum signs (`owners_sign`). An owner's own limits and
 *                    recipients are instant, with no rule to fit.
 *   staff in a rule  a staff member's spending rule pays alone
 *                    (`splash_spend::pay_intent`, `staff_rule`), signed by
 *                    that person's own passkey, when the amount, the
 *                    recipient and the time window all fit: the amount is
 *                    within the rule's per-payment maximum and what is left
 *                    of its cap (counting payments already on their way),
 *                    the rule is running (started, not ended, and still
 *                    running when the payment could be signed), the
 *                    recipient is on the policy as a wallet, and the running
 *                    total to that recipient stays at or below the
 *                    second-approval threshold (10,000 USDC unless the
 *                    policy says otherwise; split payments to one recipient
 *                    count together).
 *   anything else    staff ask the owners (`ask_owners`), and the reasons
 *                    are named, so the owners and the asker see why.
 *
 * Sky's rule: anyone can fund the wallet, but they can only spend what the
 * rule allows, and anything outside the rule needs the person in charge.
 *
 * A bank payout and USDC to another chain are the owners' to pay (the payout
 * route instructs the partner first; a cross-chain payment is never on a
 * spending rule), and so is an exchange account (its Travel Rule message is
 * sent first), so staff always ask for those. A payment in anything but USDC
 * is refused for everyone (D6): no rule pays it and the owners do not either.
 *
 * The page runs this to say why; the server runs the same function before it
 * builds a staff member's transaction (lib/server/wallet-transfers.ts), so a
 * stale page cannot make a payment the rule does not cover. The chain checks
 * it a third time (splash_spend::pay_intent and the allowance itself).
 *
 * Pure and client-safe.
 */
import { normalizeSuiAddress } from '@mysten/sui/utils';

import { formatUsdc } from '../fees/copy.ts';
import { parseMinor } from '../money.ts';
import { MICRO_DECIMALS } from '../money.ts';
import { timeLeftWords } from '../team-rules/words.ts';

export const DEFAULT_SECOND_APPROVAL_MINOR = 10_000_000_000n;
export const U64_MAX = 18_446_744_073_709_551_615n;

/** An amount as a person types it ("5,000", "5000.50"), in USDC minor units; null when it is not an exact amount above zero. */
export function parseAmountMinor(text: string): bigint | null {
  const raw = String(text ?? '').trim();
  if (!/^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,6})?$/.test(raw)) return null;
  let minor: bigint;
  try {
    minor = parseMinor(raw.replace(/,/g, ''), MICRO_DECIMALS);
  } catch {
    return null;
  }
  return minor > 0n && minor <= U64_MAX ? minor : null;
}

export type FundsCheck =
  | { enough: boolean; unknown?: false; needMinor: bigint; shortByMinor: bigint }
  | { enough: false; unknown: true; needMinor: bigint; shortByMinor: null };

/** What the wallet needs for this payment (the amount and the fee shown) and what it lacks. A balance that could not be read is unknown, never zero. */
export function fundsCheck(input: { balanceMinor: bigint | null; amountMinor: bigint; feeMinor: bigint }): FundsCheck {
  const needMinor = input.amountMinor + input.feeMinor;
  if (input.balanceMinor === null) return { enough: false, unknown: true, needMinor, shortByMinor: null };
  const short = needMinor > input.balanceMinor ? needMinor - input.balanceMinor : 0n;
  return { enough: short === 0n, needMinor, shortByMinor: short };
}

/** The fee the person was shown, as the payment's max_fee; null when no fee was shown, which is no payment. */
export function maxFeeToSend(shown: { feeMinor: bigint | null } | null): string | null {
  if (!shown || shown.feeMinor === null || shown.feeMinor < 0n) return null;
  return shown.feeMinor.toString();
}

export type ApprovalReason =
  | 'viewer'
  | 'no_rule'
  | 'rule_not_active'
  | 'rule_expired'
  | 'rule_revoked'
  | 'rule_not_started'
  | 'rule_ends_soon'
  | 'over_payment_max'
  | 'cap_used_up'
  | 'over_cap'
  | 'recipient_not_on_rule'
  | 'above_threshold'
  | 'owners_pay_this_kind'
  | 'exchange_needs_owners'
  | 'wrong_asset'
  | 'policy_unreadable'
  | 'staff_rule_not_wired';

export type ApprovalPlan =
  | { route: 'owners_sign'; needsOwnerApproval: false; reasons: []; thresholdMinor: bigint }
  | { route: 'staff_rule'; needsOwnerApproval: false; reasons: []; thresholdMinor: bigint }
  | { route: 'ask_owners'; needsOwnerApproval: true; reasons: ApprovalReason[]; thresholdMinor: bigint; renewsAtMs?: string | null }
  | { route: 'blocked'; needsOwnerApproval: false; reasons: ApprovalReason[]; thresholdMinor: bigint };

/**
 * The caller's own rule, as GET /api/wallet/spending-rules answers it. The
 * dates are optional: a rule read without them is judged on `status` alone.
 */
export type StaffRuleFacts = {
  status: string;
  perPaymentMaxMinor: string;
  spendableNowMinor: string;
  startsAtMs?: string | null;
  expiresAtMs?: string | null;
  /** When the cap window ends and the full cap applies again; null when there is no window to wait for. */
  renewsAtMs?: string | null;
};
/** The business policy, as the same route answers it. */
export type PolicyFacts = { secondApprovalThresholdMinor: string; recipients: Array<{ address: string; tag?: string }> };

export type PlanPayee = { kind: 'bank' | 'splash_business' | 'wallet'; wallet?: string; address?: string | null };

/** Payments this person has asked for that the chain has not yet counted: signed but not on chain, or still collecting. */
export type InFlight = { spenderMinor: bigint; recipientMinor: bigint };

export function approvalPlan(input: {
  role: string;
  amountMinor: bigint;
  feeMinor: bigint;
  payee: PlanPayee;
  rule: StaffRuleFacts | null;
  policy: PolicyFacts | null;
  /** What the running-total window already counts towards this recipient. */
  runningTotalMinor?: bigint;
  /** The asset the payment moves; absent means USDC, the only asset a payment moves (D6). */
  asset?: string;
  /** Now, and the time the payment must be signed by (its quote's deadline): the rule must still be running then. */
  nowMs?: bigint;
  settleByMs?: bigint;
  inFlight?: InFlight;
}): ApprovalPlan {
  const thresholdMinor = input.policy ? BigInt(input.policy.secondApprovalThresholdMinor) : DEFAULT_SECOND_APPROVAL_MINOR;
  if (input.asset !== undefined && input.asset.toUpperCase() !== 'USDC') return { route: 'blocked', needsOwnerApproval: false, reasons: ['wrong_asset'], thresholdMinor };
  if (input.role === 'OWNER') return { route: 'owners_sign', needsOwnerApproval: false, reasons: [], thresholdMinor };
  if (input.role !== 'MAKER' && input.role !== 'APPROVER') return { route: 'blocked', needsOwnerApproval: false, reasons: ['viewer'], thresholdMinor };

  const ask = (reasons: ApprovalReason[], renewsAtMs?: string | null): ApprovalPlan => ({ route: 'ask_owners', needsOwnerApproval: true, reasons, thresholdMinor, ...(renewsAtMs !== undefined ? { renewsAtMs } : {}) });
  if (input.payee.kind === 'bank' || (input.payee.kind === 'wallet' && input.payee.wallet === 'cross_chain')) return ask(['owners_pay_this_kind']);
  if (input.payee.kind === 'wallet' && input.payee.wallet === 'exchange') return ask(['exchange_needs_owners']);
  const { rule, policy } = input;
  if (!rule) return ask(['no_rule']);
  if (rule.status === 'expired') return ask(['rule_expired']);
  if (rule.status === 'no_allowance') return ask(['rule_revoked']);
  if (rule.status === 'not_started') return ask(['rule_not_started']);
  if (rule.status !== 'active') return ask(['rule_not_active']);

  const reasons: ApprovalReason[] = [];
  const now = input.nowMs;
  const settleBy = input.settleByMs ?? now;
  if (now !== undefined) {
    // The status is as of when the rule was read; the dates say whether it is running now and when the payment could be signed.
    if (rule.startsAtMs && now < BigInt(rule.startsAtMs)) return ask(['rule_not_started']);
    if (rule.expiresAtMs) {
      const ends = BigInt(rule.expiresAtMs);
      if (now >= ends) return ask(['rule_expired']);
      if (settleBy !== undefined && settleBy > ends) reasons.push('rule_ends_soon');
    }
  }
  const flight = input.inFlight ?? { spenderMinor: 0n, recipientMinor: 0n };
  if (input.amountMinor > BigInt(rule.perPaymentMaxMinor)) reasons.push('over_payment_max');
  const left = BigInt(rule.spendableNowMinor) - flight.spenderMinor;
  if (left <= 0n) reasons.push('cap_used_up');
  else if (input.amountMinor + input.feeMinor > left) reasons.push('over_cap');
  if (!policy) {
    reasons.push('policy_unreadable');
  } else {
    const address = input.payee.address ? safeNormalise(input.payee.address) : null;
    const listed = address ? policy.recipients.find((r) => safeNormalise(r.address) === address) : undefined;
    if (!listed) reasons.push('recipient_not_on_rule');
    else if (listed.tag === 'exchange') reasons.push('exchange_needs_owners');
    if ((input.runningTotalMinor ?? 0n) + flight.recipientMinor + input.amountMinor > thresholdMinor) reasons.push('above_threshold');
  }
  if (reasons.length > 0) return ask(reasons, reasons.includes('cap_used_up') || reasons.includes('over_cap') ? (rule.renewsAtMs ?? null) : undefined);
  return { route: 'staff_rule', needsOwnerApproval: false, reasons: [], thresholdMinor };
}

function safeNormalise(address: string): string | null {
  try {
    return normalizeSuiAddress(address);
  } catch {
    return null;
  }
}

/**
 * What this server can carry out for a plan. `wired` is a fact the server
 * reports (`staffRulePaymentsWired` in GET /api/wallet/transfers/context): it
 * is true when splash_spend's ids, a gas sponsor and the wallet are all in
 * place. When it is not, a payment under a staff rule goes to the owners,
 * with the reason `staff_rule_not_wired`, and they pay it from the wallet.
 * Every other plan is carried out as planned. There is no default: the
 * caller must say.
 */
export function executableRoute(plan: ApprovalPlan, wired: boolean): ApprovalPlan {
  if (typeof wired !== 'boolean') throw new TypeError('executableRoute needs to be told whether paying under a rule is wired');
  if (plan.route === 'staff_rule' && !wired) {
    return { route: 'ask_owners', needsOwnerApproval: true, reasons: ['staff_rule_not_wired'], thresholdMinor: plan.thresholdMinor };
  }
  return plan;
}

/** Words for each reason, for the person asking and for the owners. */
export const APPROVAL_REASON_TEXT: Record<ApprovalReason, string> = {
  viewer: 'Viewers can look at payments but cannot make them.',
  no_rule: 'You have no spending rule, so this payment needs the owners.',
  rule_not_active: 'Your spending rule is not running at the moment, so this payment needs the owners.',
  rule_expired: 'Your spending rule has ended, so this payment needs the owners.',
  rule_revoked: 'Your spending rule was taken back, so this payment needs the owners.',
  rule_not_started: 'Your spending rule has not started yet, so this payment needs the owners.',
  rule_ends_soon: 'Your spending rule ends before this payment could be signed, so it needs the owners.',
  over_payment_max: 'This is more than your rule allows for one payment.',
  cap_used_up: 'You have used up your rule’s cap for now.',
  over_cap: 'This is more than is left of your rule’s cap for now.',
  recipient_not_on_rule: 'This recipient is not on your rule’s list of verified recipients.',
  above_threshold: 'With what was already paid to this recipient, the total is above the amount an owner must approve.',
  owners_pay_this_kind: 'Bank payouts and USDC to another chain are paid by the owners.',
  exchange_needs_owners: 'Payments to an exchange account need a Travel Rule message first, so the owners send them.',
  wrong_asset: 'Payments are made in USDC only.',
  policy_unreadable: 'Your business’s spending policy could not be read, so this payment needs the owners.',
  staff_rule_not_wired: 'Your rule covers this payment, but paying under a rule is not set up for your business, so the owners approve it.',
};

const stampUtc = (ms: bigint | string) => `${new Date(Number(ms)).toISOString().replace('T', ' ').slice(0, 16)} UTC`;

/**
 * The reasons as sentences with their numbers: the limit the amount is over,
 * what is left of the cap and when it renews, the amount an owner must
 * approve from. A payment within the rule has nothing to explain.
 */
export function approvalReasonLines(
  plan: ApprovalPlan,
  facts: { rule: StaffRuleFacts | null; policy: PolicyFacts | null; amountMinor: bigint; nowMs?: number },
): string[] {
  const usdc = (minor: string | bigint) => `${formatUsdc(BigInt(minor))} USDC`;
  const renews = (): string => {
    const at = plan.route === 'ask_owners' ? (plan.renewsAtMs ?? facts.rule?.renewsAtMs ?? null) : null;
    if (!at) return '';
    const left = facts.nowMs !== undefined ? Number(at) - facts.nowMs : Number.NaN;
    return Number.isFinite(left) && left > 0 ? ` It renews in ${timeLeftWords(left)} (${stampUtc(at)}).` : ` It renews on ${stampUtc(at)}.`;
  };
  return plan.reasons.map((reason) => {
    const base = APPROVAL_REASON_TEXT[reason];
    switch (reason) {
      case 'over_payment_max':
        return facts.rule ? `This is more than your rule allows for one payment. Your limit is ${usdc(facts.rule.perPaymentMaxMinor)} a payment.` : base;
      case 'cap_used_up':
        return `${base}${renews()}`;
      case 'over_cap':
        return facts.rule ? `This is more than is left of your rule’s cap for now: ${usdc(facts.rule.spendableNowMinor)} left, counting the fee.${renews()}` : base;
      case 'above_threshold':
        return facts.policy ? `With what was already paid to this recipient, the total is above ${usdc(facts.policy.secondApprovalThresholdMinor)}, the amount an owner must approve.` : base;
      default:
        return base;
    }
  });
}
