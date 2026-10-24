/**
 * What each spending rule looks like now, from the chain (v2 §4.2).
 *
 * Allowances emit no events. A business's rules are indexed from:
 *
 *   - the `AllowanceCap`s its wallet owns (sent to the funder when an
 *     allowance is issued, destroyed with it by `revoke`), which point to the
 *     shared `Allowance`s: funder, spender, app, name, caps, expiry and
 *     `current_spend`;
 *   - its `SpendPolicy` for the current wallet generation: the spenders with
 *     their own per-payment maximum, the verified recipients and
 *     beneficiaries, the limits, the running-total window, and the running
 *     totals per (payer, recipient) toward the second-approval threshold;
 *   - `splash_spend::RuleSpend` events (one per payment under a rule: intent,
 *     allowance, approval, recipient, kind charged, fee).
 *
 * An allowance belongs to the current policy when it is bound to Splash's
 * SPLASH_SPEND app, its funder is the current wallet and its name is that
 * policy's `allowance_name`; only such an allowance can pay (pay_intent checks
 * the same). One funded by an earlier wallet, or named for an earlier
 * generation's policy, is STALE: after a rotation it can no longer pay, and
 * the rules it carried must be reissued under the new wallet's policy.
 *
 * Every limit shown is what the chain will apply: the rate-limit window is
 * rolled forward as the next charge would (lib/wallet/allowance-window.ts),
 * so a day or month that has passed shows its full cap again, and the running
 * totals count what `spend_policy::threshold_total` counts.
 *
 * Pure: the caller reads the chain. Amounts are minor units of USDC, as
 * decimal strings; times are Unix milliseconds, as decimal strings.
 */
import { normalizeSuiAddress } from '@mysten/sui/utils';

import { liveRateLimit, thresholdCounted } from '../wallet/allowance-window.ts';
import { allowanceNameFor, type AllowanceState, type RuleSpendEvent, type RunningEntry, type SpendPolicyHead } from '../wallet/spend-rules-bcs.ts';

/** A policy with its tables read. */
export type PolicyState = SpendPolicyHead & {
  initialSharedVersion: string;
  spenders: Array<{ spender: string; role: number; perPaymentMax: bigint }>;
  recipients: Array<{ domain: number; address: string; kind: number }>;
  beneficiaries: Array<{ commitment: string; partnerDeposit: string }>;
  runningTotals: RunningEntry[];
};

/** An allowance with the cap the wallet holds for it. */
export type HeldAllowance = AllowanceState & { initialSharedVersion: string; cap: { objectId: string; version: string; digest: string } };

export type AllowanceView = {
  allowanceId: string;
  capId: string;
  name: string;
  funder: string;
  spender: string | null;
  /** Bound to the current policy, funded by the current wallet: it can pay. */
  current: boolean;
  state: 'active' | 'not_started' | 'expired';
  startsAtMs: string | null;
  expiresAtMs: string | null;
  /** Everything charged under it so far (`current_spend`): principal plus each payment's fee bound. */
  currentSpendMinor: string;
  lifetimeCapMinor: string | null;
  lifetimeRemainingMinor: string | null;
  window: {
    period: 'day' | 'month' | 'other';
    limitMinor: string;
    /** Spent in the window that is current now (zero once it has rolled over). */
    spentMinor: string;
    remainingMinor: string;
    startsAtMs: string | null;
    endsAtMs: string | null;
    /** The stored window has passed; the next charge starts a new one. */
    rolledOver: boolean;
  } | null;
  /** What one more charge could draw now: the window's and the lifetime's remaining, 0 unless active. */
  spendableNowMinor: string;
};

export type RunningTotalView = {
  /** The recipient address, or for a bank payout the beneficiary commitment (hex). */
  recipient: string | null;
  beneficiary: string | null;
  windowStartMs: string;
  windowEndMs: string;
  /** Paid in this window. */
  totalMinor: string;
  /** What the second-approval check counts now (this window, and what it still carries). */
  countedMinor: string;
  countsUntilMs: string;
  /** How much more this payer can pay this recipient before an owner must approve. */
  beforeApprovalMinor: string;
  /** At or above 80% of the threshold. */
  nearThreshold: boolean;
};

export type RuleView = {
  spender: string;
  role: 'staff' | 'executor';
  perPaymentMaxMinor: string;
  status: 'active' | 'not_started' | 'expired' | 'no_allowance';
  allowances: AllowanceView[];
  runningTotals: RunningTotalView[];
  recentSpends: Array<{ intentId: string; allowanceId: string; approvalId: string | null; recipient: string; derivedKind: number; feeMinor: string }>;
};

export type SpendView = {
  walletEpoch: string;
  wallet: string | null;
  policy: {
    id: string;
    perPaymentMaxMinor: string;
    secondApprovalThresholdMinor: string;
    runningWindowMs: string;
    generation: string;
    recipients: Array<{ address: string; tag: 'wallet' | 'exchange' }>;
    beneficiaries: Array<{ commitment: string; partnerDeposit: string }>;
  } | null;
  rules: RuleView[];
  /** Allowances of the current wallet and policy whose spender is no longer on the policy: they cannot pay; revoke them. */
  unattached: AllowanceView[];
  /** Allowances from an earlier wallet or policy generation: they cannot pay. */
  stale: AllowanceView[];
  /** An earlier generation's policy had rules this one does not: reissue after the rotation. */
  reissueNeeded: boolean;
};

const s = (v: bigint) => v.toString();
const min = (a: bigint, b: bigint) => (a < b ? a : b);
export const DAY_MS = 86_400_000n;

function allowanceView(a: HeldAllowance, now: bigint, current: boolean): AllowanceView {
  const state: AllowanceView['state'] =
    a.startMs !== null && now < a.startMs ? 'not_started' : a.expiresAtMs !== null && now >= a.expiresAtMs ? 'expired' : 'active';
  const lifetimeRemaining = a.lifetimeCap === null ? null : a.lifetimeCap > a.currentSpend ? a.lifetimeCap - a.currentSpend : 0n;
  let window: AllowanceView['window'] = null;
  let spendable: bigint | null = lifetimeRemaining;
  if (a.rateLimit) {
    const live = liveRateLimit(a.rateLimit, now);
    const w = a.rateLimit.window;
    const period = w.kind === 'periodic' && w.periodMs === DAY_MS ? 'day' : w.kind === 'calendar' && w.months === 1 ? 'month' : 'other';
    window = {
      period,
      limitMinor: s(live.limitMinor),
      spentMinor: s(live.spentMinor),
      remainingMinor: s(live.remainingMinor),
      startsAtMs: live.startsAtMs === null ? null : s(live.startsAtMs),
      endsAtMs: live.endsAtMs === null ? null : s(live.endsAtMs),
      rolledOver: live.rolledOver,
    };
    spendable = spendable === null ? live.remainingMinor : min(spendable, live.remainingMinor);
  }
  return {
    allowanceId: a.id,
    capId: normalizeSuiAddress(a.cap.objectId),
    name: a.name,
    funder: a.funder,
    spender: a.spender,
    current,
    state,
    startsAtMs: a.startMs === null ? null : s(a.startMs),
    expiresAtMs: a.expiresAtMs === null ? null : s(a.expiresAtMs),
    currentSpendMinor: s(a.currentSpend),
    lifetimeCapMinor: a.lifetimeCap === null ? null : s(a.lifetimeCap),
    lifetimeRemainingMinor: lifetimeRemaining === null ? null : s(lifetimeRemaining),
    window,
    spendableNowMinor: state === 'active' ? s(spendable ?? 0n) : '0',
  };
}

/** Does this allowance pay under this policy, from this wallet? The checks pay_intent makes. */
export function boundTo(a: AllowanceState, policy: { id: string; wallet: string }, appName: string): boolean {
  return a.app === appName && a.funder === normalizeSuiAddress(policy.wallet) && a.name === allowanceNameFor(policy.id);
}

export function buildSpendView(input: {
  now: bigint;
  wallet: string | null;
  walletEpoch: bigint;
  /** The policy of the current wallet generation, if created. */
  policy: PolicyState | null;
  /** Policies of earlier generations that still exist. */
  earlierPolicies: PolicyState[];
  /** Every Splash allowance a wallet of this business (current or earlier) holds a cap for. */
  allowances: HeldAllowance[];
  /** RuleSpend events, newest first. */
  spends: RuleSpendEvent[];
  /** The SPLASH_SPEND type name as the chain records it. */
  appName: string;
}): SpendView {
  const { now, policy } = input;
  const ours = input.allowances.filter((a) => a.app === input.appName);
  const current = policy && input.wallet && policy.wallet === normalizeSuiAddress(input.wallet) ? policy : null;
  const bound = current ? ours.filter((a) => boundTo(a, current, input.appName)) : [];
  const boundIds = new Set(bound.map((a) => a.id));
  const stale = ours.filter((a) => !boundIds.has(a.id)).map((a) => allowanceView(a, now, false));

  const rules: RuleView[] = [];
  const unattached: AllowanceView[] = [];
  if (current) {
    const threshold = current.secondApprovalThreshold;
    for (const sp of current.spenders) {
      const mine = bound.filter((a) => a.spender === sp.spender).map((a) => allowanceView(a, now, true));
      const status: RuleView['status'] =
        mine.length === 0 ? 'no_allowance' : mine.some((a) => a.state === 'active') ? 'active' : mine.some((a) => a.state === 'not_started') ? 'not_started' : 'expired';
      const runningTotals = current.runningTotals
        .filter((e) => e.payer === sp.spender)
        .map((e) => {
          const { countedMinor, countsUntilMs } = thresholdCounted(e, now);
          const bank = e.beneficiary.length > 0;
          return {
            recipient: bank ? null : e.recipient,
            beneficiary: bank ? e.beneficiary : null,
            windowStartMs: s(e.windowStartMs),
            windowEndMs: s(e.windowEndMs),
            totalMinor: now < e.windowEndMs ? s(e.total) : '0',
            countedMinor: s(countedMinor),
            countsUntilMs: s(countsUntilMs),
            beforeApprovalMinor: s(countedMinor >= threshold ? 0n : threshold - countedMinor),
            nearThreshold: threshold > 0n && countedMinor * 100n >= threshold * 80n,
          };
        })
        .filter((t) => t.countedMinor !== '0' || t.totalMinor !== '0');
      const recentSpends = input.spends
        .filter((e) => e.policyId === current.id && e.spender === sp.spender)
        .map((e) => ({ intentId: e.intentId, allowanceId: e.allowanceId, approvalId: e.approvalId, recipient: e.recipient, derivedKind: e.derivedKind, feeMinor: s(e.fee) }));
      rules.push({
        spender: sp.spender,
        role: sp.role === 2 ? 'executor' : 'staff',
        perPaymentMaxMinor: s(sp.perPaymentMax),
        status,
        allowances: mine,
        runningTotals,
        recentSpends,
      });
    }
    const onPolicy = new Set(current.spenders.map((x) => x.spender));
    for (const a of bound) if (!a.spender || !onPolicy.has(a.spender)) unattached.push(allowanceView(a, now, true));
  }

  const carried = new Set(current ? current.spenders.map((x) => x.spender) : []);
  const reissueNeeded = input.earlierPolicies.some((p) => p.spenders.some((x) => !carried.has(x.spender)));
  return {
    walletEpoch: s(input.walletEpoch),
    wallet: input.wallet ? normalizeSuiAddress(input.wallet) : null,
    policy: current
      ? {
          id: current.id,
          perPaymentMaxMinor: s(current.perPaymentMax),
          secondApprovalThresholdMinor: s(current.secondApprovalThreshold),
          runningWindowMs: s(current.runningWindowMs),
          generation: s(current.generation),
          recipients: current.recipients.map((r) => ({ address: r.address, tag: r.kind === 1 ? ('wallet' as const) : ('exchange' as const) })),
          beneficiaries: current.beneficiaries,
        }
      : null,
    rules,
    unattached,
    stale,
    reissueNeeded,
  };
}
