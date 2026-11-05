/**
 * The spending-rules summary on the Wallet page (v2 brief 5.5), read from
 * GET /api/wallet/spending-rules (lib/server/spend-rules-index.ts), which
 * already shows what the chain applies: windows rolled forward, remaining
 * amounts, who holds each rule. Pure and client-safe. Rules are given,
 * changed and taken back in Settings, never here.
 */
import { formatUsdc } from '../fees/copy.ts';
import { ruleTerms, type AllowanceLike } from '../team-rules/terms.ts';
import type { Tone } from './labels.ts';

type RuleLike = { name?: string | null; status: string; perPaymentMaxMinor: string; allowances: AllowanceLike[] };
export type SpendViewFacts = {
  policy: { secondApprovalThresholdMinor: string } | null;
  reissueNeeded: boolean;
  orphaned?: string[];
  nearThreshold?: unknown[];
  rules: RuleLike[];
};

const usdc = (minor: string) => `${formatUsdc(BigInt(minor))} USDC`;

const STATES: Record<string, { state: string; tone: Tone }> = {
  active: { state: 'Active', tone: 'ok' },
  not_started: { state: 'Starts later', tone: 'wait' },
  expired: { state: 'Expired', tone: 'bad' },
  no_allowance: { state: 'No allowance', tone: 'bad' },
};

export type RuleLine = { name: string; perPayment: string; state: string; tone: Tone; window: string | null };

export function rulesSummary(view: SpendViewFacts, viewer: { owner: boolean }) {
  const rules: RuleLine[] = view.rules.map((r) => {
    const s = STATES[r.status] ?? { state: 'Unknown', tone: 'wait' as Tone };
    // A rule is read as a whole: a change made after spending leaves a short bridge for today that is not the rule.
    const t = ruleTerms(r.allowances);
    const used = r.status === 'active' && t?.usedUp;
    // A rule whose lifetime total is spent pays nothing, whatever its window has left.
    const w = used ? null : t?.window ?? null;
    const when = w?.period === 'day' ? 'today' : w?.period === 'month' ? 'this month' : 'in the current window';
    return {
      name: r.name ?? 'A staff member',
      perPayment: usdc(r.perPaymentMaxMinor),
      state: used ? 'Used up' : s.state,
      tone: used ? ('wait' as Tone) : s.tone,
      window: w ? (t?.bridged ? `${usdc(w.remainingMinor)} left ${when}` : `${formatUsdc(BigInt(w.spentMinor))} of ${usdc(w.limitMinor)} used ${when}`) : null,
    };
  });
  return {
    threshold: view.policy ? usdc(view.policy.secondApprovalThresholdMinor) : null,
    active: view.rules.filter((r) => r.status === 'active').length,
    rules,
    reissueNeeded: view.reissueNeeded,
    orphaned: view.orphaned?.length ?? 0,
    // Who paid whom is the owners' to see.
    nearThreshold: viewer.owner ? view.nearThreshold?.length ?? 0 : 0,
  };
}
