/**
 * v2 Phase 3, scheduled batches, Mode B “Pay automatically within my limits”.
 *
 * At the due time, with no one present, Splash pays the batch through
 * splash_spend under an allowance the owners signed to the scheduled payer
 * (a KMS key apart from the gas sponsor's), after re-checking everything. Every
 * path here runs against the staff-rule world's model chain, which applies
 * splash_spend's checks and the allowance's caps to the very bytes the server
 * built, so a payment the rules refuse aborts there too. No key is real and
 * nothing is signed for any network.
 *
 *   pays        every payment, in order, once; the allowance charged the amount
 *               and the fee shown; the operator sponsors the gas and its budget
 *               counts; the owners are told the day before and as it runs, and
 *               get a receipt
 *   hands back  any failed check hands the WHOLE run back to “ask me first”, with
 *               the reason in plain words, and nothing is paid: paused, no
 *               allowance, expired, a new recipient, a payment over the limit,
 *               the window, the daily limit, the approval line, a fee that rose,
 *               a recipient who changed or left the list, a creator who is no
 *               longer an owner, no payer
 *   once        a payment is claimed once; an unknown outcome is read back from
 *               the chain and never sent again; running twice pays once
 *   stops       Skip, Stop, the kill switch and a switch to “ask me first” take
 *               effect at once, even between two payments
 *   production  no sandbox payer can pay; nothing is paid without the key
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { eq } from 'drizzle-orm';

import * as schema from '../lib/db/schema.ts';
import { runScheduledPayments, SUBMIT_GIVE_UP_MS } from '../lib/server/scheduled-runner.ts';
import * as S from '../lib/server/scheduled-payments.ts';
import { claimPayment, getSettings, listRunPayments, listRuns, saveSettings } from '../lib/server/scheduled-store.ts';
import { sponsoredBudgetSince } from '../lib/server/wallet-signing-store.ts';
import { changeRecipients } from '../lib/server/spend-rules.ts';
import { signBy } from './fixtures/staff-rule-world.mjs';
import { DAY, OWNER_ACTOR, PAYER, U, WALLET_C, feeFor, sched, scheduleWorld, t0 } from './fixtures/schedule-world.mjs';

const HOUR = 3_600_000;
const FIRST = new Date(Number(t0) + 2 * Number(DAY));
const at = (ms) => new Date(ms);
const runner = (t, over = {}) => ({ db: t.w.db, now: () => t.w.signing.now(), depsFor: async (orgId) => (orgId === 'acme' ? t.sdeps() : null), env: { NODE_ENV: 'test' }, ...over });
const runs = (t) => listRuns(t.w.db, 'acme');
const batches = (t) => t.w.db.select().from(schema.walletBatches).where(eq(schema.walletBatches.orgId, 'acme'));

/**
 * A business whose owners gave the scheduled payer an allowance, with two
 * recipients it has paid before, and an automatic schedule paying both.
 */
async function ready({ allowance = {}, items, schedule = {}, world = {} } = {}) {
  const t = await scheduleWorld(world);
  await t.allowance(allowance);
  await t.payBefore(t.ids.a, 1);
  await t.payBefore(t.ids.b, 1);
  const made = await S.createSchedule(t.sdeps(), OWNER_ACTOR, sched(t.ids, { mode: 'auto', firstDueAt: FIRST.toISOString(), ...(items ? { items } : {}), ...schedule }));
  assert.equal(made.ok, true, JSON.stringify(made));
  t.schedule = made.schedule;
  return t;
}

const handedBack = async (t, code, textPattern) => {
  const [run] = await runs(t);
  assert.equal(run.status, 'waiting_approval', `${code}: handed back to “ask me first”, ${run.reason}`);
  assert.equal(run.ranAs, 'ask');
  assert.equal(run.fallback, true);
  assert.equal(run.reasonCode, code);
  if (textPattern) assert.match(run.reason, textPattern);
  assert.equal(t.spent(), 0, 'nothing was paid automatically');
  assert.equal(t.signed.length, 0, 'the scheduled payer signed nothing');
  assert.ok(run.batchId, 'an approval request went out');
  const asked = t.notices.find((n) => n.kind === 'approval_ready');
  assert.ok(asked, 'the owners are told');
  assert.equal(asked.reason, run.reason, 'and told why, in the same words');
  return run;
};

test('the day before, the owners are told what will be paid and when; the run is made once', async () => {
  const t = await ready();
  await t.clock(at(FIRST.getTime() - 20 * HOUR));
  const first = await runScheduledPayments(runner(t));
  assert.equal(first.runsMade, 1);
  assert.deepEqual(t.kinds(), ['day_before']);
  const notice = t.notices[0];
  assert.equal(notice.dueAtMs, FIRST.getTime());
  assert.equal(notice.itemCount, 2);
  assert.equal(notice.totalMinor, (U(500) + U(750.5)).toString());
  assert.equal(notice.mode, 'auto');
  assert.match(notice.path, /view=scheduled&run=psr_/, 'its link opens the Scheduled tab where Skip and Stop are one click');
  await runScheduledPayments(runner(t));
  await runScheduledPayments(runner(t));
  assert.deepEqual(t.kinds(), ['day_before'], 'sent once');
  assert.equal((await runs(t)).length, 1);
  assert.equal(t.spent(), 0, 'nothing is paid before the due time');
  assert.equal((await batches(t)).length, 0);
});

test('at the due time every payment is paid inside the allowance, once, signed by the scheduled payer with the operator sponsoring gas', async () => {
  const t = await ready();
  const before = t.w.balances.get(t.wallet.address).addressBalanceMinor;
  await t.clock(at(FIRST.getTime() - 20 * HOUR));
  await runScheduledPayments(runner(t));
  await t.clock(FIRST);
  const result = await runScheduledPayments(runner(t));
  assert.deepEqual(result.errors, []);

  const [run] = await runs(t);
  assert.equal(run.status, 'paid');
  assert.equal(run.ranAs, 'auto');
  assert.equal(run.fallback, false);
  assert.equal(run.itemCount, 2);
  assert.equal(run.totalMinor, U(1_250.5));
  assert.equal(run.feeMinor, feeFor(U(500)) + feeFor(U(750.5)));
  assert.equal(run.batchId, null, 'no batch and no approval request: the owners’ allowance is the authority');

  const payments = await listRunPayments(t.w.db, 'acme', run.id);
  assert.deepEqual(payments.map((p) => [p.position, p.status]), [[1, 'paid'], [2, 'paid']]);
  assert.ok(payments.every((p) => /^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(p.digest)), 'each has the digest the network gave');
  assert.deepEqual(payments.map((p) => p.maxFeeMinor), [feeFor(U(500)), feeFor(U(750.5))], 'max_fee is the fee that was shown, per payment');

  assert.equal(t.spent(), 2);
  assert.ok(t.w.spends.every((s) => s.spender === PAYER), 'every payment was made by the scheduled payer');
  assert.deepEqual(t.w.spends.map((s) => s.fee), [feeFor(U(500)), feeFor(U(750.5))]);
  const allowance = [...t.w.spend.allowances.values()].find((a) => a.spender === PAYER);
  assert.equal(allowance.currentSpend, U(1_250.5) + feeFor(U(500)) + feeFor(U(750.5)), 'the allowance was charged the amounts and the fees');
  assert.equal(t.w.balances.get(t.wallet.address).addressBalanceMinor, before - U(1_250.5) - feeFor(U(500)) - feeFor(U(750.5)));
  assert.equal(t.signed.length, 2, 'the scheduled payer signed each payment once');

  assert.deepEqual(t.kinds(), ['day_before', 'running', 'paid']);
  assert.equal(t.notices.find((n) => n.kind === 'paid').runId, run.id);
  const view = (await S.listRunViews(t.sdeps()))[0];
  assert.equal(view.status, 'paid');
  assert.equal(view.receiptPath, `/dashboard/history/scheduled/${run.id}`);
  assert.equal(view.payments.length, 2);
  assert.ok(view.payments.every((p) => /^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(p.digest)));
});

test('running it again, or twice at once, pays nothing twice', async () => {
  const t = await ready();
  await t.clock(FIRST);
  const both = await Promise.all([runScheduledPayments(runner(t)), runScheduledPayments(runner(t))]);
  assert.ok(both.every((r) => r.ok));
  await runScheduledPayments(runner(t));
  await runScheduledPayments(runner(t));
  assert.equal(t.spent(), 2, 'two payments, once each');
  assert.equal((await runs(t)).length, 1);
  assert.equal(t.signed.length, 2);
  assert.equal((await listRunPayments(t.w.db, 'acme', (await runs(t))[0].id)).length, 2);
  assert.equal(t.kinds().filter((k) => k === 'paid').length, 1, 'one receipt');
  assert.equal(t.kinds().filter((k) => k === 'running').length, 1);
});

test('the gas the payments reserved counts toward the business’s 24-hour network-fee allowance', async () => {
  const t = await ready();
  await t.clock(FIRST);
  const beforeRun = await sponsoredBudgetSince(t.w.db, 'acme', at(FIRST.getTime() - 24 * HOUR));
  await runScheduledPayments(runner(t));
  const afterRun = await sponsoredBudgetSince(t.w.db, 'acme', at(FIRST.getTime() - 24 * HOUR));
  assert.equal(afterRun - beforeRun, 40_000_000n, 'two payments of 20,000,000 MIST');
  const small = await ready();
  await small.clock(FIRST);
  small.w.signing.sponsorDailyBudgetMist = 30_000_000n;
  await runScheduledPayments(runner(small));
  const [run] = await runs(small);
  assert.equal(run.status, 'failed');
  assert.match(run.reason, /1 of 2 payments went out/);
  assert.match(run.reason, /network-fee allowance/);
  assert.equal(small.spent(), 1, 'the payment inside the allowance went; the one over it did not');
});

test('a run that fails any check is handed back whole to “ask me first”, with the reason, and the owners are asked to sign', async () => {
  // Kill switch.
  let t = await ready();
  await S.pauseAutomatic(t.sdeps(), OWNER_ACTOR);
  t.notices.length = 0;
  await t.clock(FIRST);
  await runScheduledPayments(runner(t));
  await handedBack(t, 'auto_paused', /paused/);

  // No allowance was ever given.
  t = await scheduleWorld();
  await t.payBefore(t.ids.a, 1);
  await t.payBefore(t.ids.b, 1);
  await S.createSchedule(t.sdeps(), OWNER_ACTOR, sched(t.ids, { mode: 'auto', firstDueAt: FIRST.toISOString() }));
  await t.clock(FIRST);
  await runScheduledPayments(runner(t));
  await handedBack(t, 'no_allowance', /allowance/);

  // The allowance ended before the run.
  t = await ready({ allowance: { expiresAtMs: t0 + 1n * DAY } });
  await t.clock(FIRST);
  await runScheduledPayments(runner(t));
  await handedBack(t, 'allowance_ended');

  // The owners took the allowance back.
  t = await ready();
  const revoke = await S.revokeAllowance(t.sdeps(), OWNER_ACTOR);
  assert.equal(revoke.ok, true);
  assert.equal((await signBy(t.w, revoke.request, ['two', 'three'])).status, 'executed');
  await t.clock(FIRST);
  await runScheduledPayments(runner(t));
  const run = (await runs(t))[0];
  assert.equal(run.status, 'waiting_approval');
  assert.ok(['no_allowance', 'allowance_ended'].includes(run.reasonCode));
  assert.equal(t.spent(), 0);
});

test('a recipient not paid before hands the run back, naming who', async () => {
  const t = await scheduleWorld();
  await t.allowance();
  await t.payBefore(t.ids.a, 1);
  // ids.c has never been paid.
  await S.createSchedule(t.sdeps(), OWNER_ACTOR, sched(t.ids, { mode: 'auto', firstDueAt: FIRST.toISOString(), items: [{ recipientId: t.ids.a, amount: '100' }, { recipientId: t.ids.c, amount: '100' }] }));
  await t.clock(FIRST);
  await runScheduledPayments(runner(t));
  await handedBack(t, 'new_recipient', /Reyes Logistics Corp: .*first payment is never automatic/);
});

test('limits hand the run back: one payment over the limit, the window, the daily limit, the approval line', async () => {
  // One payment over the allowance’s per-payment limit.
  let t = await scheduleWorld();
  await t.allowance();
  await t.payBefore(t.ids.a, 1);
  await S.createSchedule(t.sdeps(), OWNER_ACTOR, sched(t.ids, { mode: 'auto', firstDueAt: FIRST.toISOString(), items: [{ recipientId: t.ids.a, amount: '2500' }] }));
  await t.clock(FIRST);
  await runScheduledPayments(runner(t));
  await handedBack(t, 'over_payment_limit', /Dela Cruz Trading Corp: .*single automatic payment/);

  // More than is left of the monthly cap.
  t = await ready({ allowance: { cap: { period: 'month', limitMinor: U(1_000) } } });
  await t.clock(FIRST);
  await runScheduledPayments(runner(t));
  await handedBack(t, 'over_window', /more than is left of the allowance/);

  // The daily limit the owners set.
  t = await ready();
  await saveSettings(t.w.db, 'acme', { dailyCapMinor: U(1_000) }, new Date());
  await t.clock(FIRST);
  await runScheduledPayments(runner(t));
  await handedBack(t, 'daily_cap', /daily limit/);

  // Above the second-approval line: an owner must approve it, however wide the allowance.
  t = await scheduleWorld();
  await t.allowance({ perPaymentMaxMinor: U(15_000), cap: { period: 'month', limitMinor: U(50_000) } });
  await t.payBefore(t.ids.a, 1);
  await saveSettings(t.w.db, 'acme', { dailyCapMinor: U(50_000) }, new Date());
  await S.createSchedule(t.sdeps(), OWNER_ACTOR, sched(t.ids, { mode: 'auto', firstDueAt: FIRST.toISOString(), items: [{ recipientId: t.ids.a, amount: '10500' }] }));
  await t.clock(FIRST);
  await runScheduledPayments(runner(t));
  await handedBack(t, 'above_approval_line', /an owner must approve/);
});

test('the daily limit counts what earlier automatic runs paid that day', async () => {
  const t = await ready({ allowance: { cap: { period: 'month', limitMinor: U(50_000) } } });
  await saveSettings(t.w.db, 'acme', { dailyCapMinor: U(2_000) }, new Date());
  await t.clock(FIRST);
  await runScheduledPayments(runner(t));
  assert.equal((await runs(t))[0].status, 'paid');
  // A second schedule, the same day.
  await S.createSchedule(t.sdeps(), OWNER_ACTOR, sched(t.ids, { clientKey: 'second_key_00001', name: 'Second', mode: 'auto', firstDueAt: at(FIRST.getTime() + 2 * HOUR).toISOString(), items: [{ recipientId: t.ids.a, amount: '900' }] }));
  await t.clock(at(FIRST.getTime() + 2 * HOUR));
  await runScheduledPayments(runner(t));
  const second = (await runs(t)).find((r) => r.status === 'waiting_approval');
  assert.ok(second, 'the second is handed back');
  assert.equal(second.reasonCode, 'daily_cap');
  assert.equal(t.spent(), 2, 'only the first schedule’s two payments went out');
});

test('a fee that rose since the owner saw it, a recipient who changed or left the list, and a creator who is no longer an owner each hand the run back', async () => {
  // The fee rose.
  let t = await ready();
  await t.clock(FIRST);
  await runScheduledPayments(runner(t, { depsFor: async () => t.sdeps('acme', { splashFee: async ({ kind, principalMinor }) => ({ feeMinor: feeFor(principalMinor, kind) + 1n, feesOn: true }) }) }));
  await handedBack(t, 'fee_changed', /Splash’s fee/);

  // A recipient changed address.
  t = await ready();
  await t.w.db.update(schema.suppliers).set({ walletAddress: `0x${'66'.repeat(32)}` }).where(eq(schema.suppliers.id, t.ids.b));
  await t.clock(FIRST);
  await runScheduledPayments(runner(t));
  const changed = (await runs(t))[0];
  assert.equal(changed.status, 'failed', 'the old address is no longer a saved recipient, so the owners are not even asked to sign it');
  assert.match(changed.reason, /changed|Santos Supplies Inc/);
  assert.equal(t.spent(), 0);
  assert.equal(t.signed.length, 0);

  // A recipient was taken off the verified list.
  t = await ready();
  const gone = await changeRecipients(t.w.sc, { orgId: 'acme', requestedBy: 'u-founder', wallet: t.members, change: { remove: [(await t.w.db.select().from(schema.suppliers).where(eq(schema.suppliers.id, t.ids.b)))[0].walletAddress] } });
  assert.equal(gone.ok, true, JSON.stringify(gone));
  assert.equal((await signBy(t.w, gone.request, ['two', 'three'])).status, 'executed');
  await t.clock(FIRST);
  await runScheduledPayments(runner(t));
  await handedBack(t, 'recipient_not_verified', /Santos Supplies Inc: .*verified recipients/);

  // The person who set it up is no longer an owner.
  t = await ready();
  await t.w.db.update(schema.memberships).set({ role: 'checker' }).where(eq(schema.memberships.userId, 'u-founder'));
  await t.clock(FIRST);
  await runScheduledPayments(runner(t));
  await handedBack(t, 'not_owner_created', /still an owner/);
});

test('without the scheduled payer, or with the wallet short, nothing is paid automatically', async () => {
  let t = await ready();
  t.state.payer = { ok: false, code: 'not_configured', reason: 'No scheduled-payer KMS key is configured (SCHEDULED_PAYER_KMS_KEY_ID).' };
  await t.clock(FIRST);
  await runScheduledPayments(runner(t));
  await handedBack(t, 'payer_unavailable', /not switched on/);

  t = await ready();
  t.state.balance = U(500);
  await t.clock(FIRST);
  await runScheduledPayments(runner(t));
  const [run] = await runs(t);
  assert.equal(run.status, 'failed', 'a wallet that cannot cover it cannot be asked to sign it either');
  assert.match(run.reason, /does not hold enough/);
  assert.equal(t.spent(), 0);
  assert.equal(t.signed.length, 0);
});

test('switching the schedule to “ask me first” takes effect for the very next run', async () => {
  const t = await ready();
  await t.clock(at(FIRST.getTime() - 3 * HOUR));
  await runScheduledPayments(runner(t));
  assert.equal(t.kinds()[0], 'day_before');
  const switched = await S.editSchedule(t.sdeps(), OWNER_ACTOR, t.schedule.id, { mode: 'ask' });
  assert.equal(switched.ok, true);
  await t.clock(FIRST);
  await runScheduledPayments(runner(t));
  const [run] = await runs(t);
  assert.equal(run.status, 'waiting_approval');
  assert.equal(run.ranAs, 'ask');
  assert.equal(run.fallback, false, 'it is not a fallback: the owners chose it');
  assert.equal(t.spent(), 0);
  assert.equal(t.signed.length, 0);
});

test('Skip before the run, Stop, and the kill switch each stop an automatic run at once', async () => {
  let t = await ready();
  await t.clock(at(FIRST.getTime() - 3 * HOUR));
  await runScheduledPayments(runner(t));
  assert.equal((await S.skipRun(t.sdeps(), OWNER_ACTOR, t.schedule.id)).ok, true);
  await t.clock(FIRST);
  await runScheduledPayments(runner(t));
  assert.equal((await runs(t))[0].status, 'skipped');
  assert.equal(t.spent(), 0);

  t = await ready();
  await t.clock(at(FIRST.getTime() - 3 * HOUR));
  await runScheduledPayments(runner(t));
  await S.stopSchedule(t.sdeps(), OWNER_ACTOR, t.schedule.id);
  await t.clock(FIRST);
  await runScheduledPayments(runner(t));
  assert.equal(t.spent(), 0);
  assert.equal(t.signed.length, 0);
  assert.notEqual((await runs(t))[0].status, 'paid');
});

test('the kill switch pressed between two payments stops the rest, and says how many went out', async () => {
  const t = await ready();
  await t.clock(FIRST);
  const sign = t.payer.sign;
  let calls = 0;
  t.payer.sign = async (bytes) => {
    const signature = await sign(bytes);
    calls += 1;
    if (calls === 1) {
      const [run] = await runs(t);
      assert.equal(run.status, 'approved', 'while it pays it is approved, in the owners’ own words');
      await S.pauseAutomatic(t.sdeps(), OWNER_ACTOR);
    }
    return signature;
  };
  await runScheduledPayments(runner(t));
  const [run] = await runs(t);
  assert.equal(run.status, 'failed');
  assert.match(run.reason, /1 of 2 payments went out/);
  assert.match(run.reason, /paused/);
  assert.match(run.reason, /Nothing was paid twice/);
  assert.equal(t.spent(), 1);
  const payments = await listRunPayments(t.w.db, 'acme', run.id);
  assert.deepEqual(payments.map((p) => p.status), ['paid', 'failed']);
  // And pressing it again, or running again, pays nothing more.
  await runScheduledPayments(runner(t));
  assert.equal(t.spent(), 1);
  assert.equal(((await getSettings(t.w.db, 'acme'))).autoPaused, true);
});

test('a payment the network refuses fails the run in words; the ones already paid are not paid again', async () => {
  const t = await ready();
  await t.clock(FIRST);
  // The wallet holds enough for the first payment and not the second.
  t.w.balances.set(t.wallet.address, { coinMinor: 0n, addressBalanceMinor: U(520) });
  t.state.balance = undefined;
  await runScheduledPayments(runner(t, { depsFor: async () => t.sdeps('acme', { walletBalance: async () => U(100_000) }) }));
  const [run] = await runs(t);
  assert.equal(run.status, 'failed');
  assert.match(run.reason, /1 of 2 payments went out/);
  assert.match(run.reason, /dry run refused|refused/);
  assert.equal(t.spent(), 1);
  await runScheduledPayments(runner(t));
  assert.equal(t.spent(), 1, 'running again does not send the first one a second time');
  assert.ok(t.notices.some((n) => n.kind === 'failed' && n.reason === run.reason));
});

test('an answer that never came is read back from the chain by its digest and never sent again', async () => {
  const t = await ready();
  await t.clock(FIRST);
  const chain = t.w.signing.chain;
  const realExecute = chain.execute;
  const realRead = chain.read;
  let executions = 0;
  let landed = null;
  chain.execute = async (bytes, signatures) => {
    executions += 1;
    if (executions === 1) {
      const result = await realExecute(bytes, signatures);
      landed = result;
      throw new Error('timeout');
    }
    return realExecute(bytes, signatures);
  };
  // The network says it has not seen it yet.
  chain.read = async (digest) => (landed && landed.digest === digest && t.state.seen ? landed : null);
  await runScheduledPayments(runner(t));
  const [run] = await runs(t);
  assert.equal(run.status, 'approved', 'the outcome is not known, so the run is still approved and still being followed');
  let payments = await listRunPayments(t.w.db, 'acme', run.id);
  assert.deepEqual(payments.map((p) => p.status), ['submitting', 'pending']);
  assert.equal(executions, 1, 'the second payment waits for the first’s outcome');

  await t.clock(at(FIRST.getTime() + 10 * 60_000));
  await runScheduledPayments(runner(t));
  payments = await listRunPayments(t.w.db, 'acme', run.id);
  assert.equal(payments[0].status, 'submitting', 'still not seen');
  assert.equal(executions, 1, 'never sent again');

  t.state.seen = true;
  await runScheduledPayments(runner(t));
  payments = await listRunPayments(t.w.db, 'acme', run.id);
  assert.equal(payments[0].status, 'paid', 'read back from the chain by its digest');
  assert.equal(payments[0].digest, landed.digest);
  assert.equal(executions, 1);
  assert.equal(t.spent(), 1, 'paid once');
  // The second payment was pending when the runner lost its place: it is not sent late.
  assert.equal(payments[1].status, 'failed');
  assert.match(payments[1].error, /not sent late/);
  assert.equal((await runs(t))[0].status, 'failed');
  assert.match((await runs(t))[0].reason, /1 of 2 payments went out/);
  chain.execute = realExecute;
  chain.read = realRead;
});

test('a payment never seen by the network after it can no longer land is given up on, and nothing was paid', async () => {
  const u = await scheduleWorld();
  await u.allowance();
  await u.payBefore(u.ids.a, 1);
  await S.createSchedule(u.sdeps(), OWNER_ACTOR, sched(u.ids, { mode: 'auto', firstDueAt: FIRST.toISOString(), items: [{ recipientId: u.ids.a, amount: '100' }] }));
  await u.clock(FIRST);
  const chain = u.w.signing.chain;
  const realExecute = chain.execute;
  const realRead = chain.read;
  chain.execute = async () => {
    throw new Error('timeout');
  };
  chain.read = async () => null;
  await runScheduledPayments(runner(u));
  assert.equal((await runs(u))[0].status, 'approved');
  await u.clock(at(FIRST.getTime() + SUBMIT_GIVE_UP_MS + 60_000));
  await runScheduledPayments(runner(u));
  const [run] = await runs(u);
  assert.equal(run.status, 'failed');
  assert.match(run.reason, /Nothing was paid/);
  assert.equal(u.spent(), 0);
  chain.execute = realExecute;
  chain.read = realRead;
});

test('a run Splash could not start within a day of its time is not run late, and the payer signs nothing', async () => {
  const t = await ready();
  await t.clock(at(FIRST.getTime() + 25 * HOUR));
  await runScheduledPayments(runner(t));
  const [run] = await runs(t);
  assert.equal(run.status, 'lapsed');
  assert.equal(t.spent(), 0);
  assert.equal(t.signed.length, 0);
});

test('production: a sandbox payer cannot pay, and nothing is sent to the network', async () => {
  const t = await ready();
  t.state.payer = { ok: true, payer: { kind: 'sandbox', address: PAYER, sign: async () => 'sandbox-signature-not-valid-on-any-network' } };
  await t.clock(FIRST);
  let executed = 0;
  const chain = t.w.signing.chain;
  const real = chain.execute;
  chain.execute = async (...args) => {
    executed += 1;
    return real(...args);
  };
  const out = await runScheduledPayments(runner(t, { env: { NODE_ENV: 'production' }, depsFor: async () => t.sdeps('acme', { env: { NODE_ENV: 'production' } }) }));
  const [run] = await runs(t);
  assert.deepEqual(out.errors, []);
  assert.equal(run.status, 'failed');
  const payments = await listRunPayments(t.w.db, 'acme', run.id);
  assert.ok(payments.every((p) => p.status === 'failed' && !String(p.digest ?? '').startsWith('sandbox:') || p.status === 'failed'), 'no sandbox result is recorded as paid');
  assert.ok(!payments.some((p) => p.status === 'paid'));
  assert.equal(executed, 0);
  assert.equal(t.spent(), 0);
  chain.execute = real;
});

test('in development the sandbox payer works the run through and signs nothing on any network', async () => {
  const t = await ready();
  t.state.payer = { ok: true, payer: { kind: 'sandbox', address: PAYER, sign: async () => 'sandbox-signature-not-valid-on-any-network' } };
  await t.clock(FIRST);
  const chain = t.w.signing.chain;
  const real = chain.execute;
  let executed = 0;
  chain.execute = async (...args) => {
    executed += 1;
    return real(...args);
  };
  await runScheduledPayments(runner(t));
  const [run] = await runs(t);
  assert.equal(run.status, 'paid');
  assert.equal(executed, 0, 'nothing was submitted to any network');
  const payments = await listRunPayments(t.w.db, 'acme', run.id);
  assert.ok(payments.every((p) => p.digest.startsWith('sandbox:')));
  const view = (await S.listRunViews(t.sdeps()))[0];
  assert.ok(view.payments.every((p) => p.digest === null), 'a sandbox digest is never shown as an explorer link');
  chain.execute = real;
});

test('a payment is claimed once, only for its own business, and only while its run is still approved', async () => {
  const t = await ready();
  await t.clock(FIRST);
  await runScheduledPayments(runner(t));
  const [run] = await runs(t);
  const [paid] = await listRunPayments(t.w.db, 'acme', run.id);
  assert.equal(await claimPayment(t.w.db, 'acme', paid.id, { digest: 'x', gasBudgetMist: 1n, now: new Date() }), null, 'a payment that is not pending cannot be claimed');
  // A pending payment of a run that is not approved cannot be claimed either, nor by another business.
  await t.w.db.update(schema.paymentScheduleRunPayments).set({ status: 'pending' }).where(eq(schema.paymentScheduleRunPayments.id, paid.id));
  assert.equal(await claimPayment(t.w.db, 'northwind', paid.id, { digest: 'x', gasBudgetMist: 1n, now: new Date() }), null, 'another business cannot claim it');
  assert.equal(await claimPayment(t.w.db, 'acme', paid.id, { digest: 'x', gasBudgetMist: 1n, now: new Date() }), null, 'the run is paid, not approved');
});

test('the database itself refuses an automatic schedule that an owner did not set up', async () => {
  const t = await scheduleWorld();
  const now = new Date();
  await assert.rejects(
    t.w.db.insert(schema.paymentSchedules).values({
      id: 'psc_bad', orgId: 'acme', clientKey: 'bad_key_000001', name: 'x', mode: 'auto', cadence: 'weekly', firstDueAt: now, nextDueAt: now, status: 'active', createdBy: 'u-lead', createdAs: 'finance_lead',
      items: [], itemCount: 1, totalMinor: 1n, feeMinor: 0n, createdAt: now, updatedAt: now,
    }),
    (e) => /violates check constraint "payment_schedules_auto_owner_check"/.test(String(e.cause?.message ?? e.message)),
  );
});

test('an automatic run in another business is judged with that business’s own allowance and settings', async () => {
  const t = await ready();
  await saveSettings(t.w.db, 'northwind', { autoPaused: true, pausedBy: 'u-north', pausedAt: new Date() }, new Date());
  await t.clock(FIRST);
  await runScheduledPayments(runner(t));
  assert.equal((await runs(t))[0].status, 'paid', 'northwind pausing its payments does not pause ours');
  assert.equal((await getSettings(t.w.db, 'acme'))?.autoPaused ?? false, false);
});

test('the wallet short of USDC aside, every automatic payment reaches only an address the owners verified', async () => {
  const t = await ready();
  await t.clock(FIRST);
  await runScheduledPayments(runner(t));
  const policy = [...t.w.spend.policies.values()][0];
  const verified = new Set(policy.recipients.map((r) => r.address));
  assert.ok(t.w.spends.length > 0);
  assert.ok(t.w.spends.every((s) => verified.has(s.recipient)), 'every recipient paid was on the owners’ list');
  assert.ok(!t.w.spends.some((s) => s.recipient === WALLET_C));
});
