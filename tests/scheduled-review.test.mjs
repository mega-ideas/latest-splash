/**
 * v2 Phase 3, scheduled batches: what the independent review found, each
 * reproduced here first.
 *
 *   a run's time     moving a schedule's time inside the same UTC day moves the
 *                    run already made for it, later or earlier; the day-before
 *                    notice is sent again for the new time
 *   resume           a stopped schedule that is started again before its next
 *                    time still runs that time; a time the owner skipped does not
 *   automatic        an owner switching an "ask me first" schedule to automatic
 *                    takes it as their own, and confirms its payments; no raw
 *                    database error ever reaches a caller
 *   daily limit      a raised limit applies only once the owners sign; two
 *                    runners working different schedules of one business cannot
 *                    both pass a limit that fits only one
 *   skip and pay     a Skip and the first payment's claim cannot both succeed
 *   cron             the answer carries no raw error text
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { eq } from 'drizzle-orm';

import * as schema from '../lib/db/schema.ts';
import { publicRunnerResult, runScheduledPayments } from '../lib/server/scheduled-runner.ts';
import * as S from '../lib/server/scheduled-payments.ts';
import { claimPayment, getSettings, insertRunPayments, listRunPayments, listRuns, saveSettings } from '../lib/server/scheduled-store.ts';
import { signBy } from './fixtures/staff-rule-world.mjs';
import { DAY, FINANCE_LEAD, OWNER_ACTOR, U, sched, scheduleWorld, t0 } from './fixtures/schedule-world.mjs';

const HOUR = 3_600_000;
const FIRST = new Date(Number(t0) + 2 * Number(DAY));
const at = (ms) => new Date(ms);
const runner = (t, over = {}) => ({ db: t.w.db, now: () => t.w.signing.now(), depsFor: async (orgId) => (orgId === 'acme' ? t.sdeps() : null), env: { NODE_ENV: 'test' }, ...over });
const runs = (t) => listRuns(t.w.db, 'acme');
const batches = (t) => t.w.db.select().from(schema.walletBatches).where(eq(schema.walletBatches.orgId, 'acme'));
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

async function askSchedule(over = {}) {
  const t = await scheduleWorld();
  const made = ok(await S.createSchedule(t.sdeps(), OWNER_ACTOR, sched(t.ids, { cadence: 'once', firstDueAt: FIRST.toISOString(), ...over })));
  t.schedule = made.schedule;
  return t;
}

// ─── The time of a run made for an old time ────────────────────────────────

test('moving the time later inside the same UTC day moves the run already made: it does not start at the old time', async () => {
  const t = await askSchedule();
  await t.clock(at(FIRST.getTime() - 20 * HOUR));
  await runScheduledPayments(runner(t));
  assert.equal((await runs(t))[0].dueAt.getTime(), FIRST.getTime());

  const later = at(FIRST.getTime() + 2 * HOUR); // 10:00 the same day
  ok(await S.editSchedule(t.sdeps(), OWNER_ACTOR, t.schedule.id, { firstDueAt: later.toISOString() }));
  const [moved] = await runs(t);
  assert.equal(moved.status, 'scheduled');
  assert.equal(moved.dueAt.getTime(), later.getTime(), 'the run now falls due at the new time');

  await t.clock(at(FIRST.getTime() + 5 * 60_000));
  const early = await runScheduledPayments(runner(t));
  assert.equal(early.started, 0, 'nothing starts at the time the owner moved it away from');
  assert.equal((await runs(t))[0].status, 'scheduled');
  assert.equal((await batches(t)).length, 0);

  await t.clock(at(later.getTime() + 60_000));
  const due = await runScheduledPayments(runner(t));
  assert.equal(due.started, 1);
  assert.equal((await runs(t))[0].status, 'waiting_approval');
});

test('moving the time earlier inside the same UTC day makes the run start at the new, earlier time', async () => {
  const t = await askSchedule();
  await t.clock(at(FIRST.getTime() - 20 * HOUR));
  await runScheduledPayments(runner(t));
  const earlier = at(FIRST.getTime() - 2 * HOUR); // 06:00 the same day
  ok(await S.editSchedule(t.sdeps(), OWNER_ACTOR, t.schedule.id, { firstDueAt: earlier.toISOString() }));
  assert.equal((await runs(t))[0].dueAt.getTime(), earlier.getTime());
  await t.clock(at(earlier.getTime() + 5 * 60_000));
  const result = await runScheduledPayments(runner(t));
  assert.equal(result.started, 1);
  assert.equal((await runs(t))[0].status, 'waiting_approval');
});

test('an automatic run moved to a new time says so again: the day-before notice is stamped against the new time', async () => {
  const t = await scheduleWorld();
  ok(await S.createSchedule(t.sdeps(), OWNER_ACTOR, sched(t.ids, { mode: 'auto', cadence: 'once', firstDueAt: FIRST.toISOString() })));
  const id = (await S.listScheduleViews(t.sdeps(), OWNER_ACTOR))[0].id;
  await t.clock(at(FIRST.getTime() - 20 * HOUR));
  await runScheduledPayments(runner(t));
  assert.equal(t.notices.at(-1).dueAtMs, FIRST.getTime());
  const later = at(FIRST.getTime() + 2 * HOUR);
  ok(await S.editSchedule(t.sdeps(), OWNER_ACTOR, id, { firstDueAt: later.toISOString() }));
  await runScheduledPayments(runner(t));
  const days = t.notices.filter((n) => n.kind === 'day_before');
  assert.equal(days.length, 2, 'told once for each time');
  assert.equal(days[1].dueAtMs, later.getTime());
  assert.equal((await runs(t)).length, 1, 'still one run for the day');
});

test('moving the time to another day still takes back the run made for the old day', async () => {
  const t = await askSchedule();
  await t.clock(at(FIRST.getTime() - 20 * HOUR));
  await runScheduledPayments(runner(t));
  const nextWeek = at(FIRST.getTime() + 7 * 24 * HOUR);
  ok(await S.editSchedule(t.sdeps(), OWNER_ACTOR, t.schedule.id, { firstDueAt: nextWeek.toISOString() }));
  const [old] = await runs(t);
  assert.equal(old.status, 'skipped');
  assert.match(old.reason, /Nothing was paid/);
});

// ─── Resume ────────────────────────────────────────────────────────────────

test('a schedule stopped and started again before its next time still runs that time', async () => {
  const t = await askSchedule({ cadence: 'weekly' });
  await t.clock(at(FIRST.getTime() - 20 * HOUR));
  await runScheduledPayments(runner(t));
  ok(await S.stopSchedule(t.sdeps(), OWNER_ACTOR, t.schedule.id));
  assert.equal((await runs(t))[0].status, 'skipped');
  const resumed = ok(await S.resumeSchedule(t.sdeps(), OWNER_ACTOR, t.schedule.id));
  assert.equal(resumed.schedule.nextDueAt, FIRST.toISOString(), 'the next time is the one it was stopped before');
  assert.equal((await runs(t))[0].status, 'scheduled', 'the occurrence is open again');
  await t.clock(FIRST);
  await runScheduledPayments(runner(t));
  assert.equal((await runs(t))[0].status, 'waiting_approval', 'and it runs');
});

test('a run an owner skipped on purpose stays skipped when the schedule is stopped and started again, and the screen says the next time is the one after', async () => {
  const t = await askSchedule({ cadence: 'weekly' });
  await t.clock(at(FIRST.getTime() - 20 * HOUR));
  const skipped = ok(await S.skipRun(t.sdeps(), OWNER_ACTOR, t.schedule.id));
  assert.equal(skipped.run.status, 'skipped');
  ok(await S.stopSchedule(t.sdeps(), OWNER_ACTOR, t.schedule.id));
  const resumed = ok(await S.resumeSchedule(t.sdeps(), OWNER_ACTOR, t.schedule.id));
  assert.equal(Date.parse(resumed.schedule.nextDueAt), FIRST.getTime() + 7 * 24 * HOUR);
  const view = (await runs(t)).find((r) => r.id === skipped.run.id);
  assert.equal(view.status, 'skipped');
});

test('a once schedule cannot be moved onto a day that already has its run finished or skipped: it says so', async () => {
  const t = await askSchedule();
  ok(await S.skipRun(t.sdeps(), OWNER_ACTOR, t.schedule.id));
  refused(await S.editSchedule(t.sdeps(), OWNER_ACTOR, t.schedule.id, { firstDueAt: at(FIRST.getTime() + 2 * HOUR).toISOString() }), 409, 'already_ran_that_day');
});

// ─── Automatic ─────────────────────────────────────────────────────────────

test('an owner switches a Finance lead’s “ask me first” schedule to automatic: it becomes the owner’s, after the owner confirms its payments', async () => {
  const t = await scheduleWorld();
  const made = ok(await S.createSchedule(t.sdeps(), FINANCE_LEAD, sched(t.ids, { clientKey: 'lead_ask_9000001' })));
  assert.equal(made.schedule.createdAs, 'finance_lead');
  const id = made.schedule.id;
  // The mode alone is not enough: the owner has not been shown or confirmed the payments.
  refused(await S.editSchedule(t.sdeps(), OWNER_ACTOR, id, { mode: 'auto' }), 400, 'confirm_payments');
  const items = [
    { recipientId: t.ids.a, amount: '500', reference: 'INV-1' },
    { recipientId: t.ids.b, amount: '750.50', reference: 'INV-2' },
  ];
  const switched = ok(await S.editSchedule(t.sdeps(), OWNER_ACTOR, id, { mode: 'auto', items }));
  assert.equal(switched.schedule.mode, 'auto');
  assert.equal(switched.schedule.createdAs, 'owner');
  assert.equal(switched.schedule.createdBy, OWNER_ACTOR.userId);
  // …and the Finance lead can no longer touch it.
  refused(await S.editSchedule(t.sdeps(), FINANCE_LEAD, id, { name: 'No' }), 403, 'owner_only');
});

test('payments a Finance lead changed are confirmed by the owner before the schedule pays automatically', async () => {
  const t = await scheduleWorld();
  const id = ok(await S.createSchedule(t.sdeps(), OWNER_ACTOR, sched(t.ids))).schedule.id;
  ok(await S.editSchedule(t.sdeps(), FINANCE_LEAD, id, { items: [{ recipientId: t.ids.c, amount: '900', reference: 'LEAD' }] }));
  refused(await S.editSchedule(t.sdeps(), OWNER_ACTOR, id, { mode: 'auto' }), 400, 'confirm_payments');
  const seen = [{ recipientId: t.ids.c, amount: '900', reference: 'LEAD' }];
  assert.equal(ok(await S.editSchedule(t.sdeps(), OWNER_ACTOR, id, { mode: 'auto', items: seen })).schedule.mode, 'auto');
});

test('an owner editing the payments of any schedule takes it as theirs', async () => {
  const t = await scheduleWorld();
  const made = ok(await S.createSchedule(t.sdeps(), FINANCE_LEAD, sched(t.ids, { clientKey: 'lead_ask_9000002' })));
  const edited = ok(await S.editSchedule(t.sdeps(), OWNER_ACTOR, made.schedule.id, { items: [{ recipientId: t.ids.a, amount: '10' }] }));
  assert.equal(edited.schedule.createdAs, 'owner');
  assert.equal(edited.schedule.createdBy, OWNER_ACTOR.userId);
});

// ─── The daily limit ───────────────────────────────────────────────────────

test('a raised daily limit applies only once the owners have signed; until then the old one holds, and a refused request leaves it alone', async () => {
  const t = await scheduleWorld();
  // Splash has raised this business's daily limit (Settings, Limits; tests/business-limits.test.mjs), so the owners may ask for more than the standard 5,000 a day.
  await t.w.db.insert(schema.businessLimits).values({ orgId: 'acme', kind: 'daily', value: U(12_000), heldMax: U(12_000), source: 'raised', changedBy: 'system:limits' });
  const form = (daily) => ({ perPaymentUsdc: '1000', dailyUsdc: daily, monthlyUsdc: '20000', expiresInDays: 60 });
  const before = await S.automaticStatus(t.sdeps());
  assert.equal(before.dailyCapMinor, U(5_000).toString());

  const raise = ok(await S.requestAllowance(t.sdeps(), OWNER_ACTOR, await t.confirmed(form('9000'))));
  const waiting = await S.automaticStatus(t.sdeps());
  assert.equal(waiting.dailyCapMinor, U(5_000).toString(), 'one owner’s call did not raise the limit');
  assert.equal(waiting.pendingDailyCapMinor, U(9_000).toString(), 'it is shown as waiting for the owners');
  assert.equal((await getSettings(t.w.db, 'acme'))?.dailyCapMinor ?? null, null, 'nothing was written as the limit');

  assert.equal((await signBy(t.w, raise.request, ['two', 'three'])).status, 'executed');
  const signed = await S.automaticStatus(t.sdeps());
  assert.equal(signed.dailyCapMinor, U(9_000).toString());
  assert.equal(signed.pendingDailyCapMinor, null);

  // A request that is cancelled before it is signed leaves the limit where it was.
  const second = ok(await S.requestAllowance(t.sdeps(), OWNER_ACTOR, await t.confirmed(form('12000'))));
  assert.equal((await S.automaticStatus(t.sdeps())).dailyCapMinor, U(9_000).toString());
  const { cancelSigningRequest } = await import('../lib/server/wallet-signing.ts');
  const cancelled = await cancelSigningRequest(t.w.signing, { orgId: 'acme', userId: OWNER_ACTOR.userId, id: second.request.id });
  assert.equal(cancelled.ok, true);
  const after = await S.automaticStatus(t.sdeps());
  assert.equal(after.dailyCapMinor, U(9_000).toString());
  assert.equal(after.pendingDailyCapMinor, null, 'a closed request is not pending any more');
});

test('two runners working different schedules of one business cannot both pass a daily limit that fits only one', async () => {
  const t = await scheduleWorld();
  await t.allowance({ cap: { period: 'month', limitMinor: U(50_000) } });
  await t.payBefore(t.ids.a, 1);
  await t.payBefore(t.ids.b, 1);
  // No warning window here: the race is between two runs of one business reaching the same lock together.
  await saveSettings(t.w.db, 'acme', { dailyCapMinor: U(1_500), graceMinutes: 0 }, new Date());
  const one = ok(await S.createSchedule(t.sdeps(), OWNER_ACTOR, sched(t.ids, { clientKey: 'cap_one_0000001', name: 'One', mode: 'auto', cadence: 'once', firstDueAt: FIRST.toISOString(), items: [{ recipientId: t.ids.a, amount: '900' }] })));
  const two = ok(await S.createSchedule(t.sdeps(), OWNER_ACTOR, sched(t.ids, { clientKey: 'cap_two_0000001', name: 'Two', mode: 'auto', cadence: 'once', firstDueAt: FIRST.toISOString(), items: [{ recipientId: t.ids.b, amount: '900' }] })));
  await t.clock(at(FIRST.getTime() - 20 * HOUR));
  await runScheduledPayments(runner(t));
  assert.equal((await runs(t)).length, 2);
  await t.clock(FIRST);
  const both = await Promise.all([runScheduledPayments(runner(t)), runScheduledPayments(runner(t))]);
  assert.ok(both.every((r) => r.errors.length === 0), JSON.stringify(both.map((r) => r.errors)));
  const all = await runs(t);
  const paid = all.filter((r) => r.status === 'paid');
  const back = all.filter((r) => r.status === 'waiting_approval');
  assert.equal(paid.length, 1, 'one fits the limit and is paid');
  assert.equal(back.length, 1, 'the other is handed back to the owners');
  assert.equal(back[0].reasonCode, 'daily_cap');
  assert.equal(t.spent(), 1, 'one payment went out, not two');
  assert.ok([one.schedule.id, two.schedule.id].includes(paid[0].scheduleId));
});

// ─── Skip and the first payment's claim ────────────────────────────────────

test('a Skip and the first payment’s claim never both succeed', async () => {
  const t = await scheduleWorld();
  const schedule = ok(await S.createSchedule(t.sdeps(), OWNER_ACTOR, sched(t.ids, { mode: 'auto', cadence: 'weekly', firstDueAt: FIRST.toISOString() }))).schedule;
  const now = new Date(t.w.signing.now());
  for (let n = 0; n < 8; n += 1) {
    const runId = `psr_race_${n}`;
    const dueDate = `2027-0${(n % 8) + 1}-15`;
    await t.w.db.insert(schema.paymentScheduleRuns).values({ id: runId, scheduleId: schedule.id, orgId: 'acme', dueDate, dueAt: at(Date.parse(`${dueDate}T08:00:00Z`)), mode: 'auto', ranAs: 'auto', status: 'approved', createdAt: now, updatedAt: now });
    await insertRunPayments(t.w.db, [{ id: `psp_race_${n}`, runId, orgId: 'acme', position: 1, paymentRef: String(n).repeat(64).slice(0, 64).replace(/[^0-9a-f]/g, '1'), recipientId: t.ids.a, businessId: null, payeeName: 'Race', address: `0x${'71'.repeat(32)}`, amountMinor: U(5), maxFeeMinor: 0n, feeKind: 1, reference: null, status: 'pending', createdAt: now, updatedAt: now }]);
  }
  const outcomes = await Promise.all(
    Array.from({ length: 8 }, async (_, n) => {
      const [skip, claim] = await Promise.all([S.skipRun(t.sdeps(), OWNER_ACTOR, schedule.id, { runId: `psr_race_${n}` }), claimPayment(t.w.db, 'acme', `psp_race_${n}`, { digest: `digest${n}`, gasBudgetMist: 1n, now })]);
      return { n, skipped: skip.ok === true, claimed: claim !== null };
    }),
  );
  for (const o of outcomes) assert.ok(!(o.skipped && o.claimed), `run ${o.n} was skipped and also had a payment claimed`);
  const final = await runs(t);
  for (const o of outcomes) {
    const run = final.find((r) => r.id === `psr_race_${o.n}`);
    const [p] = await listRunPayments(t.w.db, 'acme', run.id);
    if (run.status === 'skipped') assert.equal(p.status, 'pending', 'a skipped run has no payment going out');
    else assert.equal(p.status, 'submitting');
  }
});

// ─── The cron answer ───────────────────────────────────────────────────────

test('the cron answer names what could not be worked on, never the error text', () => {
  const answer = publicRunnerResult({ ok: true, schedules: 2, runsMade: 1, started: 1, followed: 0, notices: 0, deferred: false, errors: [{ orgId: 'acme', id: 'psr_1', error: 'insert into "payment_schedule_runs" (...) values ($1, $2) failed: duplicate key' }] });
  assert.deepEqual(answer.errors, [{ orgId: 'acme', id: 'psr_1' }]);
  assert.ok(!JSON.stringify(answer).includes('insert into'));
  assert.equal(answer.schedules, 2);
});
