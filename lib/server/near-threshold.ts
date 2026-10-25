/**
 * Near-threshold alerts for spending rules (v2 Phase 2; A1 §6; Phase 1 R5).
 *
 * The second-approval threshold is enforced on chain over a running total
 * per (payer, recipient): one staff member splitting one invoice into
 * several payments needs an owner's approval for the part over it. Two
 * patterns stay under it, and this module flags them for the owners. It is
 * DETECTIVE only: it blocks nothing, signs nothing and changes no rule. A
 * staff member can build and submit a payment alone, without Splash's
 * backend, so a flag is all an off-chain check can be.
 *
 *   near_threshold_repeat
 *     One spender has paid one recipient (or one bank beneficiary) two or
 *     more times, and what the threshold check counts for them now is at or
 *     above 80% of the threshold but still below it: the next payment
 *     could be the one that needs an approval, or the payments are being
 *     kept just under it.
 *
 *   same_recipient_many_spenders
 *     Two or more spenders each have a running total to the same recipient
 *     (or beneficiary), and together they count at or above 80% of the
 *     threshold. Each total is checked on its own, so together they can
 *     pass the threshold with no approval at all (`over_threshold`).
 *
 * Inputs are what the chain shows, through the spending-rule index
 * (lib/server/spend-rules-index.ts): the running totals the SpendPolicy
 * keeps, counted as `spend_policy::threshold_total` counts them, and the
 * `RuleSpend` events (who paid whom). RuleSpend carries no principal; the
 * amounts are the policy's totals. A bank payout's RuleSpend names the
 * partner deposit address, so its payments are counted per deposit address
 * (several beneficiaries bound to one deposit address count together, a
 * possible over-count that only makes a flag likelier).
 *
 * Pure. Each alert is keyed by its content (the policy, who, to whom, and
 * the windows the totals belong to), so a re-run derives the same key and a
 * new window derives a new one.
 */
import { formatUsdcBound } from '../fees/copy.ts';
import type { SpendView } from './spend-rules-index.ts';

export type NearThresholdKind = 'near_threshold_repeat' | 'same_recipient_many_spenders';
export type NearThresholdSeverity = 'near_threshold' | 'over_threshold';

export type NearThresholdAlert = {
  key: string;
  kind: NearThresholdKind;
  severity: NearThresholdSeverity;
  policyId: string;
  /** The recipient address, or null for a bank beneficiary. */
  recipient: string | null;
  /** The beneficiary commitment (hex) of a bank payout, or null. */
  beneficiary: string | null;
  spenders: string[];
  /** What the threshold check counts now, summed over the spenders (minor units). */
  countedMinor: string;
  thresholdMinor: string;
  /** RuleSpend payments seen to this recipient by these spenders. */
  payments: number;
  /** Shown until the last of the totals stops counting. */
  activeUntilMs: string;
  summary: string;
  detail: string;
};

/** 80%: the same line the index marks `nearThreshold` at. */
const NEAR_PERCENT = 80n;
/** Payments by one spender to one recipient before a repeat is flagged. */
export const MIN_REPEAT_PAYMENTS = 2;

const short = (a: string) => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
const usdc = (minor: bigint) => `${formatUsdcBound(minor)} USDC`;

/** Who someone is, for the words: a name the caller knows, or a short address. */
export type NameOf = (address: string) => string | null;

function who(address: string, role: 'staff' | 'executor' | undefined, nameOf?: NameOf): string {
  if (role === 'executor') return "Splash's scheduled-payment operator";
  return nameOf?.(address) ?? short(address);
}

function list(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

const ACT = 'Check these payments in your spending rules. Splash blocks nothing on this alert; to stop further payments, change or revoke a rule.';

export function deriveNearThresholdAlerts(view: SpendView, opts: { nameOf?: NameOf } = {}): NearThresholdAlert[] {
  const policy = view.policy;
  if (!policy) return [];
  const threshold = BigInt(policy.secondApprovalThresholdMinor);
  if (threshold <= 0n) return [];
  const near = (n: bigint) => n * 100n >= threshold * NEAR_PERCENT;
  const depositOf = new Map(policy.beneficiaries.map((b) => [b.commitment.toLowerCase(), b.partnerDeposit]));
  const role = new Map(view.rules.map((r) => [r.spender, r.role]));

  type Entry = { spender: string; recipient: string | null; beneficiary: string | null; counted: bigint; windowStartMs: string; countsUntilMs: bigint; payments: number };
  const entries: Entry[] = [];
  for (const rule of view.rules) {
    for (const t of rule.runningTotals) {
      const counted = BigInt(t.countedMinor);
      if (counted <= 0n) continue;
      // Who RuleSpend names for this total: the address, or the bank
      // beneficiary's partner deposit address.
      const paidTo = t.recipient ?? (t.beneficiary ? depositOf.get(t.beneficiary.toLowerCase()) ?? null : null);
      const payments = paidTo ? rule.recentSpends.filter((s) => s.recipient === paidTo).length : 0;
      entries.push({ spender: rule.spender, recipient: t.recipient, beneficiary: t.beneficiary, counted, windowStartMs: t.windowStartMs, countsUntilMs: BigInt(t.countsUntilMs), payments });
    }
  }

  const to = (e: Pick<Entry, 'recipient' | 'beneficiary'>) => (e.recipient ? `${short(e.recipient)}` : `the bank account ${short(`0x${e.beneficiary ?? ''}`)}`);
  const full = (e: Pick<Entry, 'recipient' | 'beneficiary'>) => (e.recipient ? `Recipient: ${e.recipient}.` : `Bank beneficiary commitment: ${e.beneficiary}.`);
  const alerts: NearThresholdAlert[] = [];

  // One spender, one recipient, several payments just under the threshold.
  for (const e of entries) {
    if (e.payments < MIN_REPEAT_PAYMENTS || e.counted >= threshold || !near(e.counted)) continue;
    const target = e.recipient ?? `b:${e.beneficiary}`;
    alerts.push({
      key: `near_threshold_repeat|${policy.id}|${e.spender}|${target}|${e.windowStartMs}`,
      kind: 'near_threshold_repeat',
      severity: 'near_threshold',
      policyId: policy.id,
      recipient: e.recipient,
      beneficiary: e.beneficiary,
      spenders: [e.spender],
      countedMinor: e.counted.toString(),
      thresholdMinor: threshold.toString(),
      payments: e.payments,
      activeUntilMs: e.countsUntilMs.toString(),
      summary: `${who(e.spender, role.get(e.spender), opts.nameOf)} has paid ${to(e)} ${e.payments} times, ${usdc(e.counted)} in all, close to the ${usdc(threshold)} that needs a second approval.`,
      detail: `${full(e)} What counts toward the second approval now: ${usdc(e.counted)} of ${usdc(threshold)}. ${ACT}`,
    });
  }

  // Several spenders, one recipient: each total is checked on its own.
  const groups = new Map<string, Entry[]>();
  for (const e of entries) {
    const target = e.recipient ?? `b:${e.beneficiary}`;
    groups.set(target, [...(groups.get(target) ?? []), e]);
  }
  for (const [target, group] of groups) {
    const spenders = [...new Set(group.map((e) => e.spender))].sort();
    if (spenders.length < 2) continue;
    const counted = group.reduce((n, e) => n + e.counted, 0n);
    if (!near(counted)) continue;
    const over = counted >= threshold;
    const sorted = [...group].sort((a, b) => (a.spender < b.spender ? -1 : a.spender > b.spender ? 1 : 0));
    const until = group.reduce((m, e) => (e.countsUntilMs > m ? e.countsUntilMs : m), 0n);
    const names = list(spenders.map((s) => who(s, role.get(s), opts.nameOf)));
    const e0 = group[0];
    alerts.push({
      key: `same_recipient_many_spenders|${policy.id}|${target}|${sorted.map((e) => `${e.spender}@${e.windowStartMs}`).join(',')}`,
      kind: 'same_recipient_many_spenders',
      severity: over ? 'over_threshold' : 'near_threshold',
      policyId: policy.id,
      recipient: e0.recipient,
      beneficiary: e0.beneficiary,
      spenders,
      countedMinor: counted.toString(),
      thresholdMinor: threshold.toString(),
      payments: group.reduce((n, e) => n + e.payments, 0),
      activeUntilMs: until.toString(),
      summary: over
        ? `${names} have together paid ${to(e0)} ${usdc(counted)}, above the ${usdc(threshold)} that needs a second approval for one person. Each stayed under it alone, so no approval was asked for.`
        : `${names} have together paid ${to(e0)} ${usdc(counted)}, close to the ${usdc(threshold)} that needs a second approval for one person.`,
      detail: `${full(e0)} ${sorted.map((e) => `${who(e.spender, role.get(e.spender), opts.nameOf)}: ${usdc(e.counted)}`).join('; ')}. ${ACT}`,
    });
  }
  return alerts;
}
