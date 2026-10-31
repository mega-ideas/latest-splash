import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { copyViolations } from '../scripts/copy-rules.mjs';
import { buildHistory, failureNote, filterHistory, historyCsv, mergeLists, statTones, summaryOf } from '../lib/history-page/entries.ts';

/**
 * v2 Phase 3, History: a payment that failed is its own category, with its own
 * filter and count, apart from "In progress" (still moving) and "Not paid" (a
 * person said no, or the time ran out). Every failed row says in words what
 * happened and what to do next. A refresh that fails keeps the counts that
 * were loaded and says so in one sentence above the list.
 */

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const USDC = (n) => String(Math.round(n * 1_000_000));

const transfer = (over = {}) => ({ id: 'wt_1', paymentRef: 'pay_1', status: 'settled', payeeKind: 'SELF_CUSTODY', payeeName: 'Dela Cruz Trading', payeeMasked: '0x7777…7777', payeeCountry: 'PH', amountMinor: USDC(250), reference: 'INV-204', createdAt: '2026-10-20T08:00:00.000Z', ...over });
const batch = (over = {}) => ({ id: 'wb_1', label: 'October suppliers', status: 'settled', rowCount: 12, totalMinor: USDC(4000), createdAt: '2026-10-22T08:00:00.000Z', ...over });
const withdrawal = (over = {}) => ({ id: 'wdr_1', status: 'paid_out', destination: { label: 'Operating account', last4: '4411' }, amountMinor: USDC(1000), currency: 'MYR', createdAt: '2026-10-25T08:00:00.000Z', ...over });
const earlier = (over = {}) => ({ id: 'tr_old', recipientName: 'PT Maju', targetCurrency: 'IDR', targetAmount: '1500000', sourceAmountUsd: '95', state: 'SETTLED', createdAt: '2026-09-01T00:00:00.000Z', ...over });
const none = { transfers: [], batches: [], withdrawals: [], earlier: [] };
const one = (kind, row) => buildHistory({ ...none, [kind]: [row] })[0];

/* The categories ------------------------------------------------------------- */

test('a payment that broke is Failed; one that a person stopped or that ran out of time is Not paid', () => {
  const group = (kind, row) => one(kind, row).group;
  for (const status of ['failed']) assert.equal(group('transfers', transfer({ status })), 'failed', `payment ${status}`);
  for (const status of ['declined', 'expired', 'withdrawn']) assert.equal(group('transfers', transfer({ status })), 'not_paid', `payment ${status}`);
  assert.equal(group('batches', batch({ status: 'failed' })), 'failed');
  assert.equal(group('batches', batch({ status: 'expired' })), 'not_paid');
  for (const status of ['failed', 'returned']) assert.equal(group('withdrawals', withdrawal({ status })), 'failed', `withdrawal ${status}`);
  assert.equal(group('withdrawals', withdrawal({ status: 'cancelled' })), 'not_paid');
  for (const state of ['FAILED', 'REFUNDING', 'REFUNDED']) assert.equal(group('earlier', earlier({ state })), 'failed', `earlier ${state}`);
  // Moving on is not failing, and a paid row stays paid.
  assert.equal(group('transfers', transfer({ status: 'on_the_way' })), 'in_progress');
  assert.equal(group('withdrawals', withdrawal({ status: 'paid_out' })), 'paid');
  assert.equal(group('earlier', earlier({ state: 'EXCHANGING' })), 'in_progress');
});

test('every row is in exactly one category, so the four counts add up to all', () => {
  const list = buildHistory({
    transfers: ['settled', 'on_the_way', 'awaiting_signatures', 'asked_owners', 'failed', 'declined', 'expired', 'withdrawn'].map((status, i) => transfer({ id: `wt_${i}`, paymentRef: `pay_${i}`, status })),
    batches: ['settled', 'prepared', 'failed', 'expired'].map((status, i) => batch({ id: `wb_${i}`, status })),
    withdrawals: ['paid_out', 'sent', 'failed', 'returned', 'cancelled'].map((status, i) => withdrawal({ id: `wdr_${i}`, status })),
    earlier: ['SETTLED', 'EXCHANGING', 'FAILED', 'REFUNDED'].map((state, i) => earlier({ id: `tr_${i}`, state })),
  });
  const s = summaryOf(list, new Date('2026-10-28T00:00:00Z'));
  const count = (g) => filterHistory(list, { group: g, query: '' }).length;
  assert.equal(s.failed, count('failed'));
  assert.equal(s.failed, 1 + 1 + 2 + 2);
  assert.equal(s.notPaid, count('not_paid'));
  assert.equal(s.notPaid, 3 + 1 + 1);
  assert.equal(s.inProgress, count('in_progress'));
  assert.equal(count('paid') + s.inProgress + s.failed + s.notPaid, s.total);
  assert.equal(count('all'), s.total);
  // A failed row is in no other filter.
  for (const g of ['paid', 'in_progress', 'not_paid']) assert.ok(filterHistory(list, { group: g, query: '' }).every((e) => e.status.label !== 'Did not go through' && e.status.label !== 'Returned to your wallet'), g);
});

test('the Failed filter holds only failed rows, and a search narrows within it', () => {
  const list = buildHistory({
    transfers: [transfer({ status: 'failed', payeeName: 'Kopi Works', reference: 'PO-9' }), transfer({ id: 'wt_2', paymentRef: 'pay_2', status: 'failed', payeeName: 'Maju Print' }), transfer({ id: 'wt_3', paymentRef: 'pay_3', status: 'declined', payeeName: 'Kopi Corner' })],
    batches: [batch({ status: 'failed' })],
    withdrawals: [],
    earlier: [],
  });
  assert.equal(filterHistory(list, { group: 'failed', query: '' }).length, 3);
  assert.equal(filterHistory(list, { group: 'failed', query: 'kopi' }).length, 1);
  assert.equal(filterHistory(list, { group: 'failed', query: 'po-9' }).length, 1);
  assert.equal(filterHistory(list, { group: 'not_paid', query: 'kopi' }).length, 1);
  assert.equal(filterHistory(list, { group: 'failed', query: 'nothing like it' }).length, 0);
});

test('the counts come from the rows: a failed row never raises Not paid or In progress', () => {
  const list = buildHistory({ ...none, transfers: [transfer({ status: 'failed' })] });
  const s = summaryOf(list, new Date('2026-10-28T00:00:00Z'));
  assert.deepEqual([s.failed, s.notPaid, s.inProgress, s.total], [1, 0, 0, 1]);
  assert.equal(s.sentThisMonthMinor, '0', 'a payment that failed was never sent');
});

test('a count turns the alarm colour only when there is something that failed', () => {
  const quiet = statTones({ inProgress: 0, failed: 0, notPaid: 0 });
  assert.equal(quiet.failed, quiet.inProgress, 'zero is not news');
  const loud = statTones({ inProgress: 2, failed: 3, notPaid: 4 });
  assert.match(loud.failed, /--error/);
  assert.match(loud.inProgress, /--gold-ink/);
  assert.doesNotMatch(loud.notPaid, /--error/, 'a payment someone stopped is not an alarm');
  assert.notEqual(loud.failed, loud.inProgress, 'failing and waiting are told apart by colour as well as by words');
});

/* What happened and what to do ----------------------------------------------- */

const FAILED_ROWS = () => [
  one('transfers', transfer({ status: 'failed' })),
  one('batches', batch({ status: 'failed' })),
  one('withdrawals', withdrawal({ status: 'failed' })),
  one('withdrawals', withdrawal({ status: 'returned' })),
  one('earlier', earlier({ state: 'FAILED' })),
  one('earlier', earlier({ state: 'REFUNDING' })),
  one('earlier', earlier({ state: 'REFUNDED' })),
];

test('every failed row says why in words and what to do next; no other row carries that block', () => {
  for (const e of FAILED_ROWS()) {
    assert.ok(e.explain, `${e.key} has an explanation`);
    assert.ok(e.explain.why.length > 20 && e.explain.next.length > 20, e.key);
    assert.match(e.explain.why, /\.$/);
    assert.match(e.explain.next, /\.$/);
    assert.notEqual(e.explain.why, e.explain.next);
  }
  const others = [
    one('transfers', transfer({ status: 'settled' })),
    one('transfers', transfer({ id: 'wt_2', paymentRef: 'pay_2', status: 'on_the_way' })),
    one('transfers', transfer({ id: 'wt_3', paymentRef: 'pay_3', status: 'declined' })),
    one('transfers', transfer({ id: 'wt_4', paymentRef: 'pay_4', status: 'expired' })),
    one('batches', batch({ status: 'expired' })),
    one('withdrawals', withdrawal({ status: 'cancelled' })),
    one('earlier', earlier({ state: 'SETTLED' })),
  ];
  for (const e of others) assert.equal(e.explain, null, e.key);
});

test('the words are plain: no state names, codes, hashes or system terms', () => {
  const JARGON = /\b(webhook|signing request|on-?chain|blockchain|transaction hash|digest|tx|api|http|error code|status|state|enum|kms|sui|gas|mist|idempoten\w*|reconcil\w*|null|undefined|exception|stack|partner|adapter|intent|ledger|payload)\b|0x[0-9a-f]{6,}|\b[A-Z]{2,}_[A-Z_]+\b/i;
  for (const e of FAILED_ROWS()) {
    for (const line of [e.explain.why, e.explain.next, e.status.label]) assert.doesNotMatch(line, JARGON, `${e.key}: ${line}`);
    assert.doesNotMatch(`${e.explain.why} ${e.explain.next}`, /—|–/, 'a hyphen or a full stop, not a dash');
    assert.doesNotMatch(`${e.explain.why} ${e.explain.next}`, /sorry|oops|unfortunately|!/i, 'a failure states the fact, it does not apologise');
  }
});

test('each kind of failure says what is true for it', () => {
  const [payment, batchRow, withdrawalFailed, withdrawalReturned, earlierFailed, refunding, refunded] = FAILED_ROWS();
  assert.match(payment.explain.why, /not sent|did not (?:go|reach)|could not be completed/i);
  assert.match(payment.explain.next, /payee/i, 'a payment is retried against its payee');
  assert.match(batchRow.explain.why, /none of (?:its|the) payments/i, 'a batch goes as one transaction: if it fails, none of it was sent');
  assert.match(batchRow.explain.next, /batch/i);
  assert.match(withdrawalFailed.explain.why, /bank/i);
  assert.match(withdrawalFailed.explain.why, /USDC/);
  assert.match(withdrawalFailed.explain.next, /wallet/i);
  assert.match(withdrawalReturned.explain.why, /back in your wallet/i);
  assert.match(withdrawalReturned.explain.next, /bank details/i);
  assert.match(earlierFailed.explain.next, /record|transfer/i);
  assert.match(refunding.explain.why, /sent back|returned|refund/i);
  assert.match(refunding.explain.next, /nothing|no action/i, 'a refund on its way needs nothing from the person');
  assert.match(refunded.explain.why, /sent back|returned|refund/i);
});

test('a failed row has no receipt to open, and says that it was not paid', () => {
  for (const e of FAILED_ROWS().filter((x) => x.kind !== 'earlier')) {
    assert.equal(e.href, null, e.key);
    assert.match(e.noReceipt ?? '', /no receipt/i, e.key);
  }
  assert.equal(one('earlier', earlier({ state: 'FAILED' })).href, '/dashboard/audit/tr_old', 'an earlier transfer keeps its record');
});

test('copy that appears on the page passes the copy rules', () => {
  const text = JSON.stringify(FAILED_ROWS().map((e) => e.explain));
  assert.doesNotMatch(text, /testnet|Demo|Coming soon|licen[cs]e|non-custodial/i);
  assert.doesNotMatch(text, /\b(Hata|Fiuu|PDAX|DurianPay|Halliday|Stripe|TransFi|Bridge|Elliptic|Chainalysis|Sumsub)\b/);
  assert.deepEqual(copyViolations('components/history/HistoryPage.tsx', `<p>${text}</p>`), []);
});

test('the export still names the status of a failed row and adds no fee', () => {
  const csv = historyCsv(buildHistory({ ...none, transfers: [transfer({ status: 'failed' })] }));
  assert.match(csv, /Did not go through/);
  assert.doesNotMatch(csv.split('\r\n')[0], /[Ff]ee/);
});

/* A refresh that fails ------------------------------------------------------- */

const lists = (over = {}) => ({ transfers: [transfer({ status: 'failed' }), transfer({ id: 'wt_2', paymentRef: 'pay_2', status: 'on_the_way' })], batches: [batch({ status: 'failed' })], withdrawals: [withdrawal()], earlier: [], restricted: false, ...over });
const ok = (items) => ({ ok: true, status: 200, items });
const down = { ok: false, status: 503, items: [] };
const answers = (over = {}) => ({ transfers: ok(lists().transfers), batches: ok(lists().batches), withdrawals: ok(lists().withdrawals), earlier: ok([]), ...over });

test('a refresh that fails keeps the counts that were loaded', () => {
  const before = lists();
  const countsOf = (l) => {
    const s = summaryOf(buildHistory(l), new Date('2026-10-28T00:00:00Z'));
    return [s.failed, s.inProgress, s.notPaid, s.total];
  };
  const allDown = mergeLists(before, { transfers: down, batches: down, withdrawals: down, earlier: down });
  assert.deepEqual(countsOf(allDown.lists), countsOf(before));
  assert.equal(allDown.failed.length, 4);
  const partly = mergeLists(before, answers({ transfers: down }));
  assert.deepEqual(countsOf(partly.lists), countsOf(before), 'the list that did not answer keeps what it held');
  assert.deepEqual(partly.failed, ['payments']);
  // An answer that did come in replaces what was there.
  const batchFixed = mergeLists(before, answers({ transfers: down, batches: ok([]) }));
  assert.equal(countsOf(batchFixed.lists)[0], 1, 'the failed batch is gone because the batches answered');
});

test('the sentence above the list says the counts are the last ones loaded', () => {
  const all = failureNote(['payments', 'batches', 'withdrawals', 'earlier'], true);
  assert.match(all, /could not be refreshed/);
  assert.match(all, /counts/);
  assert.match(all, /list below/);
  assert.match(all, /last time it loaded|loaded before/);
  const some = failureNote(['payments'], true);
  assert.match(some, /^Payments could not be refreshed\./);
  assert.match(some, /counts/);
  assert.match(some, /loaded before/);
  const two = failureNote(['payments', 'earlier'], true);
  assert.match(two, /^Payments and earlier transfers could not be refreshed\./);
  assert.equal(failureNote([], true), '');
  assert.equal(failureNote([], false), '');
  for (const sentence of [all, some, two]) assert.doesNotMatch(sentence, /—|–|!|sorry/i);
});

test('on a first load that only partly answered, the sentence says what is missing from the counts', () => {
  const first = failureNote(['withdrawals'], false);
  assert.match(first, /^Withdrawals could not be loaded/);
  assert.match(first, /missing from the counts/);
  assert.match(first, /list below/);
  const merged = mergeLists(null, answers({ withdrawals: down }));
  assert.deepEqual(merged.failed, ['withdrawals']);
  assert.deepEqual(merged.lists.withdrawals, [], 'nothing was loaded for it, so nothing is invented');
});

test('a viewer’s 403 is the business’s rule, never a failed refresh', () => {
  const merged = mergeLists(null, answers({ transfers: { ok: false, status: 403, items: [] }, batches: { ok: false, status: 403, items: [] } }));
  assert.deepEqual(merged.failed, []);
  assert.equal(merged.lists.restricted, true);
});

/* The page ------------------------------------------------------------------- */

const page = () => code(read('components/history/HistoryPage.tsx'));

test('the page has a Failed filter between In progress and Not paid, each with its own count', () => {
  const src = page();
  const labels = [...src.matchAll(/\{ id: '([a-z_]+)', label: '([^']+)' \}/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(labels, [['all', 'All'], ['paid', 'Paid'], ['in_progress', 'In progress'], ['failed', 'Failed'], ['not_paid', 'Not paid']]);
  assert.match(src, /failed: summary\.failed/);
  assert.match(src, /not_paid: summary\.notPaid/);
  assert.match(src, /label="Failed" value=\{String\(summary\.failed\)\} valueClassName=\{tones\.failed\}/);
  assert.match(src, /label="Not paid" value=\{String\(summary\.notPaid\)\} valueClassName=\{tones\.notPaid\}/);
});

test('a failed row shows what happened and what to do next, in words, not by colour alone', () => {
  const src = page();
  assert.match(src, /entry\.explain/);
  assert.match(src, /What happened/);
  assert.match(src, /What to do next/);
  assert.match(src, /entry\.explain\.why/);
  assert.match(src, /entry\.explain\.next/);
});

test('the failed-refresh sentence sits above the list, is announced, and offers Try again', () => {
  const src = page();
  const note = src.indexOf('{failed ?');
  const list = src.indexOf('aria-label="Receipts and records"');
  const stats = src.indexOf('<DashStat label="Sent this month"');
  assert.ok(stats > -1 && note > stats && list > note, 'counts, then the sentence, then the list');
  assert.match(src.slice(note, list), /role="status"/);
  assert.match(src.slice(note, list), /Try again/);
  assert.match(src, /failureNote\(merged\.failed, [a-zA-Z.]+ !== null\)/, 'the sentence knows whether anything was loaded before');
});

/* Tenancy ---------------------------------------------------------------------- */

test('the lists come only from routes that take the business from the session; the page names no business', () => {
  const src = page();
  assert.doesNotMatch(src, /orgId|accountId|businessId|[?&](org|orgId|account)=/);
  assert.match(read('app/api/transfers/route.ts'), /requireSessionAccount\(/);
  assert.match(read('lib/server/wallet-route.ts'), /requireSessionAccount\(/);
  for (const route of ['app/api/wallet/transfers/route.ts', 'app/api/wallet/batches/route.ts', 'app/api/wallet/withdrawals/route.ts']) {
    const text = read(route);
    const get = text.slice(text.indexOf('export async function GET'));
    assert.match(get.slice(0, 400), /Route\(request\)/, `${route}: GET goes through the session gate`);
    assert.doesNotMatch(get.slice(0, 600), /searchParams|new URL\(request\.url\)/, `${route}: GET takes no business from the query`);
  }
});

test('the page moves no money: it only reads and exports', () => {
  const src = page();
  assert.doesNotMatch(src, /method: 'POST'|method: 'PUT'|method: 'DELETE'|method: 'PATCH'/);
  assert.doesNotMatch(src, /Idempotency-Key/);
});

/* Contrast --------------------------------------------------------------------- */

const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test('the words in the failed block read at 4.5:1 on the tint they sit on', () => {
  const tokens = read('styles/tokens.css');
  const token = (name) => tokens.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`))[1];
  const ink = token('--ink');
  const errorBg = token('--error-bg');
  const error = token('--error');
  assert.ok(ratio(ink, errorBg) >= 4.5, `ink on the error tint ${ratio(ink, errorBg).toFixed(2)}`);
  assert.ok(ratio(error, '#FFFFFF') >= 4.5, `error on white ${ratio(error, '#FFFFFF').toFixed(2)}`);
  const src = page();
  // The block uses the ink on the error tint for its words; the error colour is only an edge and a heading on white.
  assert.match(src, /bg-\[var\(--error-bg\)\]/);
  assert.doesNotMatch(src.slice(src.indexOf('function Row')), /text-\[var\(--error\)\][^"]*text-\[13px\]|text-red-|text-rose-/);
});
