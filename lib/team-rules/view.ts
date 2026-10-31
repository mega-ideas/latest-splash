/**
 * What Settings → Team & rules shows (v2 §4.2): each rule read from the chain
 * as it stands now, the team, the business's spending policy, the recipients
 * staff may pay alone, and what needs an owner's attention. It words what
 * `GET /api/wallet/spending-rules` already computed (windows rolled over,
 * remaining amounts, who holds each rule); it decides nothing. Pure and
 * client-safe.
 */
import { formatUsdc } from '../fees/copy.ts';
import { kindOfRecipient, stateOf } from '../recipients-page/view.ts';
import type { ClientRecipient } from '../recipients-page/wire.ts';
import { roleLabel } from '../wallet-page/members.ts';
import { timeLeftWords, windowWords } from './words.ts';

export type Tone = 'ok' | 'wait' | 'bad';

type AllowanceLike = {
  current: boolean;
  state: string;
  expiresAtMs: string | null;
  lifetimeCapMinor: string | null;
  lifetimeRemainingMinor: string | null;
  currentSpendMinor: string;
  window: { period: string; limitMinor: string; spentMinor: string; remainingMinor: string; endsAtMs: string | null; rolledOver: boolean } | null;
};
export type RuleLike = {
  userId?: string | null;
  name?: string | null;
  spender: string;
  role?: string;
  standing?: string | null;
  perPaymentMaxMinor: string;
  status: string;
  allowances: AllowanceLike[];
};

const usdc = (minor: string | bigint) => formatUsdc(BigInt(minor));
const stamp = (ms: string) => new Date(Number(ms)).toISOString();

const STATUS: Record<string, { label: string; tone: Tone }> = {
  active: { label: 'Active', tone: 'ok' },
  not_started: { label: 'Starts later', tone: 'wait' },
  expired: { label: 'Expired', tone: 'bad' },
  no_allowance: { label: 'Taken back', tone: 'bad' },
};

export type RuleLineView = {
  userId: string | null;
  name: string;
  state: { label: string; tone: Tone };
  perPayment: string;
  /** What was spent in the window that is current now, null when no current allowance. */
  usage: { text: string; percent: number } | null;
  left: string | null;
  renews: string | null;
  ends: string | null;
  lifetime: string | null;
  /** "Renews in 14 hours": null when the window has passed (the next payment starts a new one) or there is none. */
  renewsIn: string | null;
  /** "Ends in 95 days": null when there is no end or it has passed. */
  endsIn: string | null;
  /** What the current allowance has charged (current_spend): null with no current allowance. */
  paidInAll: string | null;
  orphaned: boolean;
};

export function ruleLine(rule: RuleLike, now: Date): RuleLineView {
  const standing = rule.standing ?? 'member';
  const orphaned = standing !== 'member';
  const base = STATUS[rule.status] ?? { label: 'Unknown', tone: 'wait' as Tone };
  const state = standing === 'removed' || standing === 'not_a_member' ? { label: 'Belongs to someone who left', tone: 'bad' as Tone } : standing === 'viewer' ? { label: 'Belongs to a viewer', tone: 'bad' as Tone } : base;
  // Only the current allowance is the rule: one from an earlier wallet cannot pay.
  const current = rule.allowances.find((a) => a.current && a.state === 'active') ?? rule.allowances.find((a) => a.current) ?? null;
  const w = current?.window ?? null;
  const when = w?.period === 'day' ? 'today' : w?.period === 'month' ? 'this month' : 'in the current window';
  const limit = w ? BigInt(w.limitMinor) : 0n;
  const spent = w ? BigInt(w.spentMinor) : 0n;
  return {
    userId: rule.userId ?? null,
    name: rule.name ?? 'A staff member',
    state,
    perPayment: `${usdc(rule.perPaymentMaxMinor)} USDC`,
    usage: w ? { text: `${usdc(spent)} of ${usdc(limit)} USDC used ${when}`, percent: limit > 0n ? Math.min(100, Number((spent * 100n) / limit)) : 0 } : null,
    left: w ? `${usdc(w.remainingMinor)} USDC left ${when}` : null,
    renews: w ? (w.rolledOver ? 'A new window starts with the next payment' : w.endsAtMs ? `Renews ${stamp(w.endsAtMs).slice(0, 10)} ${stamp(w.endsAtMs).slice(11, 16)} UTC` : null) : null,
    // A rule ends at the close of its last day: midnight UTC after it.
    ends: current?.expiresAtMs ? `Ends ${new Date(Number(current.expiresAtMs) - 1).toISOString().slice(0, 10)} (UTC)` : null,
    lifetime: current?.lifetimeCapMinor && current.lifetimeRemainingMinor ? `${usdc(current.lifetimeRemainingMinor)} of ${usdc(current.lifetimeCapMinor)} USDC left in all` : null,
    renewsIn: w && !w.rolledOver && w.endsAtMs && Number(w.endsAtMs) > now.getTime() ? `Renews in ${timeLeftWords(Number(w.endsAtMs) - now.getTime())}` : null,
    endsIn: current?.expiresAtMs && Number(current.expiresAtMs) > now.getTime() ? `Ends in ${timeLeftWords(Number(current.expiresAtMs) - now.getTime())}` : null,
    paidInAll: current ? `Paid since the rule was set: ${usdc(current.currentSpendMinor)} USDC` : null,
    orphaned,
  };
}

/** What GET /api/wallet/spending-rules answers, as the page reads it (names and user ids added by the route; near-threshold flags for owners only). */
export type SpendWire = {
  walletEpoch?: string;
  policy: (PolicyLike & { id?: string }) | null;
  rules: RuleLike[];
  unattached?: unknown[];
  stale?: unknown[];
  reissueNeeded: boolean;
  orphaned?: unknown[];
  nearThreshold?: unknown[];
};

export type MemberLike = { userId: string; name: string; role: string };
export type TeamRow = { userId: string; name: string; role: string; inCharge: boolean; canHaveRule: boolean; rule: RuleLineView | null };

/** The team: each person, their role, whether they are in charge, and the rule they hold. Staff and approvers may hold one; owners and viewers do not. */
export function teamRows(input: { members: MemberLike[]; personsInCharge: Array<{ userId: string }>; rules: RuleLike[] }, now: Date): TeamRow[] {
  const charged = new Set(input.personsInCharge.map((p) => p.userId));
  const ruleOf = new Map(input.rules.filter((r) => r.userId).map((r) => [r.userId as string, r]));
  return input.members.map((m) => {
    const r = ruleOf.get(m.userId);
    return { userId: m.userId, name: m.name, role: roleLabel(m.role), inCharge: charged.has(m.userId), canHaveRule: m.role === 'maker' || m.role === 'checker', rule: r ? ruleLine(r, now) : null };
  });
}

export type PolicyLike = { perPaymentMaxMinor: string; secondApprovalThresholdMinor: string; runningWindowMs: string; recipients: Array<{ address: string; tag: string }>; beneficiaries: Array<unknown> };

export function policyView(policy: PolicyLike | null): { perPayment: string; threshold: string; window: string; recipients: number; bankAccounts: number } | null {
  if (!policy) return null;
  return {
    perPayment: `${usdc(policy.perPaymentMaxMinor)} USDC`,
    threshold: `${usdc(policy.secondApprovalThresholdMinor)} USDC`,
    window: windowWords(BigInt(policy.runningWindowMs)),
    recipients: policy.recipients.length,
    bankAccounts: policy.beneficiaries.length,
  };
}

const norm = (a: string | null | undefined) => String(a ?? '').toLowerCase();

/**
 * The recipients staff may pay alone: those on the policy now (named when the
 * business saved them), and the saved ones that could be added. Only a
 * recipient the payment gate would pay is offered, tagged for what it is (a
 * wallet the supplier proved, or a confirmed exchange account); an address
 * already on the policy is not offered again, and another chain is never one.
 */
export function recipientOffers(policy: PolicyLike | null, saved: ClientRecipient[]): {
  allowed: Array<{ address: string; tag: string; name: string | null }>;
  offers: Array<{ id: string; name: string; address: string; tag: 'wallet' | 'exchange' }>;
} {
  const byAddress = new Map<string, ClientRecipient>();
  for (const r of saved) for (const a of [r.walletAddress, r.delivery?.destinationAddress]) if (a) byAddress.set(norm(a), r);
  const onPolicy = new Set((policy?.recipients ?? []).map((r) => norm(r.address)));
  const allowed = (policy?.recipients ?? []).map((r) => ({ address: r.address, tag: r.tag, name: byAddress.get(norm(r.address))?.name ?? null }));
  if (!policy) return { allowed, offers: [] };
  const offers: Array<{ id: string; name: string; address: string; tag: 'wallet' | 'exchange' }> = [];
  for (const r of saved) {
    const kind = kindOfRecipient(r);
    if (kind !== 'self_custody' && kind !== 'exchange') continue;
    const address = r.walletAddress ?? r.delivery?.destinationAddress ?? '';
    if (!address || onPolicy.has(norm(address)) || stateOf(r).step !== 'ready') continue;
    offers.push({ id: r.id, name: r.name, address, tag: kind === 'exchange' ? 'exchange' : 'wallet' });
  }
  return { allowed, offers };
}

export type HousekeepingId = 'reissue' | 'orphaned' | 'near_threshold' | 'stale';

/** What needs an owner's attention, in one place and in order. */
export function housekeeping(
  view: { reissueNeeded: boolean; orphaned?: unknown[]; nearThreshold?: unknown[]; stale?: unknown[]; unattached?: unknown[] },
  options: { alertsShown?: boolean } = {},
): Array<{ id: HousekeepingId; text: string }> {
  const out: Array<{ id: HousekeepingId; text: string }> = [];
  if (view.reissueNeeded) out.push({ id: 'reissue', text: 'The wallet’s signers changed, and some rules were not reissued under the new wallet. Until they are reissued they cannot pay.' });
  const orphaned = (view.orphaned?.length ?? 0) + (view.unattached?.length ?? 0);
  if (orphaned > 0) out.push({ id: 'orphaned', text: orphaned === 1 ? 'A rule belongs to someone who is no longer on the team. Take it back.' : `${orphaned} rules belong to people who are no longer on the team. Take them back.` });
  const near = view.nearThreshold?.length ?? 0;
  // The alert cards name each recipient; the line that counts them is for when the cards are not shown.
  if (near > 0 && !options.alertsShown) out.push({ id: 'near_threshold', text: near === 1 ? 'One recipient is near the amount that needs an owner’s approval. Review it with your owners.' : `${near} recipients are near the amount that needs an owner’s approval. Review them with your owners.` });
  const stale = view.stale?.length ?? 0;
  if (stale > 0) out.push({ id: 'stale', text: stale === 1 ? 'An allowance from an earlier wallet can no longer pay.' : `${stale} allowances from an earlier wallet can no longer pay.` });
  return out;
}
