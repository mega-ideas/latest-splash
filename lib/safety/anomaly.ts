import type { PolicyDecision } from '../policy/evaluate.ts';
import type { UnsignedProposal } from '../agent/types.ts';
import { setCorridorCircuitBreaker, setGlobalCircuitBreaker } from './circuit-breaker.ts';

export type AnomalyRule =
  | 'PROPOSALS_PER_MINUTE'
  | 'CUMULATIVE_OUTBOUND_USD_PER_HOUR'
  | 'CONFIDENCE_SHIFT'
  | 'REPEATED_SIMULATION_MISMATCH';

export interface AnomalyEvent {
  proposal: UnsignedProposal;
  decision?: PolicyDecision;
  observedAt: string;
}

export interface AnomalyConfig {
  proposalsPerMinuteLimit: number;
  cumulativeOutboundUsdPerHourLimit: bigint;
  lowConfidenceAverageThreshold: number;
  lowConfidenceSampleSize: number;
  repeatedSimulationMismatchLimit: number;
}

export interface AnomalyFinding {
  rule: AnomalyRule;
  severity: 'WARN' | 'PAUSE';
  reason: string;
  action: 'ALERT' | 'PAUSE_GLOBAL' | 'PAUSE_CORRIDOR';
  corridor?: string;
}

// x402 is machine-speed micropayment by design — exactly what the burst and
// hourly-volume limits exist for.
const OUTBOUND_KINDS = new Set(['PAYMENT', 'BATCH_PAYOUT', 'NETTING_SETTLE', 'X402_PAYMENT']);

export const defaultAnomalyConfig: AnomalyConfig = {
  proposalsPerMinuteLimit: 12,
  cumulativeOutboundUsdPerHourLimit: BigInt(100_000_000_000),
  lowConfidenceAverageThreshold: 0.45,
  lowConfidenceSampleSize: 5,
  repeatedSimulationMismatchLimit: 3,
};

function amountUsdMicro(proposal: UnsignedProposal) {
  return proposal.explain.financialImpact.amountOut
    ?? proposal.explain.financialImpact.amountIn
    ?? BigInt(0);
}

function atMs(event: AnomalyEvent) {
  return new Date(event.observedAt).getTime();
}

function recent(events: AnomalyEvent[], now: Date, windowMs: number) {
  const cutoff = now.getTime() - windowMs;
  return events.filter((event) => atMs(event) >= cutoff && atMs(event) <= now.getTime());
}

function firstCorridor(events: AnomalyEvent[]) {
  return events.find((event) => event.proposal.corridor)?.proposal.corridor;
}

export function evaluateAnomalyRules(
  events: AnomalyEvent[],
  config: AnomalyConfig = defaultAnomalyConfig,
  now = new Date(),
): AnomalyFinding[] {
  const findings: AnomalyFinding[] = [];
  const lastMinute = recent(events, now, 60_000);
  if (lastMinute.length > config.proposalsPerMinuteLimit) {
    findings.push({
      rule: 'PROPOSALS_PER_MINUTE',
      severity: 'PAUSE',
      action: 'PAUSE_GLOBAL',
      reason: `proposal velocity ${lastMinute.length}/min exceeded ${config.proposalsPerMinuteLimit}/min`,
    });
  }

  const outboundHour = recent(events, now, 60 * 60_000)
    .filter((event) => OUTBOUND_KINDS.has(event.proposal.kind));
  const outboundTotal = outboundHour.reduce((sum, event) => sum + amountUsdMicro(event.proposal), BigInt(0));
  if (outboundTotal > config.cumulativeOutboundUsdPerHourLimit) {
    findings.push({
      rule: 'CUMULATIVE_OUTBOUND_USD_PER_HOUR',
      severity: 'PAUSE',
      action: 'PAUSE_GLOBAL',
      reason: `cumulative outbound ${outboundTotal.toString()} exceeded hourly limit`,
    });
  }

  // Only measured scores. A proposal with confidence null measured none;
  // counting it as 0 would raise a "shift" that nothing measured.
  const confidenceSample = events
    .map((event) => event.proposal.explain.confidence)
    .filter((confidence): confidence is number => typeof confidence === 'number' && Number.isFinite(confidence))
    .slice(-config.lowConfidenceSampleSize);
  if (confidenceSample.length >= config.lowConfidenceSampleSize) {
    const average = confidenceSample.reduce((sum, confidence) => sum + confidence, 0) / confidenceSample.length;
    if (average < config.lowConfidenceAverageThreshold) {
      findings.push({
        rule: 'CONFIDENCE_SHIFT',
        severity: 'WARN',
        action: 'ALERT',
        reason: `average confidence shifted to ${average.toFixed(2)}`,
      });
    }
  }

  const mismatches = recent(events, now, 10 * 60_000).filter((event) =>
    /simulation mismatch/i.test(event.proposal.simulation?.error ?? '')
      || (event.decision?.outcome === 'BLOCK' && /simulation mismatch/i.test(event.decision.reason)),
  );
  if (mismatches.length >= config.repeatedSimulationMismatchLimit) {
    findings.push({
      rule: 'REPEATED_SIMULATION_MISMATCH',
      severity: 'PAUSE',
      action: firstCorridor(mismatches) ? 'PAUSE_CORRIDOR' : 'PAUSE_GLOBAL',
      corridor: firstCorridor(mismatches),
      reason: `${mismatches.length} simulation mismatches in 10 minutes`,
    });
  }

  return findings;
}

export function applyAnomalyFindings(input: {
  orgId: string;
  findings: AnomalyFinding[];
  actor?: string;
}) {
  const actor = input.actor ?? 'anomaly-monitor';
  return input.findings
    .filter((finding) => finding.severity === 'PAUSE')
    .map((finding) => {
      if (finding.action === 'PAUSE_CORRIDOR' && finding.corridor) {
        return setCorridorCircuitBreaker({
          orgId: input.orgId,
          corridor: finding.corridor,
          state: 'PAUSED',
          actor,
          reason: finding.reason,
        });
      }
      return setGlobalCircuitBreaker({
        orgId: input.orgId,
        state: 'PAUSED',
        actor,
        reason: finding.reason,
      });
    });
}
