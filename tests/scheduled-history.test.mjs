/**
 * v2 Phase 3, scheduled batches in History and in Transfer's Scheduled tab.
 *
 *   History   a scheduled run is one row, in the owners' words: paid, waiting for
 *             approval, approved, skipped, not approved in time, and failed (which
 *             has its own group, with what happened and what to do). A run that was
 *             prepared for approval is not listed a second time as its batch.
 *   The tab   reached from Transfer by its address, so a notice can open the run it
 *             is about; Skip, Stop, Edit and Delete are plain buttons; dates go
 *             through LocalTime; nothing the copy rules refuse.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { buildHistory, filterHistory, historyCsv, summaryOf } from '../lib/history-page/entries.ts';
import { RUN_STATUSES } from '../lib/schedule/rules.ts';

const run = (over = {}) => ({
  id: 'psr_1',
  scheduleName: 'Monthly suppliers',
  status: 'paid',
  mode: 'ask',
  ranAs: 'ask',
  fallback: false,
  reason: null,
  itemCount: 2,
  totalMinor: '1250500000',
  dueAt: '2026-11-03T08:00:00.000Z',
  receiptPath: '/dashboard/history/batch/wbt_1',
  batchId: 'wbt_1',
  ...over,
});
const none = { transfers: [], batches: [], withdrawals: [], earlier: [] };

test('a paid scheduled run is one row with its receipt, and counts in what was sent this month', () => {
  const [e] = buildHistory({ ...none, scheduled: [run()] });
  assert.equal(e.kind, 'scheduled');
  assert.equal(e.title, 'Monthly suppliers');
  assert.equal(e.group, 'paid');
  assert.equal(e.status.label, 'Paid');
  assert.equal(e.href, '/dashboard/history/batch/wbt_1');
  assert.match(e.detail, /Scheduled · 2 payments · Approved by your owners/);
  assert.equal(e.amountText, '1,250.50 USDC');
  assert.equal(summaryOf([e], new Date('2026-11-20T00:00:00Z')).sentThisMonthMinor, '1250500000');
});

test('an automatic run says it was paid automatically within the limits, and a handed-back one says it was handed back', () => {
  const auto = buildHistory({ ...none, scheduled: [run({ ranAs: 'auto', mode: 'auto', batchId: null, receiptPath: '/dashboard/history/scheduled/psr_1' })] })[0];
  assert.match(auto.detail, /Paid automatically within your limits/);
  assert.equal(auto.href, '/dashboard/history/scheduled/psr_1');
  const back = buildHistory({ ...none, scheduled: [run({ mode: 'auto', fallback: true, status: 'waiting_approval', receiptPath: null })] })[0];
  assert.match(back.detail, /Handed back for approval/);
  assert.equal(back.group, 'in_progress');
  assert.equal(back.status.label, 'Waiting for approval');
  assert.equal(back.href, null);
  assert.match(back.noReceipt, /Scheduled tab/);
  assert.equal(back.mayChange, true, 'the page keeps asking while it can change');
});

test('every state lands in a group, and failed has its own with what happened and what to do', () => {
  for (const status of RUN_STATUSES) {
    const [e] = buildHistory({ ...none, scheduled: [run({ status, receiptPath: null })] });
    assert.ok(['paid', 'in_progress', 'failed', 'not_paid'].includes(e.group), status);
    assert.ok(e.status.label, status);
  }
  const failed = buildHistory({ ...none, scheduled: [run({ status: 'failed', receiptPath: null, reason: '1 of 2 payments went out, and the rest did not. Nothing was paid twice.' })] })[0];
  assert.equal(failed.group, 'failed');
  assert.match(failed.explain.why, /1 of 2 payments went out/);
  assert.match(failed.explain.next, /Scheduled tab/);
  assert.equal(failed.mayChange, false);
  const lapsed = buildHistory({ ...none, scheduled: [run({ status: 'lapsed', receiptPath: null })] })[0];
  assert.equal(lapsed.group, 'not_paid', 'not approved in time is nobody’s failure');
  assert.equal(lapsed.explain, null);
  assert.equal(lapsed.status.label, 'Not approved in time');
  const skipped = buildHistory({ ...none, scheduled: [run({ status: 'skipped', receiptPath: null })] })[0];
  assert.equal(skipped.group, 'not_paid');
  assert.equal(skipped.noReceipt, 'No payment was made, so there is no receipt.');
});

test('filtering by Failed shows a failed scheduled run, and not a lapse', () => {
  const entries = buildHistory({ ...none, scheduled: [run({ id: 'a', status: 'failed', receiptPath: null }), run({ id: 'b', status: 'lapsed', receiptPath: null }), run({ id: 'c' })] });
  assert.deepEqual(filterHistory(entries, { group: 'failed', query: '' }).map((e) => e.key), ['scheduled:a']);
  assert.deepEqual(filterHistory(entries, { group: 'not_paid', query: '' }).map((e) => e.key), ['scheduled:b']);
  assert.equal(filterHistory(entries, { group: 'all', query: 'monthly' }).length, 3);
});

test('a batch prepared for a scheduled run is shown once, as the run', () => {
  const batch = { id: 'wbt_1', label: 'Monthly suppliers', status: 'settled', rowCount: 2, totalMinor: '1250500000', createdAt: '2026-11-03T08:00:05.000Z' };
  const other = { ...batch, id: 'wbt_2', label: 'Payroll' };
  const entries = buildHistory({ ...none, batches: [batch, other], scheduled: [run()] });
  assert.deepEqual(entries.map((e) => e.key).sort(), ['batch:wbt_2', 'scheduled:psr_1']);
  assert.match(historyCsv(entries), /Scheduled payment,Monthly suppliers/);
});

test('a run that ended unpaid never says it was approved or paid, and a failed one points at the tab, not at "no payment"', () => {
  const lapsed = buildHistory({ ...none, scheduled: [run({ status: 'lapsed', receiptPath: null })] })[0];
  assert.doesNotMatch(lapsed.detail, /Approved by|Paid automatically/);
  assert.match(lapsed.detail, /Ask me first/);
  const failed = buildHistory({ ...none, scheduled: [run({ status: 'failed', ranAs: 'auto', mode: 'auto', receiptPath: null })] })[0];
  assert.doesNotMatch(failed.detail, /Paid automatically/);
  assert.match(failed.noReceipt, /Scheduled tab/);
  assert.doesNotMatch(failed.noReceipt, /No payment was made/, 'part of it may have been paid');
});

test('without scheduled runs History is as it was', () => {
  assert.deepEqual(buildHistory(none), []);
});

const read = (f) => readFileSync(f, 'utf8');
const ui = ['components/schedule/ScheduledPayments.tsx', 'components/schedule/ScheduleForm.tsx', 'components/schedule/AutomaticPanel.tsx', 'components/schedule/ScheduledReceipt.tsx', 'components/transfer/TransferHome.tsx'];

test('the Scheduled tab is a link in the address, reached from Transfer, and notices open the run they are about', () => {
  const home = read('components/transfer/TransferHome.tsx');
  assert.match(home, /view=scheduled/);
  assert.match(home, /aria-current/);
  assert.match(read('app/dashboard/transfer/page.tsx'), /TransferHome/);
  assert.match(read('components/schedule/ScheduledPayments.tsx'), /useSearchParams\(\)\.get\('run'\)/);
  assert.match(read('lib/schedule/notice.ts'), /view=scheduled&run=/);
});

test('Skip, Stop, Start again, Edit and Delete are buttons that act at once; Delete asks once and keeps the history', () => {
  const src = read('components/schedule/ScheduledPayments.tsx');
  for (const word of ['Skip the next run', 'Skip this run', 'Stop schedule', 'Start again', 'Edit', 'Delete it', 'Keep it']) assert.ok(src.includes(word), word);
  assert.match(src, /its history stays in History/);
  assert.ok(!/cooldown|waiting period|wait 24/i.test(src));
  const panel = read('components/schedule/AutomaticPanel.tsx');
  assert.match(panel, /Pause all automatic payments/);
  assert.match(panel, /Turn automatic payments back on/);
});

test('the pages say the states in the owners’ words and promise nothing the product cannot keep', () => {
  for (const file of ui) {
    const src = read(file);
    assert.ok(!/E39774|coral/i.test(src), `${file}: no coral`);
    assert.ok(!/\bDemo\b|\bDEMO\b|Coming soon/.test(src), `${file}: no Demo or Coming soon`);
    assert.ok(!/testnet/i.test(src), `${file}: no testnet on a customer surface`);
    assert.ok(!/non-custodial|licensed|zero fees|same-day|guaranteed/i.test(src), `${file}: no claim the copy rules refuse`);
    assert.ok(!/toLocale(Date|Time)?String|Intl\.DateTimeFormat/.test(src), `${file}: dates go through LocalTime`);
    assert.ok(!/—/.test(src), `${file}: no em dash`);
  }
  const rules = read('lib/schedule/rules.ts');
  for (const label of ['Scheduled', 'Waiting for approval', 'Approved', 'Paid', 'Skipped', 'Did not go through', 'Not approved in time']) assert.ok(rules.includes(`'${label}'`), label);
});

test('every control is at least 44 pixels and every field has a visible label', () => {
  const form = read('components/schedule/ScheduleForm.tsx');
  assert.ok(!/placeholder=/.test(form), 'no placeholder stands in for a label');
  assert.match(form, /htmlFor=/);
  assert.match(form, /aria-label=\{`Remove payment/);
  for (const file of ui) assert.ok(!/\bh-(8|9|10)\b/.test(read(file)), `${file}: no control under 44px`);
});

test('automatic payments are offered in the form only to an owner where the payer exists, and the reason is said otherwise', () => {
  const page = read('components/schedule/ScheduledPayments.tsx');
  assert.match(page, /canAutomatic = Boolean\(data\?\.you\.owner && automatic\?\.payer\.ready\)/);
  assert.match(page, /Only an owner can make a schedule pay automatically/);
});

test('History lists scheduled runs from the runs route and keeps what it had when that list fails', () => {
  const src = read('components/history/HistoryPage.tsx');
  assert.match(src, /\/api\/wallet\/schedules\/runs/);
  assert.match(src, /previous\?\.scheduled/);
  assert.match(src, /Scheduled payments could not be refreshed/);
});

test('the receipt route exists for an automatic run and reads only the session’s business', () => {
  assert.match(read('app/dashboard/history/scheduled/[id]/page.tsx'), /ScheduledReceipt/);
  const receipt = read('components/schedule/ScheduledReceipt.tsx');
  assert.match(receipt, /\/api\/wallet\/schedules\/runs\//);
  assert.match(receipt, /suiVisionTxUrl/);
});
