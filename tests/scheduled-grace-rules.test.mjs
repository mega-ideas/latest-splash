/**
 * v2 Phase 3, scheduled batches: the grace window and the plain-words summary,
 * the parts that need no database.
 *
 *   the window   "Pay automatically within my limits" tells the owners GRACE
 *                minutes before the first automatic payment of a run: default 10,
 *                0 to 60 per business, whole minutes only. The words say when it
 *                starts and that Skip or Stop work until then.
 *   the notices  the day-before notice and the "running" notice carry Skip and
 *                Stop as buttons in the app, never as a link that acts by itself.
 *   the summary  before the owners sign the allowance, one screen says in plain
 *                words what Splash will pay, built from the SAME values the
 *                allowance request is built from, so the two cannot differ.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  ALLOWANCE_DEFAULTS,
  FALLBACK_CODES,
  FALLBACK_TEXT,
  GRACE_DEFAULT_MINUTES,
  GRACE_MAX_MINUTES,
  WINDOW_HEAD,
  WINDOW_TAIL,
  allowanceProblems,
  allowanceRule,
  graceWords,
  parseAllowanceInput,
  parseGraceMinutes,
  windowWords,
} from '../lib/schedule/rules.ts';
import { noticeText } from '../lib/schedule/notice.ts';
import { automaticSummary, paymentsOfSchedules } from '../lib/schedule/summary.ts';

const U = (n) => BigInt(Math.round(n * 1_000_000));
const at = (iso) => Date.parse(iso);
const read = (f) => readFileSync(f, 'utf8');

// ─── The window's length ───────────────────────────────────────────────────

test('the window is 10 minutes unless an owner says otherwise, and 0 to 60 whole minutes are allowed', () => {
  assert.equal(GRACE_DEFAULT_MINUTES, 10);
  assert.equal(GRACE_MAX_MINUTES, 60);
  for (const ok of [0, 1, 10, 59, 60, '0', '25', ' 60 ']) assert.equal(parseGraceMinutes(ok), Number(String(ok).trim()), String(ok));
});

test('anything that is not a whole number of minutes from 0 to 60 is refused, at both edges', () => {
  for (const bad of [-1, 61, 60.5, 0.5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '', ' ', 'ten', '1e1', '0x10', '-0', null, undefined, true, [], {}, 10n, '61', '-1', '10.0']) {
    assert.equal(parseGraceMinutes(bad), null, `${String(bad)} is refused`);
  }
});

test('the window is said in words, and 0 says there is no warning window', () => {
  assert.match(graceWords(10), /10 minutes/);
  assert.match(graceWords(1), /1 minute\b/);
  assert.match(graceWords(60), /60 minutes/);
  assert.match(graceWords(0), /no warning window|at the due time/i);
});

// ─── "Starts at 14:10, Skip or Stop until then" ───────────────────────────

test('"Starts at 14:10, Skip or Stop until then" is said while the window is open and not after', () => {
  const startsAt = at('2026-11-03T14:10:00Z');
  assert.equal(WINDOW_HEAD, 'Starts at ');
  assert.equal(WINDOW_TAIL, ', Skip or Stop until then');
  assert.equal(windowWords(startsAt, startsAt - 1), 'Starts at 14:10 UTC, Skip or Stop until then');
  assert.equal(windowWords(startsAt, startsAt - 10 * 60_000), 'Starts at 14:10 UTC, Skip or Stop until then');
  assert.equal(windowWords(startsAt, startsAt), null, 'at the very end the window is over');
  assert.equal(windowWords(startsAt, startsAt + 1), null);
  assert.equal(windowWords(null, startsAt), null, 'a run with no window says nothing');
  assert.equal(windowWords(Number.NaN, startsAt), null);
});

// ─── The notices ───────────────────────────────────────────────────────────

const base = {
  orgId: 'acme',
  businessName: 'Acme Trading Sdn Bhd',
  scheduleId: 'psc_1',
  scheduleName: 'Monthly suppliers',
  runId: 'psr_1',
  mode: 'auto',
  dueAtMs: at('2026-11-03T14:00:00Z'),
  totalMinor: '1250500000',
  feeMinor: '250000',
  itemCount: 2,
  reason: null,
  by: null,
  path: '/dashboard/transfer?view=scheduled&run=psr_1',
};

test('the day-before notice carries Skip and Stop as buttons in the app, and no link that acts by itself', () => {
  const n = noticeText({ ...base, kind: 'day_before', graceMinutes: 10 });
  assert.deepEqual(n.actions, [
    { kind: 'skip', label: 'Skip this run', path: base.path },
    { kind: 'stop', label: 'Stop schedule', path: base.path },
  ]);
  assert.match(n.text, /Skip this run/);
  assert.match(n.text, /Stop schedule/);
  assert.match(n.text, /signed in as an owner/);
  assert.match(n.text, /10 minutes/, 'the owners are told how long the window is');
  assert.doesNotMatch(n.text, /https?:|\?skip|\?stop|token=|do=skip|do=stop/i, 'no link in the words pays, skips or stops');
  for (const a of n.actions) assert.match(a.path, /^\/dashboard\/transfer\?view=scheduled&run=psr_/, 'an action opens the signed-in Scheduled tab');
});

test('the day-before notice for a business with no window says nothing is paid before the due time', () => {
  const n = noticeText({ ...base, kind: 'day_before', graceMinutes: 0 });
  assert.doesNotMatch(n.text, /minutes after/);
  assert.match(n.text, /Nothing is paid before/);
  assert.equal(n.actions.length, 2, 'Skip and Stop are still offered');
});

test('the notice sent when the window opens says when payments start and that Skip or Stop work until then', () => {
  const startsAtMs = at('2026-11-03T14:10:00Z');
  const n = noticeText({ ...base, kind: 'running', startsAtMs, graceMinutes: 10 });
  assert.match(n.subject, /14:10 UTC/);
  assert.match(n.text, /Starts at 14:10 UTC, Skip or Stop until then/);
  assert.match(n.text, /Nothing has been paid yet/);
  assert.deepEqual(n.actions.map((a) => a.kind), ['skip', 'stop']);
  assert.doesNotMatch(n.text, /https?:|do=skip|do=stop/i);
});

test('with no window, the notice sent as a run starts is the one it always was, with no Skip it cannot keep', () => {
  const n = noticeText({ ...base, kind: 'running', startsAtMs: null });
  assert.match(n.text, /being paid now/);
  assert.doesNotMatch(n.text, /You can still skip/);
  assert.deepEqual(n.actions, []);
  assert.deepEqual(noticeText({ ...base, kind: 'running' }).actions, [], 'an older notice with no window field still reads');
});

test('no other notice offers Skip or Stop buttons it cannot honour', () => {
  for (const kind of ['paid', 'failed', 'lapsed', 'skipped', 'paused']) assert.deepEqual(noticeText({ ...base, kind }).actions, [], kind);
});

test('a run handed back because the schedule changed in the window says so', () => {
  assert.ok(FALLBACK_CODES.includes('changed_in_window'));
  assert.match(FALLBACK_TEXT.changed_in_window, /changed after/i);
  assert.match(FALLBACK_TEXT.changed_in_window, /approval/);
});

// ─── The allowance and its rule: one set of values ────────────────────────

test('typed allowance values parse one way, here and on the server', () => {
  const parsed = parseAllowanceInput({ perPaymentUsdc: '2,000', dailyUsdc: '5000', monthlyUsdc: '20000.50', expiresInDays: '90' });
  assert.deepEqual(parsed.form, { perPaymentMinor: U(2_000), dailyMinor: U(5_000), monthlyMinor: U(20_000.5), expiresInDays: 90 });
  assert.deepEqual(parsed.problems, []);
  const typed = parseAllowanceInput({ perPaymentUsdc: 'lots', dailyUsdc: '', monthlyUsdc: '-5', expiresInDays: '1.5' });
  assert.ok(typed.problems.length >= 3, typed.problems.join(' | '));
  assert.equal(parseAllowanceInput({ perPaymentUsdc: 2000, dailyUsdc: 5000, monthlyUsdc: 20000, expiresInDays: 90 }).problems.length, 0, 'numbers work as the page may send them');
});

test('the caps meet at their boundaries: equal is allowed, one micro over is not', () => {
  const form = (over) => ({ perPaymentMinor: U(2_000), dailyMinor: U(5_000), monthlyMinor: U(20_000), expiresInDays: 90, ...over });
  assert.deepEqual(allowanceProblems(form({ perPaymentMinor: U(5_000) })), [], 'one payment may use the whole day');
  assert.equal(allowanceProblems(form({ perPaymentMinor: U(5_000) + 1n })).length, 1, 'one micro over the day');
  assert.deepEqual(allowanceProblems(form({ dailyMinor: U(20_000) })), [], 'a day may use the whole month');
  assert.equal(allowanceProblems(form({ dailyMinor: U(20_000) + 1n })).length, 1);
  assert.deepEqual(allowanceProblems(form({ perPaymentMinor: U(10_000), dailyMinor: U(10_000), monthlyMinor: U(10_000) })), [], '10,000 USDC is the ceiling and is allowed');
  assert.equal(allowanceProblems(form({ perPaymentMinor: U(10_000) + 1n, dailyMinor: U(50_000), monthlyMinor: U(90_000) })).length, 1);
  assert.deepEqual(allowanceProblems(form({ expiresInDays: 366 })), []);
  assert.equal(allowanceProblems(form({ expiresInDays: 367 })).length, 1);
  assert.equal(allowanceProblems(form({ expiresInDays: 0 })).length, 1);
  assert.equal(allowanceProblems(form({ expiresInDays: 1 })).length, 0);
});

test('the rule an allowance request is built from carries exactly the values typed', () => {
  const now = at('2026-11-12T08:00:00Z');
  const { form } = parseAllowanceInput({ perPaymentUsdc: '1,500', dailyUsdc: '4000', monthlyUsdc: '16000', expiresInDays: 60 });
  const rule = allowanceRule(form, '0xspender', now);
  assert.equal(rule.spender, '0xspender');
  assert.equal(rule.perPaymentMaxMinor, U(1_500));
  assert.deepEqual(rule.cap, { period: 'month', limitMinor: U(16_000) });
  // A whole UTC day: the end of the 60th day after today, so a page and a server on the same day name the same end.
  assert.equal(rule.expiresAtMs, BigInt(Date.UTC(2027, 0, 12)));
  assert.equal(rule.expiresAtMs % 86_400_000n, 0n);
  assert.ok(rule.expiresAtMs > BigInt(now) + 60n * 86_400_000n && rule.expiresAtMs <= BigInt(now) + 61n * 86_400_000n);
});

// ─── The summary ───────────────────────────────────────────────────────────

const payments = [
  { position: 1, name: 'Santos Supplies Inc', masked: '0x7171…7171', amountMinor: U(500).toString(), feeMinor: '0', firstPayment: false, reference: 'INV-1' },
  { position: 2, name: 'Reyes Logistics Corp', masked: '0x7272…7272', amountMinor: U(750.5).toString(), feeMinor: '0', firstPayment: false, reference: 'INV-2' },
  { position: 3, name: 'Santos Supplies Inc', masked: '0x7171…7171', amountMinor: U(120).toString(), feeMinor: '0', firstPayment: false, reference: '' },
  { position: 4, name: 'Dela Cruz Trading Corp', masked: '0x6969…6969', amountMinor: U(1_900).toString(), feeMinor: '0', firstPayment: false, reference: 'INV-4' },
];

const NOW = at('2026-11-12T08:00:00Z');

/** The one schedule the payments above belong to: monthly from NOW, a run moves 3,270.50 USDC. */
const RENT = { name: 'Rent', cadence: 'monthly', cadenceText: 'On day 12 of every month at 08:00 UTC', firstDueMs: NOW, nextDueMs: NOW, paymentCount: 4, runTotalMinor: U(3_270.5).toString() };
const SCHEDULES = [RENT];

test('before the owners sign, one sentence says what Splash will pay, up to what, and until when', () => {
  const s = automaticSummary({ payments, schedules: SCHEDULES, form: { perPaymentMinor: U(2_000), dailyMinor: U(5_000), monthlyMinor: U(20_000), expiresInDays: 90 }, graceMinutes: 10, nowMs: NOW, firstPaymentMs: NOW });
  assert.equal(s.headline, 'Splash will pay these 4 payments each time they fall due, up to 2,000 USDC each, from 12 Nov until 10 Feb (UTC). Nothing is paid without your limits. You can stop this anytime.');
});

test('the summary shows the exact payments, the maximum, both caps, the recipients, the end date, the window and how to stop', () => {
  const form = { perPaymentMinor: U(2_000), dailyMinor: U(5_000), monthlyMinor: U(20_000), expiresInDays: 90 };
  const s = automaticSummary({ payments, schedules: SCHEDULES, form, graceMinutes: 10, nowMs: NOW, firstPaymentMs: at('2026-11-20T08:00:00Z') });
  assert.deepEqual(s.payments.map((p) => ({ ...p, reasons: undefined, notes: undefined })), payments.map((p) => ({ ...p, reasons: undefined, notes: undefined })), 'every payment, exactly as the owner resent it');
  assert.ok(s.payments.every((p) => p.reasons.length === 0 && p.notes.length === 0), 'and none of them is outside the limits');
  assert.equal(s.paymentCount, 4);
  assert.equal(s.perPaymentMinor, U(2_000).toString());
  assert.equal(s.dailyMinor, U(5_000).toString());
  assert.equal(s.monthlyMinor, U(20_000).toString());
  assert.deepEqual(s.recipients, ['Santos Supplies Inc', 'Reyes Logistics Corp', 'Dela Cruz Trading Corp'], 'each recipient once, in order');
  assert.equal(s.startsAtMs, at('2026-11-20T08:00:00Z'));
  assert.equal(s.endsAtMs, Date.UTC(2027, 1, 11), 'midnight UTC after the 90th day: 10 Feb is the last day');
  assert.equal(s.endsOnText, '10 Feb 2027 (UTC)');
  assert.match(s.headline, /from 20 Nov until 10 Feb \(UTC\)/);
  assert.equal(s.graceMinutes, 10);
  assert.match(s.graceText, /10 minutes/);
  assert.match(s.stopText, /Skip this run/);
  assert.match(s.stopText, /Stop schedule/);
  assert.match(s.stopText, /Pause all automatic payments/);
  const all = s.lines.join('\n');
  for (const needle of ['2,000', '5,000', '20,000', 'Santos Supplies Inc', 'Reyes Logistics Corp', 'Dela Cruz Trading Corp', '10 Feb', '10 minutes']) assert.ok(all.includes(needle), needle);
});

test('one payment is "this payment", and no schedule paying automatically says so', () => {
  const form = { perPaymentMinor: U(2_000), dailyMinor: U(5_000), monthlyMinor: U(20_000), expiresInDays: 90 };
  const once = { ...RENT, name: 'Once', cadence: 'once', cadenceText: 'Once, 08:00 UTC on 12 Nov', paymentCount: 1, runTotalMinor: U(500).toString() };
  const one = automaticSummary({ payments: payments.slice(0, 1), schedules: [once], form, graceMinutes: 0, nowMs: NOW, firstPaymentMs: NOW });
  assert.match(one.headline, /^Splash will pay this payment when it falls due, up to 2,000 USDC/);
  assert.match(one.graceText, /no warning window|at the due time/i, 'a window of 0 is said plainly');
  const none = automaticSummary({ payments: [], schedules: [], form, graceMinutes: 10, nowMs: NOW, firstPaymentMs: null });
  assert.equal(none.paymentCount, 0);
  assert.match(none.headline, /No schedule pays automatically yet/);
  assert.match(none.headline, /up to 2,000 USDC/);
  assert.match(none.headline, /until 10 Feb/);
});

test('a fractional per-payment maximum keeps its cents, a whole one does not', () => {
  const form = { perPaymentMinor: U(1_500.5), dailyMinor: U(5_000), monthlyMinor: U(20_000), expiresInDays: 30 };
  assert.match(automaticSummary({ payments, schedules: SCHEDULES, form, graceMinutes: 10, nowMs: NOW, firstPaymentMs: NOW }).headline, /up to 1,500\.50 USDC each/);
});

test('the figures in the summary are the ones in the rule the request is built from, whatever is typed', () => {
  const cases = [
    { perPaymentUsdc: '2000', dailyUsdc: '5000', monthlyUsdc: '20000', expiresInDays: 90 },
    { perPaymentUsdc: '1,500.25', dailyUsdc: '4,000', monthlyUsdc: '16000', expiresInDays: '60' },
    { perPaymentUsdc: '0.000001', dailyUsdc: '0.000001', monthlyUsdc: '0.000001', expiresInDays: 1 },
    { perPaymentUsdc: '10000', dailyUsdc: '10000', monthlyUsdc: '90000', expiresInDays: 366 },
  ];
  for (const input of cases) {
    const { form, problems } = parseAllowanceInput(input);
    assert.deepEqual(problems, [], JSON.stringify(input));
    const rule = allowanceRule(form, '0xspender', NOW);
    const s = automaticSummary({ payments, schedules: SCHEDULES, form, graceMinutes: 10, nowMs: NOW, firstPaymentMs: NOW });
    assert.equal(s.perPaymentMinor, rule.perPaymentMaxMinor.toString(), `${JSON.stringify(input)}: per payment`);
    assert.equal(s.monthlyMinor, rule.cap.limitMinor.toString(), `${JSON.stringify(input)}: monthly`);
    assert.equal(s.dailyMinor, form.dailyMinor.toString(), `${JSON.stringify(input)}: daily`);
    assert.equal(BigInt(s.endsAtMs), rule.expiresAtMs, `${JSON.stringify(input)}: end date`);
  }
});

test('the payments in a summary come from the automatic schedules that are running, and nothing else', () => {
  const view = (over) => ({ id: 'psc_a', name: 'Rent', mode: 'auto', status: 'active', cadence: 'monthly', cadenceText: 'On day 20 of every month at 08:00 UTC', firstDueAt: '2026-11-20T08:00:00.000Z', nextDueAt: '2026-11-20T08:00:00.000Z', items: payments.slice(0, 2).map((p) => ({ ...p, payeeKind: 'recipient', payeeId: 'r', country: null })), ...over });
  const got = paymentsOfSchedules([view(), view({ id: 'psc_b', name: 'Askers', mode: 'ask' }), view({ id: 'psc_c', status: 'stopped' }), view({ id: 'psc_d', status: 'completed', nextDueAt: null }), view({ id: 'psc_e', name: 'Later', nextDueAt: '2026-12-01T08:00:00.000Z', items: payments.slice(2, 3).map((p) => ({ ...p, payeeKind: 'recipient', payeeId: 'r', country: null })) })]);
  assert.equal(got.payments.length, 3, 'two from Rent and one from Later; not the "ask me first" one, the stopped one or the finished one');
  assert.deepEqual(got.payments.map((p) => p.schedule), ['Rent', 'Rent', 'Later']);
  assert.equal(got.firstPaymentMs, at('2026-11-20T08:00:00Z'), 'the earliest of their next times');
  assert.deepEqual(got.schedules.map((x) => [x.name, x.paymentCount]), [['Rent', 2], ['Later', 1]]);
  assert.deepEqual(paymentsOfSchedules([]), { payments: [], schedules: [], firstPaymentMs: null });
});

// ─── The screen builds nothing of its own ─────────────────────────────────

test('the panel and the form take the window and the summary from lib/schedule, never their own sums', () => {
  const panel = read('components/schedule/AutomaticPanel.tsx');
  assert.match(panel, /automaticSummary\(/, 'the summary comes from the shared function');
  assert.match(panel, /parseAllowanceInput\(/, 'the typed values are parsed the way the server parses them');
  assert.ok(!/parseAmountMinor/.test(panel), 'the panel does no parsing of its own');
  assert.match(panel, /Check this before your owners sign|Check before your owners sign/);
  assert.match(panel, /Starts at|graceMinutes/);
  assert.ok(/Warning before the first payment/.test(panel), 'the window has a labelled field');
  for (const file of ['components/schedule/AutomaticPanel.tsx', 'components/schedule/ScheduledPayments.tsx', 'lib/schedule/summary.ts']) {
    const src = read(file);
    assert.ok(!/E39774|coral/i.test(src), `${file}: no coral`);
    assert.ok(!/\bDemo\b|\bDEMO\b|Coming soon/.test(src), `${file}: no Demo or Coming soon`);
    assert.ok(!/testnet|non-custodial|licensed|guaranteed|zero fees/i.test(src), `${file}: no claim the copy rules refuse`);
    assert.ok(!/—/.test(src), `${file}: no em dash`);
  }
});

test('the Scheduled tab and History say the window in the same words', () => {
  const tab = read('components/schedule/ScheduledPayments.tsx');
  assert.match(tab, /<RunWindow startsAt=\{run\.startsAt\}/);
  assert.match(tab, /Stop schedule/);
  const history = read('components/history/HistoryPage.tsx');
  assert.match(history, /<RunWindow startsAt=\{entry\.startsAt\}/);
  // One component says it, from the same words the notices use.
  const line = read('components/schedule/RunWindow.tsx');
  assert.match(line, /WINDOW_HEAD/);
  assert.match(line, /WINDOW_TAIL/);
  assert.match(line, /<LocalTime value=\{startsAt\} format="time"/, 'the time is the viewer’s own clock');
});

test('the defaults the owners start from are unchanged', () => {
  assert.deepEqual({ ...ALLOWANCE_DEFAULTS }, { perPaymentUsdc: 2_000, dailyUsdc: 5_000, monthlyUsdc: 20_000, expiresInDays: 90 });
});
