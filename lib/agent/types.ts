export type AutonomyTier = 'TIER_0_PROPOSE' | 'TIER_1_THRESHOLD' | 'TIER_2_SCOPED_AUTO';

export type ProposalKind =
  | 'PAYMENT'
  | 'INTERNAL_TRANSFER'
  | 'FX_CONVERT'
  | 'TREASURY_ALLOCATE'
  | 'TREASURY_REDEEM'
  | 'BATCH_PAYOUT'
  | 'NETTING_SETTLE'
  /** An x402 (HTTP 402) payment request an operator pasted. Outbound, screened,
   *  human-approved — and not settleable until the session mandate and EVM
   *  payee screening exist (docs/X402-ASSESSMENT.md). */
  | 'X402_PAYMENT';

export type ProposalStatus =
  | 'DRAFTED'
  | 'SIMULATED'
  | 'POLICY_EVALUATED'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'SIGNED'
  | 'SUBMITTED'
  | 'SETTLED'
  | 'ANCHORED'
  | 'REJECTED'
  | 'FAILED'
  | 'EXPIRED'
  | 'REVERSED';

export type RiskBand = 'LOW' | 'MEDIUM' | 'HIGH';

/** Track A WS2 — runtime data provenance label carried by every evidence item. */
export type DataStatus = 'LIVE' | 'STALE' | 'MODELED' | 'DEMO';

/** ALL_LIVE only when every evidence item is status LIVE. */
export type EvidenceQuality = 'ALL_LIVE' | 'CONTAINS_DEMO_DATA';

export interface EvidenceItem {
  /** Provenance status of the underlying datum (absent = legacy/unlabeled). */
  status?: DataStatus;
  source:
    | 'BALANCE'
    /** The rate came from Splash's corridor table (lib/fx/corridors.ts): a
     *  reference rate, MODELED, not a market reading. */
    | 'CORRIDOR_RATE'
    /** Legacy: proposals stored before 2026-09-25 named their rate evidence
     *  this. It was never Pyth — the rate came from the corridor table then
     *  too — but stored rows must stay readable. Never written now. */
    | 'PYTH_RATE'
    | 'COUNTERPARTY'
    | 'INVOICE'
    | 'TREASURY'
    | 'NETTING'
    | 'COMPLIANCE'
    | 'CORRIDOR_LIQUIDITY'
    /** A 402 challenge the operator pasted — untrusted by construction. */
    | 'X402_CHALLENGE';
  ref: string;
  observedAt: string;
  trusted: boolean;
}

export interface FinancialImpact {
  amountIn?: bigint;
  amountOut?: bigint;
  currencyIn?: string;
  currencyOut?: string;
  feeBps?: number;
  fxRate?: ProposalFxRate;
  yieldDeltaBps?: number;
  nettingSaved?: bigint;
}

/**
 * The FX quote a proposal was priced at. `quoteRef` names where the rate came
 * from, e.g. `corridor:USD/PHP`.
 *
 * Proposals stored before 2026-09-25 carry `pythPriceId` instead: a misnomer
 * (their rate also came from the corridor table), kept because the field is
 * part of the canonical approval hash (lib/proposals/canonical-hash.ts) and
 * their stored approvals must still verify. Never written now.
 */
export type ProposalFxRate =
  | { value: string; quoteRef: string; observedAt: string }
  | { value: string; pythPriceId: string; observedAt: string };

export interface ProposalExplain {
  recommendation: string;
  financialImpact: FinancialImpact;
  evidence: EvidenceItem[];
  confidence: number;
  risk: RiskBand;
  requiredApprovers: number;
  reasoningTraceRef: string;
  /** Track A WS2 — set at proposal creation from the evidence statuses. */
  evidenceQuality?: EvidenceQuality;
}

export interface SimulationResult {
  ok: boolean;
  balanceChanges: { owner: string; coinType: string; amount: string }[];
  gasSponsored: boolean;
  error?: string;
  simulatedAt: string;
}

export type UserRole =
  | 'OWNER'
  | 'FINANCE_ADMIN'
  | 'MAKER'
  | 'APPROVER'
  | 'VIEWER'
  | 'AUDITOR'
  | 'DEVELOPER';

export interface UnsignedProposal {
  id: string;
  idempotencyKey: string;
  kind: ProposalKind;
  status: ProposalStatus;
  tier: AutonomyTier;
  orgId: string;
  corridor?: string;
  unsignedTxBytes: string;
  simulation?: SimulationResult;
  explain: ProposalExplain;
  /** The agent's persisted actor id (AGENT_ACTOR_ID in lib/agent/identity.ts) or a human userId. */
  createdBy: 'OXWAL' | string;
  createdAt: string;
  expiresAt: string;
  /** Track A §1.4 — canon version; bumped on any canon-field mutation, which
   *  voids all prior approvals. Absent on legacy rows = 1. */
  version?: number;
  /** Server-computed canonical approval hash (lib/proposals/canonical-hash). */
  approvalHash?: string;
  approvals: { userId: string; role: UserRole; signedAt: string }[];
  settlement?: { digest: string; walrusBlobId: string; auditEventId: string };
  /** The payment this rebuilds into once approved. On the proposal, not in a
   *  process map: an approval that survives a restart must still be
   *  executable, and the thing approved and the thing executed must be one
   *  record rather than two that can drift apart. */
  executionPayload?: Record<string, unknown>;
  /** What happened when it was carried out, including a failure — so an
   *  approval that could not be executed is visible rather than silent. */
  execution?: { state: 'EXECUTED' | 'FAILED' | 'SKIPPED'; detail: string; ref?: string; at: string };
  /** When the approval was spent, and what spent it: the money route that
   *  acted on the approved-proposal claim, or the approvers' replay closing it.
   *  An approval carries out one payment; set once, never cleared. */
  approvalConsumedAt?: string;
  approvalConsumedBy?: string;
}

export interface OrgPolicy {
  orgId: string;
  tier1ThresholdUsd: bigint;
  dualApprovalThresholdUsd: bigint;
  whitelistedAutoKinds: ProposalKind[];
  operatingMinimumByCorridor: Record<string, bigint>;
  perCorridorState: Record<string, 'ARMED' | 'PAUSED'>;
  globalState: 'ARMED' | 'PAUSED';
}

export interface ComplianceResult {
  kytPassed: boolean;
  kybStatus: 'VERIFIED' | 'PENDING' | 'FAILED';
  sanctionsClear: boolean;
  flags: string[];
}
