/**
 * The spending-rules summary on the Wallet page (v2 brief 5.5), read from
 * GET /api/wallet/spending-rules (lib/server/spend-rules-index.ts), which
 * already shows what the chain applies: windows rolled forward, remaining
 * amounts, who holds each rule. Pure and client-safe. Rules are given,
 * changed and taken back in Settings, never here.
 */
import { formatUsdc } from '../fees/copy.ts';
import type { Tone } from './labels.ts';

type AllowanceLike = { current: boolean; state: string; window: { period: string; limitMinor: string; spentMinor: string; remainingMinor: string } | null };
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
    const current = r.allowances.find((a) => a.current && a.state === 'active') ?? r.allowances.find((a) => a.current);
    const w = current?.window ?? null;
    const when = w?.period === 'day' ? 'today' : w?.period === 'month' ? 'this month' : 'in the current window';
    return {
      name: r.name ?? 'A staff member',
      perPayment: usdc(r.perPaymentMaxMinor),
      state: s.state,
      tone: s.tone,
      window: w ? `${formatUsdc(BigInt(w.spentMinor))} of ${usdc(w.limitMinor)} used ${when}` : null,
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
