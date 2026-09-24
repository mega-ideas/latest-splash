import { createHash } from 'node:crypto';

import type { ProposalFxRate, UnsignedProposal } from '../agent/types.ts';

/**
 * Track A §1.4 — canonical approval hash.
 *
 * An approval binds to a deterministic digest of exactly what is being
 * approved. The hash is computed SERVER-SIDE at proposal creation and stored
 * on the proposal. Any mutation to a canon field goes through
 * `reviseProposalCanon` (proposal-state.ts), which bumps `version`,
 * recomputes the hash, and voids every prior approval. Approval submission
 * recomputes from the stored row and compares before accepting.
 */

export interface ApprovalCanon {
  proposalId: string;
  proposalVersion: number;
  orgId: string;
  /** Verified Counterparty.id evidence refs — never a raw address. */
  beneficiaryIds: string;
  amountInMinor: string;
  amountOutMinor: string;
  currencyIn: string;
  currencyOut: string;
  routeId: string;
  quoteId: string;
  feeBps: string;
  expiresAt: string;
}

/**
 * The quote's name in the canon. New proposals carry `quoteRef`; stored ones
 * carry the legacy `pythPriceId`, read as-is so the canon string, and so
 * every stored approval hash, is exactly what it was.
 */
export function fxQuoteRef(fxRate: ProposalFxRate): string {
  return 'quoteRef' in fxRate ? fxRate.quoteRef : fxRate.pythPriceId;
}

export function canonFromProposal(proposal: UnsignedProposal): ApprovalCanon {
  const impact = proposal.explain.financialImpact;
  const beneficiaryIds = proposal.explain.evidence
    .filter((item) => item.source === 'COUNTERPARTY')
    .map((item) => item.ref)
    .sort()
    .join(',');
  return {
    proposalId: proposal.id,
    proposalVersion: proposal.version ?? 1,
    orgId: proposal.orgId,
    beneficiaryIds,
    amountInMinor: impact.amountIn?.toString() ?? '',
    amountOutMinor: impact.amountOut?.toString() ?? '',
    currencyIn: impact.currencyIn ?? '',
    currencyOut: impact.currencyOut ?? '',
    routeId: proposal.corridor ?? '',
    quoteId: impact.fxRate ? `${fxQuoteRef(impact.fxRate)}@${impact.fxRate.observedAt}` : '',
    feeBps: impact.feeBps?.toString() ?? '',
    expiresAt: proposal.expiresAt,
  };
}

export function canonicalApprovalHash(canon: ApprovalCanon): string {
  // Deterministic serialization: sorted keys, no whitespace.
  const canonical = JSON.stringify(canon, Object.keys(canon).sort());
  return createHash('sha256').update(canonical).digest('hex');
}

export function proposalApprovalHash(proposal: UnsignedProposal): string {
  return canonicalApprovalHash(canonFromProposal(proposal));
}
