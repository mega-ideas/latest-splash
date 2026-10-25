import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/* v2 brief 5.8, Invoices: the entry choice (Get paid | Pay invoices) and Get
   paid (create, pay link, track status, receipt).

   Get paid's status only moves forward now. PATCH /api/invoices/:id took any
   status, so a settled invoice could be set back to draft; and the public pay
   link marked an invoice paid on the payer's word alone (SECURITY.md WS7-3).
   The payer's word is "reported"; the business, or a USDC payment matched on
   Sui, makes it paid. */

async function source(relative) {
  return readFile(new URL(`../${relative}`, import.meta.url), 'utf8');
}

test('an invoice the business sent only moves forward', async () => {
  const { canMoveInvoice, INVOICE_TRANSITIONS, ISSUER_SETTABLE, PAYER_MAY_REPORT, invoiceOpen } = await import('../lib/invoices/status.ts');
  assert.equal(canMoveInvoice('settled', 'draft'), false);
  assert.equal(canMoveInvoice('paid', 'sent'), false);
  assert.equal(canMoveInvoice('reported', 'paid'), true);
  assert.equal(canMoveInvoice('paid', 'settled'), true);
  assert.deepEqual(INVOICE_TRANSITIONS.settled, []);
  assert.ok(!ISSUER_SETTABLE.includes('reported'), 'only the payer reports');
  assert.ok(!ISSUER_SETTABLE.includes('draft'), 'nothing goes back to draft');
  assert.ok(!PAYER_MAY_REPORT.includes('paid') && !PAYER_MAY_REPORT.includes('settled') && !PAYER_MAY_REPORT.includes('reported'));
  assert.equal(invoiceOpen('reported'), true);
  assert.equal(invoiceOpen('settled'), false);
});

test('PATCH refuses a status regression, a paid with no reference and a second transfer binding', async () => {
  const route = await source('app/api/invoices/[id]/route.ts');
  assert.match(route, /z\.enum\(ISSUER_SETTABLE/);
  assert.match(route, /!canMoveInvoice\(current\.status, next\)/);
  assert.match(route, /status: 409/);
  assert.match(route, /Add the payment reference you received/);
  assert.match(route, /already bound to a transfer/);
  // Still scoped to the session's org (WS2).
  assert.match(route, /readInvoice\(accountCheck\.account\.orgId, id\)/);
  assert.match(route, /patchInvoice\(accountCheck\.account\.orgId, id,/);
});

test('the pay link reports a payment, never marks it paid, and never overwrites one on record', async () => {
  const route = await source('app/api/pay/[slug]/route.ts');
  assert.match(route, /status: 'reported'/);
  assert.doesNotMatch(route, /status: 'paid'/);
  assert.match(route, /!PAYER_MAY_REPORT\.includes\(invoice\.status\)/);
  assert.match(route, /replayed: true/);
  const client = await source('components/pay/PayInvoiceClient.tsx');
  assert.match(client, /invoice\.status === 'reported'/);
});

test('Invoices opens on a choice: Get paid or Pay invoices, and the old loop link still lands', async () => {
  const page = await source('app/dashboard/invoices/page.tsx');
  assert.match(page, /Get paid/);
  assert.match(page, /Pay invoices/);
  assert.match(page, /role="tablist"/);
  assert.match(page, /aria-selected=/);
  assert.match(page, /'loop'/, '?view=loop (the old Inspection loop) opens Pay invoices');
  assert.doesNotMatch(page, /Inspection loop|Invoice vault/);
  assert.match(page, /<GetPaid/);
  assert.match(page, /<PayInvoices/);
});

test('Get paid: create with inline errors in a real dialog, a pay link, the status and a receipt', async () => {
  const getPaid = await source('components/invoices/GetPaid.tsx');
  const dialog = await source('components/invoices/CreateInvoiceDialog.tsx');
  assert.match(dialog, /role="dialog"/);
  assert.match(dialog, /aria-modal="true"/);
  assert.match(dialog, /Escape/);
  assert.match(dialog, /aria-invalid/);
  assert.match(dialog, /htmlFor=/);
  assert.match(dialog, /What your payer sees/);
  assert.match(dialog, /Copy pay link/);
  assert.match(getPaid, /INVOICE_STATUS_LABEL/);
  assert.match(getPaid, /Mark as paid/);
  assert.match(getPaid, /Receipt/);
  assert.match(getPaid, /suiScanTxUrlOn\('mainnet'/);
  assert.doesNotMatch(getPaid + dialog, /Splash Workspace/, 'the issuer is the business, not a placeholder');
});

test('the invoice pages follow the copy and colour rules', async () => {
  for (const file of [
    'app/dashboard/invoices/page.tsx',
    'components/invoices/GetPaid.tsx',
    'components/invoices/CreateInvoiceDialog.tsx',
    'components/invoices/PayInvoices.tsx',
  ]) {
    const text = await source(file);
    assert.doesNotMatch(text, /Coming soon/i, file);
    assert.doesNotMatch(text, /\bDemo\b|\bDEMO\b/, file);
    assert.doesNotMatch(text, /coral|E39774/i, file);
    assert.doesNotMatch(text, /testnet/i, file);
    assert.doesNotMatch(text, /non-custodial|licen[cs]ed/i, file);
    assert.doesNotMatch(text, /—/, `${file} uses an em dash in its copy`);
  }
});

test('Pay invoices walks the steps, says when approval is not connected, and offers MyInvois for a foreign supplier', async () => {
  const pay = await source('components/invoices/PayInvoices.tsx');
  assert.match(pay, /BILL_STEP_LABEL/);
  assert.match(pay, /PAYMENT_FLOW_NOT_WIRED/);
  assert.match(pay, /\/api\/bills\/\$\{[^}]+\}\/approve/);
  assert.match(pay, /\/api\/bills\/\$\{[^}]+\}\/e-invoice/);
  assert.match(pay, /MYINVOIS_PORTAL_URL/);
  assert.match(pay, /href="\/dashboard\/recipients"/, 'add a recipient when none matches');
  assert.match(pay, /intakeKey: crypto\.randomUUID\(\)/, 'every intake carries its idempotency key');
  assert.match(pay, /<mark/, 'the reading is shown where it was found');
});
