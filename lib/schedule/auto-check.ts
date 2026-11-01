/**
 * Every check an automatic scheduled run must pass before Splash pays it with
 * no one present (v2 Phase 3, "pay automatically within my limits"), as one
 * pure function over facts the server has just read.
 *
 * It passes only if ALL of this holds, for the whole run (a run is paid whole
 * or handed back whole; there is no paying the first three rows and asking
 * about the fourth):
 *
 *   - automatic payments are not paused, and the schedule is an owner's, set
 *     up by someone who is still an owner;
 *   - the scheduled payer and the gas sponsor are both there;
 *   - the owners' allowance is readable, running, and not about to end;
 *   - every payee is still the one the owner saved (same address, same kind),
 *     is a Splash business or a wallet (never an exchange, a bank or another
 *     chain), is cleared by screening now, and was PAID BEFORE: a first payment
 *     to a new recipient is never automatic;
 *   - every payee is on the business's list of verified recipients, each
 *     payment is within the per-payment limit and under the second-approval
 *     line, counting what was already paid that recipient, and the whole run
 *     fits what is left of the allowance's window (the same plan the chain's
 *     splash_spend and a staff member's Transfer use, run payment by payment
 *     with each payment counted against the next);
 *   - the day's automatic payments, this run included, stay within the daily
 *     limit the owners set (the allowance itself carries the monthly cap);
 *   - the fee for each payment is no higher than the fee the owner was shown;
 *   - the wallet holds enough.
 *
 * The first thing that fails is the answer, with the sentence the owners read.
 * Pure and free of the database and the network, so every branch is tested.
 */
import { approvalPlan, type ApprovalReason, type PolicyFacts, type StaffRuleFacts } from '../transfer/plan.ts';
import { AUTO_APPROVAL_CEILING_MINOR, FALLBACK_TEXT, fallbackWords, type FallbackCode } from './rules.ts';

export type AutoItemFacts = {
  position: number;
  /** The payee's name as the owner saved it, for the sentence. */
  name: string;
  /** What the owner saved. */
  saved: { address: string; amountMinor: bigint; feeMinor: bigint; feeKind: number };
  /** What the payee is now: null when it can no longer be resolved. */
  now: { address: string; kind: number } | null;
  paidBefore: boolean;
  /** Screening is a fresh CLEAR now. */
  cleared: boolean;
  /** Splash's fee for this payment now. */
  currentFeeMinor: bigint;
};

export type AutoFacts = {
  nowMs: number;
  /** How long the quote of each payment lasts: the rule must still be running then. */
  settleWindowMs: number;
  paused: boolean;
  /** The schedule's creator is still an owner and created it as one. */
  ownerCreated: boolean;
  payerReady: boolean;
  sponsorReady: boolean;
  /** The chain could be read for the allowance. */
  ruleReadable: boolean;
  rule: StaffRuleFacts | null;
  policy: PolicyFacts | null;
  /** Recipient (normalised address) -> what the running-total window counts for everyone together. */
  runningTotals: Record<string, string>;
  dailyCapMinor: bigint;
  /** What automatic runs paid, or are paying, in the last 24 hours. */
  dailyUsedMinor: bigint;
  /** What the wallet can spend now, or null when it could not be read. */
  walletBalanceMinor: bigint | null;
};

export type AutoVerdict =
  | { ok: true; rows: Array<{ position: number; amountMinor: bigint; feeMinor: bigint; address: string; kind: number }>; totalMinor: bigint; feeMinor: bigint }
  | { ok: false; code: FallbackCode; text: string; position: number | null };

const refuse = (code: FallbackCode, item?: AutoItemFacts): AutoVerdict => ({ ok: false, code, position: item?.position ?? null, text: fallbackWords(code, item?.name ?? null) });

/** The plan's reason, as the reason an owner reads for an automatic run. */
export function fallbackFor(reason: ApprovalReason): FallbackCode {
  switch (reason) {
    case 'no_rule':
      return 'no_allowance';
    case 'rule_expired':
    case 'rule_revoked':
    case 'rule_not_active':
      return 'allowance_ended';
    case 'rule_not_started':
      return 'allowance_not_started';
    case 'rule_ends_soon':
      return 'allowance_ends_soon';
    case 'over_payment_max':
      return 'over_payment_limit';
    case 'recipient_not_on_rule':
      return 'recipient_not_verified';
    case 'above_threshold':
      return 'above_approval_line';
    case 'owners_pay_this_kind':
    case 'exchange_needs_owners':
    case 'exchange_not_verified_as_exchange':
    case 'wrong_asset':
      return 'exchange_or_bank';
    case 'policy_unreadable':
      return 'policy_unreadable';
    default:
      // cap_used_up, over_cap, and anything that only a person could have been asked about
      return 'over_window';
  }
}

const norm = (address: string) => address.toLowerCase();

/** Run every check, in order, over the whole run. The first failure is the answer. */
export function evaluateAutoRun(facts: AutoFacts, items: AutoItemFacts[]): AutoVerdict {
  if (facts.paused) return refuse('auto_paused');
  if (!facts.ownerCreated) return refuse('not_owner_created');
  if (!facts.payerReady || !facts.sponsorReady) return refuse('payer_unavailable');
  if (!facts.ruleReadable) return refuse('rule_unreadable');
  if (!facts.policy) return refuse('policy_unreadable');
  if (!facts.rule) return refuse('no_allowance');
  if (items.length === 0) return refuse('over_window');

  // The line an owner must approve above: the business's own, and never higher than 10,000 USDC.
  const policyThreshold = BigInt(facts.policy.secondApprovalThresholdMinor);
  const threshold = policyThreshold < AUTO_APPROVAL_CEILING_MINOR ? policyThreshold : AUTO_APPROVAL_CEILING_MINOR;
  const policy = { ...facts.policy, secondApprovalThresholdMinor: threshold.toString() };
  const rows: Extract<AutoVerdict, { ok: true }>['rows'] = [];
  let spender = 0n;
  const toRecipient = new Map<string, bigint>();
  let total = 0n;
  let fees = 0n;

  for (const item of items) {
    // The payee is still the one the owner saved.
    if (!item.now || norm(item.now.address) !== norm(item.saved.address) || item.now.kind !== item.saved.feeKind) return refuse('recipient_changed', item);
    // Only a Splash business or a wallet. An exchange, a bank and another chain are the owners'.
    if (item.now.kind !== 0 && item.now.kind !== 1) return refuse('exchange_or_bank', item);
    // Never a first payment to a recipient automatically.
    if (!item.paidBefore) return refuse('new_recipient', item);
    if (!item.cleared) return refuse('recipient_not_cleared', item);
    // The fee shown is the fee paid: a higher fee than the owner saw is theirs to approve.
    if (item.currentFeeMinor > item.saved.feeMinor) return refuse('fee_changed', item);

    const address = norm(item.now.address);
    const amount = item.saved.amountMinor;
    const fee = item.currentFeeMinor;
    if (amount > threshold) return refuse('above_approval_line', item);

    // The same plan a staff member's payment is judged by, with each payment counted against the next.
    const plan = approvalPlan({
      role: 'MAKER',
      amountMinor: amount,
      feeMinor: fee,
      payee: item.now.kind === 0 ? { kind: 'splash_business', address } : { kind: 'wallet', wallet: 'self_custody', address },
      rule: facts.rule,
      policy,
      runningTotalMinor: BigInt(facts.runningTotals[address] ?? '0'),
      asset: 'USDC',
      nowMs: BigInt(facts.nowMs),
      settleByMs: BigInt(facts.nowMs + facts.settleWindowMs),
      inFlight: { spenderMinor: spender, recipientMinor: toRecipient.get(address) ?? 0n, openCount: 0 },
    });
    if (plan.route !== 'staff_rule') return refuse(fallbackFor(plan.reasons[0] ?? 'no_rule'), item);

    spender += amount + fee;
    toRecipient.set(address, (toRecipient.get(address) ?? 0n) + amount);
    total += amount;
    fees += fee;
    rows.push({ position: item.position, amountMinor: amount, feeMinor: fee, address: item.now.address, kind: item.now.kind });
  }

  if (facts.dailyUsedMinor + total + fees > facts.dailyCapMinor) return refuse('daily_cap');
  if (facts.walletBalanceMinor !== null && facts.walletBalanceMinor < total + fees) return refuse('balance_short');
  return { ok: true, rows, totalMinor: total, feeMinor: fees };
}

export { FALLBACK_TEXT };
