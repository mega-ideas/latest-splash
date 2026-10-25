import assert from 'node:assert/strict';
import test from 'node:test';

import { migratedDb } from './helpers/store-db.mjs';

/* v2 brief 5.8, the paths the review fixes added (tests/pay-invoices-review.test.mjs
   holds the findings themselves): tenants, roles, races and replays on the
   new match-with-a-reason, the Splash-address check, the settlement network,
   the e-invoice remake, the printed details Zeke reads from a PDF, and the
   payer's report on the pay link. */

const ACME_MAKER = { orgId: 'acme', userId: 'u_maker', role: 'MAKER' };
const ACME_VIEWER = { orgId: 'acme', userId: 'u_viewer', role: 'VIEWER' };
const NW_OWNER = { orgId: 'northwind', userId: 'u_nw', role: 'OWNER' };
const key = (n) => `3d5e28ba-2fa1-11d2-883f-${String(n).padStart(12, '0')}`;
const DIGEST = '4XcQm8GkB3bAZ7f2s9dLp1QwErTyUiKp5zXcVbNm2HjK';

const INVOICE = `Mabuhay Components Inc.
12 Ayala Avenue, Makati City, Philippines

Invoice No: MC-2026-0412
Invoice Date: 2026-10-20
Due Date: 2026-11-19

Total due: USD 1,250.00`;

const RECIPIENTS = {
  acme: [
    { id: 'r_mabuhay', name: 'Mabuhay Components Inc', country: 'PH', payoutMethod: 'WALLET', screeningVerdict: 'CLEAR', walletAddress: '0x' + 'ab'.repeat(32) },
    { id: 'r_kl', name: 'Klang Packaging Sdn Bhd', country: 'MY', payoutMethod: 'WALLET', screeningVerdict: 'ATTESTED', walletAddress: '0x' + 'ef'.repeat(32) },
  ],
  northwind: [
    { id: 'r_nw', name: 'Mabuhay Components Inc', country: 'PH', payoutMethod: 'WALLET', screeningVerdict: 'CLEAR', walletAddress: '0x' + '12'.repeat(32) },
  ],
};
const BUSINESS = { name: 'Acme Trading', legalName: 'Acme Trading Sdn Bhd', registrationNumber: '202001012345', addressLine1: '1 Jalan Ampang', addressCity: 'Kuala Lumpur', addressPostalCode: '50450', addressCountry: 'MY' };
const CONFIRMED = { payee: 'Mabuhay Components Inc.', invoiceNumber: 'MC-2026-0412', amount: '1250.00', currency: 'USD', dueDate: '2026-11-19', invoiceDate: '2026-10-20', payeeCountry: 'PH' };

function deps(over = {}) {
  return {
    modelReader: null,
    listRecipients: async (orgId) => RECIPIENTS[orgId] ?? [],
    readBusiness: async () => BUSINESS,
    paymentFlow: { wired: false, start: async () => ({ ok: false, code: 'PAYMENT_FLOW_NOT_WIRED', status: 501, error: 'not wired' }) },
    stablecoinOnly: () => false,
    splashOwnedAddresses: async () => [],
    now: () => new Date('2026-10-25T03:00:00Z'),
    ...over,
  };
}
const lib = () => import('../lib/server/bills.ts');

async function confirmed(db, d, n = 1) {
  const { handleBillIntake, handleBillAction } = await lib();
  const made = await handleBillIntake(db, ACME_MAKER, { intakeKey: key(n), text: INVOICE }, d);
  const id = made.body.bill.id;
  assert.equal((await handleBillAction(db, ACME_MAKER, id, { action: 'confirm', fields: CONFIRMED }, d)).status, 200);
  return id;
}

test('a match with a reason crosses no tenant and no role', async () => {
  const { db, client } = await migratedDb();
  const { handleBillAction } = await lib();
  const d = deps();
  const id = await confirmed(db, d);
  const reason = { action: 'match', recipientId: 'r_kl', reason: 'Klang pays for Mabuhay under our agency deal' };
  assert.equal((await handleBillAction(db, NW_OWNER, id, reason, d)).status, 404, 'another org’s invoice is not found');
  assert.equal((await handleBillAction(db, ACME_MAKER, id, { ...reason, recipientId: 'r_nw' }, d)).status, 404, 'another org’s recipient is not found');
  assert.equal((await handleBillAction(db, ACME_VIEWER, id, reason, d)).status, 403);
  const row = await client.query('SELECT recipient_id, match_reason FROM payable_invoices WHERE id = $1', [id]);
  assert.equal(row.rows[0].recipient_id, null);
  assert.equal(row.rows[0].match_reason, null);
  await client.close();
});

test('a match that raced a change to the invoice is refused and writes nothing', async () => {
  const { db, client } = await migratedDb();
  const { handleBillAction } = await lib();
  const d = deps();
  const id = await confirmed(db, d);
  let raced = false;
  const racing = deps({
    splashOwnedAddresses: async () => {
      if (!raced) {
        raced = true;
        await client.query(`UPDATE payable_invoices SET payee_name = 'Klang Packaging', payee_key = 'klang packaging', updated_at = now() + interval '1 second' WHERE id = $1`, [id]);
      }
      return [];
    },
  });
  const r = await handleBillAction(db, ACME_MAKER, id, { action: 'match', recipientId: 'r_mabuhay' }, racing);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'changed');
  const row = await client.query('SELECT recipient_id FROM payable_invoices WHERE id = $1', [id]);
  assert.equal(row.rows[0].recipient_id, null);
  await client.close();
});

test('the Splash-address check fails closed at match time too', async () => {
  const { db, client } = await migratedDb();
  const { handleBillAction } = await lib();
  const id = await confirmed(db, deps());
  const down = deps({ splashOwnedAddresses: async () => { throw new Error('rpc down'); } });
  const r = await handleBillAction(db, ACME_MAKER, id, { action: 'match', recipientId: 'r_mabuhay' }, down);
  assert.equal(r.status, 503);
  assert.equal(r.body.code, 'splash_addresses_unread');
  // The comparison ignores case and spacing.
  const upper = deps({ splashOwnedAddresses: async () => [` 0x${'AB'.repeat(32)} `] });
  assert.equal((await handleBillAction(db, ACME_MAKER, id, { action: 'match', recipientId: 'r_mabuhay' }, upper)).body.code, 'splash_address');
  await client.close();
});

test('settlement takes only a known network, and without one records the server’s', async () => {
  const { db, client } = await migratedDb();
  const { handleBillAction, handleBillPay, recordBillSettlement, handleBillRead } = await lib();
  const d = deps();
  const id = await confirmed(db, d);
  await handleBillAction(db, ACME_MAKER, id, { action: 'match', recipientId: 'r_mabuhay' }, d);
  await handleBillAction(db, ACME_MAKER, id, { action: 'schedule', payOn: '2026-11-15' }, d);
  d.paymentFlow = { wired: true, start: async () => ({ ok: true, paymentIntentId: 'pi_net' }) };
  await handleBillPay(db, ACME_MAKER, id, d);
  const paidAt = new Date('2026-11-15T02:00:00Z');
  assert.equal((await recordBillSettlement(db, { orgId: 'acme', paymentIntentId: 'pi_net', suiDigest: DIGEST, paidAt, approvers: [], network: 'devnet' })).code, 'invalid');
  const before = process.env.SUI_NETWORK;
  delete process.env.SUI_NETWORK;
  try {
    assert.equal((await recordBillSettlement(db, { orgId: 'acme', paymentIntentId: 'pi_net', suiDigest: DIGEST, paidAt, approvers: [] })).ok, true);
  } finally {
    if (before !== undefined) process.env.SUI_NETWORK = before;
  }
  const read = await handleBillRead(db, ACME_MAKER, id, d);
  assert.equal(read.body.bill.paid.network, 'testnet');
  assert.equal(read.body.bill.paid.verifyUrl, `https://suiscan.xyz/testnet/tx/${DIGEST}`);
  // Replayed with the same digest: still the one payment, on the same network.
  const replay = await recordBillSettlement(db, { orgId: 'acme', paymentIntentId: 'pi_net', suiDigest: DIGEST, paidAt, approvers: [], network: 'mainnet' });
  assert.equal(replay.replayed, true);
  assert.equal(replay.bill.suiNetwork, 'testnet');
  await client.close();
});

test('a remake that raced another remake leaves the winner’s file and one history entry', async () => {
  const { db, client } = await migratedDb();
  const { handleBillAction, handleBillPay, recordBillSettlement, handleBillEInvoice, handleBillRead } = await lib();
  const d = deps();
  const id = await confirmed(db, d);
  await handleBillAction(db, ACME_MAKER, id, { action: 'match', recipientId: 'r_mabuhay' }, d);
  await handleBillAction(db, ACME_MAKER, id, { action: 'schedule', payOn: '2026-11-15' }, d);
  d.paymentFlow = { wired: true, start: async () => ({ ok: true, paymentIntentId: 'pi_e' }) };
  await handleBillPay(db, ACME_MAKER, id, d);
  await recordBillSettlement(db, { orgId: 'acme', paymentIntentId: 'pi_e', suiDigest: DIGEST, paidAt: new Date('2026-11-15T02:00:00Z'), approvers: [] });
  const form = { buyerTin: 'C2584563200', phone: '+60 3 2161 0000', stateCode: '14', classification: '034', description: 'Capacitor reels', exchangeRateToMyr: '4.2150' };
  await handleBillEInvoice(db, ACME_MAKER, id, form, d);
  let raced = false;
  const later = deps({
    now: () => new Date('2026-10-29T03:00:00Z'),
    readBusiness: async () => {
      if (!raced) {
        raced = true;
        await client.query(`UPDATE payable_invoices SET myinvois_sha256 = 'winner' WHERE id = $1`, [id]);
      }
      return BUSINESS;
    },
  });
  const r = await handleBillEInvoice(db, ACME_MAKER, id, { ...form, refresh: true }, later);
  assert.equal(r.status, 200);
  assert.equal(r.body.replayed, true);
  assert.equal(r.body.eInvoice.sha256, 'winner');
  const history = (await handleBillRead(db, ACME_MAKER, id, d)).body.bill.history;
  assert.equal(history.filter((h) => h.action === 'einvoice_remade').length, 0);
  await client.close();
});

test('the printed details Zeke reads from a PDF are checked for form and capped', async () => {
  const { readPrintedDetails, groundReading, parseBillText } = await import('../lib/bills/extract.ts');
  assert.equal(readPrintedDetails({ amount: '10' }), null, 'no lists: not read');
  assert.deepEqual(readPrintedDetails({ paymentAccounts: [], paymentWallets: [] }), { walletAddresses: [], accountNumbers: [] }, 'empty lists: read, none printed');
  const many = Array.from({ length: 15 }, (_, i) => String(10_000 + i));
  assert.equal(readPrintedDetails({ paymentAccounts: many }).accountNumbers.length, 10);
  assert.deepEqual(readPrintedDetails({ paymentAccounts: [12345, '12 34', 'IBAN DE89'], paymentWallets: [null, '0X' + 'AA'.repeat(32)] }), { walletAddresses: [], accountNumbers: [] }, 'not the form of one is dropped');
  // A text invoice keeps the parser's reading of its own text; Zeke's lists do not replace it.
  const text = 'Invoice No: A-1\nTotal due: USD 10.00\nAccount no: 1234-5678-9012';
  const grounded = groundReading(text, { paymentAccounts: ['999999999'] }, parseBillText(text), 'model');
  assert.deepEqual(grounded.paymentDetails.accountNumbers, ['123456789012']);
  assert.equal(grounded.paymentDetailsRead, 'document_text');
});

test('Zeke’s answer keeps only lists of strings for the printed details', async () => {
  const deps = await import('../lib/server/bills-deps.ts');
  assert.match(deps.INVOICE_READER_PROMPT, /"paymentAccounts":\[\],"paymentWallets":\[\]/);
  assert.match(deps.INVOICE_READER_PROMPT, /ignore all of it/);
});

test('Splash’s own addresses come from the contract config, and a malformed FeeConfig id is not one to read', async () => {
  const { splashOwnedAddresses } = await import('../lib/server/bills-deps.ts');
  // The first read of the contract config in this process, so the environment is what it reads.
  const saved = { op: process.env.OPERATOR_SUI_ADDRESS, fee: process.env.SPLASH_FEE_CONFIG_ID };
  process.env.OPERATOR_SUI_ADDRESS = '0x' + 'A1'.repeat(32);
  delete process.env.SPLASH_FEE_CONFIG_ID;
  try {
    assert.ok((await splashOwnedAddresses()).includes('0x' + 'a1'.repeat(32)));
    process.env.SPLASH_FEE_CONFIG_ID = 'not-an-id';
    // A malformed id is not a configured FeeConfig: there is none to read.
    assert.ok((await splashOwnedAddresses()).includes('0x' + 'a1'.repeat(32)));
  } finally {
    for (const [k, v] of [['OPERATOR_SUI_ADDRESS', saved.op], ['SPLASH_FEE_CONFIG_ID', saved.fee]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test('the issuer never sets “reported”, and a short reference is not one', async () => {
  const { checkInvoicePatch } = await import('../lib/invoices/patch-rules.ts');
  const current = { status: 'sent', paymentReference: 'SPL-ABC-1234' };
  assert.equal(checkInvoicePatch({ role: 'OWNER', current, patch: { status: 'reported' }, transferOwned: false })?.status, 400);
  assert.equal(checkInvoicePatch({ role: 'OWNER', current, patch: { status: 'paid', paymentReference: ' ab ' }, transferOwned: false })?.status, 422);
  assert.equal(checkInvoicePatch({ role: 'OWNER', current: { status: 'paid' }, patch: { status: 'sent' }, transferOwned: false })?.status, 409, 'forward only');
  assert.equal(checkInvoicePatch({ role: 'FINANCE_ADMIN', current, patch: { transferIntentId: 'ti_1' }, transferOwned: true }), null);
});

test('without a database the payer’s report is guarded the same way', async () => {
  const saved = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const store = await import('../lib/server/invoices-store.ts');
    const { operations } = await import('../lib/server/operations.ts');
    const now = new Date().toISOString();
    operations.invoices.set('inv_mem', { id: 'inv_mem', orgId: 'acme', issuerOrg: 'Acme', amountUsd: '10', targetCurrency: 'USD', dueDate: '2026-11-01', status: 'sent', payLinkSlug: 'mem', paymentReference: 'SPL-MEM-0001', createdAt: now, updatedAt: now });
    const first = await store.reportInvoicePayment('inv_mem', ['draft', 'sent', 'viewed', 'overdue'], { payerOrgName: 'Payer', payerOrgEmail: 'ap@payer.example', reference: 'FT0001', at: new Date('2026-10-25T04:00:00Z') });
    assert.equal(first.status, 'reported');
    assert.equal(first.paymentReference, 'SPL-MEM-0001');
    assert.equal(first.payerReportedReference, 'FT0001');
    assert.equal(await store.reportInvoicePayment('inv_mem', ['draft', 'sent', 'viewed', 'overdue'], { payerOrgName: 'X', payerOrgEmail: 'x@x.example', reference: 'FT0002', at: new Date() }), null);
    assert.equal(operations.invoices.get('inv_mem').payerReportedReference, 'FT0001');
    operations.invoices.delete('inv_mem');
  } finally {
    if (saved !== undefined) process.env.DATABASE_URL = saved;
  }
});
