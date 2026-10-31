import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

import { copyViolations } from '../scripts/copy-rules.mjs';
import { buildHistory, filterHistory, historyCsv, summaryOf } from '../lib/history-page/entries.ts';

/**
 * v2 Phase 3, brief 5.9: History, receipts first. Every payment, batch and
 * withdrawal is a receipt the person can open, in the words a person uses (Paid,
 * On its way, Waiting for an owner), not a state machine; what was sent this
 * month is only what was paid; the export is what an accountant can use and
 * claims no fee it does not know.
 */

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const USDC = (n) => String(Math.round(n * 1_000_000));

const transfer = (over = {}) => ({ id: 'wt_1', paymentRef: 'pay_1', route: 'owners_sign', status: 'settled', payeeKind: 'SELF_CUSTODY', payeeName: 'Dela Cruz Trading', payeeMasked: '0x7777…7777', payeeCountry: 'PH', amountMinor: USDC(250), feeMinor: USDC(0.25), feeKind: 1, reference: 'INV-204', signingRequestId: 'sr_1', askId: null, createdAt: '2026-10-20T08:00:00.000Z', ...over });
const batch = (over = {}) => ({ id: 'wb_1', label: 'October suppliers', status: 'settled', rowCount: 12, totalMinor: USDC(4000), feeMinor: USDC(3), signingRequestId: 'sr_2', requestedBy: 'u1', createdAt: '2026-10-22T08:00:00.000Z', rows: [], ...over });
const withdrawal = (over = {}) => ({ id: 'wdr_1', status: 'paid_out', partner: 'p', destination: { id: 'd', bankCode: 'X', last4: '4411', label: 'Operating account' }, amountMinor: USDC(1000), maxFeeMinor: USDC(1), currency: 'MYR', receiveMinor: '470000', intentId: 'i', createdAt: '2026-10-25T08:00:00.000Z', kind: 'withdrawal', ...over });
const earlier = (over = {}) => ({ id: 'tr_old', recipientName: 'PT Maju', targetCurrency: 'IDR', targetAmount: '1500000', sourceAmountUsd: '95', state: 'SETTLED', createdAt: '2026-09-01T00:00:00.000Z', ...over });

test('a transfer reads in the words a person uses, grouped paid, in progress, failed or not paid', () => {
  const cases = {
    settled: ['Paid', 'ok', 'paid'],
    on_the_way: ['On its way', 'wait', 'in_progress'],
    awaiting_signatures: ['Waiting for signatures', 'wait', 'in_progress'],
    asked_owners: ['Waiting for an owner', 'wait', 'in_progress'],
    failed: ['Did not go through', 'bad', 'failed'],
    declined: ['Declined by an owner', 'bad', 'not_paid'],
    expired: ['Expired before it was signed', 'bad', 'not_paid'],
    withdrawn: ['Withdrawn', 'bad', 'not_paid'],
  };
  for (const [status, [label, tone, group]] of Object.entries(cases)) {
    const [e] = buildHistory({ transfers: [transfer({ status })], batches: [], withdrawals: [], earlier: [] });
    assert.deepEqual([e.status.label, e.status.tone, e.group], [label, tone, group], status);
  }
});

test('a batch and a withdrawal read the same way, and a withdrawal says where it is', () => {
  const b = (status) => buildHistory({ transfers: [], batches: [batch({ status })], withdrawals: [], earlier: [] })[0];
  assert.deepEqual([b('settled').status.label, b('settled').group], ['Paid', 'paid']);
  assert.equal(b('prepared').status.label, 'Waiting for an owner to start the signatures');
  assert.equal(b('awaiting_signatures').group, 'in_progress');
  assert.equal(b('failed').group, 'failed');
  assert.equal(b('expired').group, 'not_paid');
  assert.equal(b('settled').title, 'October suppliers');
  assert.equal(buildHistory({ transfers: [], batches: [batch({ label: null })], withdrawals: [], earlier: [] })[0].title, 'Batch of 12 payments');
  const w = (status) => buildHistory({ transfers: [], batches: [], withdrawals: [withdrawal({ status })], earlier: [] })[0];
  assert.deepEqual([w('paid_out').status.label, w('paid_out').group], ['In your bank', 'paid']);
  assert.deepEqual([w('sent').status.label, w('sent').group], ['On its way to your bank', 'in_progress']);
  assert.equal(w('returned').status.label, 'Returned to your wallet');
  assert.equal(w('returned').group, 'failed');
  assert.equal(w('cancelled').group, 'not_paid');
  assert.equal(w('paid_out').title, 'Withdrawal to Operating account');
  assert.match(w('paid_out').detail, /4411/);
});

test('only a payment the owners accepted has a receipt to open', () => {
  const href = (t) => buildHistory({ transfers: [t], batches: [], withdrawals: [], earlier: [] })[0].href;
  assert.equal(href(transfer({ status: 'settled' })), '/dashboard/history/pay_1');
  assert.equal(href(transfer({ status: 'on_the_way' })), '/dashboard/history/pay_1');
  for (const status of ['awaiting_signatures', 'asked_owners', 'failed', 'declined', 'expired', 'withdrawn']) assert.equal(href(transfer({ status })), null, status);
  const batchHref = (s) => buildHistory({ transfers: [], batches: [batch({ status: s })], withdrawals: [], earlier: [] })[0].href;
  assert.equal(batchHref('settled'), '/dashboard/history/batch/wb_1');
  assert.equal(batchHref('on_the_way'), '/dashboard/history/batch/wb_1');
  assert.equal(batchHref('prepared'), null);
  const wdHref = (s) => buildHistory({ transfers: [], batches: [], withdrawals: [withdrawal({ status: s })], earlier: [] })[0].href;
  assert.equal(wdHref('paid_out'), '/dashboard/history/wdr_1');
  assert.equal(wdHref('sent'), '/dashboard/history/wdr_1');
  assert.equal(wdHref('preparing'), null);
  // A reference is a path segment: it is encoded, never trusted as one.
  assert.equal(buildHistory({ transfers: [transfer({ paymentRef: 'a/b?c' })], batches: [], withdrawals: [], earlier: [] })[0].href, '/dashboard/history/a%2Fb%3Fc');
});

test('everything is one list, newest first, and an earlier transfer is marked as earlier', () => {
  const list = buildHistory({ transfers: [transfer()], batches: [batch()], withdrawals: [withdrawal()], earlier: [earlier()] });
  assert.deepEqual(list.map((e) => e.kind), ['withdrawal', 'batch', 'payment', 'earlier']);
  const old = list[3];
  assert.equal(old.href, '/dashboard/audit/tr_old');
  assert.equal(old.amountText, 'USD 95');
  assert.match(old.detail, /Earlier transfer/);
  assert.equal(old.group, 'paid');
  assert.equal(buildHistory({ transfers: [], batches: [], withdrawals: [], earlier: [earlier({ state: 'EXCHANGING' })] })[0].group, 'in_progress');
  assert.equal(buildHistory({ transfers: [], batches: [], withdrawals: [], earlier: [earlier({ state: 'REFUNDED' })] })[0].group, 'failed');
});

test('the amount is what was sent, in USDC, never a guess', () => {
  const [e] = buildHistory({ transfers: [transfer()], batches: [], withdrawals: [], earlier: [] });
  assert.equal(e.amountText, '250.00 USDC');
  assert.equal(e.amountMinor, USDC(250));
  assert.doesNotMatch(JSON.stringify(e), /fee/i, 'the list shows no fee: what the chain charged is on the receipt');
});

test('sent this month counts only what was paid, this month, in USDC', () => {
  const list = buildHistory({
    transfers: [transfer({ amountMinor: USDC(250) }), transfer({ id: 'wt_2', paymentRef: 'pay_2', status: 'on_the_way', amountMinor: USDC(999) }), transfer({ id: 'wt_3', paymentRef: 'pay_3', createdAt: '2026-09-20T00:00:00Z', amountMinor: USDC(777) })],
    batches: [batch({ totalMinor: USDC(4000) })],
    withdrawals: [withdrawal({ amountMinor: USDC(1000) })],
    earlier: [earlier({ createdAt: '2026-10-02T00:00:00Z' })],
  });
  const s = summaryOf(list, new Date('2026-10-28T00:00:00Z'));
  assert.equal(s.sentThisMonthMinor, USDC(5250));
  assert.equal(s.inProgress, 1);
  assert.equal(s.notPaid, 0);
  assert.equal(s.failed, 0);
  assert.equal(s.total, 6);
});

test('filter by group and search by payee, reference or amount', () => {
  const list = buildHistory({ transfers: [transfer(), transfer({ id: 'wt_2', paymentRef: 'pay_2', status: 'declined', payeeName: 'Kopi Works', reference: 'PO-9' })], batches: [batch()], withdrawals: [], earlier: [] });
  assert.equal(filterHistory(list, { group: 'paid', query: '' }).length, 2);
  assert.equal(filterHistory(list, { group: 'not_paid', query: '' }).length, 1);
  assert.equal(filterHistory(list, { group: 'all', query: 'kopi' }).length, 1);
  assert.equal(filterHistory(list, { group: 'all', query: 'inv-204' }).length, 1);
  assert.equal(filterHistory(list, { group: 'all', query: 'october' }).length, 1);
  assert.equal(filterHistory(list, { group: 'paid', query: 'kopi' }).length, 0);
});

test('the export is a plain table an accountant can open, quoted, with no formula an app would run', () => {
  const list = buildHistory({ transfers: [transfer({ payeeName: '=HYPERLINK("http://x","y")', reference: 'a, "b"\nc' })], batches: [batch()], withdrawals: [], earlier: [] });
  const csv = historyCsv(list);
  const [header, ...rows] = csv.split('\r\n');
  assert.equal(header, 'Date,Type,Payee,Reference,Amount sent (USDC),Status,Receipt');
  assert.equal(rows.length, 2);
  assert.match(csv, /"'=HYPERLINK\(""http:\/\/x"",""y""\)"/, 'a cell that starts like a formula is made text');
  assert.match(csv, /"a, ""b""\nc"/);
  assert.match(csv, /2026-10-22,Batch,October suppliers,,4000\.00,Paid,\/dashboard\/history\/batch\/wb_1/);
  assert.doesNotMatch(header, /[Ff]ee/, 'a fee is on each receipt, as the chain charged it; the list only knows the most it could be');
});

/* The page ------------------------------------------------------------------ */

const pageFiles = () => {
  const dir = new URL('../components/history/', import.meta.url);
  return existsSync(dir) ? readdirSync(dir).filter((f) => /\.tsx?$/.test(f)).map((f) => [`components/history/${f}`, read(`components/history/${f}`)]) : [];
};

test('the page reads the business’s own payments, batches and withdrawals and nothing else', () => {
  const files = pageFiles();
  assert.ok(files.length >= 2);
  const joined = files.map(([, t]) => code(t)).join('\n');
  for (const url of ['/api/wallet/transfers', '/api/wallet/batches', '/api/wallet/withdrawals', '/api/transfers']) assert.match(joined, new RegExp(url.replaceAll('/', '\\/')), url);
  assert.doesNotMatch(joined, /orgId|accountId|\?(org|orgId|account)=/);
  assert.match(read('app/dashboard/history/page.tsx'), /HistoryPage/);
});

test('the old settlement state machine, the step bar and the Demo badge are gone', () => {
  const joined = pageFiles().map(([, t]) => code(t)).join('\n') + code(read('app/dashboard/history/page.tsx'));
  assert.doesNotMatch(joined, /STATE_ORDER|ProgressSteps|EXCHANGING|Deposit Confirmed|Sweeping|StatusBadge|record\.demo|Settlement history/);
  assert.doesNotMatch(joined, /text-red-|bg-red-|bg-foreground|border-primary/, 'colours come from the dashboard tokens');
});

test('a receipt opens from the list: a payment, a batch and a withdrawal each have a page', () => {
  assert.ok(existsSync(new URL('../app/dashboard/history/[ref]/page.tsx', import.meta.url)));
  assert.ok(existsSync(new URL('../app/dashboard/history/batch/[id]/page.tsx', import.meta.url)));
  const receipt = pageFiles().map(([, t]) => t).join('\n');
  assert.match(receipt, /<StepReceipt refId=/);
  assert.match(receipt, /<StepReceipts batchId=/);
  assert.match(read('app/dashboard/history/[ref]/page.tsx'), /await params/);
});

test('a viewer is told why the list is short, polling runs only while something is in progress, and a failure is a sentence', () => {
  const joined = pageFiles().map(([, t]) => code(t)).join('\n');
  // Where the four answers are folded (a viewer's 403 is not a failure) is the page or the pure lists module beside it.
  assert.match([joined, read('lib/history-page/entries.ts')].join('\n'), /status === 403/);
  assert.match(joined, /Only an owner or a staff member/);
  assert.match(joined, /if \(!moving\) return;/, 'a page with nothing moving asks nothing every few seconds');
  assert.match(joined, /visibilityState/);
  assert.match(joined, /<Note tone="error">/, 'a failure is a sentence (the Note is an alert)');
  assert.match(read('components/wallet/parts.tsx'), /role="alert"/);
  assert.match(joined, /Try again/);
});

test('no coral, Demo, Coming soon, testnet, grid, unsigned partner name or licence claim, and the copy rules hold', () => {
  const all = [...pageFiles(), ['app/dashboard/history/page.tsx', read('app/dashboard/history/page.tsx')]];
  for (const [name, text] of all) {
    const body = code(text);
    assert.doesNotMatch(body, /E39774|coral|\bDemo\b|\bDEMO\b|Coming soon|testnet|bg-grid|grid-background/i, name);
    assert.doesNotMatch(body, /\b(Hata|Fiuu|PDAX|DurianPay|Halliday|Stripe|TransFi|Bridge|Elliptic|Chainalysis|Sumsub)\b/, name);
    assert.deepEqual(copyViolations(name, text), [], name);
  }
});
