import type {
  ComplianceResult,
  OrgPolicy,
  ProposalKind,
  SimulationResult,
  UnsignedProposal,
  UserRole,
} from '../agent/types.ts';
import { USD_MICRO, checkMinimumSettlement, formatUsd } from './limits.ts';

export type PolicyDecision =
  | { outcome: 'AUTO_EXECUTE' }
  | { outcome: 'REQUIRE_APPROVAL'; approvers: 1 | 2 }
  | { outcome: 'BLOCK'; reason: string };

export type PolicyContext = {
  proposal: UnsignedProposal;
  actor: UserRole;
  policy: OrgPolicy;
  simulation: SimulationResult;
  compliance: ComplianceResult;
  now?: string;
};

const OUTBOUND_KINDS = new Set<ProposalKind>(['PAYMENT', 'BATCH_PAYOUT', 'NETTING_SETTLE']);
const APPROVAL_ROLES = new Set<UserRole>(['OWNER', 'FINANCE_ADMIN', 'APPROVER']);
const AUTO_INTERNAL_ROLES = new Set<UserRole>(['OWNER', 'FINANCE_ADMIN', 'APPROVER', 'MAKER']);

const USD_LEG_CURRENCIES = new Set(['USD', 'USDC', 'USDT']);

function amountUsdMicro(proposal: UnsignedProposal): bigint {
  const impact = proposal.explain.financialImpact;
  // USD thresholds must compare against the USD-denominated leg. Cross-currency
  // proposals (payment/FX) carry the USD notional as amountIn and the target
  // currency as amountOut — using amountOut here would compare pesos to dollars.
  if (USD_LEG_CURRENCIES.has(impact.currencyIn ?? '') && typeof impact.amountIn === 'bigint') {
    return impact.amountIn;
  }
  if (USD_LEG_CURRENCIES.has(impact.currencyOut ?? '') && typeof impact.amountOut === 'bigint') {
    return impact.amountOut;
  }
  return impact.amountOut ?? impact.amountIn ?? BigInt(0);
}

function absBigInt(value: bigint) {
  return value < BigInt(0) ? -value : value;
}

function parseBigInt(value: string): bigint | null {
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function withinTolerance(observed: bigint, expected: bigint, toleranceBps: bigint) {
  if (expected === BigInt(0)) return observed === BigInt(0);
  const delta = absBigInt(observed - expected);
  return delta * BigInt(10_000) <= expected * toleranceBps;
}

function simulationMatchesFinancialImpact(proposal: UnsignedProposal, simulation: SimulationResult) {
  const claims = [
    proposal.explain.financialImpact.amountIn,
    proposal.explain.financialImpact.amountOut,
  ].filter((amount): amount is bigint => typeof amount === 'bigint' && amount > BigInt(0));

  if (claims.length === 0) return true;

  const deltas = simulation.balanceChanges
    .map((change) => parseBigInt(change.amount))
    .filter((amount): amount is bigint => amount !== null)
    .map(absBigInt);

  if (deltas.length === 0) return false;
  return claims.every((claim) => deltas.some((delta) => withinTolerance(delta, claim, BigInt(5))));
}

function hasVerifiedCounterpartyEvidence(proposal: UnsignedProposal) {
  return proposal.explain.evidence.some((item) => item.source === 'COUNTERPARTY' && item.trusted);
}

function complianceFailed(compliance: ComplianceResult) {
  return !compliance.kytPassed
    || compliance.kybStatus !== 'VERIFIED'
    || !compliance.sanctionsClear
    || compliance.flags.length > 0;
}

function operatingBalanceAfter(proposal: UnsignedProposal, simulation: SimulationResult): bigint | null {
  if (!proposal.corridor) return null;
  const marker = `OPERATING_BALANCE_AFTER:${proposal.corridor}`;
  const exact = simulation.balanceChanges.find((change) => change.owner === marker);
  const generic = simulation.balanceChanges.find(
    (change) => change.owner === 'OPERATING_BALANCE_AFTER' && change.coinType === proposal.corridor,
  );
  const amount = (exact ?? generic)?.amount;
  return amount ? parseBigInt(amount) : null;
}

function actorCanApprove(actor: UserRole) {
  return APPROVAL_ROLES.has(actor);
}

function actorCanAutoInternal(actor: UserRole) {
  return AUTO_INTERNAL_ROLES.has(actor);
}

function approvalCountForAmount(amount: bigint, policy: OrgPolicy): 1 | 2 {
  return amount >= policy.dualApprovalThresholdUsd ? 2 : 1;
}

export function evaluatePolicy(ctx: PolicyContext): PolicyDecision {
  const { proposal, actor, policy, simulation, compliance } = ctx;
  const corridorState = proposal.corridor ? policy.perCorridorState[proposal.corridor] : 'ARMED';
  if (policy.globalState === 'PAUSED' || corridorState === 'PAUSED') {
    return { outcome: 'BLOCK', reason: 'circuit breaker' };
  }

  const nowMs = new Date(ctx.now ?? nowForPolicy()).getTime();
  if (Number.isFinite(nowMs) && new Date(proposal.expiresAt).getTime() < nowMs) {
    return { outcome: 'BLOCK', reason: 'quote expired' };
  }

  if (!simulation.ok || !simulationMatchesFinancialImpact(proposal, simulation)) {
    return { outcome: 'BLOCK', reason: 'simulation mismatch' };
  }

  if (complianceFailed(compliance)) {
    return { outcome: 'BLOCK', reason: 'compliance hold' };
  }

  // WS2 belt-and-braces: evidence that is not ALL_LIVE can never auto-execute,
  // whatever the autonomy tier — a human sees DEMO/MODELED data before money moves.
  const forceHumanApproval = proposal.explain.evidenceQuality === 'CONTAINS_DEMO_DATA';

  const amount = amountUsdMicro(proposal);

  // x402 has its own branch, and it sits here on purpose: AFTER the
  // compliance hold (an unscreened EVM payee is blocked like any other
  // unscreened beneficiary) and BEFORE the settlement minimum. That minimum
  // prices the local-rail delivery of a cross-border payout; an x402 payment
  // is a USDC micropayment on an EVM chain, typically cents, and the payout
  // minimum would refuse every one for a reason that does not apply. What
  // does apply: a human approves, always — never auto, whatever the tier —
  // and two approve above the org's dual threshold.
  if (proposal.kind === 'X402_PAYMENT') {
    if (amount <= 0n) return { outcome: 'BLOCK', reason: 'x402 amount must be positive' };
    return amount >= policy.dualApprovalThresholdUsd
      ? { outcome: 'REQUIRE_APPROVAL', approvers: 2 }
      : { outcome: 'REQUIRE_APPROVAL', approvers: 1 };
  }

  // Minimum settlement size. Enforced here as well as at the API edge, because
  // this is the choke point every path shares — in-chat approval, the
  // maker-checker queue, and submit-time re-evaluation all run evaluatePolicy,
  // so a sub-minimum proposal can never be approved by any route.
  if (OUTBOUND_KINDS.has(proposal.kind)) {
    const amountUsd = Number(amount) / USD_MICRO;
    const minimum = checkMinimumSettlement(
      amountUsd,
      proposal.kind === 'BATCH_PAYOUT' ? 'batch' : 'transfer',
    );
    if (!minimum.ok) {
      return { outcome: 'BLOCK', reason: `below minimum (${formatUsd(minimum.minimumUsd)})` };
    }
  }

  if (OUTBOUND_KINDS.has(proposal.kind)) {
    if (!hasVerifiedCounterpartyEvidence(proposal)) {
      return { outcome: 'REQUIRE_APPROVAL', approvers: 1 };
    }

    if (amount >= policy.dualApprovalThresholdUsd) {
      return { outcome: 'REQUIRE_APPROVAL', approvers: 2 };
    }

    if (
      amount <= policy.tier1ThresholdUsd
      && proposal.tier === 'TIER_1_THRESHOLD'
      && actorCanApprove(actor)
    ) {
      return { outcome: 'REQUIRE_APPROVAL', approvers: 1 };
    }

    return { outcome: 'REQUIRE_APPROVAL', approvers: approvalCountForAmount(amount, policy) };
  }

  if (proposal.kind === 'TREASURY_ALLOCATE') {
    const floor = proposal.corridor ? policy.operatingMinimumByCorridor[proposal.corridor] : undefined;
    const remaining = operatingBalanceAfter(proposal, simulation);
    if (floor !== undefined && remaining !== null && remaining < floor) {
      return { outcome: 'BLOCK', reason: 'treasury floor' };
    }

    if (
      policy.whitelistedAutoKinds.includes(proposal.kind)
      && proposal.tier === 'TIER_2_SCOPED_AUTO'
    ) {
      if (forceHumanApproval) return { outcome: 'REQUIRE_APPROVAL', approvers: 1 };
      return { outcome: 'AUTO_EXECUTE' };
    }
  }

  if (proposal.kind === 'INTERNAL_TRANSFER') {
    if (amount <= policy.tier1ThresholdUsd && actorCanAutoInternal(actor)) {
      if (forceHumanApproval) return { outcome: 'REQUIRE_APPROVAL', approvers: 1 };
      return { outcome: 'AUTO_EXECUTE' };
    }
    return { outcome: 'REQUIRE_APPROVAL', approvers: approvalCountForAmount(amount, policy) };
  }

  return { outcome: 'REQUIRE_APPROVAL', approvers: 1 };
}

function nowForPolicy() {
  return new Date().toISOString();
}
