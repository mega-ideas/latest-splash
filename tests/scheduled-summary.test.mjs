/**
 * v2 Phase 3, scheduled batches: the plain-words summary an owner reads before
 * the owners sign the allowance that lets a schedule pay automatically.
 *
 * "Splash will pay these 4 payments, up to 2,000 USDC each, from 12 Nov until
 * 10 Feb. Nothing is paid without your limits. You can stop this anytime."
 *
 * The test that matters: the figures on the screen are the figures in the
 * request. The summary is built from the SAME rule the signing request is made
 * from, and after the owners sign, the network holds exactly those numbers.
 * PGlite with the staff-rule world's model chain; nothing reaches a network.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import * as S from '../lib/server/scheduled-payments.ts';
import { automaticSummary, paymentsOfSchedules } from '../lib/schedule/summary.ts';
import { parseAllowanceInput } from '../lib/schedule/rules.ts';
import { signBy } from './fixtures/staff-rule-world.mjs';
import { DAY, FINANCE_LEAD, OWNER_ACTOR, U, sched, scheduleWorld, t0 } from './fixtures/schedule-world.mjs';

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

async function withAutoSchedule(over = {}) {
  const t = await scheduleWorld();
  await t.payBefore(t.ids.a, 1);
  await t.payBefore(t.ids.b, 1);
  const made = ok(await S.createSchedule(t.sdeps(), OWNER_ACTOR, sched(t.ids, { mode: 'auto', firstDueAt: FIRST.toISOString(), ...over })));
  t.schedule = made.schedule;
  return t;
}

const typed = { perPaymentUsdc: '1,500', dailyUsdc: '4000', monthlyUsdc: '16000', expiresInDays: 60 };

test('asking for the allowance answers with the summary, built from the rule that was issued', async () => {
  const t = await withAutoSchedule();
  const asked = ok(await S.requestAllowance(t.sdeps(), OWNER_ACTOR, typed));
  const s = asked.summary;
  assert.ok(s, 'the answer carries the summary');
  assert.equal(s.paymentCount, 2);
  assert.deepEqual(s.payments.map((p) => [p.name, p.amountMinor, p.reference]), [
    ['Dela Cruz Trading Corp', U(500).toString(), 'INV-1'],
    ['Santos Supplies Inc', U(750.5).toString(), 'INV-2'],
  ]);
  assert.equal(s.perPaymentMinor, U(1_500).toString());
  assert.equal(s.dailyMinor, U(4_000).toString());
  assert.equal(s.monthlyMinor, U(16_000).toString());
  assert.equal(s.endsAtMs, Number(t0) + 60 * 86_400_000);
  assert.equal(s.startsAtMs, FIRST.getTime(), 'it starts with the first run');
  assert.equal(s.graceMinutes, 10);
  assert.match(s.headline, /^Splash will pay these 2 payments, up to 1,500 USDC each, from \d+ \w{3} until \d+ \w{3}\. Nothing is paid without your limits\. You can stop this anytime\.$/);
});

test('what the owners sign is what the summary said: after they sign, the network holds the same figures', async () => {
  const t = await withAutoSchedule();
  const asked = ok(await S.requestAllowance(t.sdeps(), OWNER_ACTOR, typed));
  assert.equal((await signBy(t.w, asked.request, ['two', 'three'])).status, 'executed');
  const held = await S.automaticStatus(t.sdeps());
  assert.equal(held.allowance.state, 'active');
  assert.equal(held.allowance.perPaymentMaxMinor, asked.summary.perPaymentMinor, 'the most for one payment');
  assert.equal(held.allowance.spendableNowMinor, asked.summary.monthlyMinor, 'the monthly cap');
  assert.equal(held.allowance.expiresAtMs, String(asked.summary.endsAtMs), 'the end date');
  assert.equal(held.dailyCapMinor, asked.summary.dailyMinor, 'the daily limit Splash holds');
  assert.equal(held.graceMinutes, asked.summary.graceMinutes, 'the window');
});

test('the screen and the server build the same summary from the same typed values', async () => {
  const t = await withAutoSchedule();
  const views = await S.listScheduleViews(t.sdeps(), OWNER_ACTOR);
  const { payments, firstPaymentMs } = paymentsOfSchedules(views);
  const { form, problems } = parseAllowanceInput(typed);
  assert.deepEqual(problems, []);
  const client = automaticSummary({ payments, form, graceMinutes: 10, nowMs: Number(t0), firstPaymentMs });
  const server = ok(await S.requestAllowance(t.sdeps(), OWNER_ACTOR, typed)).summary;
  assert.deepEqual(client, server);
});

test('the payments in the summary are the ones the owner resent when switching to automatic, not the ones it had', async () => {
  const t = await scheduleWorld();
  await t.payBefore(t.ids.a, 1);
  const asking = ok(await S.createSchedule(t.sdeps(), OWNER_ACTOR, sched(t.ids, { firstDueAt: FIRST.toISOString(), items: [{ recipientId: t.ids.a, amount: '10' }] })));
  assert.equal(asking.schedule.mode, 'ask');
  refused(await S.editSchedule(t.sdeps(), OWNER_ACTOR, asking.schedule.id, { mode: 'auto' }), 400, 'confirm_payments');
  ok(await S.editSchedule(t.sdeps(), OWNER_ACTOR, asking.schedule.id, { mode: 'auto', items: [{ recipientId: t.ids.a, amount: '123.45', reference: 'RESENT' }] }));
  const s = ok(await S.requestAllowance(t.sdeps(), OWNER_ACTOR, typed)).summary;
  assert.deepEqual(s.payments.map((p) => [p.amountMinor, p.reference]), [[U(123.45).toString(), 'RESENT']]);
  assert.match(s.headline, /^Splash will pay this payment, up to 1,500 USDC/);
});

test('a schedule that asks first is not in the summary, nor is another business’s', async () => {
  const t = await withAutoSchedule();
  ok(await S.createSchedule(t.sdeps(), OWNER_ACTOR, sched(t.ids, { clientKey: 'sched_key_000002', name: 'Asks first', items: [{ recipientId: t.ids.c, amount: '77' }] })));
  const mine = ok(await S.requestAllowance(t.sdeps(), OWNER_ACTOR, typed)).summary;
  assert.equal(mine.paymentCount, 2, 'only the automatic schedule’s two payments');
  assert.ok(!mine.payments.some((p) => p.amountMinor === U(77).toString()));
  const northOwner = { userId: 'u-north', role: 'OWNER' };
  const theirs = await S.requestAllowance(t.sdeps('northwind'), northOwner, typed);
  if (theirs.ok) assert.equal(theirs.summary.paymentCount, 0, 'northwind sees none of ours');
});

test('with no automatic schedule yet, the summary says so and still shows the limits', async () => {
  const t = await scheduleWorld();
  const s = ok(await S.requestAllowance(t.sdeps(), OWNER_ACTOR, typed)).summary;
  assert.equal(s.paymentCount, 0);
  assert.match(s.headline, /No schedule pays automatically yet/);
  assert.match(s.headline, /up to 1,500 USDC/);
});

test('a request that cannot be made has no summary, and only an owner can make one', async () => {
  const t = await withAutoSchedule();
  const bad = refused(await S.requestAllowance(t.sdeps(), OWNER_ACTOR, { ...typed, perPaymentUsdc: '9000' }), 400, 'bad_allowance');
  assert.equal(bad.summary, undefined);
  refused(await S.requestAllowance(t.sdeps(), FINANCE_LEAD, typed), 403, 'owner_only');
});

test('the window an owner set is the window the summary names', async () => {
  const t = await withAutoSchedule();
  ok(await S.setGraceWindow(t.sdeps(), OWNER_ACTOR, 25));
  const s = ok(await S.requestAllowance(t.sdeps(), OWNER_ACTOR, typed)).summary;
  assert.equal(s.graceMinutes, 25);
  assert.match(s.graceText, /25 minutes/);
});

test('the allowance route sends the summary back with the request', async () => {
  const { readFileSync } = await import('node:fs');
  const route = readFileSync('app/api/wallet/schedules/automatic/allowance/route.ts', 'utf8');
  assert.match(route, /summary: result\.summary/);
  const auto = readFileSync('app/api/wallet/schedules/automatic/route.ts', 'utf8');
  assert.match(auto, /action === 'grace'|'grace'/);
  assert.match(auto, /setGraceWindow/);
});
