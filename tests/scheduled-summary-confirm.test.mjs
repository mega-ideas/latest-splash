/**
 * v2 Phase 3, scheduled batches: the summary an owner confirms is the summary the
 * server checks, and every signer sees it.
 *
 * An independent review found that the screen the owner confirmed was built in
 * the browser from schedules loaded earlier and the browser's clock, while the
 * request posted only four typed strings; the server rebuilt a summary from the
 * schedules as they were then and compared it with a rule built by the same call.
 * A payee added or an amount changed after the page loaded was confirmed unseen,
 * and the other owners who sign saw no summary at all.
 *
 *   digest      the request carries a digest of the summary the owner saw; the
 *               server builds its own and refuses a difference with 409 and the
 *               new summary, so the owner confirms again; no digest, no request
 *   clock       the end date is a whole UTC day, so a page and a server whose
 *               clocks differ by hours build the same summary on the same day
 *   signers     the summary text is stored with the signing request and shown to
 *               every owner who signs
 *   limits      a payment the limits would refuse, a payee never paid before, a
 *               run bigger than the daily or monthly limit and a schedule whose
 *               next time is after the end are marked, with how often it runs
 *   zone        every date on the screen is a UTC date, and says so
 *   server time the window line and the Stop button follow the server's clock
 *
 * PGlite with the staff-rule world's model chain; nothing reaches a network.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import * as S from '../lib/server/scheduled-payments.ts';
import { signingInbox } from '../lib/server/wallet-signing.ts';
import { buildHistory } from '../lib/history-page/entries.ts';
import { dayMonthWords, parseAllowanceInput, windowOpenNow } from '../lib/schedule/rules.ts';
import { automaticSummary, paymentsOfSchedules, summaryDigest } from '../lib/schedule/summary.ts';
import { signBy } from './fixtures/staff-rule-world.mjs';
import { DAY, OWNER_ACTOR, U, sched, scheduleWorld, t0 } from './fixtures/schedule-world.mjs';

const HOUR = 3_600_000;
const FIRST = new Date(Number(t0) + 2 * Number(DAY));
const ok = (r) => {
  assert.equal(r.ok, true, JSON.stringify(r, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
  return r;
};
const refused = (r, status, code) => {
  assert.equal(r.ok, false, 'expected a refusal');
  assert.equal(r.status, status, JSON.stringify(r));
  if (code) assert.equal(r.code, code);
  return r;
};

const typed = { perPaymentUsdc: '1,500', dailyUsdc: '4000', monthlyUsdc: '16000', expiresInDays: 60 };

async function withAutoSchedule(over = {}) {
  const t = await scheduleWorld();
  await t.payBefore(t.ids.a, 1);
  await t.payBefore(t.ids.b, 1);
  const made = ok(await S.createSchedule(t.sdeps(), OWNER_ACTOR, sched(t.ids, { mode: 'auto', firstDueAt: FIRST.toISOString(), ...over })));
  t.schedule = made.schedule;
  return t;
}

/** What the page builds: from the schedules it loaded, the typed values and its own clock. */
async function onThePage(t, input = typed, nowMs = Number(t0)) {
  const views = await S.listScheduleViews(t.sdeps(), OWNER_ACTOR);
  const { payments, schedules, firstPaymentMs } = paymentsOfSchedules(views);
  const { form, problems } = parseAllowanceInput(input);
  assert.deepEqual(problems, []);
  const summary = automaticSummary({ payments, schedules, form, graceMinutes: 10, nowMs, firstPaymentMs });
  return { summary, digest: await summaryDigest(summary) };
}

// ─── The digest ────────────────────────────────────────────────────────────

test('the owner confirms what the page showed: the digest of that summary is accepted, and the server answers with the same summary', async () => {
  const t = await withAutoSchedule();
  const page = await onThePage(t);
  const asked = ok(await S.requestAllowance(t.sdeps(), OWNER_ACTOR, { ...typed, summaryDigest: page.digest }));
  assert.deepEqual(asked.summary, page.summary);
  assert.equal(await summaryDigest(asked.summary), page.digest);
});

test('a payee added after the page loaded: the request is refused with the new summary, nothing is asked, and confirming again goes through', async () => {
  const t = await withAutoSchedule();
  const page = await onThePage(t);
  await t.payBefore(t.ids.c, 1);
  ok(await S.createSchedule(t.sdeps(), OWNER_ACTOR, sched(t.ids, { clientKey: 'sched_key_000009', name: 'Late addition', mode: 'auto', firstDueAt: FIRST.toISOString(), items: [{ recipientId: t.ids.c, amount: '5000', reference: 'BIG' }] })));

  const stale = refused(await S.requestAllowance(t.sdeps(), OWNER_ACTOR, { ...typed, summaryDigest: page.digest }), 409, 'summary_changed');
  assert.equal(stale.details.summary.paymentCount, 3, 'the new summary has the payee the owner never saw');
  assert.ok(stale.details.summary.payments.some((p) => p.reference === 'BIG'));
  assert.equal(stale.details.digest, await summaryDigest(stale.details.summary));
  assert.equal((await S.automaticStatus(t.sdeps())).pendingDailyCapMinor, null, 'no request was made and no daily limit is waiting');
  assert.equal((await signingInbox(t.w.signing, { orgId: 'acme', userId: 'u-two' })).length, 0, 'no owner was asked to sign anything');

  const again = ok(await S.requestAllowance(t.sdeps(), OWNER_ACTOR, { ...typed, summaryDigest: stale.details.digest }));
  assert.equal(again.summary.paymentCount, 3);
});

test('an amount changed after the page loaded is refused the same way', async () => {
  const t = await withAutoSchedule();
  const page = await onThePage(t);
  ok(await S.editSchedule(t.sdeps(), OWNER_ACTOR, t.schedule.id, { items: [{ recipientId: t.ids.a, amount: '500', reference: 'INV-1' }, { recipientId: t.ids.b, amount: '1400', reference: 'INV-2' }] }));
  refused(await S.requestAllowance(t.sdeps(), OWNER_ACTOR, { ...typed, summaryDigest: page.digest }), 409, 'summary_changed');
});

test('a different limit than the one the owner saw is refused: the digest covers the limits too', async () => {
  const t = await withAutoSchedule();
  const page = await onThePage(t);
  refused(await S.requestAllowance(t.sdeps(), OWNER_ACTOR, { ...typed, perPaymentUsdc: '1,800', summaryDigest: page.digest }), 409, 'summary_changed');
  refused(await S.requestAllowance(t.sdeps(), OWNER_ACTOR, { ...typed, expiresInDays: 90, summaryDigest: page.digest }), 409, 'summary_changed');
});

test('no digest, no request: the server asks nobody to sign a summary the owner did not confirm', async () => {
  const t = await withAutoSchedule();
  refused(await S.requestAllowance(t.sdeps(), OWNER_ACTOR, typed), 400, 'summary_not_confirmed');
  refused(await S.requestAllowance(t.sdeps(), OWNER_ACTOR, { ...typed, summaryDigest: '' }), 400, 'summary_not_confirmed');
  refused(await S.requestAllowance(t.sdeps(), OWNER_ACTOR, { ...typed, summaryDigest: 12 }), 400, 'summary_not_confirmed');
});

test('the allowance route passes the digest on and answers a changed summary with it', async () => {
  const { readFileSync } = await import('node:fs');
  const route = readFileSync('app/api/wallet/schedules/automatic/allowance/route.ts', 'utf8');
  assert.match(route, /summaryDigest: body\.summaryDigest/);
});

// ─── The clock ─────────────────────────────────────────────────────────────

test('a page whose clock is hours off builds the same summary on the same UTC day, so the owner is not sent back for nothing', async () => {
  const serverNow = Number(t0);
  for (const skew of [-7 * HOUR, 0, 7 * HOUR]) {
    const t = await withAutoSchedule();
    const page = await onThePage(t, typed, serverNow + skew);
    ok(await S.requestAllowance(t.sdeps(), OWNER_ACTOR, { ...typed, summaryDigest: page.digest }));
  }
});

test('a page whose clock is on the next UTC day builds a different end date, and the server says so', async () => {
  const t = await withAutoSchedule();
  const page = await onThePage(t, typed, Number(t0) + 17 * HOUR);
  refused(await S.requestAllowance(t.sdeps(), OWNER_ACTOR, { ...typed, summaryDigest: page.digest }), 409, 'summary_changed');
});

test('the allowance ends at the end of a UTC day, and the network holds exactly the end the summary named', async () => {
  const t = await withAutoSchedule();
  const page = await onThePage(t);
  const asked = ok(await S.requestAllowance(t.sdeps(), OWNER_ACTOR, { ...typed, summaryDigest: page.digest }));
  assert.equal(asked.summary.endsAtMs % Number(DAY), 0, 'the end is midnight UTC');
  assert.ok(asked.summary.endsAtMs > Number(t0) + 60 * Number(DAY), 'at least the days asked for');
  assert.ok(asked.summary.endsAtMs <= Number(t0) + 61 * Number(DAY), 'and less than a day more');
  assert.equal((await signBy(t.w, asked.request, ['two', 'three'])).status, 'executed');
  const held = await S.automaticStatus(t.sdeps());
  assert.equal(held.allowance.expiresAtMs, String(asked.summary.endsAtMs));
});

test('every date on the screen is a UTC date, and the headline says so', async () => {
  const t = await withAutoSchedule();
  const { summary } = await onThePage(t);
  assert.match(summary.headline, /from \d+ \w{3} until \d+ \w{3} \(UTC\)/);
  assert.match(summary.endsOnText, /^\d+ \w{3} \d{4} \(UTC\)$/);
  const last = new Date(summary.endsAtMs - 1);
  assert.equal(summary.endsOnText, `${dayMonthWords(summary.endsAtMs - 1)} ${last.getUTCFullYear()} (UTC)`, 'the last day it is in force, not the midnight after it');
  assert.ok(summary.headline.includes(`until ${dayMonthWords(summary.endsAtMs - 1)} (UTC)`));
});

// ─── Every signer sees it ──────────────────────────────────────────────────

test('the summary is stored with the signing request and shown to the owners who sign, in the same words', async () => {
  const t = await withAutoSchedule();
  const page = await onThePage(t);
  const asked = ok(await S.requestAllowance(t.sdeps(), OWNER_ACTOR, { ...typed, summaryDigest: page.digest }));
  assert.deepEqual(asked.request.summaryText, { headline: page.summary.headline, lines: page.summary.lines });
  for (const userId of ['u-two', 'u-three']) {
    const mine = (await signingInbox(t.w.signing, { orgId: 'acme', userId })).find((r) => r.id === asked.request.id);
    assert.ok(mine, `${userId} has the request`);
    assert.equal(mine.summaryText.headline, page.summary.headline);
    assert.ok(mine.summaryText.lines.some((l) => l.includes('Dela Cruz Trading Corp') && l.includes('500')), 'the exact payments');
    assert.ok(mine.summaryText.lines.some((l) => /The most for one payment: 1,500 USDC/.test(l)));
    assert.ok(mine.summaryText.lines.some((l) => /The most in a day: 4,000 USDC.*The most in a month: 16,000 USDC/.test(l)));
  }
});

test('other signing requests carry no summary text', async () => {
  const t = await scheduleWorld();
  const all = await signingInbox(t.w.signing, { orgId: 'acme', userId: 'u-two' });
  assert.ok(all.every((r) => r.summaryText === null));
});

// ─── What the limits would refuse, and how often ───────────────────────────

test('a payment above the most for one payment is marked, and the headline says up to', async () => {
  const t = await withAutoSchedule();
  const { summary } = await onThePage(t, { ...typed, perPaymentUsdc: '600' });
  const santos = summary.payments.find((p) => p.name === 'Santos Supplies Inc');
  assert.deepEqual(santos.reasons, ['over_payment_limit']);
  assert.match(santos.notes[0], /600 USDC/);
  assert.match(santos.notes[0], /approve/i);
  assert.deepEqual(summary.payments.find((p) => p.name === 'Dela Cruz Trading Corp').reasons, []);
  assert.match(summary.headline, /^Splash will pay up to 2 payments /);
  assert.match(summary.headline, /1 of them would come to you for approval/);
  assert.equal(summary.handedBackCount, 1);
});

test('a payee never paid before is marked: a first payment is never automatic', async () => {
  const w = await scheduleWorld();
  await w.payBefore(w.ids.a, 1);
  ok(await S.createSchedule(w.sdeps(), OWNER_ACTOR, sched(w.ids, { mode: 'auto', firstDueAt: FIRST.toISOString(), items: [{ recipientId: w.ids.a, amount: '10' }, { recipientId: w.ids.c, amount: '20' }] })));
  const { summary } = await onThePage(w);
  assert.deepEqual(summary.payments.find((p) => p.name === 'Reyes Logistics Corp').reasons, ['new_payee']);
  assert.match(summary.payments.find((p) => p.name === 'Reyes Logistics Corp').notes[0], /not been paid before/i);
  assert.deepEqual(summary.payments.find((p) => p.name === 'Dela Cruz Trading Corp').reasons, []);
  assert.match(summary.headline, /^Splash will pay up to 2 payments /);
});

test('a run bigger than the daily or the monthly limit is marked on its schedule', async () => {
  const t = await withAutoSchedule();
  const { summary } = await onThePage(t, { perPaymentUsdc: '1000', dailyUsdc: '1000', monthlyUsdc: '1200', expiresInDays: 60 });
  const [s] = summary.schedules;
  assert.deepEqual(s.reasons.sort(), ['over_daily', 'over_monthly']);
  assert.equal(s.pays, false);
  assert.match(s.notes.join(' '), /daily limit/);
  assert.match(s.notes.join(' '), /monthly limit/);
  assert.match(summary.headline, /^Splash will pay up to /);
});

test('how often it runs: the cadence and how many runs fall before the end, with the payments in all', async () => {
  const t = await withAutoSchedule();
  const { summary } = await onThePage(t);
  const [s] = summary.schedules;
  assert.equal(s.name, 'Monthly suppliers');
  assert.match(s.cadenceText, /Every month/);
  const ends = summary.endsAtMs;
  const day = (n) => Date.UTC(2026, 9 + n, 27, 8, 0, 0);
  const expected = [0, 1, 2, 3].filter((n) => day(n) < ends).length;
  assert.equal(s.runs, expected);
  assert.equal(s.paymentCount, 2);
  assert.equal(summary.paymentsInAll, 2 * expected);
  assert.match(summary.headline, /each time they fall due/);
  assert.ok(summary.lines.some((l) => l.startsWith('Monthly suppliers:') && l.includes('Every month') && l.includes(`${expected} run`)));
});

test('a schedule whose next time falls after the allowance ends is marked', async () => {
  const t = await withAutoSchedule();
  const { summary } = await onThePage(t, { ...typed, expiresInDays: 1 });
  const [s] = summary.schedules;
  assert.equal(s.runs, 0);
  assert.deepEqual(s.reasons, ['after_end']);
  assert.equal(s.pays, false);
});

test('a clean summary promises exactly what it will do and nothing it would refuse', async () => {
  const t = await withAutoSchedule();
  const { summary } = await onThePage(t);
  assert.equal(summary.handedBackCount, 0);
  assert.match(summary.headline, /^Splash will pay these 2 payments each time they fall due, up to 1,500 USDC each, from /);
  assert.ok(summary.payments.every((p) => p.reasons.length === 0 && p.notes.length === 0));
  assert.ok(summary.schedules.every((s) => s.pays && s.notes.length === 0));
});

// ─── The window line follows the server's clock ────────────────────────────

test('a device whose clock runs fast still sees the window as open for as long as the server does', () => {
  const startsAt = '2026-10-27T08:10:00.000Z';
  const server = Date.parse('2026-10-27T08:05:00.000Z');
  const fast = server + 10 * 60_000;
  assert.equal(windowOpenNow(startsAt, fast, 0), false, 'read by the device clock alone it would hide the line and the Stop button');
  assert.equal(windowOpenNow(startsAt, fast, server - fast), true, 'read with the server’s time it is open');
  const ends = Date.parse(startsAt);
  assert.equal(windowOpenNow(startsAt, ends - 1 + 10 * 60_000, -10 * 60_000), true, 'one millisecond before the start, by the server’s clock');
  assert.equal(windowOpenNow(startsAt, ends + 10 * 60_000, -10 * 60_000), false, 'at the start the window is over');
  assert.equal(windowOpenNow(null, fast, 0), false);
  assert.equal(windowOpenNow('not a date', fast, 0), false);
});

test('the run and the History row say whether the window is open, by the server’s clock', async () => {
  const t = await scheduleWorld();
  await t.allowance();
  await t.payBefore(t.ids.a, 1);
  await t.payBefore(t.ids.b, 1);
  ok(await S.createSchedule(t.sdeps(), OWNER_ACTOR, sched(t.ids, { mode: 'auto', firstDueAt: FIRST.toISOString() })));
  const { runScheduledPayments } = await import('../lib/server/scheduled-runner.ts');
  const runner = () => ({ db: t.w.db, now: () => t.w.signing.now(), depsFor: async (orgId) => (orgId === 'acme' ? t.sdeps() : null), env: { NODE_ENV: 'test' } });
  await t.clock(new Date(FIRST.getTime()));
  await runScheduledPayments(runner());
  const open = (await S.listRunViews(t.sdeps()))[0];
  assert.equal(open.windowOpen, true);
  assert.equal(open.serverNowMs, FIRST.getTime(), 'the server says what time it is');
  const entry = buildHistory({ transfers: [], batches: [], withdrawals: [], earlier: [], scheduled: [open] })[0];
  assert.equal(entry.windowOpen, true);
  assert.equal(entry.serverNowMs, FIRST.getTime());
  assert.equal((await S.listScheduleViews(t.sdeps(), OWNER_ACTOR))[0].runs[0].windowOpen, true);
  await t.clock(new Date(FIRST.getTime() + 10 * 60_000));
  const ended = (await S.listRunViews(t.sdeps()))[0];
  assert.equal(ended.windowOpen, false, 'at the start time the window is over');
  void U;
});
