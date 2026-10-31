/**
 * v2 Phase 3, scheduled batches: the rules that need no database.
 *
 *   - when a schedule falls due: once, every week, every month (a short month
 *     uses its last day), found strictly after a moment, UTC;
 *   - the key a run is made under, stable for one schedule and one due date;
 *   - the states a run goes through, each worded once, with the group History
 *     files it under (failed has its own);
 *   - the reasons an automatic run is handed back, each in a sentence;
 *   - the allowance owners are offered, and what is wrong with one they typed;
 *   - the notices, in plain words, with no link that pays, skips or stops by itself.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ALLOWANCE_DEFAULTS,
  APPROVAL_WINDOW_MS,
  AUTO_MIN_LEAD_MS,
  DAY_MS,
  FALLBACK_CODES,
  FALLBACK_TEXT,
  LAPSED_REASON,
  RUN_STATE,
  RUN_STATUSES,
  allowanceProblems,
  allowanceSentence,
  cadenceSummary,
  dueDateOf,
  fallbackWords,
  nextDueAfter,
  occurrenceMs,
  runIsOpen,
  runKey,
  stampWords,
} from '../lib/schedule/rules.ts';
import { noticeText, scheduledRunPath, SCHEDULED_PATH } from '../lib/schedule/notice.ts';

const at = (iso) => Date.parse(iso);

test('weekly falls due every seven days at the same UTC time', () => {
  const first = at('2026-11-02T09:00:00Z');
  assert.equal(occurrenceMs('weekly', first, 0), first);
  assert.equal(occurrenceMs('weekly', first, 3), first + 21 * DAY_MS);
  assert.equal(nextDueAfter('weekly', first, first), first + 7 * DAY_MS, 'strictly after the moment given');
  assert.equal(nextDueAfter('weekly', first, first - 1), first);
  assert.equal(nextDueAfter('weekly', first, first + 20 * DAY_MS), first + 21 * DAY_MS);
});

test('monthly keeps the day of the month, and a short month uses its last day', () => {
  const first = at('2026-01-31T09:30:00Z');
  assert.equal(new Date(occurrenceMs('monthly', first, 0)).toISOString(), '2026-01-31T09:30:00.000Z');
  assert.equal(new Date(occurrenceMs('monthly', first, 1)).toISOString(), '2026-02-28T09:30:00.000Z');
  assert.equal(new Date(occurrenceMs('monthly', first, 2)).toISOString(), '2026-03-31T09:30:00.000Z');
  assert.equal(new Date(occurrenceMs('monthly', first, 3)).toISOString(), '2026-04-30T09:30:00.000Z');
  assert.equal(new Date(occurrenceMs('monthly', at('2027-01-31T00:00:00Z'), 1)).toISOString(), '2027-02-28T00:00:00.000Z');
  assert.equal(new Date(occurrenceMs('monthly', at('2027-12-15T00:00:00Z'), 2)).toISOString(), '2028-02-15T00:00:00.000Z', 'a year is crossed');
  assert.equal(new Date(occurrenceMs('monthly', at('2027-12-31T00:00:00Z'), 2)).toISOString(), '2028-02-29T00:00:00.000Z', 'a leap year');
  const found = nextDueAfter('monthly', first, at('2026-03-01T00:00:00Z'));
  assert.equal(new Date(found).toISOString(), '2026-03-31T09:30:00.000Z');
  assert.equal(new Date(nextDueAfter('monthly', first, at('2026-03-31T09:30:00Z'))).toISOString(), '2026-04-30T09:30:00.000Z', 'strictly after');
});

test('once falls due once and never again', () => {
  const first = at('2026-11-02T09:00:00Z');
  assert.equal(occurrenceMs('once', first, 0), first);
  assert.ok(Number.isNaN(occurrenceMs('once', first, 1)));
  assert.equal(nextDueAfter('once', first, first - 1), first);
  assert.equal(nextDueAfter('once', first, first), null);
  assert.equal(nextDueAfter('once', first, first + DAY_MS), null);
});

test('a bad index is not a time', () => {
  assert.ok(Number.isNaN(occurrenceMs('weekly', 0, -1)));
  assert.ok(Number.isNaN(occurrenceMs('weekly', 0, 1.5)));
});

test('a run is made under the schedule and the due date, and nothing else', () => {
  assert.equal(dueDateOf(at('2026-11-02T23:59:59Z')), '2026-11-02');
  assert.equal(dueDateOf(at('2026-11-03T00:00:00Z')), '2026-11-03');
  const a = runKey('psc_11111111-2222-3333-4444-555555555555', '2026-11-02');
  assert.equal(a, runKey('psc_11111111-2222-3333-4444-555555555555', '2026-11-02'), 'the same inputs give the same key');
  assert.notEqual(a, runKey('psc_11111111-2222-3333-4444-555555555555', '2026-11-03'));
  assert.notEqual(a, runKey('psc_11111111-2222-3333-4444-555555555556', '2026-11-02'));
  assert.match(`sch-${a}`, /^[A-Za-z0-9_-]{8,80}$/, 'it is an acceptable intent id for a batch');
});

test('every state has a label, a tone, a group and a sentence; failed is its own group', () => {
  assert.deepEqual(Object.keys(RUN_STATE).sort(), [...RUN_STATUSES].sort());
  for (const s of RUN_STATUSES) {
    const w = RUN_STATE[s];
    assert.ok(w.label && w.says, s);
    assert.ok(['ok', 'wait', 'bad'].includes(w.tone));
    assert.ok(['paid', 'in_progress', 'failed', 'not_paid'].includes(w.group));
  }
  assert.equal(RUN_STATE.failed.group, 'failed');
  assert.equal(RUN_STATE.paid.group, 'paid');
  assert.equal(RUN_STATE.lapsed.group, 'not_paid', 'a lapse is not a failure');
  assert.equal(RUN_STATE.skipped.group, 'not_paid');
  for (const s of ['scheduled', 'waiting_approval', 'approved']) assert.ok(runIsOpen(s), s);
  for (const s of ['paid', 'skipped', 'failed', 'lapsed']) assert.ok(!runIsOpen(s), s);
  const labels = ['Scheduled', 'Waiting for approval', 'Approved', 'Paid', 'Skipped'];
  assert.deepEqual(['scheduled', 'waiting_approval', 'approved', 'paid', 'skipped'].map((s) => RUN_STATE[s].label), labels, 'the states are shown in the words the brief names');
});

test('a lapse says nothing was paid and that there is no late fee or penalty', () => {
  assert.match(LAPSED_REASON, /Nothing was paid/);
  assert.match(LAPSED_REASON, /no late fee or penalty/i);
  assert.match(RUN_STATE.lapsed.says, /Nothing was paid/);
  assert.equal(APPROVAL_WINDOW_MS, DAY_MS, 'the owners have the signing layer’s longest request, 24 hours');
});

test('every reason an automatic run is handed back is a sentence an owner can act on', () => {
  assert.deepEqual(Object.keys(FALLBACK_TEXT).sort(), [...FALLBACK_CODES].sort());
  for (const code of FALLBACK_CODES) {
    const text = FALLBACK_TEXT[code];
    assert.match(text, /^[A-Z]/, code);
    assert.match(text, /\.$/, code);
    assert.match(text, /approval|attention/i, `${code} says it comes back to the owners`);
    assert.ok(!/coral|demo|testnet|non-custodial|coming soon/i.test(text), code);
  }
  assert.match(fallbackWords('new_recipient', 'Dela Cruz Trading'), /^Dela Cruz Trading: /);
  assert.equal(fallbackWords('auto_paused'), FALLBACK_TEXT.auto_paused);
});

test('the allowance defaults pass their own checks, and a bad one says what is wrong', () => {
  const m = (usdc) => BigInt(usdc) * 1_000_000n;
  const ok = { perPaymentMinor: m(ALLOWANCE_DEFAULTS.perPaymentUsdc), dailyMinor: m(ALLOWANCE_DEFAULTS.dailyUsdc), monthlyMinor: m(ALLOWANCE_DEFAULTS.monthlyUsdc), expiresInDays: ALLOWANCE_DEFAULTS.expiresInDays };
  assert.deepEqual(allowanceProblems(ok), []);
  assert.ok(ok.dailyMinor <= ok.monthlyMinor && ok.perPaymentMinor <= ok.dailyMinor);
  assert.ok(allowanceProblems({ ...ok, perPaymentMinor: 0n })[0].includes('one payment'));
  assert.ok(allowanceProblems({ ...ok, perPaymentMinor: ok.dailyMinor + 1n }).some((p) => /one payment cannot be more than the daily/.test(p)));
  assert.ok(allowanceProblems({ ...ok, dailyMinor: ok.monthlyMinor + 1n }).some((p) => /daily limit cannot be more than the monthly/.test(p)));
  assert.ok(allowanceProblems({ ...ok, expiresInDays: 0 }).length > 0);
  assert.ok(allowanceProblems({ ...ok, expiresInDays: 400 }).some((p) => /at most a year/.test(p)));
  assert.ok(allowanceProblems({ ...ok, expiresInDays: 1.5 }).length > 0);
  assert.ok(allowanceProblems(ok, m(1_000)).some((p) => /business’s own limit of 1,000/.test(p)), 'it cannot be above the business’s own per-payment limit');
  assert.match(allowanceSentence(ok), /You can take it back at any time/);
});

test('words for a schedule and a moment are in the dashboard’s own style', () => {
  assert.equal(stampWords(at('2026-11-03T16:00:00Z')), '16:00 UTC on 3 Nov');
  assert.equal(cadenceSummary('monthly', at('2026-11-03T16:00:00Z')), 'On day 3 of every month at 16:00 UTC');
  assert.equal(cadenceSummary('weekly', at('2026-11-02T09:00:00Z')), 'Every Monday at 09:00 UTC');
  assert.equal(cadenceSummary('once', at('2026-11-03T16:00:00Z')), 'Once, 16:00 UTC on 3 Nov');
  assert.ok(AUTO_MIN_LEAD_MS >= 3_600_000, 'an automatic schedule gives the owners an hour to read the notice');
});

const base = { orgId: 'acme', businessName: 'Acme Trading Sdn Bhd', scheduleId: 'psc_1', scheduleName: 'Monthly suppliers', runId: 'psr_1', mode: 'auto', dueAtMs: at('2026-11-03T16:00:00Z'), totalMinor: '1250000000', feeMinor: '250000', itemCount: 3, reason: null, by: null, path: scheduledRunPath('psr_1') };

test('the day-before notice says what will be paid, when, and how to skip or stop', () => {
  const { subject, text } = noticeText({ ...base, kind: 'day_before' });
  assert.match(subject, /Monthly suppliers/);
  assert.match(text, /3 payments, 1,250\.00 USDC/);
  assert.match(text, /16:00 UTC on 3 Nov/);
  assert.match(text, /Skip this run/);
  assert.match(text, /Stop the schedule/);
  assert.match(text, /Nothing is paid before 16:00 UTC on 3 Nov/);
});

test('a run handed back to “ask me first” says why, in the owner’s words, and that nothing was paid', () => {
  const reason = fallbackWords('new_recipient', 'Santos Supplies');
  const { text } = noticeText({ ...base, kind: 'approval_ready', reason });
  assert.ok(text.includes(reason));
  assert.match(text, /not paid automatically/);
  assert.match(text, /Nothing has been paid/);
  const plain = noticeText({ ...base, mode: 'ask', kind: 'approval_ready' }).text;
  assert.match(plain, /Nothing is paid until the owners sign it with their passkeys/);
  assert.match(plain, /lapses and nothing is paid/);
});

test('the receipt, a failure, a lapse, a skip and the kill switch each read plainly', () => {
  assert.match(noticeText({ ...base, kind: 'paid' }).text, /was paid\. Your receipt is in History/);
  assert.match(noticeText({ ...base, kind: 'failed', reason: '2 of 3 payments went out.' }).text, /2 of 3 payments went out/);
  const lapsed = noticeText({ ...base, kind: 'lapsed' }).text;
  assert.match(lapsed, /not approved in time/);
  assert.match(lapsed, /no late fee or penalty/);
  assert.match(noticeText({ ...base, kind: 'skipped', by: 'Maria' }).text, /Maria skipped the run/);
  assert.match(noticeText({ ...base, kind: 'paused', by: 'Maria' }).text, /Maria paused automatic payments/);
});

test('no notice carries a link, and every path opens the signed-in Scheduled tab', () => {
  for (const kind of ['day_before', 'running', 'approval_ready', 'paid', 'failed', 'lapsed', 'skipped', 'paused']) {
    const { text, subject } = noticeText({ ...base, kind });
    assert.ok(!/https?:\/\//.test(text + subject), `${kind} has no URL in its words`);
    assert.ok(!/\bDemo\b|Coming soon|coral|testnet/i.test(text + subject), kind);
  }
  assert.equal(SCHEDULED_PATH, '/dashboard/transfer?view=scheduled');
  assert.equal(scheduledRunPath('a b'), '/dashboard/transfer?view=scheduled&run=a%20b');
});
