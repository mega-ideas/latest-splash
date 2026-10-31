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
 *                    (`splash_spend::pay_intent`, `staff_rule`) when the
 *                    amount is within the rule's per-payment maximum and what
 *                    is left of its cap, the recipient is on the policy, and
 *                    the running total to that recipient stays at or below
 *                    the second-approval threshold (10,000 USDC unless the
 *                    policy says otherwise; split payments to one recipient
 *                    count together).
 *   anything else    staff ask the owners (`ask_owners`), and the reasons
 *                    are named, so the owners and the asker see why.
 *
 * A bank payout and USDC to another chain are the owners' to pay (the payout
 * route instructs the partner first; a cross-chain payment is never on a
 * spending rule), so staff always ask for those.
 *
 * `STAFF_RULE_PAYMENTS_WIRED` says whether this server can carry out a
 * payment under a staff rule. It cannot yet: the staff-side transaction
 * (create_intent and pay_intent signed on the staff member's own device) has
 * no builder on this branch. Until it does, `executableRoute` turns a
 * `staff_rule` plan into asking the owners, and says so; nothing pretends.
 *
 * Pure and client-safe.
 */
import { normalizeSuiAddress } from '@mysten/sui/utils';

import { parseMinor } from '../money.ts';
import { MICRO_DECIMALS } from '../money.ts';

export const DEFAULT_SECOND_APPROVAL_MINOR = 10_000_000_000n;
export const U64_MAX = 18_446_744_073_709_551_615n;

export const STAFF_RULE_PAYMENTS_WIRED = false;

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
  | 'over_payment_max'
  | 'over_cap'
  | 'recipient_not_on_rule'
  | 'above_threshold'
  | 'owners_pay_this_kind'
  | 'policy_unreadable'
  | 'staff_rule_not_wired';

export type ApprovalPlan =
  | { route: 'owners_sign'; needsOwnerApproval: false; reasons: []; thresholdMinor: bigint }
  | { route: 'staff_rule'; needsOwnerApproval: false; reasons: []; thresholdMinor: bigint }
  | { route: 'ask_owners'; needsOwnerApproval: true; reasons: ApprovalReason[]; thresholdMinor: bigint }
  | { route: 'blocked'; needsOwnerApproval: false; reasons: ApprovalReason[]; thresholdMinor: bigint };

/** The caller's own rule, as GET /api/wallet/spending-rules answers it. */
export type StaffRuleFacts = { status: string; perPaymentMaxMinor: string; spendableNowMinor: string };
/** The business policy, as the same route answers it. */
export type PolicyFacts = { secondApprovalThresholdMinor: string; recipients: Array<{ address: string; tag?: string }> };

export type PlanPayee = { kind: 'bank' | 'splash_business' | 'wallet'; wallet?: string; address?: string | null };

export function approvalPlan(input: {
  role: string;
  amountMinor: bigint;
  feeMinor: bigint;
  payee: PlanPayee;
  rule: StaffRuleFacts | null;
  policy: PolicyFacts | null;
  /** What the running-total window already counts towards this recipient. */
  runningTotalMinor?: bigint;
}): ApprovalPlan {
  const thresholdMinor = input.policy ? BigInt(input.policy.secondApprovalThresholdMinor) : DEFAULT_SECOND_APPROVAL_MINOR;
  if (input.role === 'OWNER') return { route: 'owners_sign', needsOwnerApproval: false, reasons: [], thresholdMinor };
  if (input.role !== 'MAKER' && input.role !== 'APPROVER') return { route: 'blocked', needsOwnerApproval: false, reasons: ['viewer'], thresholdMinor };

  const ask = (reasons: ApprovalReason[]): ApprovalPlan => ({ route: 'ask_owners', needsOwnerApproval: true, reasons, thresholdMinor });
  if (input.payee.kind === 'bank' || (input.payee.kind === 'wallet' && input.payee.wallet === 'cross_chain')) return ask(['owners_pay_this_kind']);
  const { rule, policy } = input;
  if (!rule) return ask(['no_rule']);
  if (rule.status !== 'active') return ask(['rule_not_active']);

  const reasons: ApprovalReason[] = [];
  if (input.amountMinor > BigInt(rule.perPaymentMaxMinor)) reasons.push('over_payment_max');
  if (input.amountMinor + input.feeMinor > BigInt(rule.spendableNowMinor)) reasons.push('over_cap');
  if (!policy) {
    reasons.push('policy_unreadable');
  } else {
    const address = input.payee.address ? safeNormalise(input.payee.address) : null;
    if (!address || !policy.recipients.some((r) => safeNormalise(r.address) === address)) reasons.push('recipient_not_on_rule');
    if ((input.runningTotalMinor ?? 0n) + input.amountMinor > thresholdMinor) reasons.push('above_threshold');
  }
  if (reasons.length > 0) return ask(reasons);
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
 * What this server can carry out for a plan. A payment under a staff rule is
 * not wired here yet (`STAFF_RULE_PAYMENTS_WIRED`), so it goes to the owners,
 * with the reason `staff_rule_not_wired`; the owners then pay it from the
 * wallet. Every other plan is carried out as planned.
 */
export function executableRoute(plan: ApprovalPlan, wired: boolean = STAFF_RULE_PAYMENTS_WIRED): ApprovalPlan {
  if (plan.route === 'staff_rule' && !wired) {
    return { route: 'ask_owners', needsOwnerApproval: true, reasons: ['staff_rule_not_wired'], thresholdMinor: plan.thresholdMinor };
  }
  return plan;
}

/** Words for each reason, for the person asking and for the owners. */
export const APPROVAL_REASON_TEXT: Record<ApprovalReason, string> = {
  viewer: 'Viewers can look at payments but cannot make them.',
  no_rule: 'You have no spending rule yet, so the owners approve this payment.',
  rule_not_active: 'Your spending rule is not active (it has ended or has not started), so the owners approve this payment.',
  over_payment_max: 'This is more than your rule allows for one payment.',
  over_cap: 'This is more than is left of your rule’s cap for now.',
  recipient_not_on_rule: 'This recipient is not on your rule’s list of verified recipients.',
  above_threshold: 'With what was already paid to this recipient, the total is above the amount an owner must approve.',
  owners_pay_this_kind: 'Bank payouts and USDC to another chain are paid by the owners.',
  policy_unreadable: 'Your business’s spending policy could not be read, so the owners approve this payment.',
  staff_rule_not_wired: 'Your rule covers this payment, but paying under a rule from here is not switched on yet, so the owners approve it.',
};
