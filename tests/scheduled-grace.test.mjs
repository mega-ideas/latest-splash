/**
 * v2 Phase 3, scheduled batches: the grace window of "Pay automatically within
 * my limits".
 *
 * The notice that a run is starting goes out GRACE minutes before the first
 * automatic payment of the run (default 10; an owner sets 0 to 60 per business,
 * instantly). Until the window ends nothing is claimed or paid; Skip or Stop
 * inside it ends the run as "skipped, nothing paid"; everything is checked again
 * at the window's end, and anything that no longer passes hands the run back to
 * "ask me first". The per-business lock, the run lease and "a Skip and the first
 * payment never both happen" are as they were. The runner takes the clock the
 * test controls; nothing reaches a network.
 *
 *   window      opens when the run starts; the notice names the start; the
 *               payments wait for it, to the millisecond; an announced window is
 *               not moved by changing the setting
 *   setting     owner only, whole minutes 0 to 60, per business, recorded
 *   stops       Skip and Stop inside the window; the race with the window's end
 *   re-checks   the kill switch, the allowance, the limits (at their edges), the
 *               payments, the mode: all read again at the end
 *   once        running it again, or twice at once, tells once and pays once
 *   tenants     another business can neither skip nor stretch a window
 *   production  nothing is announced or paid by a payer that cannot pay there
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { eq } from 'drizzle-orm';

import * as schema from '../lib/db/schema.ts';
import { listAuthorityEvents } from '../lib/server/wallet-authority.ts';
import { runScheduledPayments } from '../lib/server/scheduled-runner.ts';
import * as S from '../lib/server/scheduled-payments.ts';
import { claimPayment, getSettings, insertRunPayments, listRunPayments, listRuns, moveRunUnlessPaying, openGraceWindow, saveSettings } from '../lib/server/scheduled-store.ts';
import { buildHistory } from '../lib/history-page/entries.ts';
import { signBy } from './fixtures/staff-rule-world.mjs';
import { DAY, FINANCE_LEAD, OWNER_ACTOR, STAFF_ACTOR, U, feeFor, sched, scheduleWorld, t0 } from './fixtures/schedule-world.mjs';

const HOUR = 3_600_000;
const MIN = 60_000;
const FIRST = new Date(Number(t0) + 2 * Number(DAY));
const at = (ms) => new Date(ms);
const runner = (t, over = {}) => ({ db: t.w.db, now: () => t.w.signing.now(), depsFor: async (orgId) => (orgId === 'acme' ? t.sdeps() : null), env: { NODE_ENV: 'test' }, ...over });
const runs = (t) => listRuns(t.w.db, 'acme');
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

/** Owners gave the scheduled payer an allowance; two recipients were paid before; an automatic schedule pays both. The window is the default (10 minutes). */
async function ready({ allowance = {}, items, schedule = {}, grace } = {}) {
  const t = await scheduleWorld();
  await t.allowance(allowance);
  await t.payBefore(t.ids.a, 1);
  await t.payBefore(t.ids.b, 1);
  const made = await S.createSchedule(t.sdeps(), OWNER_ACTOR, sched(t.ids, { mode: 'auto', firstDueAt: FIRST.toISOString(), ...(items ? { items } : {}), ...schedule }));
  assert.equal(made.ok, true, JSON.stringify(made));
  t.schedule = made.schedule;
  if (grace !== undefined) ok(await S.setGraceWindow(t.sdeps(), OWNER_ACTOR, grace));
  return t;
}

/** Run the cron once at a moment. */
const pass = async (t, when) => {
  await t.clock(at(when));
  return runScheduledPayments(runner(t));
};

const START = FIRST.getTime() + 10 * MIN;

// ─── The window ────────────────────────────────────────────────────────────

test('the notice goes out at the due time and names the start; nothing is paid until 10 minutes later, to the millisecond', async () => {
  const t = await ready();
  await pass(t, FIRST.getTime() - 20 * HOUR);
  assert.deepEqual(t.kinds(), ['day_before']);

  const opened = await pass(t, FIRST.getTime());
  assert.deepEqual(opened.errors, []);
  const [run] = await runs(t);
  assert.equal(run.status, 'scheduled', 'the run waits, still skippable');
  assert.equal(run.startsAt.getTime(), START, 'it starts GRACE minutes after the notice went out');
  assert.ok(run.noticeRunningAt, 'the notice is stamped once');
  assert.deepEqual(t.kinds(), ['day_before', 'running']);
  const running = t.notices.find((n) => n.kind === 'running');
  assert.equal(running.startsAtMs, START);
  assert.equal(running.graceMinutes, 10);
  assert.equal(running.itemCount, 2);
  assert.equal(t.spent(), 0);
  assert.equal(t.signed.length, 0);
  assert.equal((await listRunPayments(t.w.db, 'acme', run.id)).length, 0, 'no payment row exists before the window ends');

  await pass(t, FIRST.getTime() + 5 * MIN);
  await pass(t, START - 1);
  assert.equal(t.spent(), 0, 'one millisecond before the end nothing is paid');
  assert.equal((await runs(t))[0].status, 'scheduled');

  await pass(t, START);
  const [done] = await runs(t);
  assert.equal(done.status, 'paid', 'at the end of the window it is paid');
  assert.equal(done.ranAs, 'auto');
  assert.equal(t.spent(), 2);
  assert.equal(t.signed.length, 2);
  assert.deepEqual(t.kinds(), ['day_before', 'running', 'paid'], 'told once before, once as it starts, once with the receipt');
});

test('one millisecond after the end it is paid too, and the window never starts a second time', async () => {
  const t = await ready();
  await pass(t, FIRST.getTime());
  await pass(t, START + 1);
  assert.equal((await runs(t))[0].status, 'paid');
  assert.equal(t.kinds().filter((k) => k === 'running').length, 1);
  assert.equal((await runs(t))[0].startsAt.getTime(), START, 'the announced start stays what it was');
});

test('a window of 0 pays at the due time as before: no waiting, and the notice names no start', async () => {
  const t = await ready({ grace: 0 });
  await pass(t, FIRST.getTime());
  const [run] = await runs(t);
  assert.equal(run.status, 'paid');
  assert.equal(run.startsAt, null, 'no window was opened');
  assert.equal(t.spent(), 2);
  const running = t.notices.find((n) => n.kind === 'running');
  assert.equal(running.startsAtMs ?? null, null);
  assert.deepEqual(t.kinds(), ['running', 'paid']);
});

test('the longest window, 60 minutes, holds the payments for the full hour', async () => {
  const t = await ready({ grace: 60 });
  await pass(t, FIRST.getTime());
  assert.equal((await runs(t))[0].startsAt.getTime(), FIRST.getTime() + 60 * MIN);
  await pass(t, FIRST.getTime() + 59 * MIN + 59_999);
  assert.equal(t.spent(), 0);
  await pass(t, FIRST.getTime() + 60 * MIN);
  assert.equal(t.spent(), 2);
});

test('a window announced is not moved by changing the setting afterwards', async () => {
  const t = await ready();
  await pass(t, FIRST.getTime());
  ok(await S.setGraceWindow(t.sdeps(), OWNER_ACTOR, 60));
  await pass(t, START);
  assert.equal((await runs(t))[0].status, 'paid', 'the 10 minutes the notice named are the 10 minutes it waited');

  const shorter = await ready();
  await pass(shorter, FIRST.getTime());
  ok(await S.setGraceWindow(shorter.sdeps(), OWNER_ACTOR, 0));
  await pass(shorter, FIRST.getTime() + 5 * MIN);
  assert.equal(shorter.spent(), 0, 'shortening the setting does not bring an announced start forward');
  await pass(shorter, START);
  assert.equal(shorter.spent(), 2);
});

test('the day-before notice says how long the window is, and carries Skip and Stop', async () => {
  const t = await ready();
  await pass(t, FIRST.getTime() - 20 * HOUR);
  const n = t.notices[0];
  assert.equal(n.kind, 'day_before');
  assert.equal(n.graceMinutes, 10);
  assert.match(n.path, /view=scheduled&run=psr_/);
});

// ─── The setting ───────────────────────────────────────────────────────────

test('an owner sets the window from 0 to 60 minutes, at once; the default is 10', async () => {
  const t = await scheduleWorld();
  assert.equal((await S.automaticStatus(t.sdeps())).graceMinutes, 10, 'the default, with nothing saved');
  for (const minutes of [0, 60, 25, 10, '15']) {
    const done = ok(await S.setGraceWindow(t.sdeps(), OWNER_ACTOR, minutes));
    assert.equal(done.graceMinutes, Number(minutes));
    assert.equal((await S.automaticStatus(t.sdeps())).graceMinutes, Number(minutes), 'in force at once, with no cooldown');
  }
  assert.equal((await getSettings(t.w.db, 'acme')).graceMinutes, 15);
  const trail = (await listAuthorityEvents(t.w.db, 'acme')).filter((e) => e.action === 'automatic_grace_changed');
  assert.ok(trail.length >= 5, 'each change is on the owners’ trail');
  assert.equal(trail.at(-1).detail.minutes, 15);
  assert.equal(trail.at(-1).actorUserId, 'u-founder');
});

test('a window that is not a whole number of minutes from 0 to 60 is refused and changes nothing', async () => {
  const t = await scheduleWorld();
  ok(await S.setGraceWindow(t.sdeps(), OWNER_ACTOR, 20));
  for (const bad of [-1, 61, 1.5, '', 'ten', null, undefined, Number.NaN, 600, '60.5']) {
    refused(await S.setGraceWindow(t.sdeps(), OWNER_ACTOR, bad), 400, 'bad_grace');
  }
  assert.equal((await S.automaticStatus(t.sdeps())).graceMinutes, 20);
});

test('only an owner sets the window: not the Finance lead, not staff', async () => {
  const t = await scheduleWorld();
  refused(await S.setGraceWindow(t.sdeps(), FINANCE_LEAD, 0), 403, 'owner_only');
  refused(await S.setGraceWindow(t.sdeps(), STAFF_ACTOR, 60), 403, 'owner_only');
  assert.equal((await S.automaticStatus(t.sdeps())).graceMinutes, 10);
});

test('the window is per business: another business setting 60 leaves ours at 10', async () => {
  const t = await ready();
  ok(await S.setGraceWindow(t.sdeps('northwind'), { userId: 'u-north', role: 'OWNER' }, 60));
  assert.equal((await getSettings(t.w.db, 'northwind')).graceMinutes, 60);
  assert.equal((await S.automaticStatus(t.sdeps())).graceMinutes, 10);
  await pass(t, FIRST.getTime());
  assert.equal((await runs(t))[0].startsAt.getTime(), START, 'our run waited our 10 minutes');
});

test('saving other settings leaves the window alone', async () => {
  const t = await scheduleWorld();
  ok(await S.setGraceWindow(t.sdeps(), OWNER_ACTOR, 40));
  ok(await S.pauseAutomatic(t.sdeps(), OWNER_ACTOR));
  ok(await S.resumeAutomatic(t.sdeps(), OWNER_ACTOR));
  await saveSettings(t.w.db, 'acme', { dailyCapMinor: U(1_000) }, new Date());
  assert.equal((await S.automaticStatus(t.sdeps())).graceMinutes, 40);
});

test('the database itself refuses a window outside 0 to 60', async () => {
  const t = await scheduleWorld();
  for (const bad of [-1, 61]) {
    await assert.rejects(saveSettings(t.w.db, 'acme', { graceMinutes: bad }, new Date()), (e) => /violates check constraint "scheduled_payment_settings_grace_check"/.test(String(e.cause?.message ?? e.message)), String(bad));
  }
  await saveSettings(t.w.db, 'acme', { graceMinutes: 0 }, new Date());
  await saveSettings(t.w.db, 'acme', { graceMinutes: 60 }, new Date());
});

// ─── Skip and Stop inside the window ───────────────────────────────────────

test('Skip inside the window ends the run as skipped with nothing paid, and later passes pay nothing', async () => {
  const t = await ready();
  await pass(t, FIRST.getTime());
  const [open] = await S.listRunViews(t.sdeps());
  assert.equal(open.status, 'scheduled');
  assert.equal(open.canSkip, true, 'Skip is offered in the window');
  assert.equal(open.startsAt, new Date(START).toISOString());

  await t.clock(at(FIRST.getTime() + 4 * MIN));
  const skipped = ok(await S.skipRun(t.sdeps(), OWNER_ACTOR, t.schedule.id, { runId: open.id }));
  assert.equal(skipped.run.status, 'skipped');
  assert.match(skipped.run.reason, /Nothing was paid/);
  await pass(t, START);
  await pass(t, START + 20 * MIN);
  const [run] = await runs(t);
  assert.equal(run.status, 'skipped');
  assert.equal(t.spent(), 0);
  assert.equal(t.signed.length, 0);
  assert.equal((await listRunPayments(t.w.db, 'acme', run.id)).length, 0);
  assert.ok(t.kinds().includes('skipped'));
  assert.ok(!t.kinds().includes('paid'));
});

test('Stop inside the window ends the run the same way, and starting the schedule again does not pay this time late', async () => {
  const t = await ready();
  await pass(t, FIRST.getTime());
  await t.clock(at(FIRST.getTime() + 2 * MIN));
  ok(await S.stopSchedule(t.sdeps(), OWNER_ACTOR, t.schedule.id));
  const [stopped] = await runs(t);
  assert.equal(stopped.status, 'skipped');
  assert.match(stopped.reason, /Nothing was paid/);
  await pass(t, START + 1);
  assert.equal(t.spent(), 0);
  assert.equal(t.signed.length, 0);
});

test('only an owner can skip or stop an automatic run in its window; the Finance lead and staff cannot', async () => {
  const t = await ready();
  await pass(t, FIRST.getTime());
  const [run] = await runs(t);
  refused(await S.skipRun(t.sdeps(), FINANCE_LEAD, t.schedule.id, { runId: run.id }), 403, 'owner_only');
  refused(await S.stopSchedule(t.sdeps(), STAFF_ACTOR, t.schedule.id), 403, 'owner_only');
  await pass(t, START);
  assert.equal((await runs(t))[0].status, 'paid', 'a refusal changes nothing');
});

test('another business cannot skip or stop our run, or lengthen our window', async () => {
  const t = await ready();
  await pass(t, FIRST.getTime());
  const [run] = await runs(t);
  const northOwner = { userId: 'u-north', role: 'OWNER' };
  refused(await S.skipRun(t.sdeps('northwind'), northOwner, t.schedule.id, { runId: run.id }), 404, 'schedule_not_found');
  refused(await S.stopSchedule(t.sdeps('northwind'), northOwner, t.schedule.id), 404, 'schedule_not_found');
  assert.equal(await openGraceWindow(t.w.db, 'northwind', run.id, { startsAt: at(START + 50 * MIN), windowVersion: 1, now: at(FIRST.getTime()) }), null, 'the store keeps tenants apart too');
  assert.equal((await runs(t))[0].startsAt.getTime(), START);
  await pass(t, START);
  assert.equal((await runs(t))[0].status, 'paid');
});

// ─── Skip racing the window's end ──────────────────────────────────────────

test('a Skip a millisecond before the window ends wins: the run is skipped and nothing is paid', async () => {
  const t = await ready();
  await pass(t, FIRST.getTime());
  const [run] = await runs(t);
  await t.clock(at(START - 1));
  ok(await S.skipRun(t.sdeps(), OWNER_ACTOR, t.schedule.id, { runId: run.id }));
  await pass(t, START);
  assert.equal((await runs(t))[0].status, 'skipped');
  assert.equal(t.spent(), 0);
  assert.equal(t.signed.length, 0);
});

test('a Skip at the very moment the window ends, and the runner at the same moment: never both', async () => {
  for (let n = 0; n < 3; n += 1) {
    const t = await ready();
    await pass(t, FIRST.getTime());
    const [run] = await runs(t);
    await t.clock(at(START));
    const [skip, pass2] = await Promise.all([S.skipRun(t.sdeps(), OWNER_ACTOR, t.schedule.id, { runId: run.id }), runScheduledPayments(runner(t))]);
    assert.deepEqual(pass2.errors, []);
    const [after] = await runs(t);
    if (skip.ok) {
      assert.equal(after.status, 'skipped', `trial ${n}: a Skip that succeeded is final`);
      assert.equal(t.spent(), 0, `trial ${n}: nothing was paid`);
      assert.equal(t.signed.length, 0);
    } else {
      assert.equal(skip.status, 409, `trial ${n}: ${JSON.stringify(skip)}`);
      assert.equal(after.status, 'paid', `trial ${n}: a Skip that was refused means the run went out`);
      assert.equal(t.spent(), 2);
    }
    // And a later pass changes neither.
    await pass(t, START + 5 * MIN);
    assert.equal(t.spent(), skip.ok ? 0 : 2);
  }
});

test('a payment cannot be claimed before the window ends, and a Skip still wins up to the first claim', async () => {
  const t = await ready();
  await pass(t, FIRST.getTime());
  const [run] = await runs(t);
  // Build the state the runner reaches at the end of the window, but with the clock still inside it.
  await t.w.db.update(schema.paymentScheduleRuns).set({ status: 'approved', ranAs: 'auto' }).where(eq(schema.paymentScheduleRuns.id, run.id));
  const now = at(FIRST.getTime());
  await insertRunPayments(t.w.db, [{ id: 'psp_early', runId: run.id, orgId: 'acme', position: 1, paymentRef: 'a'.repeat(64), recipientId: t.ids.a, businessId: null, payeeName: 'Early', address: `0x${'71'.repeat(32)}`, amountMinor: U(5), maxFeeMinor: 0n, feeKind: 1, reference: null, status: 'pending', createdAt: now, updatedAt: now }]);
  assert.equal(await claimPayment(t.w.db, 'acme', 'psp_early', { digest: 'd1', gasBudgetMist: 1n, now: at(START - 1) }), null, 'the database refuses a claim inside the window');
  assert.equal((await listRunPayments(t.w.db, 'acme', run.id))[0].status, 'pending');
  const claimed = await claimPayment(t.w.db, 'acme', 'psp_early', { digest: 'd1', gasBudgetMist: 1n, now: at(START) });
  assert.ok(claimed, 'at the end of the window the claim is allowed');
  assert.equal(await moveRunUnlessPaying(t.w.db, 'acme', run.id, { status: 'skipped' }, ['approved']), null, 'and after the first claim a Skip no longer goes through');
});

test('opening a window is once per run: a second opener finds it open', async () => {
  const t = await ready();
  await pass(t, FIRST.getTime());
  const [run] = await runs(t);
  assert.equal(await openGraceWindow(t.w.db, 'acme', run.id, { startsAt: at(START + 30 * MIN), windowVersion: 1, now: at(FIRST.getTime() + 1) }), null);
  assert.equal((await runs(t))[0].startsAt.getTime(), START);
});

// ─── Everything is checked again at the end ────────────────────────────────

const handedBack = async (t, code) => {
  const [run] = await runs(t);
  assert.equal(run.status, 'waiting_approval', `${code}: ${run.status} ${run.reason}`);
  assert.equal(run.reasonCode, code);
  assert.equal(run.fallback, true);
  assert.equal(t.spent(), 0, 'nothing was paid automatically');
  assert.equal(t.signed.length, 0);
  assert.ok(run.batchId, 'an approval request went out');
  assert.ok(t.notices.some((n) => n.kind === 'approval_ready' && n.reason === run.reason), 'the owners are told why');
  return run;
};

test('the kill switch pressed inside the window hands the run back at its end', async () => {
  const t = await ready();
  await pass(t, FIRST.getTime());
  ok(await S.pauseAutomatic(t.sdeps(), OWNER_ACTOR));
  await pass(t, FIRST.getTime() + 3 * MIN);
  assert.equal(t.spent(), 0);
  await pass(t, START);
  await handedBack(t, 'auto_paused');
});

test('switching to “ask me first” inside the window takes effect: the owners are asked, nothing is paid', async () => {
  const t = await ready();
  await pass(t, FIRST.getTime());
  ok(await S.editSchedule(t.sdeps(), OWNER_ACTOR, t.schedule.id, { mode: 'ask' }));
  await pass(t, START);
  const [run] = await runs(t);
  assert.equal(run.status, 'waiting_approval');
  assert.equal(run.ranAs, 'ask');
  assert.equal(run.fallback, false, 'the owners chose it');
  assert.equal(t.spent(), 0);
  assert.equal(t.signed.length, 0);
});

test('changing the payments inside the window hands the run back: what was announced is not what is paid', async () => {
  const t = await ready();
  await pass(t, FIRST.getTime());
  ok(await S.editSchedule(t.sdeps(), OWNER_ACTOR, t.schedule.id, { items: [{ recipientId: t.ids.a, amount: '900' }] }));
  await pass(t, START);
  await handedBack(t, 'changed_in_window');
});

test('the allowance changed or taken back inside the window is read again at the end', async () => {
  const t = await ready();
  await pass(t, FIRST.getTime());
  const lower = ok(await S.requestAllowance(t.sdeps(), OWNER_ACTOR, { perPaymentUsdc: '400', dailyUsdc: '5000', monthlyUsdc: '20000', expiresInDays: 90 }));
  assert.equal((await signBy(t.w, lower.request, ['two', 'three'])).status, 'executed');
  await pass(t, START);
  await handedBack(t, 'over_payment_limit');

  const gone = await ready();
  await pass(gone, FIRST.getTime());
  const revoke = ok(await S.revokeAllowance(gone.sdeps(), OWNER_ACTOR));
  assert.equal((await signBy(gone.w, revoke.request, ['two', 'three'])).status, 'executed');
  await pass(gone, START);
  const [run] = await runs(gone);
  assert.equal(run.status, 'waiting_approval');
  assert.ok(['no_allowance', 'allowance_ended'].includes(run.reasonCode));
  assert.equal(gone.spent(), 0);
});

test('the daily limit is read again at the end: exactly enough pays, one micro short hands the run back', async () => {
  const total = U(500) + U(750.5) + feeFor(U(500)) + feeFor(U(750.5));
  const exact = await ready();
  await pass(exact, FIRST.getTime());
  await saveSettings(exact.w.db, 'acme', { dailyCapMinor: total }, new Date());
  await pass(exact, START);
  assert.equal((await runs(exact))[0].status, 'paid', 'a limit equal to the run is not exceeded');
  assert.equal(exact.spent(), 2);

  const short = await ready();
  await pass(short, FIRST.getTime());
  await saveSettings(short.w.db, 'acme', { dailyCapMinor: total - 1n }, new Date());
  await pass(short, START);
  await handedBack(short, 'daily_cap');
});

test('a per-payment limit equal to the payment is not exceeded; one micro below is handed back before anything is announced', async () => {
  const equal = await ready({ allowance: { perPaymentMaxMinor: U(750.5) } });
  await pass(equal, FIRST.getTime());
  assert.ok((await runs(equal))[0].startsAt, 'the biggest payment is exactly the limit: the window opens');
  await pass(equal, START);
  assert.equal((await runs(equal))[0].status, 'paid');

  const below = await ready({ allowance: { perPaymentMaxMinor: U(750.5) - 1n } });
  await pass(below, FIRST.getTime());
  const [run] = await runs(below);
  assert.equal(run.status, 'waiting_approval', 'handed back when the run starts, so the owners are not promised a payment that cannot happen');
  assert.equal(run.reasonCode, 'over_payment_limit');
  assert.equal(run.startsAt, null);
  assert.ok(!below.kinds().includes('running'), 'no “starting” notice for a run that was handed back');
  assert.equal(below.spent(), 0);
});

test('the monthly cap equal to the run pays; one micro below is handed back at the start', async () => {
  const total = U(500) + U(750.5) + feeFor(U(500)) + feeFor(U(750.5));
  const equal = await ready({ allowance: { cap: { period: 'month', limitMinor: total } } });
  await pass(equal, FIRST.getTime());
  await pass(equal, START);
  assert.equal((await runs(equal))[0].status, 'paid');

  const below = await ready({ allowance: { cap: { period: 'month', limitMinor: total - 1n } } });
  await pass(below, FIRST.getTime());
  assert.equal((await runs(below))[0].reasonCode, 'over_window');
  assert.equal(below.spent(), 0);
});

test('the scheduled payer going away inside the window hands the run back', async () => {
  const t = await ready();
  await pass(t, FIRST.getTime());
  t.state.payer = { ok: false, code: 'no_key', reason: 'No key.' };
  await pass(t, START);
  await handedBack(t, 'payer_unavailable');
});

// ─── Once ──────────────────────────────────────────────────────────────────

test('running the cron twice, or twice at once, at the start and at the end tells once and pays once', async () => {
  const t = await ready();
  await t.clock(at(FIRST.getTime()));
  const both = await Promise.all([runScheduledPayments(runner(t)), runScheduledPayments(runner(t))]);
  assert.ok(both.every((r) => r.errors.length === 0));
  await runScheduledPayments(runner(t));
  assert.equal(t.kinds().filter((k) => k === 'running').length, 1, 'one “starting” notice');
  assert.equal(t.spent(), 0);
  await t.clock(at(START));
  const ends = await Promise.all([runScheduledPayments(runner(t)), runScheduledPayments(runner(t))]);
  assert.ok(ends.every((r) => r.errors.length === 0));
  await runScheduledPayments(runner(t));
  assert.equal(t.spent(), 2, 'two payments, once each');
  assert.equal(t.signed.length, 2);
  assert.equal((await runs(t)).length, 1, 'one run for the schedule and the date');
  assert.equal((await listRunPayments(t.w.db, 'acme', (await runs(t))[0].id)).length, 2);
  assert.equal(t.kinds().filter((k) => k === 'paid').length, 1);
});

// ─── The clock ─────────────────────────────────────────────────────────────

test('a run not started within a day of its time lapses, window or not, and nothing is paid', async () => {
  const t = await ready();
  await pass(t, FIRST.getTime());
  await pass(t, FIRST.getTime() + 24 * HOUR + 1);
  const [run] = await runs(t);
  assert.equal(run.status, 'lapsed');
  assert.equal(t.spent(), 0);
  assert.equal(t.signed.length, 0);

  const late = await ready();
  await pass(late, FIRST.getTime() + 23 * HOUR + 55 * MIN);
  const [opened] = await runs(late);
  assert.equal(opened.status, 'scheduled', 'opened late, still inside the day');
  assert.equal(opened.startsAt.getTime(), FIRST.getTime() + 23 * HOUR + 65 * MIN, 'its window is counted from when the notice went out');
  await pass(late, FIRST.getTime() + 24 * HOUR + 5 * MIN);
  assert.equal((await runs(late))[0].status, 'lapsed', 'the window ended after the run could no longer be started on time: it is not paid late');
  assert.equal(late.spent(), 0);
});

test('a run before its time opens no window', async () => {
  const t = await ready();
  await pass(t, FIRST.getTime() - 1);
  const [run] = await runs(t);
  assert.equal(run.startsAt, null);
  assert.ok(!t.kinds().includes('running'));
  assert.equal(t.spent(), 0);
});

test('moving the time later inside the same day closes the window: the new time gets its own, and nothing is paid at the old one', async () => {
  const t = await ready();
  await pass(t, FIRST.getTime());
  await t.clock(at(FIRST.getTime() + 2 * MIN));
  ok(await S.editSchedule(t.sdeps(), OWNER_ACTOR, t.schedule.id, { firstDueAt: new Date(FIRST.getTime() + 2 * HOUR).toISOString() }));
  const [moved] = await runs(t);
  assert.equal(moved.startsAt, null, 'the old window is gone');
  assert.equal(moved.noticeRunningAt, null, 'and so is its notice, so the new time is announced');
  await pass(t, START);
  assert.equal(t.spent(), 0, 'not paid at the time it was moved away from');
  await pass(t, FIRST.getTime() + 2 * HOUR);
  const [again] = await runs(t);
  assert.equal(again.startsAt.getTime(), FIRST.getTime() + 2 * HOUR + 10 * MIN);
  assert.equal(t.kinds().filter((k) => k === 'running').length, 2);
  assert.equal(t.spent(), 0);
  await pass(t, FIRST.getTime() + 2 * HOUR + 10 * MIN);
  assert.equal(t.spent(), 2);
});

// ─── Production, and the words ─────────────────────────────────────────────

test('production: a sandbox payer opens no window and pays nothing; the run is handed back, with nothing sent to any network', async () => {
  const t = await ready();
  t.state.payer = { ok: true, payer: { kind: 'sandbox', address: t.payer.address, sign: async () => 'sandbox-signature-not-valid-on-any-network' } };
  let executed = 0;
  const chain = t.w.signing.chain;
  const real = chain.execute;
  chain.execute = async (...args) => {
    executed += 1;
    return real(...args);
  };
  const prod = { env: { NODE_ENV: 'production' }, depsFor: async () => t.sdeps('acme', { env: { NODE_ENV: 'production' } }) };
  await t.clock(at(FIRST.getTime()));
  const out = await runScheduledPayments(runner(t, prod));
  await t.clock(at(START));
  await runScheduledPayments(runner(t, prod));
  chain.execute = real;
  assert.deepEqual(out.errors, []);
  const [run] = await runs(t);
  assert.equal(run.startsAt, null, 'no window was announced for a payment that cannot happen');
  assert.ok(!t.kinds().includes('running'));
  assert.ok(['waiting_approval', 'failed'].includes(run.status), 'handed back to people; never paid');
  assert.match(run.reason, /not switched on for your business/);
  assert.equal(run.fallback, true);
  assert.equal(executed, 0);
  assert.equal(t.spent(), 0);
  const payments = await listRunPayments(t.w.db, 'acme', run.id);
  assert.ok(!payments.some((p) => p.status === 'paid' || String(p.digest ?? '').startsWith('sandbox:')), 'no sandbox result anywhere');
});

test('in development the sandbox payer works a run through its window and signs nothing on any network', async () => {
  const t = await ready();
  t.state.payer = { ok: true, payer: { kind: 'sandbox', address: t.payer.address, sign: async () => 'sandbox-signature-not-valid-on-any-network' } };
  await pass(t, FIRST.getTime());
  assert.equal(t.spent(), 0);
  await pass(t, START);
  const [run] = await runs(t);
  assert.equal(run.status, 'paid');
  assert.ok((await listRunPayments(t.w.db, 'acme', run.id)).every((p) => p.digest.startsWith('sandbox:')));
});

test('the Scheduled tab and History carry the start of the window while it is open', async () => {
  const t = await ready();
  await pass(t, FIRST.getTime());
  const view = (await S.listRunViews(t.sdeps()))[0];
  assert.equal(view.startsAt, new Date(START).toISOString());
  const listed = (await S.listScheduleViews(t.sdeps(), OWNER_ACTOR))[0].runs[0];
  assert.equal(listed.startsAt, view.startsAt);
  const entry = buildHistory({ transfers: [], batches: [], withdrawals: [], earlier: [], scheduled: [view] })[0];
  assert.equal(entry.startsAt, view.startsAt);
  assert.equal(entry.group, 'in_progress');
  await pass(t, START);
  const done = (await S.listRunViews(t.sdeps()))[0];
  assert.equal(done.status, 'paid');
  const doneEntry = buildHistory({ transfers: [], batches: [], withdrawals: [], earlier: [], scheduled: [done] })[0];
  assert.equal(doneEntry.startsAt, null, 'a finished run no longer says it starts');
  const plain = buildHistory({ transfers: [], batches: [], withdrawals: [], earlier: [], scheduled: [{ ...done, startsAt: undefined, status: 'waiting_approval' }] })[0];
  assert.equal(plain.startsAt, null, 'a row from before the window existed reads as it did');
});
