import type { ComplianceResult, ProposalKind, UnsignedProposal } from '../agent/types.ts';
import { getComplianceStatus } from '../agent/oxwal.ts';

/**
 * Track A §1.2 — compliance state is resolved SERVER-SIDE from persisted
 * screening records, by beneficiary id. It is never accepted from a request
 * body, and a beneficiary with NO screening record is BLOCKED — never
 * defaulted to clear.
 */

// X402_PAYMENT is outbound: its payee is an EVM address Splash holds no
// screening record for, so it lands in NO_SCREENING_RECORD below — correctly.
const OUTBOUND_KINDS = new Set<ProposalKind>(['PAYMENT', 'BATCH_PAYOUT', 'NETTING_SETTLE', 'X402_PAYMENT']);

const CLEAR: ComplianceResult = {
  kytPassed: true,
  kybStatus: 'VERIFIED',
  sanctionsClear: true,
  flags: [],
};

function merge(results: ComplianceResult[]): ComplianceResult {
  return results.reduce((acc, result) => ({
    kytPassed: acc.kytPassed && result.kytPassed,
    kybStatus: result.kybStatus === 'VERIFIED' ? acc.kybStatus : result.kybStatus,
    sanctionsClear: acc.sanctionsClear && result.sanctionsClear,
    flags: [...acc.flags, ...result.flags],
  }), CLEAR);
}

/**
 * Resolve the compliance decision for a proposal from persisted screening
 * state only. Outbound money with no screenable beneficiary → BLOCKED.
 */
export function resolveComplianceForProposal(proposal: UnsignedProposal): ComplianceResult {
  const beneficiaryIds = proposal.explain.evidence
    .filter((item) => item.source === 'COUNTERPARTY')
    .map((item) => item.ref);

  if (!OUTBOUND_KINDS.has(proposal.kind)) {
    // No third-party beneficiary: org-scope internal/treasury movement.
    return CLEAR;
  }

  if (beneficiaryIds.length === 0) {
    return {
      kytPassed: false,
      kybStatus: 'PENDING',
      sanctionsClear: false,
      flags: ['NO_SCREENING_RECORD'],
    };
  }

  // getComplianceStatus reads the persisted screening store; an unknown
  // beneficiary comes back blocked (COUNTERPARTY_NOT_FOUND), never clear.
  return merge(beneficiaryIds.map((id) => getComplianceStatus({ counterpartyId: id })));
}
