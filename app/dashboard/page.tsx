import Link from 'next/link';
import { Layers, Send } from 'lucide-react';

import type { ProposalExplain, SimulationResult, UnsignedProposal } from '@/lib/agent/types';
import { getOxwalProposalStore } from '@/lib/agent/oxwal';
import { buildApprovalQueue, queueLanes, type QueueLane } from '@/lib/queue/approval-queue';
import ApprovalQueueBoard, { type QueueItem, type QueueLaneData } from '@/components/queue/ApprovalQueueBoard';
import DashPageHeader from '@/components/dashboard/DashPageHeader';
import { lockedCopy } from '@/content/claims';

export const dynamic = 'force-dynamic';

/**
 * Dashboard home — the Action Queue (suppliers-first IA).
 *
 * The queue is the operator's inbox: pending approvals, compliance holds,
 * expiring quotes, failed settlements, and anomaly halts. 0xWal prepares
 * proposals (from the dock on any page); approval always happens here.
 * A compact "today" strip (pipeline + corridor status, folded in from the
 * old Overview) sits above the lanes.
 */

const generatedAt = new Date();

type ProposalOverride = Partial<Omit<UnsignedProposal, 'explain' | 'simulation' | 'approvals'>> & {
  approvals?: UnsignedProposal['approvals'];
  explain?: Partial<ProposalExplain>;
  simulation?: Partial<SimulationResult>;
};

const baseExplain: ProposalExplain = {
  recommendation: 'Release verified supplier payout',
  financialImpact: {
    amountOut: BigInt(420000),
    currencyOut: 'USD',
    feeBps: 18,
  },
  evidence: [
    { source: 'COUNTERPARTY', ref: 'cp_acme_ph', observedAt: generatedAt.toISOString(), trusted: true },
    { source: 'PYTH_RATE', ref: 'pyth_usdc_usd', observedAt: generatedAt.toISOString(), trusted: true },
  ],
  confidence: 0.91,
  risk: 'LOW',
  requiredApprovers: 1,
  reasoningTraceRef: 'walrus_reasoning_pending',
};

const baseSimulation: SimulationResult = {
  ok: true,
  balanceChanges: [
    { owner: 'org_treasury', coinType: 'USD', amount: '-420000' },
    { owner: 'cp_acme_ph', coinType: 'USD', amount: '420000' },
  ],
  gasSponsored: true,
  simulatedAt: generatedAt.toISOString(),
};

function minutesFromNow(minutes: number) {
  return new Date(generatedAt.getTime() + minutes * 60 * 1000).toISOString();
}

function proposal(id: string, overrides: ProposalOverride = {}): UnsignedProposal {
  const explain = { ...baseExplain, ...overrides.explain };
  const simulation = { ...baseSimulation, ...overrides.simulation };
  return {
    id,
    idempotencyKey: `idem_${id}`,
    kind: 'PAYMENT',
    status: 'PENDING_APPROVAL',
    tier: 'TIER_0_PROPOSE',
    orgId: 'org_splash_demo',
    corridor: 'MY_PH',
    unsignedTxBytes: 'dW5zaWduZWQ=',
    createdBy: 'maker_ops_1',
    createdAt: new Date(generatedAt.getTime() - 18 * 60 * 1000).toISOString(),
    expiresAt: minutesFromNow(72),
    approvals: [],
    ...overrides,
    explain,
    simulation,
  };
}

const demoProposals: UnsignedProposal[] = [
  proposal('prop_dual_threshold', {
    explain: {
      recommendation: 'Approve dual-control supplier payout',
      financialImpact: { amountOut: BigInt(1250000), currencyOut: 'USD', feeBps: 14 },
      requiredApprovers: 2,
      risk: 'MEDIUM',
      confidence: 0.86,
    },
    approvals: [{ userId: 'approver_ops_1', role: 'APPROVER', signedAt: generatedAt.toISOString() }],
  }),
  proposal('prop_expiring_quote', {
    kind: 'FX_CONVERT',
    expiresAt: minutesFromNow(11),
    explain: {
      recommendation: 'Convert corridor float before quote expiry',
      financialImpact: { amountIn: BigInt(300000), amountOut: BigInt(299240), currencyIn: 'USD', currencyOut: 'USD', feeBps: 9 },
      requiredApprovers: 1,
      risk: 'LOW',
    },
  }),
  proposal('prop_compliance_hold', {
    explain: {
      recommendation: 'Hold payout pending compliance review',
      evidence: [
        { source: 'COMPLIANCE', ref: 'elliptic_review_case_48', observedAt: generatedAt.toISOString(), trusted: false },
      ],
      requiredApprovers: 1,
      risk: 'HIGH',
      confidence: 0.58,
    },
  }),
  proposal('prop_failed_relay', {
    status: 'FAILED',
    simulation: { ok: false, balanceChanges: [], error: 'settlement relay failed' },
    explain: {
      recommendation: 'Review failed settlement relay',
      risk: 'MEDIUM',
      confidence: 0.7,
    },
  }),
  proposal('prop_anomaly_halt', {
    status: 'FAILED',
    simulation: { ok: false, balanceChanges: [], error: 'anomaly velocity halt' },
    explain: {
      recommendation: 'Investigate outbound velocity halt',
      risk: 'HIGH',
      confidence: 0.49,
    },
  }),
];

const queueView = buildApprovalQueue(demoProposals, { now: generatedAt, expiringWithinMs: 20 * 60 * 1000 });

function formatAmount(proposal: UnsignedProposal) {
  const amount = proposal.explain.financialImpact.amountOut ?? proposal.explain.financialImpact.amountIn ?? BigInt(0);
  const currency = proposal.explain.financialImpact.currencyOut ?? proposal.explain.financialImpact.currencyIn ?? 'USD';
  return `${currency} ${amount.toLocaleString()}`;
}

function formatExpiry(expiresInMs: number | null) {
  if (expiresInMs === null) return 'No expiry';
  if (expiresInMs < 0) return 'Expired';
  const minutes = Math.ceil(expiresInMs / 60000);
  return `${minutes}m`;
}

const laneLabels: Record<QueueLane, string> = {
  PENDING_APPROVALS: 'Pending approvals',
  COMPLIANCE_HOLDS: 'Compliance holds',
  EXPIRING_QUOTES: 'Expiring quotes',
  FAILED_SETTLEMENTS: 'Failed settlements',
  ANOMALY_HALTS: 'Anomaly halts',
};

// Compact "today" strip — folded in from the old Overview page.
const PIPELINE = [
  { label: 'Authorized', count: 8, amount: '$4,540', dot: 'bg-[#E39774]' },
  { label: 'On the way', count: 5, amount: '$2,960', dot: 'bg-[#5C9EAD]' },
  { label: 'Settled today', count: 19, amount: '$14,640', dot: 'bg-emerald-500' },
];

export default async function DashboardHomePage() {
  // Live proposals 0xWal drafted this session (in-memory store). Anything the
  // operator did not approve inside the 2-minute chat window — or walked away
  // from — surfaces here as real maker-checker work.
  const liveProposals: QueueItem[] = getOxwalProposalStore()
    .list()
    .filter((item) => item.status === 'SIMULATED' || item.status === 'POLICY_EVALUATED' || item.status === 'PENDING_APPROVAL')
    .map((item) => ({
      id: item.id,
      recommendation: item.explain.recommendation,
      kind: item.kind,
      maker: item.createdBy,
      amountLabel: formatAmount(item),
      approvalsCollected: new Set(item.approvals.map((approval) => approval.userId)).size,
      requiredApprovers: item.explain.requiredApprovers,
      risk: item.explain.risk,
      expiryLabel: 'From 0xWal chat',
    }));

  // Serialize the queue for the interactive client board (no bigint/Date over
  // the boundary). Approve/Reject state lives client-side for the demo.
  const pending: QueueItem[] = [
    ...liveProposals,
    ...queueView.lanes.PENDING_APPROVALS.map((item) => ({
      id: item.proposal.id,
      recommendation: item.proposal.explain.recommendation,
      kind: item.proposal.kind,
      maker: item.proposal.createdBy,
      amountLabel: formatAmount(item.proposal),
      approvalsCollected: item.approvalsCollected,
      requiredApprovers: item.requiredApprovers,
      risk: item.proposal.explain.risk,
      expiryLabel: formatExpiry(item.expiresInMs),
    })),
  ];

  const otherLanes: QueueLaneData[] = queueLanes
    .filter((lane) => lane !== 'PENDING_APPROVALS')
    .map((lane) => ({
      key: lane,
      label: laneLabels[lane],
      items: queueView.lanes[lane].map((item) => ({
        id: item.proposal.id,
        recommendation: item.proposal.explain.recommendation,
        kind: item.proposal.kind,
        maker: item.proposal.createdBy,
        amountLabel: formatAmount(item.proposal),
        approvalsCollected: item.approvalsCollected,
        requiredApprovers: item.requiredApprovers,
        risk: item.proposal.explain.risk,
        expiryLabel: formatExpiry(item.expiresInMs),
        reason: item.reasons[0],
      })),
    }));

  return (
    <div className="space-y-5">
      <DashPageHeader
        kicker="0xWal control room"
        title="Approval queue"
        description={lockedCopy.agent}
        actions={
          <>
            <Link href="/dashboard/payments/new" className="dash-btn">
              <Send size={14} />
              New Transfer
            </Link>
            <Link href="/dashboard/payments/runs" className="dash-btn dash-btn-ghost">
              <Layers size={14} />
              Batch Payout
            </Link>
          </>
        }
      />

      {/* Today strip: settlement pipeline + corridor status */}
      <div className="dash-surface p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-bold text-[#1F4452]">Settlement Pipeline</h2>
          <span className="rounded-full bg-[#326273]/8 px-2.5 py-1 text-[11px] font-semibold text-[#326273]/60">
            Next window: 16:30 MYT · 13 transfers · $7,510
          </span>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {PIPELINE.map((item) => (
            <div key={item.label} className="rounded-xl bg-[#F6F0ED] p-3">
              <div className="flex items-center gap-1.5">
                <span className={`h-2 w-2 rounded-full ${item.dot}`} />
                <span className="text-[11px] text-[#326273]/60">{item.label}</span>
              </div>
              <div className="mt-2 text-2xl font-extrabold text-[#1F4452]">{item.count}</div>
              <div className="mt-0.5 text-xs font-semibold text-[#5C9EAD]">{item.amount}</div>
            </div>
          ))}
          <div className="rounded-xl bg-[#F6F0ED] p-3">
            <div className="flex items-center gap-1.5">
              <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" />
              <span className="text-[11px] text-[#326273]/60">Corridor Coverage</span>
            </div>
            <div className="mt-2 text-lg font-extrabold text-[#1F4452]">USD → PHP</div>
            <div className="mt-0.5 text-[11px] font-semibold text-[#326273]/55">1 live-model · 8 implemented in code</div>
          </div>
        </div>
      </div>

      <ApprovalQueueBoard pending={pending} otherLanes={otherLanes} />
    </div>
  );
}
