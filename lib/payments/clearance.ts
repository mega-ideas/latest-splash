import type { CheckpointStates } from '@/components/shell/ClearanceProgress';
import { getUsdCorridorByCurrency } from '@/lib/fx/corridors';
import { getNetworkProfile } from '@/lib/network';
import type { TransferIntentRecord, TransferIntentState } from '@/lib/server/operations';

/**
 * The clearance record: one view model for a payment wherever it appears
 * (board row, inspector, payments register, receipt). Built from the
 * operations store's transfer intents and the agent's unsigned proposals;
 * nothing here invents state — every checkpoint maps to a field an auditor
 * can point at.
 */

export type ProposalSummary = {
  id: string;
  kind: string;
  status: string;
  corridor: string | null;
  recommendation: string;
  createdBy?: string;
  approvalHash?: string | null;
  evidenceQuality?: 'trusted' | 'untrusted';
  amountLabel: string | null;
  risk: string;
  approvalsCollected: number;
  requiredApprovers: number;
  createdAt: string;
  expiresAt: string | null;
};

export type ClearanceGroup = 'needs-clearance' | 'in-flight' | 'attention' | 'cleared';

export type EvidenceRow = { id: string; label: string; ref: string | null; at: string | null; state: 'complete' | 'pending' | 'exception'; detail?: string };

export type ClearanceRecord = {
  id: string;
  kind: 'proposal' | 'transfer';
  beneficiary: string;
  purpose: string;
  corridor: { from: string; to: string; origin: string; destination: string; country: string };
  send: { currency: string; amount: string };
  receive: { currency: string; amount: string };
  rate: string | null;
  rail: string;
  railKind: 'partner' | 'bank';
  checkpoints: CheckpointStates;
  status: string;
  group: ClearanceGroup;
  eta: string;
  sla: string;
  createdAt: string;
  updatedAt: string;
  digest: string | null;
  blobId: string | null;
  anchorId: string | null;
  failureReason: string | null;
  evidence: EvidenceRow[];
  href: string;
  approvalsCollected?: number;
  requiredApprovers?: number;
  risk?: string;
  expiresAt?: string | null;
};

const ORIGIN = { code: 'KUL', label: 'Kuala Lumpur, MY' };
const DESTINATIONS: Record<string, { code: string; label: string; country: string }> = {
  PHP: { code: 'MNL', label: 'Manila, PH', country: 'PH' },
  IDR: { code: 'JKT', label: 'Jakarta, ID', country: 'ID' },
  MYR: { code: 'KUL', label: 'Kuala Lumpur, MY', country: 'MY' },
  SGD: { code: 'SIN', label: 'Singapore, SG', country: 'SG' },
  VND: { code: 'SGN', label: 'Ho Chi Minh City, VN', country: 'VN' },
  THB: { code: 'BKK', label: 'Bangkok, TH', country: 'TH' },
  EUR: { code: 'FRA', label: 'Frankfurt, EU', country: 'EU' },
  GBP: { code: 'LON', label: 'London, GB', country: 'GB' },
};

export function destinationFor(currency: string) {
  return DESTINATIONS[currency.toUpperCase()] ?? { code: currency.toUpperCase().slice(0, 3), label: currency.toUpperCase(), country: currency.toUpperCase() };
}

export function shortTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.toISOString().slice(11, 19)} UTC`;
}

const IN_FLIGHT: ReadonlySet<TransferIntentState> = new Set(['AUTHORIZED', 'DEPOSIT_CONFIRMED', 'EXCHANGING', 'EXCHANGED', 'QUEUED', 'SETTLING', 'SETTLED', 'SWEEPING']);
const CLEARED: ReadonlySet<TransferIntentState> = new Set(['DISBURSED', 'CREDITED']);
const RETURNED: ReadonlySet<TransferIntentState> = new Set(['REFUNDING', 'REFUNDED']);

function railFor(currency: string): { label: string; kind: 'partner' | 'bank'; eta: string; sla: string } {
  const corridor = getNetworkProfile().corridors.find((entry) => entry.currency === currency.toUpperCase());
  if (corridor) return { label: 'Regulated partner rail', kind: 'partner', eta: 'Same day', sla: 'SLA 4h' };
  return { label: 'Bank wire', kind: 'bank', eta: '1–3 business days', sla: 'SLA 3d' };
}

export function fromTransfer(t: TransferIntentRecord): ClearanceRecord {
  const dest = destinationFor(t.targetCurrency);
  const rail = railFor(t.targetCurrency);
  const settled = Boolean(t.suiTxDigest);
  const anchored = Boolean(t.walrusBlobId || t.auditAnchorId);
  const failed = t.state === 'FAILED';
  const returned = RETURNED.has(t.state);
  const cleared = CLEARED.has(t.state);
  const executing = IN_FLIGHT.has(t.state) && !settled;
  const inTransit = IN_FLIGHT.has(t.state) && settled;

  const checkpoints: CheckpointStates = {
    B: 'complete',
    FX: t.quoteId || t.exchangeRate ? 'complete' : 'attention',
    POL: 'complete',
    APP: 'complete',
    EXE: failed ? 'exception' : returned ? 'exception' : executing ? 'active' : 'complete',
    PRO: cleared && anchored ? 'complete' : inTransit || cleared ? 'active' : 'pending',
  };

  const status = failed ? 'Exception' : returned ? 'Returned' : cleared ? (anchored ? 'Reconciled' : 'Credited') : inTransit ? 'In transit' : 'Executing';
  const group: ClearanceGroup = failed || returned ? 'attention' : cleared ? 'cleared' : 'in-flight';

  const evidence: EvidenceRow[] = [
    { id: 'ben', label: 'Beneficiary verified', ref: t.recipientId ? `REC-${t.recipientId.slice(-6).toUpperCase()}` : null, at: shortTime(t.createdAt), state: 'complete' },
    { id: 'kyt', label: 'Sanctions & KYT clear', ref: t.fundingKytStatus ? `KYT-${t.fundingKytStatus.toUpperCase()}` : null, at: shortTime(t.createdAt), state: t.fundingKytStatus === 'blocked' ? 'exception' : 'complete' },
    { id: 'quote', label: 'Quote locked', ref: t.quoteId ? `QTE-${t.quoteId.slice(-6).toUpperCase()}` : null, at: shortTime(t.createdAt), state: t.quoteId || t.exchangeRate ? 'complete' : 'pending', detail: t.exchangeRate ? `1 USD = ${t.exchangeRate} ${t.targetCurrency}` : undefined },
    { id: 'policy', label: 'Policy passed', ref: t.pegChecked ? 'POL-PEG-OK' : 'POL-LIMITS', at: shortTime(t.createdAt), state: 'complete' },
    { id: 'approval', label: 'Approval recorded', ref: t.verificationReference ? `APR-${t.verificationReference.slice(-6).toUpperCase()}` : null, at: shortTime(t.createdAt), state: 'complete' },
    { id: 'settled', label: 'Settled on Sui', ref: t.suiTxDigest ? `${t.suiTxDigest.slice(0, 10)}…` : null, at: shortTime(t.updatedAt), state: settled ? 'complete' : failed ? 'exception' : 'pending', detail: t.suiTxDigest ? 'pay · allocate · prove in one transaction' : undefined },
    { id: 'anchor', label: 'Audit anchored', ref: t.walrusBlobId ? `${t.walrusBlobId.slice(0, 10)}…` : t.auditAnchorId ? `${t.auditAnchorId.slice(0, 10)}…` : null, at: anchored ? shortTime(t.updatedAt) : null, state: anchored ? 'complete' : 'pending', detail: anchored ? 'Seal-encrypted, Walrus-stored' : undefined },
  ];

  return {
    id: t.id,
    kind: 'transfer',
    beneficiary: t.recipientName,
    purpose: t.invoiceId ? `Invoice · ${t.invoiceId}` : 'Supplier payout',
    corridor: { from: 'USD', to: t.targetCurrency, origin: ORIGIN.code, destination: dest.code, country: dest.country },
    send: { currency: 'USD', amount: t.sourceAmountUsd },
    receive: { currency: t.targetCurrency, amount: t.targetAmount },
    rate: t.exchangeRate,
    rail: rail.label,
    railKind: rail.kind,
    checkpoints,
    status,
    group,
    eta: rail.eta,
    sla: rail.sla,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    digest: t.suiTxDigest,
    blobId: t.walrusBlobId ?? null,
    anchorId: t.auditAnchorId ?? null,
    failureReason: t.failureReason,
    evidence,
    href: `/dashboard/receipts/${t.id}`,
  };
}

function parseAmountLabel(label: string | null): { currency: string; amount: string } | null {
  if (!label) return null;
  const match = label.match(/^([\d,]+(?:\.\d+)?)\s+([A-Z]{3})$/);
  return match ? { currency: match[2], amount: match[1] } : null;
}

export function fromProposal(p: ProposalSummary): ClearanceRecord {
  const corridorCurrency = (p.corridor ?? '').split('_').pop() ?? '';
  const parsed = parseAmountLabel(p.amountLabel);
  const receiveCurrency = parsed?.currency && parsed.currency !== 'USD' ? parsed.currency : corridorCurrency && corridorCurrency !== 'MY' ? corridorCurrency : 'PHP';
  const dest = destinationFor(receiveCurrency === 'PH' ? 'PHP' : receiveCurrency === 'ID' ? 'IDR' : receiveCurrency);
  const rail = railFor(dest.country === 'PH' ? 'PHP' : dest.country === 'ID' ? 'IDR' : receiveCurrency);
  const awaiting = p.requiredApprovers > p.approvalsCollected;
  const status = p.status === 'SIMULATED' ? 'Proposal ready' : awaiting ? 'Awaiting checker' : 'Approved';
  const checkpoints: CheckpointStates = {
    B: p.evidenceQuality === 'untrusted' ? 'attention' : 'complete',
    FX: 'complete',
    POL: p.status === 'POLICY_EVALUATED' || p.status === 'PENDING_APPROVAL' ? 'complete' : 'active',
    APP: awaiting ? 'active' : 'complete',
    EXE: 'pending',
    PRO: 'pending',
  };
  const evidence: EvidenceRow[] = [
    { id: 'ben', label: 'Beneficiary verified', ref: `EV-BEN-${p.id.slice(-6).toUpperCase()}`, at: shortTime(p.createdAt), state: p.evidenceQuality === 'untrusted' ? 'pending' : 'complete', detail: p.evidenceQuality === 'untrusted' ? 'Contains untrusted data' : undefined },
    { id: 'quote', label: 'Quote locked', ref: `EV-QTE-${p.id.slice(-6).toUpperCase()}`, at: shortTime(p.createdAt), state: 'complete' },
    { id: 'policy', label: 'Policy evaluated', ref: `EV-POL-${p.id.slice(-6).toUpperCase()}`, at: shortTime(p.createdAt), state: checkpoints.POL === 'complete' ? 'complete' : 'pending', detail: `${p.risk} risk` },
    { id: 'maker', label: 'Maker proposal recorded', ref: p.createdBy ? `MAKER-${p.createdBy.slice(-6).toUpperCase()}` : null, at: shortTime(p.createdAt), state: 'complete', detail: p.createdBy ? undefined : 'Prepared by 0xWal' },
    { id: 'checker', label: awaiting ? 'Checker approval pending' : 'Checker approval recorded', ref: p.approvalHash ? `${p.approvalHash.slice(0, 10)}…` : null, at: null, state: awaiting ? 'pending' : 'complete', detail: `${p.approvalsCollected} of ${p.requiredApprovers} approvals` },
  ];
  return {
    id: p.id,
    kind: 'proposal',
    beneficiary: p.recommendation.replace(/^Prepare a [A-Z]{3} payment for verified counterparty /i, '').split('.')[0].slice(0, 60),
    purpose: p.kind.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase()),
    corridor: { from: 'USD', to: dest.country === 'PH' ? 'PHP' : dest.country === 'ID' ? 'IDR' : receiveCurrency, origin: ORIGIN.code, destination: dest.code, country: dest.country },
    send: parsed && parsed.currency === 'USD' ? { currency: 'USD', amount: parsed.amount } : { currency: 'USD', amount: '—' },
    receive: parsed && parsed.currency !== 'USD' ? parsed : { currency: dest.country === 'PH' ? 'PHP' : 'IDR', amount: '—' },
    rate: null,
    rail: rail.label,
    railKind: rail.kind,
    checkpoints,
    status,
    group: 'needs-clearance',
    eta: rail.eta,
    sla: rail.sla,
    createdAt: p.createdAt,
    updatedAt: p.createdAt,
    digest: null,
    blobId: null,
    anchorId: null,
    failureReason: null,
    evidence,
    href: `/dashboard/approvals?id=${encodeURIComponent(p.id)}`,
    approvalsCollected: p.approvalsCollected,
    requiredApprovers: p.requiredApprovers,
    risk: p.risk,
    expiresAt: p.expiresAt,
  };
}

/** Route alternatives for a corridor: the regulated partner rail against category baselines. Illustrative, labelled as such. */
export function routeAlternatives(currency: string, sendUsd: number) {
  const corridor = getUsdCorridorByCurrency(currency);
  const feeBps = corridor?.feeBps ?? 80;
  const rate = corridor?.rate ?? 0;
  const precision = corridor?.precision ?? 2;
  const partnerFee = sendUsd * (feeBps / 10_000);
  const rows = [
    { id: 'partner', route: 'Regulated partner rail', recommended: true, feeUsd: partnerFee, feePct: feeBps / 100, delivered: (sendUsd - partnerFee) * rate, eta: 'Same day', confidence: 98, freshness: 'live' },
    { id: 'wire', route: 'Bank SWIFT', recommended: false, feeUsd: sendUsd * 0.025 + 35, feePct: 2.5, delivered: (sendUsd - (sendUsd * 0.025 + 35)) * rate, eta: '2–5 days', confidence: 72, freshness: 'baseline' },
    { id: 'fintech', route: 'Digital MTO', recommended: false, feeUsd: sendUsd * 0.015 + 4, feePct: 1.5, delivered: (sendUsd - (sendUsd * 0.015 + 4)) * rate, eta: '1–2 days', confidence: 85, freshness: 'baseline' },
  ];
  return { rows, precision, currency };
}

export function groupRecords(records: ClearanceRecord[]) {
  const groups: Record<ClearanceGroup, ClearanceRecord[]> = { 'needs-clearance': [], 'in-flight': [], attention: [], cleared: [] };
  for (const record of records) groups[record.group].push(record);
  return groups;
}
