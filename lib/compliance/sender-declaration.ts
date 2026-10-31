/**
 * The sender-declaration pack (v2 §4.6, §4.7, D5a): what a supplier hands
 * its exchange when USDC arrives from a business's own self-hosted wallet,
 * which no VASP holds and so no VASP can send Travel Rule data for.
 *
 * The pack says who paid (the business, from its verified profile), from
 * which wallet, to which deposit address on which network, how much, for
 * which invoice, and the transaction digest once there is one. It is a
 * declaration by the paying business, generated from what Splash holds: no
 * field is filled from the request except the invoice's number and date,
 * which are the business's own words and are labelled so.
 *
 * Output: the same content as JSON (schema `splash.sender-declaration.v1`)
 * and as a PDF, with the SHA-256 of the JSON so either can be matched to the
 * other. The exchange is named only when its agreement is signed
 * (lib/partners/signed-partners.ts); otherwise its role.
 */
import { createHash } from 'node:crypto';

import { partnerLabel, type PartnerId } from '../partners/signed-partners.ts';
import { renderTextPdf, withReducedNote, type PdfLine } from './pdf-text.ts';
import type { TravelRuleExchange } from './sumsub.ts';

export type SenderDeclarationInput = {
  payer: {
    legalName: string;
    registrationNumber: string | null;
    country: string | null;
    address: string | null;
  };
  /** The business's own wallet the USDC leaves from. */
  walletAddress: string;
  /** How the wallet signs, from the payment's own signing request. Without it the statement claims nothing about shared control. */
  walletControl?: { signerKind: string; threshold: number } | null;
  supplier: { name: string; exchange: TravelRuleExchange; depositAddress: string };
  /** USDC, 6 decimals. */
  amountMinor: bigint;
  invoice: { number: string | null; date: string | null };
  paymentRef: string;
  suiDigest: string | null;
  generatedAt: Date;
  signedPartners: ReadonlySet<PartnerId>;
};

export type SenderDeclaration = {
  schema: 'splash.sender-declaration.v1';
  paymentRef: string;
  payer: { legalName: string; registrationNumber: string | null; country: string | null; address: string | null };
  sendingWallet: { address: string; network: 'Sui'; kind: 'self-hosted business wallet' };
  recipient: { supplierName: string; exchange: string; depositAddress: string; network: 'Sui' };
  asset: 'USDC';
  amount: string;
  invoice: { number: string | null; date: string | null; declaredByPayer: true };
  suiDigest: string | null;
  statement: string;
  generatedAt: string;
};

const usdc = (minor: bigint) => {
  const s = minor.toString().padStart(7, '0');
  return `${s.slice(0, -6)}.${s.slice(-6)}`;
};

/** What the statement says of who controls the sending wallet: shared control only for a multisig wallet, with its threshold. */
function controlOf(control: SenderDeclarationInput['walletControl']): string {
  if (control && control.signerKind === 'multisig' && control.threshold >= 2) {
    return `which its owners control together (${control.threshold} signatures are needed for a payment)`;
  }
  return 'which the business controls';
}

/** Free text from the business: printable, single-line, cut short. */
function clean(value: string | null, max: number): string | null {
  if (value === null) return null;
  const v = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  return v || null;
}

export function senderDeclaration(input: SenderDeclarationInput): { json: SenderDeclaration; sha256: string; pdf: Uint8Array } {
  if (input.amountMinor <= 0n) throw new Error('a sender declaration needs an amount');
  const exchange = partnerLabel(input.supplier.exchange, input.signedPartners);
  const json: SenderDeclaration = {
    schema: 'splash.sender-declaration.v1',
    paymentRef: input.paymentRef,
    payer: {
      legalName: input.payer.legalName,
      registrationNumber: input.payer.registrationNumber,
      country: input.payer.country,
      address: input.payer.address,
    },
    sendingWallet: { address: input.walletAddress, network: 'Sui', kind: 'self-hosted business wallet' },
    recipient: { supplierName: input.supplier.name, exchange, depositAddress: input.supplier.depositAddress, network: 'Sui' },
    asset: 'USDC',
    amount: usdc(input.amountMinor),
    invoice: { number: clean(input.invoice.number, 64), date: clean(input.invoice.date, 32), declaredByPayer: true },
    suiDigest: input.suiDigest,
    statement:
      `${input.payer.legalName} declares that it sends ${usdc(input.amountMinor)} USDC on Sui from its own self-hosted business wallet, ` +
      `${controlOf(input.walletControl)}, to the deposit address above, in payment to the supplier named above. ` +
      'No exchange or other provider holds the sending wallet, so this declaration carries the sender details the receiving exchange asks for.',
    generatedAt: input.generatedAt.toISOString(),
  };
  const text = JSON.stringify(json);
  const sha256 = createHash('sha256').update(text).digest('hex');
  const lines: PdfLine[] = [
    { kind: 'title', text: 'Sender declaration' },
    { kind: 'text', text: `For the supplier to give ${exchange} with this deposit.` },
    { kind: 'heading', text: 'Sender' },
    { kind: 'field', label: 'Business', value: json.payer.legalName },
    { kind: 'field', label: 'Registration number', value: json.payer.registrationNumber ?? 'Not on file' },
    { kind: 'field', label: 'Country', value: json.payer.country ?? 'Not on file' },
    { kind: 'field', label: 'Registered address', value: json.payer.address ?? 'Not on file' },
    { kind: 'field', label: 'Sending wallet (Sui)', value: json.sendingWallet.address },
    { kind: 'heading', text: 'Recipient' },
    { kind: 'field', label: 'Supplier', value: json.recipient.supplierName },
    { kind: 'field', label: 'Exchange', value: exchange },
    { kind: 'field', label: 'Deposit address (Sui)', value: json.recipient.depositAddress },
    { kind: 'heading', text: 'Payment' },
    { kind: 'field', label: 'Amount', value: `${json.amount} USDC` },
    { kind: 'field', label: 'Invoice number (as stated by the sender)', value: json.invoice.number ?? 'Not given' },
    { kind: 'field', label: 'Invoice date (as stated by the sender)', value: json.invoice.date ?? 'Not given' },
    { kind: 'field', label: 'Payment reference', value: json.paymentRef },
    { kind: 'field', label: 'Sui transaction digest', value: json.suiDigest ?? 'Not sent yet' },
    { kind: 'heading', text: 'Declaration' },
    { kind: 'text', text: json.statement },
    { kind: 'gap' },
    { kind: 'field', label: 'Generated', value: json.generatedAt },
    { kind: 'field', label: 'SHA-256 of the JSON copy', value: sha256 },
  ];
  return { json, sha256, pdf: renderTextPdf(withReducedNote(lines), { footer: `Sender declaration ${json.paymentRef}` }) };
}
