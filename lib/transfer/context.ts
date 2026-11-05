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

import type { InFlight, PolicyFacts, StaffRuleFacts } from './plan.ts';

type RuleLike = {
  spender: string;
  status: string;
  perPaymentMaxMinor: string;
  allowances: Array<{
    current: boolean;
    state: string;
    spendableNowMinor: string;
    startsAtMs?: string | null;
    expiresAtMs?: string | null;
    lifetimeRemainingMinor?: string | null;
    window?: { endsAtMs?: string | null } | null;
  }>;
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

export function staffFactsFrom(view: SpendViewLike | null, myAddresses: string[]): { rule: StaffRuleFacts | null; policy: PolicyFacts | null; runningTotals: Record<string, string>; spender: string | null } {
  if (!view) return { rule: null, policy: null, runningTotals: {}, spender: null };
  const mine = new Set(myAddresses.map(norm).filter((a): a is string => Boolean(a)));
  const policy: PolicyFacts | null = view.policy
    ? { secondApprovalThresholdMinor: view.policy.secondApprovalThresholdMinor, recipients: view.policy.recipients.map((r) => ({ address: r.address, tag: r.tag })) }
    : null;
  const own = view.rules.find((r) => {
    const s = norm(r.spender);
    return s !== null && mine.has(s);
  });
  if (!own) return { rule: null, policy, runningTotals: {}, spender: null };
  const usable = own.allowances.filter((a) => a.current && a.state === 'active');
  // The allowance with the most room is the one a payment draws on: its dates are the rule's dates.
  const best = usable.reduce<(typeof usable)[number] | null>((top, a) => (top === null || BigInt(a.spendableNowMinor) > BigInt(top.spendableNowMinor) ? a : top), null);
  const spendable = best ? BigInt(best.spendableNowMinor) : 0n;
  // The second-approval amount is the recipient's: what every spender has paid it in the window counts together,
  // because the chain keeps the total per payer and several people each under it can together pass it.
  const sums = new Map<string, bigint>();
  for (const rule of view.rules) {
    for (const t of rule.runningTotals) {
      const r = t.recipient ? norm(t.recipient) : null;
      if (r) sums.set(r, (sums.get(r) ?? 0n) + BigInt(t.countedMinor));
    }
  }
  const runningTotals: Record<string, string> = {};
  for (const [r, total] of sums) runningTotals[r] = total.toString();
  return {
    spender: norm(own.spender),
    rule: {
      // With no allowance that can pay now, say why: ended, not begun, or taken back (nothing left to pay under).
      status: best ? own.status : own.status === 'expired' || own.status === 'not_started' ? own.status : 'no_allowance',
      perPaymentMaxMinor: own.perPaymentMaxMinor,
      spendableNowMinor: spendable.toString(),
      startsAtMs: best?.startsAtMs ?? null,
      expiresAtMs: best?.expiresAtMs ?? null,
      // A lifetime cap that is spent never renews, whatever its window says.
      renewsAtMs: best && best.lifetimeRemainingMinor !== '0' ? (best.window?.endsAtMs ?? null) : null,
    },
    policy,
    runningTotals,
  };
}

/** What is already on its way for the caller, as the context route sends it. */
export type InFlightWire = { spenderMinor: string; openCount: number; byRecipient: Record<string, string> };

/** The payments on their way, as the plan counts them for one recipient: the caller's own total and open payments, and everyone's towards that recipient. */
export function inFlightForPayee(wire: InFlightWire | undefined | null, address: string | null): InFlight {
  if (!wire) return { spenderMinor: 0n, recipientMinor: 0n, openCount: 0 };
  const key = address ? norm(address) : null;
  return {
    spenderMinor: BigInt(wire.spenderMinor),
    recipientMinor: key && wire.byRecipient[key] ? BigInt(wire.byRecipient[key]) : 0n,
    openCount: wire.openCount,
  };
}

/**
 * Whether this server can carry out a payment under the caller's rule: the policy exists, a gas sponsor pays the
 * network fee, and the passkey the rule belongs to is one the person can sign with on this site (not just any
 * passkey of theirs).
 */
export function paysAlone(input: { hasPolicy: boolean; sponsored: boolean; spender: string | null; members: Array<{ address: string; canSign: boolean }> }): boolean {
  if (!input.hasPolicy || !input.sponsored || !input.spender) return false;
  const spender = norm(input.spender);
  return spender !== null && input.members.some((m) => m.canSign && norm(m.address) === spender);
}
