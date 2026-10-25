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
  // The rules live in lib/invoices/patch-rules.ts since the 5.8 review;
  // tests/pay-invoices-review.test.mjs drives them.
  assert.match(route, /checkInvoicePatch\(/);
  const rules = await source('lib/invoices/patch-rules.ts');
  assert.match(rules, /!canMoveInvoice\(current\.status as InvoiceStatusV2, next\)/);
  assert.match(rules, /status: 409/);
  assert.match(rules, /Add the reference of the payment you received/);
  assert.match(rules, /already bound to a transfer/);
  // Still scoped to the session's org (WS2).
  assert.match(route, /readInvoice\(accountCheck\.account\.orgId, id\)/);
  assert.match(route, /patchInvoice\(accountCheck\.account\.orgId, id,/);
});

test('the pay link reports a payment, never marks it paid, and never overwrites one on record', async () => {
  const route = await source('app/api/pay/[slug]/route.ts');
  // The report is written by a guarded UPDATE in the repository since the 5.8 review.
  assert.match(route, /reportInvoicePayment\(invoice\.id, PAYER_MAY_REPORT/);
  assert.match(await source('lib/server/repository/invoices.ts'), /status: 'reported'/);
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

test('the Get paid totals show the whole amount on a phone, never cut off', async () => {
  const getPaid = await source('components/invoices/GetPaid.tsx');
  const tile = /<p className=\{cn\('dash-num[^']*'[^}]*\}\s*[^>]*>/.exec(getPaid);
  assert.ok(tile, 'the totals tile renders its figure through cn(), sized by its length');
  assert.doesNotMatch(tile[0], /truncate/, 'an amount is never shown cut off, as "10,931..."');
  assert.doesNotMatch(tile[0], /overflow-wrap:anywhere|break-all/, 'a money figure is never split mid-number, as "1,234,567.8" / "9"');
  assert.match(tile[0], /whitespace-nowrap/, 'a money figure stays on one line');
  assert.match(tile[0], /figure\.className/, 'the figure steps down in size by its length');
});

test('at 390px every Get paid total of 1,234,567.89 and up fits its tile on one line', async () => {
  const { TOTALS_PHONE, TOTALS_WIDE, totalsFigure, figureFits } = await import('../lib/invoices/totals-figure.ts');
  // The phone tiles: Open has the whole row; Overdue and Paid this month share
  // the next one. Widths are the measured content boxes at 390x844.
  for (const value of ['1,234,567.89', '12,345,678.90', '999,999,999.99', '1,234,567,890.12', '999,999,999,999.99']) {
    for (const width of [TOTALS_PHONE.fullRowPx, TOTALS_PHONE.halfRowPx]) {
      const fig = totalsFigure(value);
      assert.ok(figureFits(fig, width), `${value} at ${fig.phonePx}px fits ${width}px on one line`);
      assert.equal(fig.full, value, 'the full value is always kept, for the title and screen readers');
    }
    const fig = totalsFigure(value);
    assert.ok(figureFits(fig, TOTALS_WIDE.narrowestPx, fig.widePx), `${value} at ${fig.widePx}px fits the narrowest tile from sm up`);
  }
  // Short figures keep the reading size; long ones step down, never below 12px.
  assert.equal(totalsFigure('10,931.50').phonePx, 15);
  assert.ok(totalsFigure('999,999,999,999.99').phonePx >= 12);
  // Past what a tile can hold at 12px, the figure is shown compact with the full value beside it for assistive tech.
  const huge = totalsFigure('1,234,567,890,123,456.78');
  assert.ok(huge.display.length < huge.full.length && figureFits(huge, TOTALS_PHONE.halfRowPx));
  assert.equal(huge.full, '1,234,567,890,123,456.78');
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
