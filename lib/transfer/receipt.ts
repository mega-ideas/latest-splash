/**
 * The payment receipt (v2 brief 5.4 step 5; board "How it works", the
 * receipt card): receipt no., what the payee received, what was paid, the
 * Splash fee with its kind and tier, the partner's or Circle's fee as its own
 * line, the rate, who paid, who approved, the partner's reference when its
 * agreement is signed, the Sui transaction and a link that checks it.
 *
 * Every figure is given to this module; it makes none up. A fee Splash did
 * not charge is not shown as one, a partner is named only when signed
 * (lib/partners/signed-partners.ts), and nothing here carries an account
 * number, a wallet key or a signature: the payee's account is the masked form
 * the server gives (`••0391`).
 *
 * Pure and client-safe (the PDF is lib/transfer/receipt-pdf.ts, server-side).
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { toHex } from '@mysten/sui/utils';

import { kindLabel, formatUsdc, tierLabel } from '../fees/copy.ts';
import { tierOf, type FeeSchedule } from '../fees/schedule.ts';
import { formatMoney } from '../formatMoney.ts';
import { suiScanTxUrlOn } from '../explorer.ts';
import { PARTNERS, isPartnerId } from '../partners/signed-partners.ts';
import {
  MYINVOIS_PORTAL_URL,
  DOCUMENT_VERSION,
  type SelfBilledClassification,
  type SelfBilledInput,
} from '../myinvois/self-billed.ts';

export type ReceiptStatus = 'settled' | 'on_the_way' | 'failed';

export type ReceiptInput = {
  paymentRef: string;
  status: ReceiptStatus;
  createdAt?: string | null;
  paidAt: string | null;
  payer: { name: string };
  payee: { kind: 'bank' | 'splash_business' | 'wallet'; wallet?: string; name: string; masked: string | null; country?: string | null };
  /** USDC minor units the payee is paid (the principal). */
  sendMinor: string;
  splashFee: { minor: string; kind: number; feesOn: boolean };
  schedule?: FeeSchedule | null;
  /** A bank payout: what the account receives, in the local currency's minor units, and the rate (local per USDC, times 1e6). */
  receive?: { currency: string; minor: string; rateMicro: string } | null;
  /** Each fee that is not Splash's, as its own line. `partner` is a payout partner's id or `circle`. */
  partnerFees: Array<{ partner: string; label: string; currency: string; amountMinor: string }>;
  approvers: Array<{ name: string; signedAt?: string | null }>;
  suiDigest: string | null;
  network: 'mainnet' | 'testnet';
  partnerReference?: { partner: string; reference: string } | null;
  signedPartners: readonly string[];
  reference?: string | null;
  /** A bank payout: where the bank leg is, as the partner reports it. */
  bankCredit?: 'pending' | 'credited' | 'failed' | null;
};

export type PaymentReceipt = {
  schema: 'splash.receipt.v1';
  receiptNo: string;
  paymentRef: string;
  status: ReceiptStatus;
  /** Settled with a transaction to check: the only receipt that is final. */
  final: boolean;
  paidAt: string | null;
  paidFrom: string;
  payee: ReceiptInput['payee'];
  sendMinor: string;
  totalDebitMinor: string;
  receive: ReceiptInput['receive'] | null;
  fees: {
    splash: { minor: string; kind: number; kindLabel: string; tierLabel: string | null; feesOn: boolean };
    partner: Array<{ payee: 'circle' | 'partner'; label: string; currency: string; amountMinor: string }>;
  };
  approvers: Array<{ name: string; signedAt: string | null }>;
  /** Present only when the partner's agreement is signed. */
  partner: { name: string; reference: string } | null;
  suiDigest: string | null;
  network: 'mainnet' | 'testnet';
  verifyUrl: string | null;
  reference: string | null;
  bankCredit: 'pending' | 'credited' | 'failed' | null;
};

/** SPL-YYMM-XXXXXX: the month of the payment and six hex digits of its reference's hash. Stable for a payment. */
export function receiptNumber(paymentRef: string, iso: string | null | undefined): string {
  const d = iso ? new Date(iso) : null;
  const yymm = d && Number.isFinite(d.getTime()) ? `${String(d.getUTCFullYear() % 100).padStart(2, '0')}${String(d.getUTCMonth() + 1).padStart(2, '0')}` : '0000';
  const tail = toHex(sha256(new TextEncoder().encode(`splash-receipt|${paymentRef}`))).slice(0, 6).toUpperCase();
  return `SPL-${yymm}-${tail}`;
}

export function buildReceipt(input: ReceiptInput): PaymentReceipt {
  const send = BigInt(input.sendMinor);
  const fee = BigInt(input.splashFee.minor);
  const signed = new Set(input.signedPartners);
  let tier: string | null = null;
  const kindSchedule = input.schedule?.[input.splashFee.kind];
  if (kindSchedule) tier = tierLabel(kindSchedule, tierOf(kindSchedule, send).index);
  const final = input.status === 'settled' && Boolean(input.suiDigest);
  const partner =
    input.partnerReference && isPartnerId(input.partnerReference.partner) && signed.has(input.partnerReference.partner)
      ? { name: PARTNERS[input.partnerReference.partner].name, reference: input.partnerReference.reference }
      : null;
  return {
    schema: 'splash.receipt.v1',
    receiptNo: receiptNumber(input.paymentRef, input.createdAt ?? input.paidAt),
    paymentRef: input.paymentRef,
    status: input.status,
    final,
    paidAt: input.paidAt,
    paidFrom: input.payer.name,
    payee: input.payee,
    sendMinor: input.sendMinor,
    totalDebitMinor: (send + (input.splashFee.feesOn ? fee : 0n)).toString(),
    receive: input.receive ?? null,
    fees: {
      splash: { minor: input.splashFee.feesOn ? input.splashFee.minor : '0', kind: input.splashFee.kind, kindLabel: kindLabel(input.splashFee.kind), tierLabel: tier, feesOn: input.splashFee.feesOn },
      partner: input.partnerFees.map((f) => ({ payee: f.partner === 'circle' ? 'circle' : 'partner', label: f.label, currency: f.currency, amountMinor: f.amountMinor })),
    },
    approvers: input.approvers.map((a) => ({ name: a.name, signedAt: a.signedAt ?? null })),
    partner,
    suiDigest: input.suiDigest,
    network: input.network,
    verifyUrl: input.suiDigest ? suiScanTxUrlOn(input.network, input.suiDigest) : null,
    reference: input.reference ?? null,
    bankCredit: input.bankCredit ?? null,
  };
}

const usdc = (minor: string | bigint) => `${formatUsdc(BigInt(minor))} USDC`;
const short = (digest: string) => `${digest.slice(0, 4)}…${digest.slice(-4)}`;

/** The rate as printed: "57.40", "16,290.00". Local currency per USDC. */
function rateText(rateMicro: string): string {
  const micro = BigInt(rateMicro);
  const whole = (micro / 1_000_000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = (micro % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '').padEnd(2, '0');
  return `${whole}.${frac}`;
}

export type ReceiptRow = { label: string; value: string };

/** The receipt as labelled rows, in the order the card shows them. */
export function receiptRows(r: PaymentReceipt): ReceiptRow[] {
  const rows: ReceiptRow[] = [];
  rows.push({ label: 'Receipt no.', value: r.receiptNo });
  const received = r.receive ? formatMoney(BigInt(r.receive.minor), r.receive.currency) : usdc(r.sendMinor);
  rows.push({ label: `${r.payee.name} received`, value: received });
  rows.push({ label: 'You paid', value: usdc(r.totalDebitMinor) });
  const s = r.fees.splash;
  rows.push({
    label: 'Splash fee',
    value: s.feesOn ? [usdc(s.minor), s.kindLabel, s.tierLabel].filter(Boolean).join(' · ') : 'No Splash fee was charged',
  });
  for (const f of r.fees.partner) {
    const label = f.payee === 'circle' ? 'Circle fee' : 'Payout partner fee';
    rows.push({ label, value: f.currency === 'USDC' ? usdc(f.amountMinor) : formatMoney(BigInt(f.amountMinor), f.currency) });
  }
  if (r.receive) rows.push({ label: 'Rate', value: `1 USDC = ${rateText(r.receive.rateMicro)} ${r.receive.currency}` });
  rows.push({ label: 'Paid by', value: r.paidFrom });
  if (r.approvers.length > 0) rows.push({ label: 'Approved by', value: r.approvers.map((a) => a.name).join(', ') });
  if (r.partner) rows.push({ label: `${r.partner.name} reference`, value: r.partner.reference });
  if (r.reference) rows.push({ label: 'Reference', value: r.reference });
  if (r.bankCredit) rows.push({ label: 'Bank credit', value: r.bankCredit === 'credited' ? 'Credited to the account' : r.bankCredit === 'failed' ? 'Not credited: the USDC is returned to your wallet' : 'On its way to the account' });
  if (r.suiDigest) rows.push({ label: 'Sui transaction', value: short(r.suiDigest) });
  return rows;
}

/** Plain text for an email or a WhatsApp message. No account number, no key; the link is the payment's. */
export function receiptShareText(r: PaymentReceipt, link: string | null): string {
  const lines = [`Receipt ${r.receiptNo}`, `Paid to ${r.payee.name}${r.payee.masked ? ` (${r.payee.masked})` : ''}`];
  const rows = Object.fromEntries(receiptRows(r).map((x) => [x.label, x.value]));
  lines.push(`${r.payee.name} received ${rows[`${r.payee.name} received`]}`);
  lines.push(`Paid ${rows['You paid']}${r.fees.splash.feesOn ? ` (Splash fee ${usdc(r.fees.splash.minor)} included)` : ''}`);
  if (rows.Rate) lines.push(`Rate ${rows.Rate}`);
  lines.push(`Paid by ${r.paidFrom}${r.approvers.length ? `, approved by ${rows['Approved by']}` : ''}`);
  if (r.reference) lines.push(`Reference ${r.reference}`);
  if (r.verifyUrl) lines.push(`Check it on Sui: ${r.verifyUrl}`);
  if (link) lines.push(`Receipt: ${link}`);
  return lines.join('\n');
}

export function whatsappUrl(text: string): string {
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}

const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

export function isEmail(value: string): boolean {
  return value.length <= 200 && EMAIL.test(value);
}

/** A message for the person's own mail program. With no address the program asks for one. */
export function mailtoUrl(input: { to?: string; subject: string; body: string }): string {
  const to = input.to ?? '';
  if (to !== '' && !isEmail(to)) throw new RangeError('that is not an email address');
  if (/[\r\n]/.test(input.subject)) throw new RangeError('a subject is one line');
  return `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(input.subject)}&body=${encodeURIComponent(input.body)}`;
}

export function accountantMessage(r: PaymentReceipt, link: string | null, input: { business: string }): { subject: string; text: string } {
  return {
    subject: `Receipt ${r.receiptNo} · ${input.business}`,
    text: `${input.business} has sent you the receipt of a payment, for your records.\n\n${receiptShareText(r, null)}${link ? `\n\n${link}` : ''}`,
  };
}

// ─── Self-billed e-invoice (MyInvois) ───────────────────────────────────────

/**
 * What the file was checked against. The MyInvois SDK page for Invoice v1.0
 * (sdk.myinvois.hasil.gov.my/documents/invoice-v1-0/, read 31 Oct 2026) says
 * v1.0 is the version without signature validation and is kept alongside
 * v1.1, which it will later replace; the file is made as v1.0 because v1.1
 * needs the issuer's digital signature, which Splash does not hold. The
 * Inland Revenue Board's e-Invoice Specific Guideline, Version 4.7 (20 April
 * 2026), covers self-billed e-invoices; a later version (4.9) was named by one
 * secondary source and not found on an official page, so it is not cited.
 * Validate in the MyInvois sandbox before relying on a new field.
 */
export const EINVOICE_GUIDELINE = {
  source: 'MyInvois SDK, Invoice v1.0 (sdk.myinvois.hasil.gov.my) and the LHDN e-Invoice Specific Guideline',
  version: 'Specific Guideline 4.7 (20 April 2026); Invoice document v1.0',
  checkedOn: '2026-10-31',
  documentVersion: DOCUMENT_VERSION,
  portal: MYINVOIS_PORTAL_URL,
} as const;

export type EInvoiceOffer = { offered: true } | { offered: false; why: 'not_settled' | 'not_malaysian' | 'supplier_country_unknown' | 'supplier_in_malaysia' };

/** Offered to a Malaysian business for a settled payment to a supplier outside Malaysia, and to no one else. */
export function eInvoiceOffer(r: PaymentReceipt, who: { payerCountry: string | null; supplierCountry: string | null }): EInvoiceOffer {
  if (!r.final) return { offered: false, why: 'not_settled' };
  if (who.payerCountry?.toUpperCase() !== 'MY') return { offered: false, why: 'not_malaysian' };
  if (!who.supplierCountry) return { offered: false, why: 'supplier_country_unknown' };
  if (who.supplierCountry.toUpperCase() === 'MY') return { offered: false, why: 'supplier_in_malaysia' };
  return { offered: true };
}

export type EInvoiceDetails = {
  buyer: SelfBilledInput['buyer'];
  supplier: { name: string; country: string; addressLine?: string; city?: string };
  exchangeRateToMyr?: string;
  description: string;
  classification: SelfBilledClassification;
};

/** The file's input: the receipt's facts and the person's own details. The buyer's TIN, contact and the exchange rate are never filled in here. */
export function eInvoiceInputFromReceipt(r: PaymentReceipt, details: EInvoiceDetails, issuedAt: Date): SelfBilledInput {
  const cents = BigInt(r.sendMinor) / 10_000n;
  const amount = `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
  return {
    eInvoiceNumber: `SB-${r.receiptNo}`,
    issuedAt,
    buyer: details.buyer,
    supplier: details.supplier,
    currency: 'USDC',
    exchangeRateToMyr: details.exchangeRateToMyr,
    amount,
    description: details.description,
    classification: details.classification,
    supplierInvoiceNumber: r.reference ?? r.receiptNo,
    paymentReference: r.suiDigest ?? undefined,
  };
}
