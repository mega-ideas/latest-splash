/**
 * v2 Phase 3, scheduled batches: the warning window protects the owners only if
 * the "starting" notice reaches them. An independent review proved two ways it
 * did not:
 *
 *   A  the mail provider is down (or no owner has an address, or WhatsApp is
 *      off): the notice was marked sent before it was tried, nothing noticed it
 *      had not gone, and the run was paid at the window's end all the same.
 *   B  the runner stopped after the window was opened and before the notice was
 *      recorded; the next pass came after the window's end and paid, with no
 *      notice ever sent.
 *
 * The window now fails closed. A notice that reached no owner is not recorded as
 * sent, and the window it belonged to is closed, so the next pass opens a fresh
 * one with the full warning. A window that ended with no recorded notice never
 * pays: the run is handed back to "ask me first". If nobody can be told for a
 * day, the run lapses unpaid like any run Splash could not start in time.
 *
 * ownersNotifier says how many owners it reached; the runner trusts that number.
 * Nothing reaches a network.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import * as S from '../lib/server/scheduled-payments.ts';
import { ownersNotifier } from '../lib/server/owners-notifier.ts';
import { runScheduledPayments } from '../lib/server/scheduled-runner.ts';
import { listRunPayments, listRuns, openGraceWindow } from '../lib/server/scheduled-store.ts';
import { DAY, OWNER_ACTOR, sched, scheduleWorld, t0 } from './fixtures/schedule-world.mjs';

const HOUR = 3_600_000;
const MIN = 60_000;
const FIRST = new Date(Number(t0) + 2 * Number(DAY));
const at = (ms) => new Date(ms);
const runner = (t, over = {}) => ({ db: t.w.db, now: () => t.w.signing.now(), depsFor: async (orgId) => (orgId === 'acme' ? t.sdeps() : null), env: { NODE_ENV: 'test' }, ...over });
const runs = (t) => listRuns(t.w.db, 'acme');

async function ready({ grace } = {}) {
  const t = await scheduleWorld();
  await t.allowance();
  await t.payBefore(t.ids.a, 1);
  await t.payBefore(t.ids.b, 1);
  const made = await S.createSchedule(t.sdeps(), OWNER_ACTOR, sched(t.ids, { mode: 'auto', firstDueAt: FIRST.toISOString() }));
  assert.equal(made.ok, true, JSON.stringify(made));
  t.schedule = made.schedule;
  if (grace !== undefined) assert.equal((await S.setGraceWindow(t.sdeps(), OWNER_ACTOR, grace)).ok, true);
  return t;
}

const pass = async (t, when) => {
  await t.clock(at(when));
  return runScheduledPayments(runner(t));
};

// ─── A: the notice does not go out ─────────────────────────────────────────

for (const failure of ['throw', 'nobody']) {
  test(`${failure === 'throw' ? 'the mail provider is down' : 'no owner can be reached'}: no payment is made without a delivered notice, and the window starts over once one can be sent`, async () => {
    const t = await ready();
    t.state.notify = failure;
    await pass(t, FIRST.getTime() - 20 * HOUR);
    t.state.notify = failure;
    const opened = await pass(t, FIRST.getTime());
    assert.deepEqual(opened.errors, []);
    const [run] = await runs(t);
    assert.equal(run.status, 'scheduled');
    assert.equal(run.noticeRunningAt, null, 'a notice that reached no one is not recorded as sent');
    assert.equal(run.startsAt, null, 'and the window it belonged to is closed, so no one is paid on the strength of it');
    assert.equal(t.undelivered.filter((n) => n.kind === 'running').length, 1, 'it was tried');

    // The old window would have ended here. Nothing is paid.
    await pass(t, FIRST.getTime() + 10 * MIN);
    await pass(t, FIRST.getTime() + 11 * MIN);
    assert.equal(t.spent(), 0, 'nothing is paid while no owner can be told');
    assert.equal(t.signed.length, 0);
    assert.equal((await runs(t))[0].status, 'scheduled');

    // The provider comes back: a fresh window opens with the full warning.
    t.state.notify = 'ok';
    const back = FIRST.getTime() + 30 * MIN;
    await pass(t, back);
    const [fresh] = await runs(t);
    assert.equal(fresh.startsAt.getTime(), back + 10 * MIN, 'a full window, counted from the notice that did reach someone');
    assert.ok(fresh.noticeRunningAt, 'recorded as sent once an owner was told');
    const running = t.notices.find((n) => n.kind === 'running');
    assert.equal(running.startsAtMs, back + 10 * MIN);
    await pass(t, back + 10 * MIN - 1);
    assert.equal(t.spent(), 0, 'one millisecond before the end of the new window');
    await pass(t, back + 10 * MIN);
    assert.equal((await runs(t))[0].status, 'paid');
    assert.equal(t.spent(), 2);
  });
}

test('nobody can be told for a whole day: the run lapses and nothing is paid', async () => {
  const t = await ready();
  t.state.notify = 'nobody';
  for (let h = 0; h <= 25; h += 1) await pass(t, FIRST.getTime() + h * HOUR);
  const [run] = await runs(t);
  assert.equal(run.status, 'lapsed');
  assert.equal(t.spent(), 0);
  assert.equal(t.signed.length, 0);
});

test('a window of 0 is the owner choosing no warning at all: it pays at the due time, told or not', async () => {
  const t = await ready({ grace: 0 });
  t.state.notify = 'nobody';
  await pass(t, FIRST.getTime());
  assert.equal((await runs(t))[0].status, 'paid', 'no window was promised, so none is missing');
});

// ─── B: the runner stopped between opening the window and recording the notice ─

async function openedButNeverAnnounced(t) {
  await pass(t, FIRST.getTime() - 20 * HOUR);
  const [run] = await runs(t);
  const opened = await openGraceWindow(t.w.db, 'acme', run.id, { startsAt: at(FIRST.getTime() + 10 * MIN), windowVersion: t.schedule.version, now: at(FIRST.getTime()) });
  assert.ok(opened, 'the window was opened');
  assert.equal(opened.noticeRunningAt, null, 'and the runner stopped before the notice was recorded');
  return run;
}

test('the next pass comes after the window ended with no notice recorded: the run is handed back, not paid', async () => {
  const t = await ready();
  const run = await openedButNeverAnnounced(t);
  const out = await pass(t, FIRST.getTime() + 11 * MIN);
  assert.deepEqual(out.errors, []);
  const [after] = await runs(t);
  assert.equal(after.id, run.id);
  assert.equal(after.status, 'waiting_approval');
  assert.equal(after.reasonCode, 'window_not_announced');
  assert.equal(after.fallback, true);
  assert.match(after.reason, /warning/i);
  assert.equal(t.spent(), 0);
  assert.equal(t.signed.length, 0);
  assert.ok(t.notices.some((n) => n.kind === 'approval_ready' && n.reason === after.reason), 'the owners are told why');
});

test('a pass inside such a window opens a fresh one with the full warning instead of paying at the old end', async () => {
  const t = await ready();
  await openedButNeverAnnounced(t);
  const now = FIRST.getTime() + 3 * MIN;
  await pass(t, now);
  const [run] = await runs(t);
  assert.equal(run.status, 'scheduled');
  assert.equal(run.startsAt.getTime(), now + 10 * MIN, 'a full window from the notice that went out');
  assert.ok(run.noticeRunningAt);
  assert.equal(t.notices.filter((n) => n.kind === 'running').length, 1);
  await pass(t, FIRST.getTime() + 10 * MIN);
  assert.equal(t.spent(), 0, 'not paid at the end of the window nobody was told about');
  await pass(t, now + 10 * MIN);
  assert.equal((await runs(t))[0].status, 'paid');
});

test('two passes at once inside such a window send one notice and open one window', async () => {
  const t = await ready();
  await openedButNeverAnnounced(t);
  await t.clock(at(FIRST.getTime() + 3 * MIN));
  const both = await Promise.all([runScheduledPayments(runner(t)), runScheduledPayments(runner(t))]);
  assert.ok(both.every((r) => r.errors.length === 0));
  assert.equal(t.notices.filter((n) => n.kind === 'running').length, 1);
  assert.equal(t.spent(), 0);
  assert.equal((await listRunPayments(t.w.db, 'acme', (await runs(t))[0].id)).length, 0);
});

// ─── The number the runner trusts ──────────────────────────────────────────

const OWNERS_ENV = { NODE_ENV: 'test', EMAIL_TRANSPORT: 'resend', EMAIL_API_KEY: 'test-key', EMAIL_FROM: 'Splash <noreply@example.test>', NEXT_PUBLIC_APP_URL: 'https://app.example.test' };
const notice = {
  kind: 'running',
  orgId: 'acme',
  businessName: 'Acme',
  scheduleId: 's1',
  scheduleName: 'Monthly suppliers',
  runId: 'r1',
  mode: 'auto',
  dueAtMs: 1,
  totalMinor: '1000000',
  feeMinor: '0',
  itemCount: 1,
  reason: null,
  by: null,
  path: '/dashboard/transfer?tab=scheduled',
  startsAtMs: 2,
  graceMinutes: 10,
};

async function withFetch(answer, fn) {
  const real = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, init) => {
    sent.push(JSON.parse(String(init?.body ?? '{}')).to?.[0]);
    return answer(url);
  };
  try {
    return await fn(sent);
  } finally {
    globalThis.fetch = real;
  }
}

test('ownersNotifier says how many owners it reached: those whose message was accepted', async () => {
  const t = await scheduleWorld();
  const notify = ownersNotifier(t.w.db, 'acme', OWNERS_ENV);
  await withFetch(
    () => new Response(JSON.stringify({ id: 'msg_1' }), { status: 200 }),
    async (sent) => {
      const reached = await notify(notice);
      assert.ok(sent.length >= 1, 'it sent to the owners');
      assert.equal(reached, sent.length);
    },
  );
  await withFetch(
    () => new Response('{}', { status: 500 }),
    async () => {
      assert.equal(await notify(notice), 0, 'the provider refusing every message reaches no one');
    },
  );
});

test('ownersNotifier reaches no one, and does not throw, when the mail transport is not set up in production', async () => {
  const t = await scheduleWorld();
  const notify = ownersNotifier(t.w.db, 'acme', { NODE_ENV: 'production' });
  assert.equal(await notify(notice), 0);
});
