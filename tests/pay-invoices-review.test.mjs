import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { migratedDb } from './helpers/store-db.mjs';

/* v2 brief 5.8, the independent review of Invoices (Get paid and Pay
   invoices). Each test here was red against 6e72483.

     1. one supplier invoice cannot be scheduled twice to the same recipient
        by typing the supplier's name another way (High);
     2. a recipient has to resemble the confirmed supplier, or a person says
        why; changing the supplier after a match clears the match;
     3. a PDF's printed payment details are read, or the page says they were
        not checked;
     4. the hand-off carries the fee rule, and a non-USD invoice is not handed
        off without a rate quote;
     5. a supplier name in Chinese or Thai script can be confirmed;
     6. a recipient whose wallet is Splash's own is never matched or paid;
     7. the receipt's Sui link follows the network the payment settled on;
     8. a remade e-invoice keeps the earlier file's hash; a schedule that
        raced a change is refused;
     9. Get paid: the payer's reported reference is never the evidence for
        Mark as paid, and only the roles that may change invoices can. */

const ACME_MAKER = { orgId: 'acme', userId: 'u_maker', role: 'MAKER' };
const key = (n) => `2c4e28ba-2fa1-11d2-883f-${String(n).padStart(12, '0')}`;
const DIGEST = '4XcQm8GkB3bAZ7f2s9dLp1QwErTyUiKp5zXcVbNm2HjK';
const OPERATOR = '0x' + '77'.repeat(32);

const INVOICE = `Mabuhay Components Inc.
12 Ayala Avenue, Makati City, Philippines

Bill to: Acme Trading Sdn Bhd, Kuala Lumpur, Malaysia

Invoice No: MC-2026-0412
Invoice Date: 2026-10-20
Due Date: 2026-11-19

Capacitor reels (x40)           1,250.00

Total due: USD 1,250.00`;

const RECIPIENTS = [
  { id: 'r_mabuhay', name: 'Mabuhay Components Inc', country: 'PH', payoutMethod: 'WALLET', screeningVerdict: 'CLEAR', walletAddress: '0x' + 'ab'.repeat(32), ownershipProvenAt: '2026-10-01T00:00:00.000Z' },
  { id: 'r_kl', name: 'Klang Packaging Sdn Bhd', country: 'MY', payoutMethod: 'WALLET', screeningVerdict: 'ATTESTED', walletAddress: '0x' + 'ef'.repeat(32), ownershipProvenAt: '2026-10-01T00:00:00.000Z' },
  { id: 'r_sz', name: '深圳华强电子有限公司', country: 'CN', payoutMethod: 'WALLET', screeningVerdict: 'CLEAR', walletAddress: '0x' + '34'.repeat(32), ownershipProvenAt: '2026-10-01T00:00:00.000Z' },
  { id: 'r_op', name: 'Mabuhay Components Treasury', country: 'PH', payoutMethod: 'WALLET', screeningVerdict: 'CLEAR', walletAddress: OPERATOR, ownershipProvenAt: '2026-10-01T00:00:00.000Z' },
];

const BUSINESS = { name: 'Acme Trading', legalName: 'Acme Trading Sdn Bhd', registrationNumber: '202001012345', addressLine1: '1 Jalan Ampang', addressCity: 'Kuala Lumpur', addressPostalCode: '50450', addressCountry: 'MY' };

function deps(over = {}) {
  const calls = { flow: 0 };
  const d = {
    modelReader: null,
    listRecipients: async (orgId) => (orgId === 'acme' ? RECIPIENTS : []),
    readBusiness: async () => BUSINESS,
    paymentFlow: { wired: false, start: async () => ({ ok: false, code: 'PAYMENT_FLOW_NOT_WIRED', status: 501, error: 'not wired' }) },
    stablecoinOnly: () => false,
    splashOwnedAddresses: async () => [OPERATOR],
    now: () => new Date('2026-10-25T03:00:00Z'),
    ...over,
  };
  return { d, calls };
}

function wiredFlow(calls, intent = 'pi_0001') {
  return { wired: true, start: async (request) => { calls.flow += 1; calls.last = request; return { ok: true, paymentIntentId: intent }; } };
}

const lib = () => import('../lib/server/bills.ts');
const source = (relative) => readFile(new URL(`../${relative}`, import.meta.url), 'utf8');

const CONFIRMED = { payee: 'Mabuhay Components Inc.', invoiceNumber: 'MC-2026-0412', amount: '1250.00', currency: 'USD', dueDate: '2026-11-19', invoiceDate: '2026-10-20', payeeCountry: 'PH' };

async function intake(db, d, text = INVOICE, n = 1) {
  const { handleBillIntake } = await lib();
  return handleBillIntake(db, ACME_MAKER, { intakeKey: key(n), documentName: 'inv.txt', text }, d);
}

async function confirmMatch(db, d, { text = INVOICE, n = 1, fields = CONFIRMED, recipientId = 'r_mabuhay', reason } = {}) {
  const { handleBillAction } = await lib();
  const made = await intake(db, d, text, n);
  const id = made.body.bill.id;
  const confirmed = await handleBillAction(db, ACME_MAKER, id, { action: 'confirm', fields }, d);
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  const matched = await handleBillAction(db, ACME_MAKER, id, { action: 'match', recipientId, ...(reason ? { reason } : {}) }, d);
  return { id, matched };
}

// ── 1. Duplicates by who is paid ────────────────────────────────────────────

test('the same invoice number to the same recipient is a duplicate however the supplier is spelled', async () => {
  const { db, client } = await migratedDb();
  const { handleBillAction } = await lib();
  const { d } = deps();
  const one = await confirmMatch(db, d);
  assert.equal((await handleBillAction(db, ACME_MAKER, one.id, { action: 'schedule', payOn: '2026-11-15' }, d)).status, 200);
  // The same invoice brought in again with one more word, under another spelling.
  const copy = INVOICE.replace('Capacitor reels (x40)', 'Capacitor reels (x40) shipped');
  const two = await confirmMatch(db, d, {
    text: copy, n: 2,
    fields: { ...CONFIRMED, payee: 'Mabuhay Components Philippines' },
    reason: 'Same supplier, its Philippine trading name',
  });
  assert.equal(two.matched.status, 200, JSON.stringify(two.matched.body));
  assert.equal(two.matched.body.bill.facts.sameNumber, true, 'found by the recipient, not by the typed name');
  const refused = await handleBillAction(db, ACME_MAKER, two.id, { action: 'schedule', payOn: '2026-11-15' }, d);
  assert.equal(refused.status, 409);
  // A race past the check meets the recipient-keyed index.
  await assert.rejects(
    client.query(`UPDATE payable_invoices SET status = 'scheduled', scheduled_for = '2026-11-15' WHERE id = $1`, [two.id]),
    /payable_invoices_recipient_number_once_unique|duplicate key/,
  );
  await client.close();
});

test('the same amount to the same recipient under another spelling needs a reason too', async () => {
  const { findDuplicates } = await import('../lib/bills/duplicates.ts');
  const at = new Date('2026-10-01T00:00:00Z');
  const base = { currency: 'USD', invoiceDate: '2026-10-20', createdAt: at, amountMinor: 5n, recipientId: 'r_1' };
  const found = findDuplicates(
    { ...base, id: 'b1', status: 'review', payeeKey: 'mabuhay components philippines', invoiceNumberKey: 'MC2' },
    [{ ...base, id: 'b2', status: 'paid', payeeKey: 'mabuhay components', invoiceNumberKey: 'MC1' }],
  );
  assert.deepEqual(found.map((f) => f.kind), ['same_amount']);
  const page = await source('components/invoices/PayInvoices.tsx');
  assert.doesNotMatch(page, /No other invoice in your list has this supplier’s number/, 'the copy says what was checked');
});

test('approve checks for a duplicate again before the hand-off', async () => {
  const bills = await source('lib/server/bills.ts');
  const pay = bills.slice(bills.indexOf('export async function handleBillPay'));
  assert.match(pay.slice(0, pay.indexOf('deps.paymentFlow.start')), /findDuplicates|sameNumber/);
});

// ── 2. The recipient resembles the supplier ─────────────────────────────────

test('a recipient whose name is unlike the confirmed supplier needs a written reason', async () => {
  const { db, client } = await migratedDb();
  const { handleBillAction } = await lib();
  const { d } = deps();
  const { id, matched } = await confirmMatch(db, d, { recipientId: 'r_kl' });
  assert.equal(matched.status, 409);
  assert.equal(matched.body.code, 'name_mismatch');
  assert.equal((await handleBillAction(db, ACME_MAKER, id, { action: 'match', recipientId: 'r_kl', reason: 'short' }, d)).status, 400);
  const withReason = await handleBillAction(db, ACME_MAKER, id, { action: 'match', recipientId: 'r_kl', reason: 'Klang pays for Mabuhay under our 2026 agency deal' }, d);
  assert.equal(withReason.status, 200);
  assert.equal(withReason.body.bill.recipient.id, 'r_kl');
  assert.equal(withReason.body.bill.recipientNameDiffers, true);
  assert.equal(withReason.body.bill.matchReason, 'Klang pays for Mabuhay under our 2026 agency deal');
  await client.close();
});

test('changing the supplier after a match clears the match', async () => {
  const { db, client } = await migratedDb();
  const { handleBillAction } = await lib();
  const { d } = deps();
  const { id, matched } = await confirmMatch(db, d);
  assert.equal(matched.body.bill.recipient.id, 'r_mabuhay');
  const sameName = await handleBillAction(db, ACME_MAKER, id, { action: 'confirm', fields: { ...CONFIRMED, amount: '1250.50' } }, d);
  assert.equal(sameName.body.bill.recipient?.id, 'r_mabuhay', 'an amount change keeps who is paid');
  const other = await handleBillAction(db, ACME_MAKER, id, { action: 'confirm', fields: { ...CONFIRMED, payee: 'Klang Packaging Sdn Bhd', payeeCountry: 'MY' } }, d);
  assert.equal(other.status, 200);
  assert.equal(other.body.bill.recipient, null);
  assert.equal(other.body.bill.facts.recipientMatched, false);
  await client.close();
});

// ── 3. A PDF's printed payment details ──────────────────────────────────────

test('a PDF’s printed account or wallet is read, checked and warned about', async () => {
  const { db, client } = await migratedDb();
  const { handleBillIntake, handleBillAction } = await lib();
  const { d } = deps({
    modelReader: async () => ({ ...CONFIRMED, paymentAccounts: ['5555-4444-3333', 'not an account', '1'.repeat(80)], paymentWallets: ['0x' + '66'.repeat(32), '0xnope'] }),
  });
  const made = await handleBillIntake(db, ACME_MAKER, { intakeKey: key(7), documentName: 'inv.pdf', pdfBase64: 'JVBERi0xLjQK' }, d);
  assert.equal(made.status, 201);
  assert.deepEqual(made.body.bill.extraction.paymentDetails, { walletAddresses: ['0x' + '66'.repeat(32)], accountNumbers: ['555544443333'] });
  assert.equal(made.body.bill.extraction.paymentDetailsRead, 'zeke_pdf');
  const id = made.body.bill.id;
  await handleBillAction(db, ACME_MAKER, id, { action: 'confirm', fields: CONFIRMED }, d);
  const matched = await handleBillAction(db, ACME_MAKER, id, { action: 'match', recipientId: 'r_mabuhay' }, d);
  assert.equal(matched.body.bill.paymentDetailsDiffer, true);
  // A reading with no payment details says it did not check them.
  const quiet = deps({ modelReader: async () => ({ amount: '10', currency: 'USD' }) }).d;
  const unread = await handleBillIntake(db, ACME_MAKER, { intakeKey: key(8), pdfBase64: 'JVBERi0xLjUK' }, quiet);
  assert.equal(unread.body.bill.extraction.paymentDetailsRead, 'not_read');
  const page = await source('components/invoices/PayInvoices.tsx');
  assert.match(page, /paymentDetailsRead === 'not_read'/);
  const prompt = await source('lib/server/bills-deps.ts');
  assert.match(prompt, /paymentAccounts/);
  assert.match(prompt, /paymentWallets/);
  await client.close();
});

// ── 4. The fee rule and the rate ────────────────────────────────────────────

test('the hand-off carries the fee rule, and a non-USD invoice waits for a rate quote', async () => {
  const { db, client } = await migratedDb();
  const { handleBillAction, handleBillPay } = await lib();
  const { d, calls } = deps();
  const usd = await confirmMatch(db, d);
  await handleBillAction(db, ACME_MAKER, usd.id, { action: 'schedule', payOn: '2026-11-15' }, d);
  d.paymentFlow = wiredFlow(calls);
  assert.equal((await handleBillPay(db, ACME_MAKER, usd.id, d)).status, 200);
  assert.equal(calls.last.settlementAsset, 'USDC');
  assert.equal(calls.last.feeRule, 'quote_in_transfer_shown_fee_is_max_fee');

  const php = INVOICE.replace('MC-2026-0412', 'MC-2026-0500').replace('USD 1,250.00', 'PHP 70,000.00');
  const peso = await confirmMatch(db, d, { text: php, n: 2, fields: { ...CONFIRMED, invoiceNumber: 'MC-2026-0500', amount: '70000', currency: 'PHP' } });
  assert.equal(peso.matched.body.bill.needsRateQuote, true);
  await handleBillAction(db, ACME_MAKER, peso.id, { action: 'schedule', payOn: '2026-11-15' }, d);
  const before = calls.flow;
  const refused = await handleBillPay(db, ACME_MAKER, peso.id, d);
  assert.equal(refused.status, 422);
  assert.equal(refused.body.code, 'fx_quote_needed');
  assert.equal(calls.flow, before, 'nothing handed off');
  const hook = await source('lib/bills/payment-hook.ts');
  assert.match(hook, /max_fee/);
  assert.match(hook, /feeRule: 'quote_in_transfer_shown_fee_is_max_fee'/);
  await client.close();
});

// ── 5. Names in any script ──────────────────────────────────────────────────

test('a supplier named in Chinese or Thai script can be confirmed and matched', async () => {
  const { payeeKey } = await import('../lib/bills/duplicates.ts');
  assert.notEqual(payeeKey('深圳华强电子有限公司'), '');
  assert.notEqual(payeeKey('บริษัท สยามพาร์ท จำกัด'), '');
  assert.equal(payeeKey('Mabuhay Components, Inc.'), 'mabuhay components', 'Latin suffixes still go');
  const { db, client } = await migratedDb();
  const { d } = deps();
  const { matched } = await confirmMatch(db, d, { fields: { ...CONFIRMED, payee: '深圳华强电子有限公司', payeeCountry: 'CN' }, recipientId: 'r_sz' });
  assert.equal(matched.status, 200, JSON.stringify(matched.body));
  assert.equal(matched.body.bill.recipientNameDiffers, false);
  await client.close();
});

// ── 6. Never to Splash's own wallet ─────────────────────────────────────────

test('a recipient whose wallet is a Splash address is never matched or paid', async () => {
  const { db, client } = await migratedDb();
  const { handleBillAction, handleBillPay } = await lib();
  const { d, calls } = deps();
  const { id, matched } = await confirmMatch(db, d, { recipientId: 'r_op' });
  assert.equal(matched.status, 409);
  assert.equal(matched.body.code, 'splash_address');
  // Matched before the address became Splash's: the hand-off refuses.
  const early = deps({ splashOwnedAddresses: async () => [] }).d;
  assert.equal((await handleBillAction(db, ACME_MAKER, id, { action: 'match', recipientId: 'r_op' }, early)).status, 200);
  await handleBillAction(db, ACME_MAKER, id, { action: 'schedule', payOn: '2026-11-15' }, d);
  d.paymentFlow = wiredFlow(calls);
  const refused = await handleBillPay(db, ACME_MAKER, id, d);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'splash_address');
  assert.equal(calls.flow, 0);
  // A list that cannot be read is not an empty list.
  const unknown = deps({ splashOwnedAddresses: async () => { throw new Error('rpc down'); }, paymentFlow: wiredFlow(calls) }).d;
  assert.equal((await handleBillPay(db, ACME_MAKER, id, unknown)).status, 503);
  assert.equal(calls.flow, 0);
  await client.close();
});

// ── 7. The receipt's Sui link ───────────────────────────────────────────────

test('the receipt links the digest on the network it settled on', async () => {
  const { db, client } = await migratedDb();
  const { handleBillAction, handleBillPay, recordBillSettlement, handleBillRead } = await lib();
  const { d, calls } = deps();
  const { id } = await confirmMatch(db, d);
  await handleBillAction(db, ACME_MAKER, id, { action: 'schedule', payOn: '2026-11-15' }, d);
  d.paymentFlow = wiredFlow(calls);
  await handleBillPay(db, ACME_MAKER, id, d);
  await recordBillSettlement(db, { orgId: 'acme', paymentIntentId: 'pi_0001', suiDigest: DIGEST, paidAt: new Date('2026-11-15T02:00:00Z'), approvers: ['u_owner'], network: 'testnet' });
  const read = await handleBillRead(db, ACME_MAKER, id, d);
  assert.equal(read.body.bill.paid.verifyUrl, `https://suiscan.xyz/testnet/tx/${DIGEST}`);
  const page = await source('components/invoices/PayInvoices.tsx');
  assert.doesNotMatch(page, /suiScanTxUrlOn\('mainnet'/);
  await client.close();
});

// ── 8. The e-invoice history and the schedule race ──────────────────────────

test('a remade e-invoice keeps the earlier file’s hash in the history', async () => {
  const { db, client } = await migratedDb();
  const { handleBillAction, handleBillPay, recordBillSettlement, handleBillEInvoice, handleBillRead } = await lib();
  const { d, calls } = deps();
  const { id } = await confirmMatch(db, d);
  await handleBillAction(db, ACME_MAKER, id, { action: 'schedule', payOn: '2026-11-15' }, d);
  d.paymentFlow = wiredFlow(calls);
  await handleBillPay(db, ACME_MAKER, id, d);
  await recordBillSettlement(db, { orgId: 'acme', paymentIntentId: 'pi_0001', suiDigest: DIGEST, paidAt: new Date('2026-11-15T02:00:00Z'), approvers: [] });
  const form = { buyerTin: 'C2584563200', phone: '+60 3 2161 0000', stateCode: '14', classification: '034', description: 'Capacitor reels', exchangeRateToMyr: '4.2150' };
  const first = await handleBillEInvoice(db, ACME_MAKER, id, form, d);
  const later = { ...d, now: () => new Date('2026-10-29T03:00:00Z') };
  const remade = await handleBillEInvoice(db, ACME_MAKER, id, { ...form, refresh: true }, later);
  assert.equal(remade.status, 201);
  const history = (await handleBillRead(db, ACME_MAKER, id, d)).body.bill.history;
  const entry = history.find((h) => h.action === 'einvoice_remade');
  assert.ok(entry, 'the remake is recorded');
  assert.match(entry.note, new RegExp(first.body.eInvoice.sha256));
  await client.close();
});

test('a schedule that raced a change to the invoice is refused', async () => {
  const { db, client } = await migratedDb();
  const { handleBillAction } = await lib();
  const { d } = deps();
  const { id } = await confirmMatch(db, d);
  let raced = false;
  const racing = {
    ...d,
    listRecipients: async (orgId) => {
      // Between the schedule's read and its write, someone changes the amount.
      if (!raced) {
        raced = true;
        await client.query(`UPDATE payable_invoices SET amount_minor = 999000000, updated_at = now() + interval '1 second' WHERE id = $1`, [id]);
      }
      return d.listRecipients(orgId);
    },
  };
  const r = await handleBillAction(db, ACME_MAKER, id, { action: 'schedule', payOn: '2026-11-15' }, racing);
  assert.equal(r.status, 409);
  const after = await client.query(`SELECT status FROM payable_invoices WHERE id = $1`, [id]);
  assert.equal(after.rows[0].status, 'review');
  await client.close();
});

// ── 9. Get paid: the payer's report and who may change an invoice ──────────

test('only the roles that may change invoices can patch one, and paid needs its own reference', async () => {
  const { checkInvoicePatch, INVOICE_WRITE_ROLES } = await import('../lib/invoices/patch-rules.ts');
  assert.deepEqual([...INVOICE_WRITE_ROLES].sort(), ['APPROVER', 'FINANCE_ADMIN', 'MAKER', 'OWNER']);
  const current = { status: 'reported', paymentReference: 'SPL-ABC-1234', payerReportedReference: 'FT12345678' };
  for (const role of ['VIEWER', 'AUDITOR', 'DEVELOPER']) {
    assert.equal(checkInvoicePatch({ role, current, patch: { status: 'paid', paymentReference: 'xxxx' }, transferOwned: true })?.status, 403, role);
  }
  const noRef = checkInvoicePatch({ role: 'MAKER', current, patch: { status: 'paid' }, transferOwned: true });
  assert.equal(noRef?.status, 422, 'the reference on file or the payer’s claim is not evidence');
  assert.equal(checkInvoicePatch({ role: 'MAKER', current, patch: { status: 'paid', paymentReference: 'FT12345678' }, transferOwned: true }), null);
  assert.equal(checkInvoicePatch({ role: 'OWNER', current: { ...current, usdcTxDigest: DIGEST }, patch: { status: 'paid' }, transferOwned: true }), null, 'a matched Sui payment is its own evidence');
  assert.equal(checkInvoicePatch({ role: 'OWNER', current, patch: { transferIntentId: 'ti_other' }, transferOwned: false })?.status, 404, 'another org’s transfer');
  const route = await source('app/api/invoices/[id]/route.ts');
  assert.match(route, /checkInvoicePatch\(/);
  assert.match(route, /resolveAuthorityForSession/);
  assert.match(route, /readTransfer\(accountCheck\.account\.orgId/);
});

test('the pay link stores the payer’s report apart and never replaces the issuer’s reference', async () => {
  const { db, client } = await migratedDb();
  const repo = await import('../lib/server/repository/invoices.ts');
  await repo.insertInvoice(db, { id: 'inv_1', orgId: 'acme', issuerOrg: 'Acme Trading', amountUsd: '100', targetCurrency: 'USD', dueDate: '2026-11-01', status: 'sent', payLinkSlug: 'slug-1', paymentReference: 'SPL-SLUG-0001' });
  const reported = await repo.reportPayment(db, 'inv_1', ['draft', 'sent', 'viewed', 'overdue'], { payerOrgName: 'Payer Co', payerOrgEmail: 'ap@payer.example', reference: 'FT12345678', at: new Date('2026-10-25T04:00:00Z') });
  assert.equal(reported.status, 'reported');
  assert.equal(reported.paymentReference, 'SPL-SLUG-0001', 'the issuer’s reference stands');
  assert.equal(reported.payerReportedReference, 'FT12345678');
  assert.equal(reported.payerReportedAt, '2026-10-25T04:00:00.000Z');
  // Guarded: once reported (or paid), a second report changes nothing.
  assert.equal(await repo.reportPayment(db, 'inv_1', ['draft', 'sent', 'viewed', 'overdue'], { payerOrgName: 'X', payerOrgEmail: 'x@x.example', reference: 'OTHER-REF', at: new Date() }), null);
  const route = await source('app/api/pay/[slug]/route.ts');
  assert.doesNotMatch(route, /paymentReference: parsed\.data\.paymentReference/);
  assert.match(route, /reportInvoicePayment\(/);
  const getPaid = await source('components/invoices/GetPaid.tsx');
  assert.doesNotMatch(getPaid, /useState\(invoice\.paymentReference/);
  assert.match(getPaid, /payerReportedReference/);
  assert.doesNotMatch(getPaid, /USDC outside the pay link, for example by bank transfer/);
  await client.close();
});
