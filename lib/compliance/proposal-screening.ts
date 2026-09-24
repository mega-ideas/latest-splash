import type { ComplianceResult, ProposalKind, UnsignedProposal } from '../agent/types.ts';
import { getComplianceStatus } from '../agent/oxwal.ts';
import {
  loadLatestScreenings,
  screeningSubjectForRef,
  type RecordedScreening,
  type ScreeningLookup,
  type ScreeningSubject,
} from '../server/screening-record.ts';

/**
 * Track A §1.2 — compliance state is resolved SERVER-SIDE from persisted
 * screening records, by beneficiary id. It is never accepted from a request
 * body, and a beneficiary with NO screening record is BLOCKED — never
 * defaulted to clear.
 *
 * Two lookups. The agent's own proposals name counterparties from its fixture
 * store (`getComplianceStatus`). The money routes' proposals name a saved
 * beneficiary (`rcpt_…`) or a payroll payee (`wallet:…`), whose screening is
 * recorded durably (lib/server/screening-record.ts) — and the approval paths
 * read that record through `resolveDurableComplianceForProposal`. The
 * synchronous form below cannot read a database, so it finds neither of those
 * and holds them; it serves the agent's fixture lookups and tests.
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

/**
 * One payee's compliance, from what is on record for it and nothing else.
 *
 * Every field is earned by a record, and each gap is named in `flags` so an
 * approver is told why a payment is held rather than only that it is:
 *
 *   sanctions and KYT   a CLEAR verdict from a screening provider. Unscreened,
 *                       failed, under review or listed all hold. An admin's
 *                       ATTESTED is accountability, not screening: the wallet
 *                       lane accepts it for its capped mainnet sends; whether
 *                       it may release a bank payout or a payroll run is a
 *                       compliance decision nobody has made, so it holds here.
 *   KYB                 the beneficiary's own verification, as its record
 *                       holds it — `full`, and nothing less. A payroll address
 *                       has no record to hold one: policy requires a verified
 *                       counterparty, and whether a sanctions CLEAR alone may
 *                       stand in for that on a payroll run is, again, a
 *                       compliance decision, not one made here.
 */
export function complianceFromRecord(subject: ScreeningSubject, recorded: RecordedScreening | null): ComplianceResult {
  if (!recorded) {
    return { kytPassed: false, kybStatus: 'PENDING', sanctionsClear: false, flags: ['COUNTERPARTY_NOT_FOUND'] };
  }
  const flags: string[] = [];
  switch (recorded.verdict) {
    case 'CLEAR':
      break;
    case 'BLOCK':
      flags.push('SANCTIONS_HIT');
      break;
    case 'REVIEW':
      flags.push('SCREENING_UNDER_REVIEW');
      break;
    case 'ERROR':
      flags.push('SCREENING_ERROR');
      break;
    case 'ATTESTED':
      flags.push('ATTESTATION_IS_NOT_SCREENING');
      break;
    default:
      flags.push('NOT_SCREENED');
  }
  const clear = recorded.verdict === 'CLEAR';

  let kybStatus: ComplianceResult['kybStatus'];
  if (subject.kind === 'RECIPIENT') {
    kybStatus = recorded.recipientKyb === 'full' ? 'VERIFIED' : recorded.recipientKyb === 'rejected' ? 'FAILED' : 'PENDING';
    if (kybStatus !== 'VERIFIED') flags.push('BENEFICIARY_KYB_INCOMPLETE');
  } else {
    kybStatus = 'PENDING';
    flags.push('PAYEE_KYB_NOT_ESTABLISHED');
  }

  return { kytPassed: clear, kybStatus, sanctionsClear: clear, flags };
}

/**
 * The approval paths' compliance check: every COUNTERPARTY ref on the
 * proposal, resolved against what is on record for it in the proposal's own
 * org — durable screening for the money routes' beneficiaries and payees, the
 * fixture store for the agent's counterparties. Async because the record is in
 * Postgres; the submit route and the code/reply settle path both await it
 * before they evaluate policy.
 */
export async function resolveDurableComplianceForProposal(
  proposal: UnsignedProposal,
  load: (orgId: string, refs: readonly string[]) => Promise<ScreeningLookup> = loadLatestScreenings,
): Promise<ComplianceResult> {
  if (!OUTBOUND_KINDS.has(proposal.kind)) return CLEAR;

  const refs = proposal.explain.evidence
    .filter((item) => item.source === 'COUNTERPARTY')
    .map((item) => item.ref);
  if (refs.length === 0) {
    return { kytPassed: false, kybStatus: 'PENDING', sanctionsClear: false, flags: ['NO_SCREENING_RECORD'] };
  }

  const durable = refs.filter((ref) => screeningSubjectForRef(ref) !== null);
  const recorded = durable.length > 0 ? await load(proposal.orgId, durable) : new Map();
  return merge(
    refs.map((ref) => {
      const subject = screeningSubjectForRef(ref);
      return subject
        ? complianceFromRecord(subject, recorded.get(ref) ?? null)
        : getComplianceStatus({ counterpartyId: ref });
    }),
  );
}

const HOLD_REASONS: Record<string, string> = {
  COUNTERPARTY_NOT_FOUND: 'a beneficiary is not on record in this workspace',
  NO_SCREENING_RECORD: 'the payment names no beneficiary that can be screened',
  NOT_SCREENED: 'a payee has not been screened',
  SCREENING_ERROR: 'screening could not complete for a payee',
  SCREENING_UNDER_REVIEW: 'a payee is under screening review',
  SANCTIONS_HIT: 'a payee is on a sanctions list',
  ATTESTATION_IS_NOT_SCREENING: 'a payee was attested by an admin, not screened',
  BENEFICIARY_KYB_INCOMPLETE: "a beneficiary's own verification is not complete",
  PAYEE_KYB_NOT_ESTABLISHED: 'a payroll payee has no verification on record',
  KYT_NOT_CLEARED: 'a counterparty has not cleared KYT',
  KYB_NOT_VERIFIED: 'a counterparty is not verified',
  SANCTIONS_NOT_CLEAR: 'a counterparty is not sanctions-clear',
};

/** Why a payment is on compliance hold, in words an approver can act on —
 *  each reason once, however many payees share it. */
export function describeComplianceHold(compliance: ComplianceResult): string {
  const reasons = [...new Set(compliance.flags)].map((flag) => HOLD_REASONS[flag] ?? flag.toLowerCase().replace(/_/g, ' '));
  return reasons.join('; ');
}
