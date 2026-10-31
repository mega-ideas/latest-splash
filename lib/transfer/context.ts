/**
 * What Transfer needs to know about the caller's spending rule, taken from
 * the rules index (`GET /api/wallet/spending-rules`, lib/server/
 * spend-rules-index.ts) and turned into the facts lib/transfer/plan.ts plans
 * with. Pure and client-safe.
 *
 * The caller's rule is the one whose spender is one of their own passkey
 * addresses. Its `spendableNowMinor` is the most one more charge could draw
 * now across its current allowances; a rule with no active current allowance
 * is not active. The running total towards a recipient is what the
 * second-approval check counts now (`countedMinor`).
 */
import { normalizeSuiAddress } from '@mysten/sui/utils';

import type { PolicyFacts, StaffRuleFacts } from './plan.ts';

type RuleLike = {
  spender: string;
  status: string;
  perPaymentMaxMinor: string;
  allowances: Array<{ current: boolean; state: string; spendableNowMinor: string }>;
  runningTotals: Array<{ recipient: string | null; countedMinor: string }>;
};

export type SpendViewLike = {
  policy: { secondApprovalThresholdMinor: string; recipients: Array<{ address: string; tag?: string }> } | null;
  rules: RuleLike[];
};

const norm = (a: string): string | null => {
  try {
    return normalizeSuiAddress(a);
  } catch {
    return null;
  }
};

export function staffFactsFrom(view: SpendViewLike | null, myAddresses: string[]): { rule: StaffRuleFacts | null; policy: PolicyFacts | null; runningTotals: Record<string, string> } {
  if (!view) return { rule: null, policy: null, runningTotals: {} };
  const mine = new Set(myAddresses.map(norm).filter((a): a is string => Boolean(a)));
  const policy: PolicyFacts | null = view.policy
    ? { secondApprovalThresholdMinor: view.policy.secondApprovalThresholdMinor, recipients: view.policy.recipients.map((r) => ({ address: r.address, tag: r.tag })) }
    : null;
  const own = view.rules.find((r) => {
    const s = norm(r.spender);
    return s !== null && mine.has(s);
  });
  if (!own) return { rule: null, policy, runningTotals: {} };
  const usable = own.allowances.filter((a) => a.current && a.state === 'active').map((a) => BigInt(a.spendableNowMinor));
  const spendable = usable.length ? usable.reduce((a, b) => (b > a ? b : a)) : 0n;
  const runningTotals: Record<string, string> = {};
  for (const t of own.runningTotals) {
    const r = t.recipient ? norm(t.recipient) : null;
    if (r) runningTotals[r] = t.countedMinor;
  }
  return {
    rule: { status: usable.length ? own.status : 'no_allowance', perPaymentMaxMinor: own.perPaymentMaxMinor, spendableNowMinor: spendable.toString() },
    policy,
    runningTotals,
  };
}
