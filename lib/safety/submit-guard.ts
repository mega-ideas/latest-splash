import type { ComplianceResult, OrgPolicy, SimulationResult, UnsignedProposal, UserRole } from '../agent/types.ts';
import { evaluatePolicy, type PolicyDecision } from '../policy/evaluate.ts';
import { ProposalStateError, transitionProposal } from '../queue/proposal-state.ts';
import { circuitBreakerDecision, policyWithCircuitBreaker } from './circuit-breaker.ts';
import { AGENT_ACTOR_ID } from '@/lib/agent/identity';

export interface SubmitGuardInput {
  proposal: UnsignedProposal;
  actor: UserRole;
  policy: OrgPolicy;
  simulation: SimulationResult;
  compliance: ComplianceResult;
  signatureRef: string;
  signedBy: string;
  signedAt?: string;
  now?: string;
}

export function authorizeProposalSubmission(input: SubmitGuardInput): PolicyDecision {
  const policy = policyWithCircuitBreaker(input.policy);
  const breaker = circuitBreakerDecision({ proposal: input.proposal, policy });
  if (!breaker.armed) {
    throw new ProposalStateError('circuit breaker blocks signing and submission');
  }
  if (!input.signatureRef || !input.signedBy || input.signedBy === AGENT_ACTOR_ID) {
    throw new ProposalStateError('a human signature reference is required before submission');
  }

  const decision = evaluatePolicy({
    proposal: input.proposal,
    actor: input.actor,
    policy,
    simulation: input.simulation,
    compliance: input.compliance,
    now: input.now,
  });
  if (decision.outcome === 'BLOCK') {
    throw new ProposalStateError(`policy blocked at submit time: ${decision.reason}`);
  }
  return decision;
}

export function markProposalSubmitted(input: SubmitGuardInput): {
  proposal: UnsignedProposal;
  policyDecision: PolicyDecision;
} {
  const policyDecision = authorizeProposalSubmission(input);
  const signed = input.proposal.status === 'SIGNED'
    ? input.proposal
    : transitionProposal(input.proposal, {
        type: 'SIGN',
        signatureRef: input.signatureRef,
        signedBy: input.signedBy,
        policyAuthorized: true,
        signedAt: input.signedAt ?? new Date().toISOString(),
      });
  const submitted = transitionProposal(signed, { type: 'SUBMIT' });
  return { proposal: submitted, policyDecision };
}
