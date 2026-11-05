import type { ProposalKind, ProposalStatus, AutonomyTier } from '../agent/types.ts';

export interface ProposalTransitionMetric {
  proposalId: string;
  kind: ProposalKind;
  tier: AutonomyTier;
  from: ProposalStatus;
  to: ProposalStatus;
  eventType: string;
  actor: string;
  decision?: string;
  latencyMs: number;
  at: string;
}

const globalObservability = globalThis as typeof globalThis & {
  oxwalTransitionMetrics?: ProposalTransitionMetric[];
  oxwalMetricCounters?: Map<string, number>;
};

const transitionMetrics = globalObservability.oxwalTransitionMetrics ?? [];
const counters = globalObservability.oxwalMetricCounters ?? new Map<string, number>();
globalObservability.oxwalTransitionMetrics = transitionMetrics;
globalObservability.oxwalMetricCounters = counters;

function increment(name: string, amount = 1) {
  counters.set(name, (counters.get(name) ?? 0) + amount);
}

export function recordProposalTransition(metric: ProposalTransitionMetric) {
  transitionMetrics.push(metric);
  increment('oxwal.proposal_transition.total');
  increment(`oxwal.proposal_transition.${metric.to.toLowerCase()}`);
  if (metric.kind === 'NETTING_SETTLE' && metric.to === 'SETTLED') increment('oxwal.realized_netting.total');
  if (metric.kind === 'INTERNAL_TRANSFER' && metric.to === 'SETTLED') increment('oxwal.internalized_volume.total');
  if (metric.kind === 'PAYMENT' && metric.to === 'SETTLED') {
    increment('oxwal.recipient_retention.touchpoints');
  }

  console.info('[0xwal.transition]', {
    proposalId: metric.proposalId,
    kind: metric.kind,
    tier: metric.tier,
    from: metric.from,
    to: metric.to,
    eventType: metric.eventType,
    actor: metric.actor,
    decision: metric.decision,
    latencyMs: metric.latencyMs,
  });
}

export function proposalObservabilitySummary() {
  return {
    transitions: [...transitionMetrics],
    counters: Object.fromEntries(counters.entries()),
  };
}

export function resetProposalObservability() {
  transitionMetrics.splice(0, transitionMetrics.length);
  counters.clear();
}
