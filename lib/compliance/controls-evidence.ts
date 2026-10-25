/**
 * The per-payment controls evidence (v2 §4.6, D12): the artefact a bank
 * partner asks for. One payment, one document, in JSON (schema
 * `splash.controls-evidence.v1`) and as a PDF with the same content:
 *
 *   who was verified       the business's KYB case: its id, its state, the
 *                          provider's applicant reference, the lifecycle
 *   what was screened      each KYT screening of the address paid: provider,
 *                          the provider's reference, the verdict (or none);
 *                          those made before the payment was approved (the
 *                          quorum's last signature) apart from those after,
 *                          so a later CLEAR is never read as the control
 *                          that applied
 *   which rule applied     the signing request, its threshold and signers,
 *                          the spending rule (allowance, policy) and second
 *                          approval when there was one
 *   the quote              its reference, rate, what arrives, each partner's
 *                          fee its own line
 *   the partner            which route, its reference, the bank's reference
 *   the chain              the Sui digest, the intent id the chain created,
 *                          the Walrus blob and content hash the settlement
 *                          anchored, and the receipt (that anchor event)
 *   the message            the masked ISO 20022 copy the partner was sent
 *
 * What it never holds: a secret, a signature, a sealed value or salt, or an
 * account number (the last four only). `assertEvidenceClean` refuses a
 * document that does, so a field added later cannot leak one by accident.
 * What is missing is said in `gaps`, in plain words, rather than left blank:
 * an export that hides a gap is worse than one that names it.
 */
import { createHash } from 'node:crypto';

import type { Pacs008Evidence } from '../payments/iso20022.ts';
import { renderTextPdf, type PdfLine } from './pdf-text.ts';

export type EvidencePaymentKind = 'withdrawal' | 'supplier_payout' | 'wallet_payment';

export type EvidenceScreening = {
  /** The Sui address the USDC went to, or a cross-chain payment's destination address on its own chain. */
  subject: 'paid_address' | 'cross_chain_recipient';
  chain: string;
  address: string;
  provider: string;
  reference: string | null;
  verdict: string | null;
  riskScore: string | null;
  screenedAt: string | null;
};

export type ControlsEvidence = {
  schema: 'splash.controls-evidence.v1';
  payment: {
    ref: string;
    kind: EvidencePaymentKind;
    status: string;
    intentId: string | null;
    asset: 'USDC';
    amountMinor: string;
    maxFeeMinor: string | null;
    /** The address the USDC went to: the partner's deposit address, or the recipient's. */
    paidTo: string;
    fromWallet: string;
    createdAt: string;
  };
  /** When the payment was approved: the signature that completed its quorum. Null while it is not. */
  approvedAt: string | null;
  kyb: {
    caseId: string;
    state: string;
    provider: 'sumsub' | null;
    providerApplicantRef: string | null;
    lifecycle: string | null;
    updatedAt: string;
  } | null;
  /** The screenings on file when the payment was approved (all of them while it is not), newest first. */
  screenings: EvidenceScreening[];
  /** Screenings made after the payment was approved: not the control that applied to it. */
  screeningsAfterApproval: EvidenceScreening[];
  travelRule: { provider: string; sandbox: boolean; reference: string | null; status: string; exchange: string } | null;
  /**
   * The saved wallet recipient the payment went to (v2 §4.7): who saved it,
   * the owner who approved it, and for a wallet the supplier holds when and
   * by which link it was proven; for an exchange account whether the
   * exchange confirmed it. Null for a payout or an address not saved once.
   */
  recipient: {
    recipientId: string;
    deliveryKind: string;
    createdBy: string | null;
    approvedBy: string | null;
    approvedAt: string | null;
    ownership: { status: string; provenAt: string | null; challengeId: string | null } | null;
    exchange: { id: string | null; confirmed: boolean } | null;
  } | null;
  /** A cross-chain payment's CCTP receipt: the Sui burn, Circle's attestation, the mint. Null when it is not one. */
  crossChain: {
    status: string;
    destination: { chain: string; domain: number; mintRecipient: string };
    amountMinor: string;
    maxBridgeFeeMinor: string;
    burn: { suiDigest: string; at: string | null } | null;
    attestation: { nonce: string | null; at: string | null; sandbox: boolean } | null;
    mint: { chain: string; txHash: string; mintedMinor: string | null; at: string | null } | null;
  } | null;
  approval: {
    signingRequestId: string;
    purpose: string;
    status: string;
    threshold: number;
    signers: Array<{ userId: string; address: string; weight: number; signedAt: string | null; declined: boolean }>;
    spendingRule: { allowanceIds: string[]; policyIds: string[] } | null;
    secondApproval: { policy: string; payer: string; settleByMs: string } | null;
  } | null;
  quote: {
    reference: string;
    expiresAt: string;
    currency: string;
    rateMicro: string;
    receiveMinor: string;
    partnerFees: unknown;
    splashFeeMinor: string | null;
    sandbox: boolean;
  } | null;
  partner: { route: string; reference: string | null; bankRef: string | null; creditorAccountLast4: string | null } | null;
  iso20022: Pacs008Evidence | null;
  chain: {
    suiDigest: string | null;
    intentIdOnChain: string | null;
    walrusBlobId: string | null;
    contentHash: string | null;
    /** The settlement's receipt on chain: the SettlementAnchored event, as `<digest>#<event index>`. */
    receiptId: string | null;
  };
  gaps: string[];
  generatedAt: string;
  generatedBy: string;
};

/** Keys that may never appear in an evidence document (an account under any of its usual names; the last four is `…Last4`). */
const FORBIDDEN_KEY = /(secret|token|password|passphrase|private|mnemonic|sealed|salt|signature$|^signature|accountNumber|apiKey|txBytes|^iban$|^bban$|^account$|accountNo|Account(?!Last4)$)/i;
/** Values that may never appear: a Sui private key, a PEM key. */
const FORBIDDEN_VALUE = /(suiprivkey1|BEGIN [A-Z ]*PRIVATE KEY)/;
/**
 * Account-shaped values: eight digits or more (spaces or dashes between
 * allowed), or an IBAN. Amounts, times, scores and counts are numeric by
 * design and are let through by key; addresses, hashes, digests, ids and
 * ISO times by their shape.
 */
const ACCOUNT_LIKE = /\d(?:[ -]?\d){7,}/;
const IBAN_LIKE = /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/;
const NUMERIC_KEY = /(Minor|Micro|Ms|Score|^value$|^threshold$|^weight$|^exchangeRate$|^amount$)$/;
/** A provider's or the chain's own reference or id: whatever shape it has, it is theirs, not an account. */
const REFERENCE_KEY = /(Ref|^ref|reference|Id|^id|Ids|[dD]igest|^uetr|^endToEndId)$/;
const SAFE_SHAPE = [
  /^0x[0-9a-fA-F]+$/, // a Sui address or object id
  /^[0-9a-fA-F]{64}$/, // a hash
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/, // an ISO time
  /^([a-z]{2,5}_)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, // a UUID, or a Splash id (wsr_, wdr_, …)
  /^[1-9A-HJ-NP-Za-km-z]{32,44}(#\d+)?$/, // a Sui digest, or a receipt id <digest>#<index>
];

export class EvidenceLeak extends Error {
  constructor(path: string) {
    super(`the evidence document holds a field it must not: ${path}`);
    this.name = 'EvidenceLeak';
  }
}

/** Refuse a document holding a secret, a signature, a sealed value or a raw key. */
export function assertEvidenceClean(value: unknown, path = '$', key = ''): void {
  if (typeof value === 'string') {
    if (FORBIDDEN_VALUE.test(value)) throw new EvidenceLeak(path);
    if (NUMERIC_KEY.test(key) && /^-?\d+(\.\d+)?$/.test(value)) return;
    if (REFERENCE_KEY.test(key)) return;
    if (SAFE_SHAPE.some((re) => re.test(value))) return;
    if (ACCOUNT_LIKE.test(value) || IBAN_LIKE.test(value)) throw new EvidenceLeak(path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertEvidenceClean(v, `${path}[${i}]`, key));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEY.test(k)) throw new EvidenceLeak(`${path}.${k}`);
      assertEvidenceClean(v, `${path}.${k}`, k);
    }
  }
}

/** Mask anything account-like: keep the last four. */
export function maskTail(value: string | null | undefined, keep = 4): string | null {
  if (!value) return null;
  const v = value.trim();
  return v.length <= keep ? `****${v}` : `****${v.slice(-keep)}`;
}

export function evidenceJson(e: ControlsEvidence): string {
  assertEvidenceClean(e);
  return JSON.stringify(e, null, 2);
}

export function evidenceSha256(e: ControlsEvidence): string {
  return createHash('sha256').update(evidenceJson(e)).digest('hex');
}

const or = (v: string | null | undefined, none: string) => (v === null || v === undefined || v === '' ? none : v);

/** The PDF: the same fields as the JSON, in the same order, and the JSON's SHA-256. */
export function evidencePdf(e: ControlsEvidence): Uint8Array {
  const sha = evidenceSha256(e);
  const L: PdfLine[] = [
    { kind: 'title', text: 'Payment controls evidence' },
    { kind: 'field', label: 'Payment', value: `${e.payment.ref} (${e.payment.kind.replace('_', ' ')})` },
    { kind: 'field', label: 'Status', value: e.payment.status },
    { kind: 'field', label: 'Amount', value: `${e.payment.amountMinor} USDC minor units (6 decimals)` },
    { kind: 'field', label: 'Splash fee bound (max_fee)', value: or(e.payment.maxFeeMinor, 'None') },
    { kind: 'field', label: 'From wallet', value: e.payment.fromWallet },
    { kind: 'field', label: 'Paid to', value: e.payment.paidTo },
    { kind: 'field', label: 'Intent id', value: or(e.payment.intentId, 'Not yet on chain') },
    { kind: 'field', label: 'Opened', value: e.payment.createdAt },
    { kind: 'heading', text: 'Who was verified (KYB)' },
  ];
  if (e.kyb) {
    L.push(
      { kind: 'field', label: 'KYB case', value: e.kyb.caseId },
      { kind: 'field', label: 'Case state', value: e.kyb.state },
      { kind: 'field', label: 'Business lifecycle', value: or(e.kyb.lifecycle, 'Unknown') },
      { kind: 'field', label: 'Provider', value: or(e.kyb.provider, 'None') },
      { kind: 'field', label: 'Provider applicant reference', value: or(e.kyb.providerApplicantRef, 'None') },
    );
  } else L.push({ kind: 'text', text: 'No KYB case on file.' });
  L.push({ kind: 'heading', text: 'What was screened (KYT)' });
  L.push({ kind: 'field', label: 'Approved at', value: or(e.approvedAt, 'Not approved yet') });
  if (e.screenings.length === 0) L.push({ kind: 'text', text: e.approvedAt ? 'No screening of the address paid was on file when it was approved.' : 'No screening on file for the address paid.' });
  const screening = (s: EvidenceScreening) =>
    L.push(
      { kind: 'field', label: 'Address', value: `${s.address} (${s.chain})` },
      { kind: 'field', label: 'Provider', value: s.provider },
      { kind: 'field', label: 'Provider reference', value: or(s.reference, 'None: no answer') },
      { kind: 'field', label: 'Result', value: or(s.verdict, 'Not screened: the provider gave no answer') },
      { kind: 'field', label: 'Screened at', value: or(s.screenedAt, 'Not screened') },
      { kind: 'gap' },
    );
  e.screenings.forEach(screening);
  if (e.screeningsAfterApproval.length > 0) {
    L.push({ kind: 'text', text: 'Screened after the payment was approved (not the check that applied to it):' });
    e.screeningsAfterApproval.forEach(screening);
  }
  L.push({ kind: 'heading', text: 'Travel Rule' });
  if (e.travelRule) {
    L.push(
      { kind: 'field', label: 'Provider', value: `${e.travelRule.provider}${e.travelRule.sandbox ? ' (sandbox)' : ''}` },
      { kind: 'field', label: 'Reference', value: or(e.travelRule.reference, 'None') },
      { kind: 'field', label: 'Status', value: e.travelRule.status },
    );
  } else L.push({ kind: 'text', text: 'No Travel Rule message for this payment.' });
  if (e.recipient) {
    L.push(
      { kind: 'heading', text: 'The saved recipient' },
      { kind: 'field', label: 'Recipient', value: `${e.recipient.recipientId} (${e.recipient.deliveryKind})` },
      { kind: 'field', label: 'Saved by', value: or(e.recipient.createdBy, 'Not recorded') },
      { kind: 'field', label: 'Approved by', value: e.recipient.approvedBy ? `${e.recipient.approvedBy} at ${or(e.recipient.approvedAt, 'an unrecorded time')}` : 'No owner approved it' },
    );
    if (e.recipient.ownership) {
      L.push({ kind: 'field', label: 'Ownership proof', value: e.recipient.ownership.provenAt ? `${e.recipient.ownership.status}, proven ${e.recipient.ownership.provenAt} (link ${or(e.recipient.ownership.challengeId, 'not recorded')})` : e.recipient.ownership.status });
    }
    if (e.recipient.exchange) L.push({ kind: 'field', label: 'Exchange account', value: `${or(e.recipient.exchange.id, 'unknown')}, ${e.recipient.exchange.confirmed ? 'confirmed by the exchange' : 'not yet confirmed by the exchange'}` });
  }
  if (e.crossChain) {
    L.push(
      { kind: 'heading', text: 'Cross-chain receipt (CCTP V2)' },
      { kind: 'field', label: 'Status', value: e.crossChain.status },
      { kind: 'field', label: 'Destination', value: `${e.crossChain.destination.chain} (domain ${e.crossChain.destination.domain}), mint recipient ${e.crossChain.destination.mintRecipient}` },
      { kind: 'field', label: 'Sui burn', value: e.crossChain.burn ? `${e.crossChain.burn.suiDigest} at ${or(e.crossChain.burn.at, 'an unrecorded time')}` : 'Not burned yet' },
      { kind: 'field', label: "Circle's attestation", value: e.crossChain.attestation ? `nonce ${or(e.crossChain.attestation.nonce, 'none')}${e.crossChain.attestation.sandbox ? ' (sandbox)' : ''}` : 'Not attested yet' },
      { kind: 'field', label: 'Mint', value: e.crossChain.mint ? `${e.crossChain.mint.txHash} on ${e.crossChain.mint.chain}` : 'Not minted yet' },
    );
  }
  L.push({ kind: 'heading', text: 'Which rule and approval applied' });
  if (e.approval) {
    L.push(
      { kind: 'field', label: 'Signing request', value: `${e.approval.signingRequestId} (${e.approval.purpose}, ${e.approval.status})` },
      { kind: 'field', label: 'Threshold', value: String(e.approval.threshold) },
    );
    for (const s of e.approval.signers) {
      L.push({ kind: 'field', label: `Signer ${s.userId}`, value: `${s.address}, weight ${s.weight}, ${s.declined ? 'declined' : s.signedAt ? `signed ${s.signedAt}` : 'did not sign'}` });
    }
    L.push({ kind: 'field', label: 'Spending rule', value: e.approval.spendingRule ? `allowances ${e.approval.spendingRule.allowanceIds.join(', ') || 'none'}; policies ${e.approval.spendingRule.policyIds.join(', ') || 'none'}` : 'None: the owners signed' });
    L.push({ kind: 'field', label: 'Second approval', value: e.approval.secondApproval ? `policy ${e.approval.secondApproval.policy}, payer ${e.approval.secondApproval.payer}` : 'None' });
  } else L.push({ kind: 'text', text: 'No signing request on file.' });
  L.push({ kind: 'heading', text: 'Quote and partner' });
  if (e.quote) {
    L.push(
      { kind: 'field', label: 'Quote reference', value: `${e.quote.reference}${e.quote.sandbox ? ' (sandbox)' : ''}` },
      { kind: 'field', label: 'Rate (local per USDC x 1e6)', value: e.quote.rateMicro },
      { kind: 'field', label: 'Arrives', value: `${e.quote.receiveMinor} ${e.quote.currency} minor units` },
      { kind: 'field', label: 'Partner fees', value: JSON.stringify(e.quote.partnerFees ?? []) },
      { kind: 'field', label: 'Splash fee', value: or(e.quote.splashFeeMinor, 'None') },
      { kind: 'field', label: 'Quote expired at', value: e.quote.expiresAt },
    );
  } else L.push({ kind: 'text', text: 'No partner quote: this payment went to a wallet.' });
  if (e.partner) {
    L.push(
      { kind: 'field', label: 'Route', value: e.partner.route },
      { kind: 'field', label: 'Partner reference', value: or(e.partner.reference, 'None yet') },
      { kind: 'field', label: 'Bank reference', value: or(e.partner.bankRef, 'None yet') },
      { kind: 'field', label: 'Account', value: or(e.partner.creditorAccountLast4, 'Not on file') },
    );
  }
  if (e.iso20022) {
    L.push(
      { kind: 'heading', text: 'ISO 20022 (pacs.008, masked)' },
      { kind: 'field', label: 'End-to-end id', value: e.iso20022.endToEndId },
      { kind: 'field', label: 'UETR', value: e.iso20022.uetr },
      { kind: 'field', label: 'Debtor', value: `${e.iso20022.debtor.name}, ${or(e.iso20022.debtor.registration, 'no registration')}` },
      { kind: 'field', label: 'Creditor', value: `${e.iso20022.creditor.name}, ${e.iso20022.creditor.town} ${e.iso20022.creditor.country}` },
      { kind: 'field', label: 'Creditor account', value: `****${e.iso20022.creditorAccountLast4}` },
      { kind: 'field', label: 'Purpose', value: e.iso20022.purposeCode },
      { kind: 'field', label: 'Relationship', value: e.iso20022.relationship },
      { kind: 'field', label: 'Source of funds', value: or(e.iso20022.sourceOfFunds, 'None') },
    );
  }
  L.push(
    { kind: 'heading', text: 'On chain' },
    { kind: 'field', label: 'Sui digest', value: or(e.chain.suiDigest, 'Not sent') },
    { kind: 'field', label: 'Intent created', value: or(e.chain.intentIdOnChain, 'Not read') },
    { kind: 'field', label: 'Walrus blob', value: or(e.chain.walrusBlobId, 'Not read') },
    { kind: 'field', label: 'Content hash', value: or(e.chain.contentHash, 'Not read') },
    { kind: 'field', label: 'Receipt', value: or(e.chain.receiptId, 'Not read') },
  );
  if (e.gaps.length > 0) {
    L.push({ kind: 'heading', text: 'Not on file' });
    for (const g of e.gaps) L.push({ kind: 'text', text: `- ${g}` });
  }
  L.push({ kind: 'gap' }, { kind: 'field', label: 'Generated', value: `${e.generatedAt} by ${e.generatedBy}` }, { kind: 'field', label: 'SHA-256 of the JSON copy', value: sha });
  return renderTextPdf(L, { footer: `Controls evidence ${e.payment.ref}` });
}
