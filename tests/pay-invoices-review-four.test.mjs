import assert from 'node:assert/strict';
import test from 'node:test';

import { migratedDb } from './helpers/store-db.mjs';

/* v2 brief 5.8, the third independent review of Invoices. Each test here was
   red against 026599e.

     1. an amount too large for the column is a field error, not a 500 (Medium);
     2. a control character in pasted text is refused with a clear message, and
        a database error never reaches a log with the invoice in it (Medium);
     3. "a Splash address" is the one definition the other money paths use: in
        production the list needs the FeeConfig id, and the gas sponsor is
        Splash's too (Medium). */

const ACME_MAKER = { orgId: 'acme', userId: 'u_maker', role: 'MAKER' };
const key = (n) => `5e7a28ba-2fa1-11d2-883f-${String(n).padStart(12, '0')}`;

const INVOICE = `Mabuhay Components Inc.
12 Ayala Avenue, Makati City, Philippines

Invoice No: MC-2026-0412
Invoice Date: 2026-10-20
Due Date: 2026-11-19

Total due: USD 1,250.00`;

const BUSINESS = { name: 'Acme Trading', legalName: 'Acme Trading Sdn Bhd', registrationNumber: '202001012345', addressLine1: '1 Jalan Ampang', addressCity: 'Kuala Lumpur', addressPostalCode: '50450', addressCountry: 'MY' };
const CONFIRMED = { payee: 'Mabuhay Components Inc.', invoiceNumber: 'MC-2026-0412', amount: '1250.00', currency: 'USD', dueDate: '2026-11-19', invoiceDate: '2026-10-20', payeeCountry: 'PH' };

function deps(over = {}) {
  return {
    modelReader: null,
    listRecipients: async () => [],
    readBusiness: async () => BUSINESS,
    paymentFlow: { wired: false, start: async () => ({ ok: false, code: 'PAYMENT_FLOW_NOT_WIRED', status: 501, error: 'not wired' }) },
    stablecoinOnly: () => false,
    splashOwnedAddresses: async () => [],
    now: () => new Date('2026-10-25T03:00:00Z'),
    ...over,
  };
}

const lib = () => import('../lib/server/bills.ts');

test('an amount too large for the column is a field error on the amount', async () => {
  const { handleBillIntake, handleBillAction } = await lib();
  const { db, client } = await migratedDb();
  const made = await handleBillIntake(db, ACME_MAKER, { intakeKey: key(1), text: INVOICE }, deps());
  assert.equal(made.status, 201);
  for (const amount of ['10000000000000', '99999999999999999999', '1234567890123.45']) {
    const r = await handleBillAction(db, ACME_MAKER, made.body.bill.id, { action: 'confirm', fields: { ...CONFIRMED, amount } }, deps());
    assert.equal(r.status, 422, amount);
    assert.ok(r.body.fields?.amount, `${amount} names the amount`);
  }
  const ok = await handleBillAction(db, ACME_MAKER, made.body.bill.id, { action: 'confirm', fields: { ...CONFIRMED, amount: '999999999999.99' } }, deps());
  assert.equal(ok.status, 200, 'twelve digits still go through');
  await client.close();
});

test('a control character in the pasted text is refused before anything is stored', async () => {
  const { handleBillIntake } = await lib();
  const { db, client } = await migratedDb();
  const utf16 = `${INVOICE}`.split('').join('\u0000');
  const r = await handleBillIntake(db, ACME_MAKER, { intakeKey: key(2), text: utf16 }, deps());
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'not_plain_text');
  const tab = await handleBillIntake(db, ACME_MAKER, { intakeKey: key(3), text: INVOICE.replace('Invoice No:', 'Invoice No:\t') }, deps());
  assert.equal(tab.status, 201, 'tabs and line breaks are text');
  const named = await handleBillIntake(db, ACME_MAKER, { intakeKey: key(4), documentName: 'a\u0000b.pdf', text: INVOICE.replace('0412', '0413') }, deps());
  assert.equal(named.status, 201);
  assert.equal(named.body.bill.documentName, 'ab.pdf', 'a control character in a file name is dropped');
  await client.close();
});

test('a thrown database error is a fixed answer, and the log names the error and the org only', async () => {
  const { answerSafely } = await lib();
  const logged = [];
  const secret = 'Mabuhay Components Inc. USD 1,250.00';
  const result = await answerSafely('acme', async () => { throw new Error(`Failed query: insert ... params: ${secret}`); }, (...args) => logged.push(args));
  assert.equal(result.status, 500);
  assert.ok(typeof result.body.error === 'string' && !result.body.error.includes('Failed query'));
  assert.equal(logged.length, 1);
  assert.ok(!JSON.stringify(logged).includes('Mabuhay'), 'the invoice is not in the log');
  assert.ok(!JSON.stringify(logged).includes('Failed query'), 'the message is not in the log');
  assert.ok(JSON.stringify(logged).includes('acme'));
  const fine = await answerSafely('acme', async () => ({ status: 200, body: { ok: true } }), () => assert.fail('nothing to log'));
  assert.equal(fine.status, 200);
});

const OP = '0x' + 'a1'.repeat(32);
const TR = '0x' + 'b2'.repeat(32);

test('production names Splash’s fee recipient or refuses, as the other money paths do', async () => {
  const { splashOwnedAddresses } = await import('../lib/server/bills-deps.ts');
  const keys = ['NODE_ENV', 'OPERATOR_SUI_ADDRESS', 'TREASURY_ADDRESS', 'SPLASH_FEE_CONFIG_ID', 'WALLET_GAS_SPONSOR', 'SPLASH_TEST_RECIPIENT_ADDRESS'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    process.env.NODE_ENV = 'production';
    process.env.OPERATOR_SUI_ADDRESS = OP;
    process.env.TREASURY_ADDRESS = TR;
    delete process.env.SPLASH_FEE_CONFIG_ID;
    delete process.env.WALLET_GAS_SPONSOR;
    delete process.env.SPLASH_TEST_RECIPIENT_ADDRESS;
    await assert.rejects(splashOwnedAddresses(), 'no FeeConfig id in production is an unreadable list');
    process.env.NODE_ENV = 'test';
    const own = await splashOwnedAddresses();
    assert.deepEqual(own.sort(), [OP, TR].sort(), 'outside production the operator and treasury are enough');
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test('the list is the union of the shared source and the bills checks', async () => {
  const { splashOwnedAddressesWith } = await import('../lib/server/bills-deps.ts');
  const extra = '0x' + 'f6'.repeat(32);
  const own = await splashOwnedAddressesWith({
    config: { operatorAddress: OP, treasuryAddress: TR },
    feeConfigId: '',
    readFeeConfig: async () => { throw new Error('not read'); },
    shared: async () => [extra, OP],
  });
  assert.ok(own.includes(extra), 'what the shared source names is Splash’s');
  assert.ok(own.includes(OP) && own.includes(TR));
  await assert.rejects(splashOwnedAddressesWith({
    config: { operatorAddress: OP, treasuryAddress: TR },
    feeConfigId: '',
    readFeeConfig: async () => { throw new Error('not read'); },
    shared: async () => { throw new Error('unavailable'); },
  }), 'when the shared source cannot answer, nothing is matched');
});
