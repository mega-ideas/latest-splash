import assert from 'node:assert/strict';
import test from 'node:test';

import { LAUNCH_SCHEDULE, FEE_KIND, tierOf } from '../lib/fees/schedule.ts';
import { tierLabel } from '../lib/fees/copy.ts';
import { selfBilledProblems } from '../lib/myinvois/self-billed.ts';
import {
  accountantMessage,
  buildReceipt,
  eInvoiceOffer,
  mailtoUrl,
  receiptNumber,
  receiptRows,
  receiptShareText,
  whatsappUrl,
  EINVOICE_GUIDELINE,
  eInvoiceInputFromReceipt,
} from '../lib/transfer/receipt.ts';
import { receiptPdf } from '../lib/transfer/receipt-pdf.ts';

/**
 * v2 Phase 3, brief 5.4 step 5: the receipt. Receipt no., amounts, the Splash
 * fee (its kind and tier label), the partner or Circle fee as its own line,
 * the rate, the payer, the approvers, the partner's reference when it is
 * signed, the Sui digest and a verify link; shared by email, WhatsApp, link
 * and PDF; sent to the accountant; and the self-billed e-invoice (MyInvois).
 */

const USDC = (n) => BigInt(Math.round(n * 1_000_000));
const DIGEST = '8xK3mPq2VnYtB6rLw9ZaCdE4FgH5JkMnPqRsTuVwXyZ1';

const BANK = {
  paymentRef: 'wdr_5f0e2c1a',
  status: 'settled',
  paidAt: '2026-10-20T03:05:00.000Z',
  payer: { name: 'Acme Trading Sdn. Bhd.' },
  payee: { kind: 'bank', name: 'Luzon Components Inc.', masked: '••0391', country: 'PH' },
  sendMinor: USDC(5_000).toString(),
  splashFee: { minor: USDC(35).toString(), kind: FEE_KIND.BANK_PAYOUT, feesOn: true },
  schedule: LAUNCH_SCHEDULE,
  receive: { currency: 'PHP', minor: '28700000', rateMicro: '57400000' },
  partnerFees: [{ partner: 'pdax', label: 'Bank transfer fee', currency: 'PHP', amountMinor: '2500' }],
  approvers: [{ name: 'Priya S.', signedAt: '2026-10-20T03:03:00.000Z' }, { name: 'Nadia R.', signedAt: '2026-10-20T03:04:00.000Z' }],
  suiDigest: DIGEST,
  network: 'mainnet',
  partnerReference: { partner: 'pdax', reference: 'PDX-77881' },
  signedPartners: [],
  reference: 'INV-0042',
};

test('the receipt number is stable for a payment and different for another', () => {
  const a = receiptNumber('wdr_5f0e2c1a', '2026-10-20T03:05:00.000Z');
  assert.match(a, /^SPL-2610-[0-9A-F]{6}$/);
  assert.equal(receiptNumber('wdr_5f0e2c1a', '2026-10-20T03:05:00.000Z'), a);
  assert.notEqual(receiptNumber('wdr_other', '2026-10-20T03:05:00.000Z'), a);
  assert.match(receiptNumber('wsr_1', '2027-01-02T00:00:00.000Z'), /^SPL-2701-/);
});

test('a bank receipt shows what the board shows: amounts, fee with its kind and tier, rate, approvers, digest and a verify link', () => {
  const r = buildReceipt(BANK);
  assert.equal(r.status, 'settled');
  assert.equal(r.final, true);
  assert.equal(r.receiptNo, receiptNumber(BANK.paymentRef, BANK.paidAt));
  assert.equal(r.fees.splash.kindLabel, 'Bank payout');
  assert.equal(r.fees.splash.tierLabel, tierLabel(LAUNCH_SCHEDULE[FEE_KIND.BANK_PAYOUT], tierOf(LAUNCH_SCHEDULE[FEE_KIND.BANK_PAYOUT], USDC(5_000)).index));
  assert.equal(r.totalDebitMinor, (USDC(5_000) + USDC(35)).toString());
  const rows = Object.fromEntries(receiptRows(r).map((x) => [x.label, x.value]));
  assert.match(rows['Luzon Components Inc. received'], /₱287,000\.00/);
  assert.equal(rows['You paid'], '5,035.00 USDC');
  assert.match(rows['Splash fee'], /^35\.00 USDC/);
  assert.match(rows['Splash fee'], /Bank payout/);
  assert.match(rows['Splash fee'], new RegExp(tierLabel(LAUNCH_SCHEDULE[FEE_KIND.BANK_PAYOUT], 1).replace(/[()]/g, '\\$&')));
  assert.match(rows.Rate, /^1 USDC = 57\.40 PHP$/);
  assert.equal(rows['Approved by'], 'Priya S., Nadia R.');
  assert.equal(rows['Receipt no.'], r.receiptNo);
  assert.equal(rows['Sui transaction'], `${DIGEST.slice(0, 4)}…${DIGEST.slice(-4)}`);
  assert.equal(rows.Reference, 'INV-0042');
  assert.equal(r.verifyUrl, `https://suiscan.xyz/mainnet/tx/${DIGEST}`);
  assert.ok(r.paidFrom === 'Acme Trading Sdn. Bhd.');
});

test('the partner’s fee is its own line in its own currency, never folded into Splash’s and never marked up', () => {
  const r = buildReceipt(BANK);
  assert.equal(r.fees.partner.length, 1);
  assert.equal(r.fees.partner[0].amountMinor, '2500');
  assert.equal(r.fees.partner[0].currency, 'PHP');
  const lines = receiptRows(r).filter((x) => /fee/i.test(x.label));
  assert.deepEqual(lines.map((x) => x.label), ['Splash fee', 'Payout partner fee']);
  assert.match(lines[1].value, /₱25\.00/);
  // Circle's own fee on a cross-chain payment is Circle's line.
  const cross = buildReceipt({
    ...BANK,
    payee: { kind: 'wallet', wallet: 'cross_chain', name: 'Orion Supplies LLC', masked: 'Base 0x5290…9EE7' },
    receive: undefined,
    splashFee: { minor: USDC(60).toString(), kind: FEE_KIND.CROSS_CHAIN, feesOn: true },
    partnerFees: [{ partner: 'circle', label: 'Circle fast transfer fee', currency: 'USDC', amountMinor: USDC(1.5).toString() }],
    partnerReference: null,
  });
  const circle = receiptRows(cross).find((x) => /Circle/.test(x.label));
  assert.ok(circle, 'Circle has its own line');
  assert.match(circle.value, /1\.50 USDC/);
});

test('the partner’s name and reference appear only once its agreement is signed', () => {
  const unsigned = buildReceipt(BANK);
  assert.equal(unsigned.partner, null);
  assert.ok(!JSON.stringify(receiptRows(unsigned)).includes('PDX-77881'));
  assert.ok(!JSON.stringify(unsigned).toLowerCase().includes('pdax'), 'no partner is named by default');
  const signed = buildReceipt({ ...BANK, signedPartners: ['pdax'] });
  assert.equal(signed.partner.reference, 'PDX-77881');
  assert.ok(receiptRows(signed).some((x) => /PDAX/i.test(x.label) && x.value === 'PDX-77881'));
});

test('a payment that is not settled is not a final receipt, and shows no verify link without a digest', () => {
  const r = buildReceipt({ ...BANK, status: 'on_the_way', suiDigest: null, approvers: [], paidAt: null });
  assert.equal(r.final, false);
  assert.equal(r.verifyUrl, null);
  assert.match(r.receiptNo, /^SPL-/);
  const rows = receiptRows(r);
  assert.ok(!rows.some((x) => x.label === 'Sui transaction'));
  assert.ok(!rows.some((x) => x.label === 'Approved by'));
});

test('the verify link follows the network the payment settled on', () => {
  assert.match(buildReceipt({ ...BANK, network: 'testnet' }).verifyUrl, /testnet/);
  assert.doesNotMatch(buildReceipt({ ...BANK, network: 'mainnet' }).verifyUrl, /testnet/);
});

test('a payment to a Splash business or a wallet has no rate and no partner, and says what was paid', () => {
  const r = buildReceipt({
    ...BANK,
    payee: { kind: 'splash_business', name: 'Orion Supplies Sdn Bhd', masked: '0x9c1…7e20' },
    receive: undefined,
    partnerFees: [],
    partnerReference: null,
    splashFee: { minor: '0', kind: FEE_KIND.SPLASH_BUSINESS, feesOn: true },
  });
  const rows = Object.fromEntries(receiptRows(r).map((x) => [x.label, x.value]));
  assert.equal(rows['Orion Supplies Sdn Bhd received'], '5,000.00 USDC');
  assert.equal(rows.Rate, undefined);
  assert.match(rows['Splash fee'], /^0\.00 USDC|Free/);
  assert.equal(rows['You paid'], '5,000.00 USDC');
});

test('while fees are off the receipt says no Splash fee was charged, and does not invent one', () => {
  const r = buildReceipt({ ...BANK, splashFee: { minor: '0', kind: FEE_KIND.BANK_PAYOUT, feesOn: false } });
  assert.equal(r.totalDebitMinor, USDC(5_000).toString());
  const fee = receiptRows(r).find((x) => x.label === 'Splash fee');
  assert.match(fee.value, /No Splash fee/);
});

// ─── Sharing ────────────────────────────────────────────────────────────────

test('the share text carries the receipt and the link, and never an account number or a wallet key', () => {
  const r = buildReceipt(BANK);
  const text = receiptShareText(r, 'https://splash.example/receipt/tok_abc');
  assert.match(text, /Receipt SPL-2610-/);
  assert.match(text, /Luzon Components Inc\./);
  assert.match(text, /5,035\.00 USDC/);
  assert.match(text, /https:\/\/splash\.example\/receipt\/tok_abc/);
  assert.match(text, /••0391/);
  assert.ok(!/\d{8,}/.test(text.replace(DIGEST, '')), 'no long digit string');
  const none = receiptShareText(r, null);
  assert.ok(!/receipt\/tok/.test(none));
});

test('WhatsApp and email are links the person sends from their own app', () => {
  const r = buildReceipt(BANK);
  const text = receiptShareText(r, 'https://splash.example/receipt/tok_abc');
  const wa = whatsappUrl(text);
  assert.ok(wa.startsWith('https://wa.me/?text='));
  assert.equal(decodeURIComponent(wa.slice('https://wa.me/?text='.length)), text);
  const mail = mailtoUrl({ to: 'ana@example.com', subject: `Receipt ${r.receiptNo}`, body: text });
  assert.ok(mail.startsWith('mailto:ana%40example.com?') || mail.startsWith('mailto:ana@example.com?'));
  assert.match(mail, /subject=Receipt%20SPL-2610-/);
  assert.throws(() => mailtoUrl({ to: 'not an email', subject: 's', body: 'b' }));
  assert.throws(() => mailtoUrl({ to: 'a@b.co\nBcc: x@y.z', subject: 's', body: 'b' }));
});

test('the accountant gets the receipt, the PDF is named and the e-invoice is offered when it applies', () => {
  const r = buildReceipt(BANK);
  const m = accountantMessage(r, 'https://splash.example/receipt/tok_abc', { business: 'Acme Trading Sdn. Bhd.' });
  assert.match(m.subject, /Acme Trading Sdn\. Bhd\./);
  assert.match(m.subject, new RegExp(r.receiptNo));
  assert.match(m.text, /https:\/\/splash\.example\/receipt\/tok_abc/);
  assert.match(m.text, /5,035\.00 USDC/);
});

test('the PDF is a PDF that carries the receipt', () => {
  const pdf = receiptPdf(buildReceipt(BANK));
  const text = Buffer.from(pdf).toString('latin1');
  assert.ok(text.startsWith('%PDF-1.'));
  assert.match(text, /SPL-2610-/);
  assert.match(text, /Luzon Components Inc\./);
  assert.ok(text.trimEnd().endsWith('%%EOF'));
});

// ─── Self-billed e-invoice (MyInvois) ───────────────────────────────────────

test('the self-billed e-invoice is offered only to a Malaysian business for a settled payment to a supplier outside Malaysia', () => {
  const r = buildReceipt(BANK);
  assert.deepEqual(eInvoiceOffer(r, { payerCountry: 'MY', supplierCountry: 'PH' }), { offered: true });
  const notMy = eInvoiceOffer(r, { payerCountry: 'SG', supplierCountry: 'PH' });
  assert.equal(notMy.offered, false);
  assert.equal(notMy.why, 'not_malaysian');
  const mySupplier = eInvoiceOffer(r, { payerCountry: 'MY', supplierCountry: 'MY' });
  assert.equal(mySupplier.why, 'supplier_in_malaysia');
  const unknown = eInvoiceOffer(r, { payerCountry: 'MY', supplierCountry: null });
  assert.equal(unknown.offered, false);
  assert.equal(unknown.why, 'supplier_country_unknown');
  const unsettled = eInvoiceOffer(buildReceipt({ ...BANK, status: 'on_the_way', suiDigest: null }), { payerCountry: 'MY', supplierCountry: 'PH' });
  assert.equal(unsettled.why, 'not_settled');
});

test('the e-invoice cites the LHDN guideline it was checked against, with a version', () => {
  assert.match(EINVOICE_GUIDELINE.source, /myinvois|lhdn|hasil\.gov\.my/i);
  assert.match(EINVOICE_GUIDELINE.version, /\d/);
  assert.match(EINVOICE_GUIDELINE.checkedOn, /^2026-/);
  assert.ok(EINVOICE_GUIDELINE.portal.startsWith('https://myinvois.hasil.gov.my'));
  assert.ok(EINVOICE_GUIDELINE.documentVersion);
});

test('the e-invoice is made from the receipt and the person’s own details, and nothing is filled in for them', () => {
  const r = buildReceipt(BANK);
  const detail = {
    buyer: { name: 'Acme Trading Sdn. Bhd.', tin: 'C1234567890', registrationNumber: '202001012345', addressLine: 'Level 8, Menara Acme', city: 'Kuala Lumpur', postcode: '50450', stateCode: '14', phone: '+60312345678' },
    supplier: { name: 'Luzon Components Inc.', country: 'PH' },
    exchangeRateToMyr: '4.2',
    description: 'Electronic components',
    classification: '034',
  };
  const input = eInvoiceInputFromReceipt(r, detail, new Date('2026-10-21T00:00:00Z'));
  assert.equal(input.currency, 'USDC');
  assert.equal(input.amount, '5000.00');
  assert.equal(input.paymentReference, DIGEST);
  assert.equal(input.supplierInvoiceNumber, 'INV-0042');
  assert.match(input.eInvoiceNumber, /^SB-SPL-2610-/);
  assert.deepEqual(selfBilledProblems(input), []);
  // Without the business's own TIN or the exchange rate, the file is not made.
  const missing = eInvoiceInputFromReceipt(r, { ...detail, buyer: { ...detail.buyer, tin: '' }, exchangeRateToMyr: '' }, new Date('2026-10-21T00:00:00Z'));
  const problems = selfBilledProblems(missing);
  assert.ok(problems.some((p) => /TIN/.test(p)));
  assert.ok(problems.some((p) => /exchange rate/i.test(p)));
  // No supplier invoice number: the payment's reference stands in; with neither, the receipt number does.
  const bare = eInvoiceInputFromReceipt(buildReceipt({ ...BANK, reference: null }), detail, new Date('2026-10-21T00:00:00Z'));
  assert.equal(bare.supplierInvoiceNumber, r.receiptNo);
});
