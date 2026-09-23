import Image from 'next/image';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import type { ProposalExplain, SimulationResult, UnsignedProposal } from '@/lib/agent/types';
import { getOxwalProposalStore } from '@/lib/agent/oxwal';
import { ensureProposalStoreHydrated } from '@/lib/queue/proposal-persistence';
import { buildApprovalQueue, queueLanes, type QueueLane } from '@/lib/queue/approval-queue';
import { getCustomerSession } from '@/lib/server/customer-auth';
import ApprovalQueueBoard, { type QueueItem, type QueueLaneData } from '@/components/queue/ApprovalQueueBoard';

export const dynamic = 'force-dynamic';

const generatedAt = new Date();

type ProposalOverride = Partial<Omit<UnsignedProposal, 'explain' | 'simulation' | 'approvals'>> & {
  approvals?: UnsignedProposal['approvals'];
  explain?: Partial<ProposalExplain>;
  simulation?: Partial<SimulationResult>;
};

const baseExplain: ProposalExplain = {
  recommendation: 'Release verified supplier payout',
  financialImpact: {
    amountOut: BigInt(420_000_000_000),
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
      // Micro units, like a real proposal. These were display-scale, which is
      // what hid the formatting bug above.
      financialImpact: { amountOut: BigInt(1_250_000_000_000), currencyOut: 'USD', feeBps: 14 },
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
      financialImpact: { amountIn: BigInt(300_000_000_000), amountOut: BigInt(299_240_000_000), currencyIn: 'USD', currencyOut: 'USD', feeBps: 9 },
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

/**
 * `financialImpact` amounts are MICRO units — `lib/agent/oxwal.ts` builds
 * every one of them through `usdMicro`/`toMicro`.
 *
 * This rendered the raw bigint, so a real proposal showed a figure a million
 * times too large: a 15,000 USD payment read as 15,000,000,000 on the one
 * screen whose entire job is to be read before money is released.
 *
 * It went unnoticed because the seeded rows below were hand-written at
 * display scale rather than micro, so the only proposals this page had ever
 * shown were the ones that happened to look right.
 */
const MICRO = BigInt(1_000_000);

function formatAmount(proposal: UnsignedProposal) {
  const impact = proposal.explain.financialImpact;
  // Pair the amount with ITS OWN currency. `amountOut` with `currencyIn` (or
  // the reverse) is how a PHP figure gets labelled USD.
  const [amountMicro, currency] = impact.amountOut !== undefined
    ? [impact.amountOut, impact.currencyOut ?? impact.currencyIn ?? 'USD']
    : [impact.amountIn ?? BigInt(0), impact.currencyIn ?? 'USD'];

  // Integer arithmetic to the last two places, then format. Dividing a
  // bigint through Number() would round a large payment silently.
  const negative = amountMicro < BigInt(0);
  const abs = negative ? -amountMicro : amountMicro;
  const whole = abs / MICRO;
  const cents = (abs % MICRO) / BigInt(10_000);
  const formatted = `${whole.toLocaleString('en-US')}.${cents.toString().padStart(2, '0')}`;
  return `${currency} ${negative ? '-' : ''}${formatted}`;
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

export default async function QueuePage() {
  const session = await getCustomerSession();

  if (!session) {
    redirect('/login');
  }

  // Live proposals 0xWal drafted this session. With DATABASE_URL set (W1),
  // the store write-throughs to Postgres and rehydrates here after a cold
  // start — a pending approval survives a restart. Anything the operator did
  // not approve inside the 2-minute chat window surfaces as maker-checker work.
  const proposalStore = getOxwalProposalStore();
  await ensureProposalStoreHydrated(proposalStore);
  const liveProposals: QueueItem[] = proposalStore
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
    <main className="min-h-screen bg-[#F6F0ED] px-4 py-6 text-[#326273] md:px-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-6">
        <header className="flex flex-col gap-4 border-b border-[#326273]/15 pb-5 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3">
            <Image src="/splash-main-icon.png" alt="Splash" width={40} height={39} className="h-10 w-10 object-contain" />
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--info)]">0xWal control room</p>
              <h1 className="text-3xl font-bold tracking-normal text-[#1F4452]">Approval queue</h1>
            </div>
          </div>
          <nav className="flex flex-wrap items-center gap-2 text-sm font-semibold">
            <Link className="rounded-md border border-[#326273]/20 px-3 py-2 text-[#326273]" href="/dashboard">0xWal</Link>
            <Link className="rounded-md bg-[#1F4452] px-3 py-2 text-white" href="/dashboard">Dashboard</Link>
          </nav>
        </header>

        <ApprovalQueueBoard pending={pending} otherLanes={otherLanes} />
      </div>
    </main>
  );
}
