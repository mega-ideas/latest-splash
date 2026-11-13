/**
 * Near-threshold alerts for spending rules (v2 Phase 2; A1 §6; Phase 1 R5).
 *
 * The second-approval threshold is enforced on chain over running totals:
 * one staff member splitting one invoice into several payments needs an
 * owner's approval for the part over it, and (pre-audit B1) so do several
 * staff splitting one recipient's payments, because the check counts the
 * larger of the payer's own total and what EVERY payer paid that recipient
 * without an owner's approval (the policy-wide total). Two patterns come
 * close to it, and this module flags them for the owners. It is DETECTIVE
 * only: it blocks nothing, signs nothing and changes no rule. A staff
 * member can build and submit a payment alone, without Splash's backend,
 * so a flag is all an off-chain check can be.
 *
 *   near_threshold_repeat
 *     One spender has paid one recipient (or one bank beneficiary) two or
 *     more times, and what the threshold check counts for them now (the
 *     larger of their own total and the policy-wide one) is at or above 80%
 *     of the threshold but still below it: the next payment could be the
 *     one that needs an approval, or the payments are being kept just
 *     under it.
 *
 *   same_recipient_many_spenders
 *     Two or more spenders each have a running total to the same recipient
 *     (or beneficiary), and together they count at or above 80% of the
 *     threshold: the larger of their own totals added up and the
 *     policy-wide total. `over_threshold` once that reaches the threshold.
 *     The chain asks for an owner's approval for any payment that would
 *     take the policy-wide total above it, so this is no longer a way
 *     around the threshold; it shows the owners several people paying one
 *     recipient that much.
 *
 * Inputs are what the chain shows, through the spending-rule index
 * (lib/server/spend-rules-index.ts): the running totals the SpendPolicy
 * keeps, counted as `spend_policy::threshold_total` counts them, the
 * policy-wide totals (`recipientTotals`), counted as
 * `spend_policy::policy_threshold_total` counts them, and the
 * `RuleSpend` events (who paid whom). RuleSpend carries no principal; the
 * amounts are the policy's totals. A bank payout's RuleSpend names the
 * partner deposit address, so its payments are counted per deposit address
 * (several beneficiaries bound to one deposit address count together, a
 * possible over-count that only makes a flag likelier).
 *
 * Pure. Each alert is keyed by its content (the policy, who, to whom, the
 * windows the totals belong to and, for several spenders, whether they are
 * near or over), so a re-run derives the same key, a new window derives a
 * new one, and passing the threshold derives a new one. A repeat counts
 * only the RuleSpend payments made inside what the threshold check counts
 * now (`countsFromMs`, by each payment's checkpoint time).
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
  /** The alert this one escalates (the same spenders' near alert, once over): no longer shown. */
  supersedesKey: string | null;
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

/** Pre-audit B1: how the chain counts several payers to one recipient. */
const TOGETHER = "What anyone pays it without an owner's approval counts together, so any payment to it that would take that above the threshold needs an owner's approval.";
const ACT = 'Check these payments in your spending rules. Splash blocks nothing on this alert; to stop further payments, change or revoke a rule.';

export function deriveNearThresholdAlerts(view: SpendView, opts: { nameOf?: NameOf } = {}): NearThresholdAlert[] {
  const policy = view.policy;
  if (!policy) return [];
  const threshold = BigInt(policy.secondApprovalThresholdMinor);
  if (threshold <= 0n) return [];
  const near = (n: bigint) => n * 100n >= threshold * NEAR_PERCENT;
  const depositOf = new Map(policy.beneficiaries.map((b) => [b.commitment.toLowerCase(), b.partnerDeposit]));
  const role = new Map(view.rules.map((r) => [r.spender, r.role]));
  const targetOf = (t: { recipient: string | null; beneficiary: string | null }) => (t.recipient ? t.recipient.toLowerCase() : `b:${(t.beneficiary ?? '').toLowerCase()}`);
  // Pre-audit B1: what every payer paid each recipient without an approval,
  // counted now. An index built without it reads as none.
  const policyWide = new Map<string, { counted: bigint; countsUntilMs: bigint }>();
  for (const t of policy.recipientTotals ?? []) {
    const counted = BigInt(t.countedMinor);
    if (counted > 0n) policyWide.set(targetOf(t), { counted, countsUntilMs: BigInt(t.countsUntilMs) });
  }

  type Entry = { spender: string; recipient: string | null; beneficiary: string | null; own: bigint; counted: bigint; windowStartMs: string; countsUntilMs: bigint; payments: number };
  const entries: Entry[] = [];
  for (const rule of view.rules) {
    for (const t of rule.runningTotals) {
      const own = BigInt(t.countedMinor);
      if (own <= 0n) continue;
      // What the chain's check counts for this payer: the larger of their own
      // total and the policy-wide one, shown until the one counted stops.
      const all = policyWide.get(targetOf(t));
      const wider = all !== undefined && all.counted > own;
      const counted = wider ? all.counted : own;
      const ownUntil = BigInt(t.countsUntilMs);
      const countsUntilMs = wider && all.countsUntilMs > ownUntil ? all.countsUntilMs : ownUntil;
      // Who RuleSpend names for this total: the address, or the bank
      // beneficiary's partner deposit address.
      const paidTo = t.recipient ?? (t.beneficiary ? depositOf.get(t.beneficiary.toLowerCase()) ?? null : null);
      // Only payments inside what the threshold check counts now: one made
      // before `countsFromMs` is in no total that counts. A payment whose time
      // the reader could not tell is counted (a flag is likelier, not missed).
      const from = t.countsFromMs === undefined ? null : BigInt(t.countsFromMs);
      const inWindow = (x: { timestampMs?: string }) => from === null || x.timestampMs === undefined || BigInt(x.timestampMs) >= from;
      const payments = paidTo ? rule.recentSpends.filter((x) => x.recipient === paidTo && inWindow(x)).length : 0;
      entries.push({ spender: rule.spender, recipient: t.recipient, beneficiary: t.beneficiary, own, counted, windowStartMs: t.windowStartMs, countsUntilMs, payments });
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
      supersedesKey: null,
      summary:
        e.counted > e.own
          ? `${who(e.spender, role.get(e.spender), opts.nameOf)} has paid ${to(e)} ${e.payments} times, ${usdc(e.own)} in all. With what everyone paid it without an owner's approval, ${usdc(e.counted)} counts toward the ${usdc(threshold)} that needs a second approval.`
          : `${who(e.spender, role.get(e.spender), opts.nameOf)} has paid ${to(e)} ${e.payments} times, ${usdc(e.counted)} in all, close to the ${usdc(threshold)} that needs a second approval.`,
      detail: `${full(e)} What counts toward the second approval now: ${usdc(e.counted)} of ${usdc(threshold)}. ${ACT}`,
    });
  }

  // Several spenders, one recipient: the larger of their own totals added up
  // and the policy-wide total (pre-audit B1), which can be the larger: it
  // keeps counting until a window after its last part, whoever paid it.
  const groups = new Map<string, Entry[]>();
  for (const e of entries) {
    const target = e.recipient ?? `b:${e.beneficiary}`;
    groups.set(target, [...(groups.get(target) ?? []), e]);
  }
  for (const [target, group] of groups) {
    const spenders = [...new Set(group.map((e) => e.spender))].sort();
    if (spenders.length < 2) continue;
    const ownSum = group.reduce((n, e) => n + e.own, 0n);
    const all = policyWide.get(targetOf(group[0]));
    const counted = all !== undefined && all.counted > ownSum ? all.counted : ownSum;
    if (!near(counted)) continue;
    const over = counted >= threshold;
    const sorted = [...group].sort((a, b) => (a.spender < b.spender ? -1 : a.spender > b.spender ? 1 : 0));
    const until = group.reduce((m, e) => (e.countsUntilMs > m ? e.countsUntilMs : m), all?.countsUntilMs ?? 0n);
    const names = list(spenders.map((s) => who(s, role.get(s), opts.nameOf)));
    const e0 = group[0];
    // Severity is part of the key: the same spenders, in the same windows,
    // passing the threshold together after a near alert is a new alert (and
    // a new email), and the near one stops being shown.
    const base = `same_recipient_many_spenders|${policy.id}|${target}|${sorted.map((e) => `${e.spender}@${e.windowStartMs}`).join(',')}`;
    alerts.push({
      key: `${base}|${over ? 'over_threshold' : 'near_threshold'}`,
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
      supersedesKey: over ? `${base}|near_threshold` : null,
      // Pre-audit B1: not "each stayed under it alone, so no approval was
      // asked for" any more: the chain counts their unapproved payments
      // together, and part of what they paid may have carried an approval.
      summary: over
        ? `${names} have together paid ${to(e0)} ${usdc(counted)}, ${counted > threshold ? 'above' : 'at'} the ${usdc(threshold)} that needs a second approval. ${TOGETHER}`
        : `${names} have together paid ${to(e0)} ${usdc(counted)}, close to the ${usdc(threshold)} that needs a second approval. ${TOGETHER}`,
      detail: `${full(e0)} ${sorted.map((e) => `${who(e.spender, role.get(e.spender), opts.nameOf)}: ${usdc(e.own)}`).join('; ')}.${all ? ` Paid to it without an owner's approval, counted together: ${usdc(all.counted)}.` : ''} ${ACT}`,
    });
  }
  return alerts;
}
