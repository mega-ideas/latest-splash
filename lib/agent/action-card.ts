import type { DataStatus, EvidenceItem, EvidenceQuality, ProposalFxRate, ProposalKind, ProposalStatus, RiskBand, SimulationResult, UserRole } from './types';

type AmountLike = bigint | number | string | undefined;

export type ClientFinancialImpact = {
  amountIn?: AmountLike;
  amountOut?: AmountLike;
  currencyIn?: string;
  currencyOut?: string;
  feeBps?: number;
  fxRate?: ProposalFxRate;
  yieldDeltaBps?: number;
  nettingSaved?: AmountLike;
};

export type ActionCardProposal = {
  id: string;
  kind: ProposalKind;
  status: ProposalStatus;
  tier: string;
  orgId: string;
  corridor?: string;
  unsignedTxBytes: string;
  /** AGENT_ACTOR_ID (lib/agent/identity.ts) or a human userId. */
  createdBy: 'OXWAL' | string;
  createdAt: string;
  expiresAt: string;
  version?: number;
  approvalHash?: string;
  approvals: { userId: string; role: UserRole; signedAt: string }[];
  simulation?: SimulationResult;
  explain: {
    recommendation: string;
    financialImpact: ClientFinancialImpact;
    evidence: EvidenceItem[];
    confidence: number;
    risk: RiskBand;
    requiredApprovers: number;
    reasoningTraceRef: string;
    evidenceQuality?: EvidenceQuality;
  };
};

export type ActionCardRow = {
  label: string;
  value: string;
  status: 'ok' | 'warning' | 'empty';
};

export type ActionCardEvidence = EvidenceItem & {
  label: string;
  trustLabel: 'Trusted' | 'Untrusted';
  tone: 'trusted' | 'untrusted';
  /** WS2 truth chip: LIVE renders default; STALE/MODELED/DEMO use caution. */
  statusLabel: DataStatus;
  statusTone: 'live' | 'caution';
};

export type ActionCardModel = {
  impactRows: ActionCardRow[];
  simulationRows: ActionCardRow[];
  evidenceRows: ActionCardEvidence[];
  confidencePercent: number;
  riskTone: 'low' | 'medium' | 'high';
  approverText: string;
  primaryActionLabel: 'Sign & approve' | 'Send for approval';
  hasUntrustedEvidence: boolean;
  /** WS2 — true when any evidence item is not LIVE (judge-facing honesty). */
  containsDemoData: boolean;
};

function parseAmount(value: AmountLike): number | null {
  if (value === undefined) return null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function money(value: AmountLike, currency = 'USD') {
  const parsed = parseAmount(value);
  if (parsed === null) return '-';
  const units = Math.abs(parsed) >= 10_000 ? parsed / 1_000_000 : parsed;
  return `${currency} ${new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(units)}`;
}

function bps(value?: number) {
  return typeof value === 'number' ? `${(value / 100).toFixed(2)}%` : '-';
}

function row(label: string, value: string): ActionCardRow {
  return { label, value, status: value === '-' ? 'empty' : 'ok' };
}

/**
 * Where a proposal's rate came from, in words. Legacy rows carry a
 * `pythPriceId` but their rate came from the corridor table as well; the card
 * used to say "via Pyth" for every one of them.
 */
function fxSourceLabel(fxRate: ProposalFxRate): string {
  const ref = 'quoteRef' in fxRate ? fxRate.quoteRef : 'corridor:';
  if (ref.startsWith('corridor:')) return 'corridor reference rate';
  if (ref.startsWith('par:')) return 'at par';
  return ref;
}

export function buildActionCardModel(proposal: ActionCardProposal): ActionCardModel {
  const impact = proposal.explain.financialImpact;
  const requiredApprovers = Math.max(0, proposal.explain.requiredApprovers);
  const approvalsCollected = new Set(proposal.approvals.map((approval) => approval.userId)).size;
  const confidencePercent = Math.max(0, Math.min(100, Math.round(proposal.explain.confidence * 100)));
  const evidenceRows = proposal.explain.evidence.map((item) => {
    const statusLabel: DataStatus = item.status ?? 'DEMO';
    return {
      ...item,
      label: `${item.source}:${item.ref}`,
      trustLabel: item.trusted ? 'Trusted' as const : 'Untrusted' as const,
      tone: item.trusted ? 'trusted' as const : 'untrusted' as const,
      statusLabel,
      statusTone: statusLabel === 'LIVE' ? 'live' as const : 'caution' as const,
    };
  });

  const pendingApprovals = Math.max(0, requiredApprovers - approvalsCollected);
  const primaryActionLabel = pendingApprovals > 0
    ? 'Sign & approve'
    : 'Send for approval';

  return {
    impactRows: [
      row('Amount in', money(impact.amountIn, impact.currencyIn)),
      row('Amount out', money(impact.amountOut, impact.currencyOut)),
      row('Fee', bps(impact.feeBps)),
      row('FX', impact.fxRate ? `${impact.fxRate.value} (${fxSourceLabel(impact.fxRate)})` : '-'),
      row('Yield delta', bps(impact.yieldDeltaBps)),
      row('Netting saved', money(impact.nettingSaved, impact.currencyIn ?? impact.currencyOut ?? 'USD')),
    ],
    simulationRows: proposal.simulation
      ? [
          {
            label: 'Dry-run',
            value: proposal.simulation.ok ? 'Matched' : proposal.simulation.error ?? 'Failed',
            status: proposal.simulation.ok ? 'ok' : 'warning',
          },
          {
            label: 'Gas',
            value: proposal.simulation.gasSponsored ? 'Sponsored' : 'Not sponsored',
            status: proposal.simulation.gasSponsored ? 'ok' : 'warning',
          },
          ...proposal.simulation.balanceChanges.map((change) => ({
            label: `${change.owner} ${change.coinType}`,
            value: change.amount,
            status: 'ok' as const,
          })),
        ]
      : [{ label: 'Dry-run', value: 'Pending', status: 'warning' }],
    evidenceRows,
    confidencePercent,
    riskTone: proposal.explain.risk.toLowerCase() as ActionCardModel['riskTone'],
    approverText: `${approvalsCollected}/${requiredApprovers}`,
    primaryActionLabel,
    hasUntrustedEvidence: evidenceRows.some((item) => !item.trusted),
    containsDemoData: proposal.explain.evidenceQuality
      ? proposal.explain.evidenceQuality === 'CONTAINS_DEMO_DATA'
      : evidenceRows.some((item) => item.statusLabel !== 'LIVE'),
  };
}
