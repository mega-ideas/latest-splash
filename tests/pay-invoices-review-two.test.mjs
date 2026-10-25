import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { migratedDb } from './helpers/store-db.mjs';

/* v2 brief 5.8, the second independent review of Invoices. Each test here was
   red against 472ad3c.

     1. Splash's own addresses fail closed: a missing or malformed operator or
        treasury address, or a malformed FeeConfig id, is an unreadable list,
        and the FeeConfig's pending recipient is Splash's too (High);
     2. the hand-off key changes with the attempt and with what is paid, and
        an invoice waiting for approval can be withdrawn through the flow
        (High);
     3. approve writes "approving" only onto the invoice it handed off
        (Medium);
     4. a self-custody wallet is paid only once its owner proved it (Medium);
     5. a recipient whose name is not the supplier's needs a written reason,
        and one shared generic word does not make two names alike (Medium);
     6. Get paid: the reference is set once, with "paid", and kept apart from
        the asked-for one; the write is guarded on the status read (Medium);
     7. the payer's report is bounded, kept in its own columns, and its email
        is not logged (Medium);
     8. confirm writes only onto the invoice it read (Low);
     9. an account that merely ends with the one on file is another account
        (Low);
    10. a rate-quote invoice is told so at the reading step, with a link to
        Transfer, and Mark as paid speaks in the invoice's own terms (Low). */

const ACME_MAKER = { orgId: 'acme', userId: 'u_maker', role: 'MAKER' };
const key = (n) => `5e7a28ba-2fa1-11d2-883f-${String(n).padStart(12, '0')}`;
const PROVEN = '2026-10-01T00:00:00.000Z';

const INVOICE = `Mabuhay Components Inc.
12 Ayala Avenue, Makati City, Philippines

Invoice No: MC-2026-0412
Invoice Date: 2026-10-20
Due Date: 2026-11-19

Total due: USD 1,250.00`;

const MABUHAY = { id: 'r_mabuhay', name: 'Mabuhay Components Inc', country: 'PH', payoutMethod: 'WALLET', screeningVerdict: 'CLEAR', walletAddress: '0x' + 'ab'.repeat(32), ownershipProvenAt: PROVEN };
const BASE_RECIPIENTS = [
  MABUHAY,
  { id: 'r_global', name: 'Global Logistics Sdn Bhd', country: 'MY', payoutMethod: 'BANK', screeningVerdict: 'CLEAR', account: '1234567890', bank: 'Maybank' },
];
const BUSINESS = { name: 'Acme Trading', legalName: 'Acme Trading Sdn Bhd', registrationNumber: '202001012345', addressLine1: '1 Jalan Ampang', addressCity: 'Kuala Lumpur', addressPostalCode: '50450', addressCountry: 'MY' };
const CONFIRMED = { payee: 'Mabuhay Components Inc.', invoiceNumber: 'MC-2026-0412', amount: '1250.00', currency: 'USD', dueDate: '2026-11-19', invoiceDate: '2026-10-20', payeeCountry: 'PH' };

function deps(over = {}) {
  return {
    modelReader: null,
    listRecipients: async (orgId) => (orgId === 'acme' ? BASE_RECIPIENTS : []),
    readBusiness: async () => BUSINESS,
    paymentFlow: { wired: false, start: async () => ({ ok: false, code: 'PAYMENT_FLOW_NOT_WIRED', status: 501, error: 'not wired' }) },
    stablecoinOnly: () => false,
    splashOwnedAddresses: async () => [],
    now: () => new Date('2026-10-25T03:00:00Z'),
    ...over,
  };
}

/** A flow that records every request and hands out a new intent each time. */
function recordingFlow({ cancel } = {}) {
  const requests = [];
  const cancels = [];
  const flow = {
    wired: true,
    start: async (request) => { requests.push(request); return { ok: true, paymentIntentId: `pi_${requests.length}` }; },
  };
  if (cancel !== false) {
    flow.cancel = async (request) => { cancels.push(request); return cancel ?? { ok: true }; };
  }
  return { flow, requests, cancels };
}

const lib = () => import('../lib/server/bills.ts');
const source = (relative) => readFile(new URL(`../${relative}`, import.meta.url), 'utf8');

async function scheduled(db, d, { n = 1, fields = CONFIRMED, recipientId = 'r_mabuhay', reason } = {}) {
  const { handleBillIntake, handleBillAction } = await lib();
  const made = await handleBillIntake(db, ACME_MAKER, { intakeKey: key(n), text: INVOICE }, d);
  const id = made.body.bill.id;
  assert.equal((await handleBillAction(db, ACME_MAKER, id, { action: 'confirm', fields }, d)).status, 200);
  const matched = await handleBillAction(db, ACME_MAKER, id, { action: 'match', recipientId, ...(reason ? { reason } : {}) }, d);
  assert.equal(matched.status, 200, JSON.stringify(matched.body));
  const sched = await handleBillAction(db, ACME_MAKER, id, { action: 'schedule', payOn: '2026-11-15' }, d);
  assert.equal(sched.status, 200, JSON.stringify(sched.body));
  return id;
}

// ─── 1. Splash's own addresses ──────────────────────────────────────────────

const OP = '0x' + 'a1'.repeat(32);
const TR = '0x' + 'b2'.repeat(32);
const FEE_ID = '0x' + 'c3'.repeat(32);
const noFees = async () => { throw new Error('not read'); };

test('Splash’s own addresses: a missing or malformed operator or treasury address is not an empty list', async () => {
  const { splashOwnedAddressesFrom } = await import('../lib/server/bills-deps.ts');
  const good = { operatorAddress: OP, treasuryAddress: TR, testRecipientAddress: '' };
  await assert.rejects(splashOwnedAddressesFrom({ config: { ...good, operatorAddress: '' }, feeConfigId: '', readFeeConfig: noFees }));
  await assert.rejects(splashOwnedAddressesFrom({ config: { ...good, treasuryAddress: '' }, feeConfigId: '', readFeeConfig: noFees }));
  await assert.rejects(splashOwnedAddressesFrom({ config: { ...good, operatorAddress: '0xnotvalid' }, feeConfigId: '', readFeeConfig: noFees }));
  await assert.rejects(splashOwnedAddressesFrom({ config: { ...good, testRecipientAddress: 'nope' }, feeConfigId: '', readFeeConfig: noFees }), 'a configured address that is not one is not skipped');
  const own = await splashOwnedAddressesFrom({ config: good, feeConfigId: '', readFeeConfig: noFees });
  assert.deepEqual(own.sort(), [OP, TR].sort());
});

test('Splash’s own addresses: a set but malformed FeeConfig id throws, and the pending recipient is Splash’s too', async () => {
  const { splashOwnedAddressesFrom } = await import('../lib/server/bills-deps.ts');
  const config = { operatorAddress: OP, treasuryAddress: TR, testRecipientAddress: '0x5' };
  await assert.rejects(splashOwnedAddressesFrom({ config, feeConfigId: '0xnotvalid', readFeeConfig: noFees }));
  await assert.rejects(splashOwnedAddressesFrom({ config, feeConfigId: FEE_ID, readFeeConfig: noFees }), 'a configured FeeConfig that cannot be read');
  const own = await splashOwnedAddressesFrom({
    config,
    feeConfigId: FEE_ID,
    readFeeConfig: async () => ({ feeRecipient: '0x' + 'd4'.repeat(32), pendingRecipient: { recipient: '0x' + 'E5'.repeat(32), etaMs: 1n } }),
  });
  assert.ok(own.includes('0x' + 'd4'.repeat(32)), 'the fee recipient in force');
  assert.ok(own.includes('0x' + 'e5'.repeat(32)), 'the fee recipient proposed under notice');
  assert.ok(own.includes('0x' + '0'.repeat(63) + '5'), 'a short address is normalised, not dropped');
});

test('the env-backed list refuses a malformed FeeConfig id instead of skipping it', async () => {
  const { splashOwnedAddresses } = await import('../lib/server/bills-deps.ts');
  const saved = { op: process.env.OPERATOR_SUI_ADDRESS, tr: process.env.TREASURY_ADDRESS, fee: process.env.SPLASH_FEE_CONFIG_ID };
  process.env.OPERATOR_SUI_ADDRESS = OP;
  process.env.TREASURY_ADDRESS = TR;
  process.env.SPLASH_FEE_CONFIG_ID = '0xnotvalid';
  try {
    await assert.rejects(splashOwnedAddresses());
  } finally {
    for (const [k, v] of [['OPERATOR_SUI_ADDRESS', saved.op], ['TREASURY_ADDRESS', saved.tr], ['SPLASH_FEE_CONFIG_ID', saved.fee]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test('a recipient wallet written short is still recognised as Splash’s', async () => {
  const { db, client } = await migratedDb();
  const { handleBillIntake, handleBillAction } = await lib();
  const short = { ...MABUHAY, id: 'r_short', walletAddress: '0x5' };
  const d = deps({ listRecipients: async () => [short], splashOwnedAddresses: async () => ['0x' + '0'.repeat(63) + '5'] });
  const made = await handleBillIntake(db, ACME_MAKER, { intakeKey: key(40), text: INVOICE }, d);
  await handleBillAction(db, ACME_MAKER, made.body.bill.id, { action: 'confirm', fields: CONFIRMED }, d);
  const r = await handleBillAction(db, ACME_MAKER, made.body.bill.id, { action: 'match', recipientId: 'r_short' }, d);
  assert.equal(r.body.code, 'splash_address');
  await client.close();
});

// ─── 2. The hand-off key, and a way out of "approving" ──────────────────────

test('the hand-off key is new after the intent closed, and new when the amount changed', async () => {
  const { db, client } = await migratedDb();
  const { handleBillAction, handleBillPay, recordBillPaymentClosed } = await lib();
  const { flow, requests } = recordingFlow();
  const d = deps({ paymentFlow: flow });
  const id = await scheduled(db, d);

  assert.equal((await handleBillPay(db, ACME_MAKER, id, d)).status, 200);
  const first = requests[0].idempotencyKey;
  assert.notEqual(first, id, 'not the bare invoice id');

  await recordBillPaymentClosed(db, { orgId: 'acme', paymentIntentId: 'pi_1', reason: 'quote expired', at: new Date('2026-10-26T00:00:00Z') });
  assert.equal((await handleBillPay(db, ACME_MAKER, id, d)).status, 200);
  const second = requests[1].idempotencyKey;
  assert.notEqual(second, first, 'the same payload after a closed intent is another attempt');

  await recordBillPaymentClosed(db, { orgId: 'acme', paymentIntentId: 'pi_2', reason: 'owners refused', at: new Date('2026-10-26T01:00:00Z') });
  assert.equal((await handleBillAction(db, ACME_MAKER, id, { action: 'unschedule' }, d)).status, 200);
  assert.equal((await handleBillAction(db, ACME_MAKER, id, { action: 'confirm', fields: { ...CONFIRMED, amount: '2000.00' } }, d)).status, 200);
  assert.equal((await handleBillAction(db, ACME_MAKER, id, { action: 'schedule', payOn: '2026-11-15' }, d)).status, 200);
  assert.equal((await handleBillPay(db, ACME_MAKER, id, d)).status, 200);
  assert.equal(requests[2].amountMicros, 2_000_000_000n);
  assert.ok(![first, second].includes(requests[2].idempotencyKey), 'a new amount is a new key');

  const hook = await source('lib/bills/payment-hook.ts');
  assert.match(hook, /different payload[^.]*409|409[^.]*different payload/i, 'the contract says the same key with another payload is a conflict');
  await client.close();
});

test('an invoice waiting for approval can be withdrawn through the flow, and only through it', async () => {
  const { db, client } = await migratedDb();
  const { handleBillAction, handleBillPay } = await lib();

  const noCancel = recordingFlow({ cancel: false });
  const d1 = deps({ paymentFlow: noCancel.flow });
  const a = await scheduled(db, d1, { n: 1 });
  await handleBillPay(db, ACME_MAKER, a, d1);
  const refused = await handleBillAction(db, ACME_MAKER, a, { action: 'withdraw' }, d1);
  assert.equal(refused.status, 501);
  assert.equal((await client.query('SELECT status FROM payable_invoices WHERE id = $1', [a])).rows[0].status, 'approving');

  const signed = recordingFlow({ cancel: { ok: false, status: 409, error: 'An owner already signed it.' } });
  const d2 = deps({ paymentFlow: signed.flow });
  const b = await scheduled(db, d2, { n: 2, fields: { ...CONFIRMED, invoiceNumber: 'MC-2026-0413', amount: '99.00' } });
  await handleBillPay(db, ACME_MAKER, b, d2);
  assert.equal((await handleBillAction(db, ACME_MAKER, b, { action: 'withdraw' }, d2)).status, 409);
  assert.equal((await client.query('SELECT status FROM payable_invoices WHERE id = $1', [b])).rows[0].status, 'approving');

  const ok = recordingFlow();
  const d3 = deps({ paymentFlow: ok.flow });
  const c = await scheduled(db, d3, { n: 3, fields: { ...CONFIRMED, invoiceNumber: 'MC-2026-0414', amount: '77.00' } });
  await handleBillPay(db, ACME_MAKER, c, d3);
  const back = await handleBillAction(db, ACME_MAKER, c, { action: 'withdraw' }, d3);
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.equal(back.body.bill.status, 'scheduled');
  assert.equal(back.body.bill.approval, null);
  assert.equal(ok.cancels[0].paymentIntentId, 'pi_1');
  // And cancelling it now is allowed again.
  assert.equal((await handleBillAction(db, ACME_MAKER, c, { action: 'cancel' }, d3)).status, 200);
  await client.close();
});

// ─── 3. Approve writes only onto what it handed off ─────────────────────────

test('an invoice changed while the flow took its quote is not marked approving, and the intent is dropped', async () => {
  const { db, client } = await migratedDb();
  const { handleBillPay } = await lib();
  const ok = recordingFlow();
  const d = deps({ paymentFlow: ok.flow });
  const id = await scheduled(db, d);
  const racing = {
    ...ok.flow,
    start: async (request) => {
      // Someone took it back, changed the amount and scheduled it again.
      await client.query(`UPDATE payable_invoices SET amount_minor = 1500000000, updated_at = now() + interval '1 second' WHERE id = $1`, [id]);
      return ok.flow.start(request);
    },
  };
  const r = await handleBillPay(db, ACME_MAKER, id, { ...d, paymentFlow: racing });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'changed');
  const row = (await client.query('SELECT status, payment_intent_id FROM payable_invoices WHERE id = $1', [id])).rows[0];
  assert.equal(row.status, 'scheduled');
  assert.equal(row.payment_intent_id, null);
  assert.equal(ok.cancels.length, 1, 'the flow is told to drop the intent');
  assert.equal(ok.cancels[0].paymentIntentId, 'pi_1');
  await client.close();
});

// ─── 4. Self-custody wallets need an ownership proof ────────────────────────

test('a self-custody wallet recipient with clear screening but no ownership proof is not matched or paid', async () => {
  const { db, client } = await migratedDb();
  const { handleBillIntake, handleBillAction, handleBillPay, handleBillRead } = await lib();
  const unproven = { ...MABUHAY, ownershipProvenAt: null };
  const d = deps({ listRecipients: async () => [unproven] });
  const made = await handleBillIntake(db, ACME_MAKER, { intakeKey: key(50), text: INVOICE }, d);
  const id = made.body.bill.id;
  await handleBillAction(db, ACME_MAKER, id, { action: 'confirm', fields: CONFIRMED }, d);
  const view = (await handleBillRead(db, ACME_MAKER, id, d)).body.bill;
  assert.equal(view.matches[0].verified, false, 'the page does not call it verified');
  const r = await handleBillAction(db, ACME_MAKER, id, { action: 'match', recipientId: 'r_mabuhay' }, d);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'ownership_unproven');

  // Proven, then matched, scheduled; the proof gone before approval: not handed off.
  const { flow, requests } = recordingFlow();
  const proven = deps({ paymentFlow: flow });
  assert.equal((await handleBillAction(db, ACME_MAKER, id, { action: 'match', recipientId: 'r_mabuhay' }, proven)).status, 200);
  assert.equal((await handleBillAction(db, ACME_MAKER, id, { action: 'schedule', payOn: '2026-11-15' }, proven)).status, 200);
  const pay = await handleBillPay(db, ACME_MAKER, id, { ...proven, listRecipients: async () => [unproven] });
  assert.equal(pay.status, 409);
  assert.equal(pay.body.code, 'ownership_unproven');
  assert.equal(requests.length, 0);

  const hook = await source('lib/bills/payment-hook.ts');
  assert.match(hook, /ownership/i, 'the hand-off contract asks the flow to check it again');
  await client.close();
});

// ─── 5. Names ───────────────────────────────────────────────────────────────

test('one shared generic word does not make two companies alike, and only the same name needs no reason', async () => {
  const { matchRecipients } = await import('../lib/bills/match.ts');
  const r = (name) => ({ id: name, name, country: 'MY', payoutMethod: 'BANK', screeningVerdict: 'CLEAR' });
  assert.deepEqual(matchRecipients('Shenzhen Electronics', [r('Shenzhen Holdings')]), []);
  assert.deepEqual(matchRecipients('Global Trading Ltd', [r('Global Logistics Sdn Bhd')]), []);

  const { db, client } = await migratedDb();
  const { handleBillIntake, handleBillAction } = await lib();
  const d = deps();
  const made = await handleBillIntake(db, ACME_MAKER, { intakeKey: key(60), text: INVOICE }, d);
  const id = made.body.bill.id;
  await handleBillAction(db, ACME_MAKER, id, { action: 'confirm', fields: { ...CONFIRMED, payee: 'Global Trading Ltd', payeeCountry: 'MY' } }, d);
  const r1 = await handleBillAction(db, ACME_MAKER, id, { action: 'match', recipientId: 'r_global' }, d);
  assert.equal(r1.status, 409);
  assert.equal(r1.body.code, 'name_mismatch');

  // Close but not the same: a reason is needed too.
  const made2 = await handleBillIntake(db, ACME_MAKER, { intakeKey: key(61), text: INVOICE.replace('MC-2026-0412', 'MC-2026-0499') }, d);
  const id2 = made2.body.bill.id;
  await handleBillAction(db, ACME_MAKER, id2, { action: 'confirm', fields: { ...CONFIRMED, invoiceNumber: 'MC-2026-0499', payee: 'Mabuhay Components Philippines Inc' } }, d);
  const r2 = await handleBillAction(db, ACME_MAKER, id2, { action: 'match', recipientId: 'r_mabuhay' }, d);
  assert.equal(r2.body.code, 'name_mismatch');
  // A match on file without a reason (from before this rule) does not schedule.
  await client.query(`UPDATE payable_invoices SET recipient_id = 'r_mabuhay' WHERE id = $1`, [id2]);
  const s = await handleBillAction(db, ACME_MAKER, id2, { action: 'schedule', payOn: '2026-11-15' }, d);
  assert.equal(s.body.code, 'name_mismatch');
  await client.close();
});

// ─── 6. Get paid: the reference and the status guard ────────────────────────

test('the payment reference is set once, with "paid", and never rewritten after', async () => {
  const { checkInvoicePatch } = await import('../lib/invoices/patch-rules.ts');
  const t = (current, patch) => checkInvoicePatch({ role: 'MAKER', current, patch, transferOwned: false });
  assert.equal(t({ status: 'paid', paymentReference: 'BANK-123' }, { paymentReference: 'x' })?.status, 409);
  assert.equal(t({ status: 'settled', paymentReference: 'BANK-123' }, { paymentReference: '' })?.status, 409);
  assert.equal(t({ status: 'sent' }, { paymentReference: 'BANK-123' })?.status, 409, 'not without moving it to paid');
  assert.equal(t({ status: 'paid' }, { status: 'paid', paymentReference: 'BANK-999' })?.status, 409, 'paid again does not rewrite it');
  assert.equal(t({ status: 'sent' }, { status: 'paid', paymentReference: 'B'.repeat(65) })?.status, 422, 'bounded');
  assert.equal(t({ status: 'sent' }, { status: 'paid', paymentReference: 'FT 2026/0412-A' }), null);
});

test('marking paid keeps the asked-for reference, and a write that met another status changes nothing', async () => {
  const { db, client } = await migratedDb();
  const repo = await import('../lib/server/repository/invoices.ts');
  await repo.insertInvoice(db, { id: 'inv_1', orgId: 'acme', issuerOrg: 'Acme', payerOrgName: 'Issuer’s payer', payerOrgEmail: 'ap@payer.example', amountUsd: '1000', targetCurrency: 'USD', dueDate: '2026-11-01', status: 'sent', payLinkSlug: 's1', paymentReference: 'SPL-S1-0001' });
  const paid = await repo.patchInvoice(db, 'acme', 'inv_1', { status: 'paid', receivedReference: 'BANK-123' }, { status: 'sent' });
  assert.equal(paid.status, 'paid');
  assert.equal(paid.receivedReference, 'BANK-123');
  assert.equal(paid.paymentReference, 'SPL-S1-0001', 'the reference the payer was asked to quote stays');

  await repo.insertInvoice(db, { id: 'inv_2', orgId: 'acme', issuerOrg: 'Acme', amountUsd: '10', targetCurrency: 'USD', dueDate: '2026-11-01', status: 'sent', payLinkSlug: 's2' });
  // A USDC sync settled it between the route's read and its write.
  await client.query(`UPDATE invoices SET status = 'settled' WHERE id = 'inv_2'`);
  assert.equal(await repo.patchInvoice(db, 'acme', 'inv_2', { status: 'paid', receivedReference: 'BANK-1' }, { status: 'sent' }), null);
  assert.equal((await client.query(`SELECT status, received_reference FROM invoices WHERE id = 'inv_2'`)).rows[0].status, 'settled');

  const route = await source('app/api/invoices/[id]/route.ts');
  assert.match(route, /status:\s*current\.status/, 'the route guards its write on the status it read');
  assert.match(route, /409/);
  await client.close();
});

// ─── 7. The payer's report ──────────────────────────────────────────────────

test('the payer’s report is bounded and its reference has a plain form', async () => {
  const { parsePaymentReport } = await import('../lib/invoices/pay-report.ts');
  const ok = { payerOrgName: 'Payer Co', payerOrgEmail: 'ap@payer.example', paymentReference: 'SPL-ABC-1234' };
  assert.ok(parsePaymentReport(ok).success);
  assert.equal(parsePaymentReport({ ...ok, paymentReference: 'A'.repeat(65) }).success, false);
  assert.equal(parsePaymentReport({ ...ok, paymentReference: 'SPL<script>' }).success, false);
  assert.equal(parsePaymentReport({ ...ok, payerOrgName: 'N'.repeat(121) }).success, false);
  assert.equal(parsePaymentReport({ ...ok, payerOrgEmail: `${'e'.repeat(250)}@x.io` }).success, false);
});

test('the payer’s report leaves the issuer’s payer name and email alone, and its email is not logged', async () => {
  const { db, client } = await migratedDb();
  const repo = await import('../lib/server/repository/invoices.ts');
  await repo.insertInvoice(db, { id: 'inv_r', orgId: 'acme', issuerOrg: 'Acme', payerOrgName: 'Real Payer Bhd', payerOrgEmail: 'ap@realpayer.example', amountUsd: '10', targetCurrency: 'USD', dueDate: '2026-11-01', status: 'sent', payLinkSlug: 'sr' });
  const row = await repo.reportPayment(db, 'inv_r', ['sent'], { payerOrgName: 'Someone Else', payerOrgEmail: 'x@else.example', reference: 'FT0001', at: new Date('2026-10-25T04:00:00Z') });
  assert.equal(row.payerOrgName, 'Real Payer Bhd');
  assert.equal(row.payerOrgEmail, 'ap@realpayer.example');
  assert.equal(row.payerReportedName, 'Someone Else');
  assert.equal(row.payerReportedEmail, 'x@else.example');
  await client.close();

  const route = await source('app/api/pay/[slug]/route.ts');
  assert.doesNotMatch(route, /console\.\w+\([^)]*email/i);
  const page = await source('components/invoices/GetPaid.tsx');
  const spans = page.match(/<span className="[^"]*">\{invoice\.payerReportedReference\}<\/span>/g) ?? [];
  assert.ok(spans.length >= 2 && spans.every((s) => /break-all/.test(s)), 'the reported reference wraps on a phone');
});

// ─── 8. Confirm writes onto what it read ────────────────────────────────────

test('a confirm that raced a change to the invoice is refused and writes nothing', async () => {
  const { db, client } = await migratedDb();
  const { handleBillIntake, handleBillAction } = await lib();
  const d = deps();
  const made = await handleBillIntake(db, ACME_MAKER, { intakeKey: key(80), text: INVOICE }, d);
  const id = made.body.bill.id;
  await handleBillAction(db, ACME_MAKER, id, { action: 'confirm', fields: CONFIRMED }, d);
  let raced = false;
  const racing = deps({
    now: () => {
      if (!raced) {
        raced = true;
        // Fired synchronously inside confirm, before its write; awaited by PGlite in order.
        void client.query(`UPDATE payable_invoices SET amount_minor = 100000000, duplicate_ack_at = now(), duplicate_ack_reason = 'second shipment', updated_at = now() + interval '1 second' WHERE id = $1`, [id]);
      }
      return new Date('2026-10-25T03:00:00Z');
    },
  });
  const r = await handleBillAction(db, ACME_MAKER, id, { action: 'confirm', fields: { ...CONFIRMED, amount: '200.00' } }, racing);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'changed');
  const row = (await client.query('SELECT amount_minor, duplicate_ack_reason FROM payable_invoices WHERE id = $1', [id])).rows[0];
  assert.equal(String(row.amount_minor), '100000000');
  await client.close();
});

// ─── 9. Payment details ─────────────────────────────────────────────────────

test('an account that merely ends with the one on file is another account', async () => {
  const { paymentDetailsDiffer } = await import('../lib/bills/match.ts');
  const printed = (a) => ({ walletAddresses: [], accountNumbers: [a] });
  assert.equal(paymentDetailsDiffer(printed('99887766554433221'), { account: '4433221' }), true);
  assert.equal(paymentDetailsDiffer(printed('4433221'), { account: '99887766554433221' }), true);
  assert.equal(paymentDetailsDiffer(printed('4433221'), { account: '443-3221' }), false, 'the same digits');
  assert.equal(paymentDetailsDiffer(printed('99887766543221'), { account: '****3221' }), false, 'a masked account on file matches its ending');
  assert.equal(paymentDetailsDiffer(printed('43221'), { account: '****3221' }), true, 'but not on a printed number too short to be an account');
});

// ─── 10. Copy ───────────────────────────────────────────────────────────────

test('a rate-quote invoice is told at the reading step, with a link to Transfer; Mark as paid speaks in the invoice’s terms', async () => {
  const pay = await source('components/invoices/PayInvoices.tsx');
  const reading = pay.slice(pay.indexOf('function ReadingStep'), pay.indexOf('function DuplicateStep'));
  assert.match(reading, /needsRateQuote/);
  assert.match(reading, /href="\/dashboard\/transfer"/);
  const getPaid = await source('components/invoices/GetPaid.tsx');
  assert.doesNotMatch(getPaid, /USDC has reached your account/);
  assert.match(getPaid, /once the payment of/);
});
