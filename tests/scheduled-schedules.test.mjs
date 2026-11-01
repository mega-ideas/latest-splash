/**
 * v2 Phase 3, scheduled batches: what an owner (or the Finance lead, where the
 * role allows) does with a schedule, instantly and with no cooldown.
 *
 * PGlite with every migration, the staff-rule world's model chain and software
 * passkeys (tests/fixtures/schedule-world.mjs). Nothing reaches a network.
 *
 *   create      once, weekly or monthly; a batch of payments to recipients the
 *               business saved and Splash screened; the fee shown is the fee on
 *               chain's schedule; idempotent by the client's key
 *   who         owners any schedule; the Finance lead "ask me first" only; staff,
 *               viewers and everyone else nothing
 *   edit        at once; the mode, the time, the recipients; switching to "ask"
 *               takes effect for the next run
 *   skip, stop, resume, delete   at once
 *   kill switch one owner pauses every automatic payment
 *   allowance   the owners give, change and take back the scheduled payer's
 *               allowance through the signed request flow
 *   tenants     another business's schedule reads as absent
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { listAuthorityEvents } from '../lib/server/wallet-authority.ts';
import * as S from '../lib/server/scheduled-payments.ts';
import { insertRunOnce, listRuns, getSettings } from '../lib/server/scheduled-store.ts';
import { dueDateOf } from '../lib/schedule/rules.ts';
import { readSpenderStanding } from '../lib/server/spend-standing.ts';
import { signBy } from './fixtures/staff-rule-world.mjs';
import { DAY, EXCHANGE, FINANCE_LEAD, NORTH, OWNER_ACTOR, PAYER, STAFF_ACTOR, VIEWER_ACTOR, WALLET_B, WALLET_C, feeFor, sched, scheduleWorld, t0, U } from './fixtures/schedule-world.mjs';

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

test('an owner sets a monthly “ask me first” schedule, and the fee shown is the schedule’s own', async () => {
  const t = await scheduleWorld();
  const made = ok(await S.createSchedule(t.sdeps(), OWNER_ACTOR, sched(t.ids)));
  assert.equal(made.created, true);
  const v = made.schedule;
  assert.equal(v.mode, 'ask');
  assert.equal(v.cadence, 'monthly');
  assert.equal(v.status, 'active');
  assert.equal(v.itemCount, 2);
  assert.equal(v.totalMinor, (U(500) + U(750.5)).toString());
  assert.equal(v.feeMinor, (feeFor(U(500)) + feeFor(U(750.5))).toString(), 'the fee comes from lib/fees, not from the request');
  assert.equal(v.nextDueAt, v.firstDueAt);
  assert.deepEqual(v.items.map((i) => i.name), ['Dela Cruz Trading Corp', 'Santos Supplies Inc']);
  assert.ok(v.items.every((i) => /^0x[0-9a-f]{4}…[0-9a-f]{4}$/.test(i.masked)), 'an address is masked in the view');
  assert.deepEqual(v.can, { edit: true, skip: true, stop: true, delete: true });
  const trail = await listAuthorityEvents(t.w.db, 'acme');
  assert.ok(trail.some((e) => e.action === 'schedule_created' && e.ref === v.id), 'the trail records it');
});

test('a retry is answered from the schedule already made; the same key for another schedule is refused', async () => {
  const t = await scheduleWorld();
  const first = ok(await S.createSchedule(t.sdeps(), OWNER_ACTOR, sched(t.ids)));
  const again = ok(await S.createSchedule(t.sdeps(), OWNER_ACTOR, sched(t.ids)));
  assert.equal(again.created, false);
  assert.equal(again.schedule.id, first.schedule.id);
  refused(await S.createSchedule(t.sdeps(), OWNER_ACTOR, sched(t.ids, { name: 'Another name' })), 409, 'idempotency_key_reused');
  refused(await S.createSchedule(t.sdeps(), OWNER_ACTOR, sched(t.ids, { items: [{ recipientId: t.ids.a, amount: '1' }] })), 409, 'idempotency_key_reused');
  const racing = await Promise.all([1, 2, 3].map(() => S.createSchedule(t.sdeps(), OWNER_ACTOR, sched(t.ids, { clientKey: 'sched_key_racing1' }))));
  assert.ok(racing.every((r) => r.ok));
  assert.equal(new Set(racing.map((r) => r.schedule.id)).size, 1, 'requests racing on one key make one schedule');
  assert.equal((await S.listScheduleViews(t.sdeps(), OWNER_ACTOR)).length, 2);
});

test('who may set a schedule: owners any, the Finance lead “ask me first” only, nobody else', async () => {
  const t = await scheduleWorld();
  ok(await S.createSchedule(t.sdeps(), OWNER_ACTOR, sched(t.ids, { clientKey: 'owner_ask_000001' })));
  ok(await S.createSchedule(t.sdeps(), OWNER_ACTOR, sched(t.ids, { clientKey: 'owner_auto_00001', mode: 'auto' })));
  const lead = ok(await S.createSchedule(t.sdeps(), FINANCE_LEAD, sched(t.ids, { clientKey: 'lead_ask_0000001' })));
  assert.equal(lead.schedule.createdAs, 'finance_lead');
  refused(await S.createSchedule(t.sdeps(), FINANCE_LEAD, sched(t.ids, { clientKey: 'lead_auto_000001', mode: 'auto' })), 403, 'owner_only');
  refused(await S.createSchedule(t.sdeps(), { ...FINANCE_LEAD, financeLead: false }, sched(t.ids, { clientKey: 'approver_ask_0001' })), 403, 'cannot_schedule');
  refused(await S.createSchedule(t.sdeps(), STAFF_ACTOR, sched(t.ids, { clientKey: 'staff_ask_0000001' })), 403, 'cannot_schedule');
  refused(await S.createSchedule(t.sdeps(), VIEWER_ACTOR, sched(t.ids, { clientKey: 'viewer_ask_000001' })), 403, 'cannot_schedule');
  refused(await S.createSchedule(t.sdeps(), STAFF_ACTOR, sched(t.ids, { clientKey: 'staff_auto_000001', mode: 'auto' })), 403, 'owner_only');
});

test('an automatic schedule is offered only where the scheduled payer exists', async () => {
  const t = await scheduleWorld();
  t.state.payer = { ok: false, code: 'not_configured', reason: 'No scheduled-payer KMS key is configured.' };
  refused(await S.createSchedule(t.sdeps(), OWNER_ACTOR, sched(t.ids, { mode: 'auto' })), 409, 'auto_not_available');
  ok(await S.createSchedule(t.sdeps(), OWNER_ACTOR, sched(t.ids, { clientKey: 'still_ask_000001' })), 'ask me first needs no payer');
});

test('a schedule must have a name, a mode, a cadence, a time and real payments', async () => {
  const t = await scheduleWorld();
  const d = () => t.sdeps();
  refused(await S.createSchedule(d(), OWNER_ACTOR, sched(t.ids, { clientKey: 'bad_a_00000001', name: '   ' })), 400, 'bad_name');
  refused(await S.createSchedule(d(), OWNER_ACTOR, sched(t.ids, { clientKey: 'bad_b_00000001', mode: 'manual' })), 400, 'bad_mode');
  refused(await S.createSchedule(d(), OWNER_ACTOR, sched(t.ids, { clientKey: 'bad_c_00000001', cadence: 'daily' })), 400, 'bad_cadence');
  refused(await S.createSchedule(d(), OWNER_ACTOR, sched(t.ids, { clientKey: 'bad_d_00000001', firstDueAt: 'tomorrow-ish' })), 400, 'bad_due');
  refused(await S.createSchedule(d(), OWNER_ACTOR, sched(t.ids, { clientKey: 'bad_e_00000001', items: [] })), 400, 'no_items');
  refused(await S.createSchedule(d(), OWNER_ACTOR, sched(t.ids, { clientKey: 'bad_f_00000001', items: Array.from({ length: 21 }, (_, i) => ({ recipientId: t.ids.a, amount: String(i + 1) })) })), 400, 'too_many_items');
  refused(await S.createSchedule(d(), OWNER_ACTOR, sched(t.ids, { clientKey: 'bad_g_00000001', items: [{ recipientId: t.ids.a, amount: '0' }] })), 400, 'bad_amount');
  refused(await S.createSchedule(d(), OWNER_ACTOR, sched(t.ids, { clientKey: 'bad_h_00000001', items: [{ recipientId: t.ids.a, amount: '1.0000001' }] })), 400, 'bad_amount');
  refused(await S.createSchedule(d(), OWNER_ACTOR, sched(t.ids, { clientKey: 'bad_i_00000001', items: [{ recipientId: t.ids.a, amount: 'RM 20k' }] })), 400, 'bad_amount');
  refused(await S.createSchedule(d(), OWNER_ACTOR, sched(t.ids, { clientKey: 'bad_j_00000001', items: [{ amount: '5' }] })), 400, 'bad_payee');
  refused(await S.createSchedule(d(), OWNER_ACTOR, sched(t.ids, { clientKey: 'bad_k_00000001', items: [{ recipientId: t.ids.a, businessId: 'northwind', amount: '5' }] })), 400, 'bad_payee');
  refused(await S.createSchedule(d(), OWNER_ACTOR, sched(t.ids, { clientKey: 'bad_l_00000001', items: [{ recipientId: 'rcp_nobody', amount: '5' }] })), 404, 'recipient_not_found');
  refused(await S.createSchedule(d(), OWNER_ACTOR, sched(t.ids, { clientKey: 'bad_m_00000001', items: [{ recipientId: t.ids.a, amount: '5', reference: 'x' }, { recipientId: t.ids.a, amount: '5', reference: 'x' }] })), 409, 'duplicate_row');
  refused(await S.createSchedule(d(), OWNER_ACTOR, { ...sched(t.ids), clientKey: 'short' }), 400, 'idempotency_key_required');
});

test('the first time must be ahead: a few minutes for “ask me first”, an hour for automatic, and no more than a year', async () => {
  const t = await scheduleWorld();
  const now = Number(t0);
  const at = (ms) => new Date(now + ms).toISOString();
  refused(await S.createSchedule(t.sdeps(), OWNER_ACTOR, sched(t.ids, { clientKey: 'soon_a_0000001', firstDueAt: at(60_000) })), 400, 'due_too_soon');
  ok(await S.createSchedule(t.sdeps(), OWNER_ACTOR, sched(t.ids, { clientKey: 'soon_b_0000001', firstDueAt: at(6 * 60_000) })));
  refused(await S.createSchedule(t.sdeps(), OWNER_ACTOR, sched(t.ids, { clientKey: 'soon_c_0000001', mode: 'auto', firstDueAt: at(30 * 60_000) })), 400, 'due_too_soon');
  ok(await S.createSchedule(t.sdeps(), OWNER_ACTOR, sched(t.ids, { clientKey: 'soon_d_0000001', mode: 'auto', firstDueAt: at(61 * 60_000) })));
  refused(await S.createSchedule(t.sdeps(), OWNER_ACTOR, sched(t.ids, { clientKey: 'soon_e_0000001', firstDueAt: at(400 * 86_400_000) })), 400, 'due_too_far');
  refused(await S.createSchedule(t.sdeps(), OWNER_ACTOR, sched(t.ids, { clientKey: 'soon_f_0000001', firstDueAt: at(-86_400_000) })), 400, 'due_too_soon');
});

test('a schedule pays a Splash business or a wallet, never an exchange account, the business’s own wallet or Splash’s', async () => {
  const t = await scheduleWorld();
  await t.w.screenClear(EXCHANGE);
  const exchange = await t.w.saveRecipient(EXCHANGE, { name: 'PDAX deposit', kind: 'EXCHANGE' });
  refused(await S.createSchedule(t.sdeps(), OWNER_ACTOR, sched(t.ids, { clientKey: 'xch_a_00000001', items: [{ recipientId: exchange, amount: '5' }] })), 409, 'not_payable_in_a_schedule');
  await t.w.screenClear(t.wallet.address);
  const own = await t.w.saveRecipient(t.wallet.address, { name: 'Ourselves' });
  refused(await S.createSchedule(t.sdeps(), OWNER_ACTOR, sched(t.ids, { clientKey: 'own_a_00000001', items: [{ recipientId: own, amount: '5' }] })), 400, 'own_wallet');
  refused(await S.createSchedule(t.sdeps('acme', { splashAddresses: async () => [WALLET_C] }), OWNER_ACTOR, sched(t.ids, { clientKey: 'spl_a_00000001', items: [{ recipientId: t.ids.c, amount: '5' }] })), 409, 'splash_controlled_address');
  // A bank account is paid with a bank payout, which tells the partner first.
  const { suppliers } = await import('../lib/db/schema.ts');
  await t.w.db.insert(suppliers).values({ id: 'rcp_bank', orgId: 'acme', name: 'Bank payee', country: 'PH', deliveryKind: 'BANK', createdBy: 'u-founder', createdAt: new Date(0) });
  refused(await S.createSchedule(t.sdeps(), OWNER_ACTOR, sched(t.ids, { clientKey: 'bnk_a_00000001', items: [{ recipientId: 'rcp_bank', amount: '5' }] })), 409, 'use_payout_route');
});

test('a recipient that screening has not cleared cannot be put in a schedule', async () => {
  const t = await scheduleWorld();
  const stranger = await t.w.saveRecipient(`0x${'55'.repeat(32)}`, { name: 'Unscreened Ltd' });
  const r = await S.createSchedule(t.sdeps(), OWNER_ACTOR, sched(t.ids, { clientKey: 'scr_a_00000001', items: [{ recipientId: stranger, amount: '5' }] }));
  assert.equal(r.ok, false);
  assert.ok([402, 409, 422, 451].includes(r.status) || r.status >= 400, JSON.stringify(r));
});

test('a Splash business named by id is paid only once the person has seen its address and confirmed it', async () => {
  const t = await scheduleWorld();
  const over = { businessWallet: async (id) => (id === 'northwind' ? { ok: true, name: 'Northwind Pte Ltd', wallet: NORTH, country: 'SG' } : null), isBusinessWallet: async (a) => a === NORTH, searchBusinesses: async () => [] };
  await t.w.screenClear(NORTH);
  const items = [{ businessId: 'northwind', amount: '100', reference: 'INV-9' }];
  const asked = refused(await S.createSchedule(t.sdeps('acme', over), OWNER_ACTOR, sched(t.ids, { clientKey: 'biz_a_00000001', items })), 409, 'new_payee_needs_confirmation');
  assert.deepEqual(asked.details.payees, [{ name: 'Northwind Pte Ltd', address: NORTH, country: 'SG' }]);
  const made = ok(await S.createSchedule(t.sdeps('acme', over), OWNER_ACTOR, sched(t.ids, { clientKey: 'biz_a_00000001', items, confirmNewPayees: true })));
  assert.equal(made.schedule.items[0].payeeKind, 'splash_business');
  assert.equal(made.schedule.feeMinor, '0', 'free between Splash businesses');
  refused(await S.createSchedule(t.sdeps('acme', over), OWNER_ACTOR, sched(t.ids, { clientKey: 'biz_b_00000001', items: [{ businessId: 'acme', amount: '1' }], confirmNewPayees: true })), 400, 'own_wallet');
  refused(await S.createSchedule(t.sdeps('acme', over), OWNER_ACTOR, sched(t.ids, { clientKey: 'biz_c_00000001', items: [{ businessId: 'nobody', amount: '1' }], confirmNewPayees: true })), 404, 'business_not_found');
});

test('an owner edits a schedule at once, and the Finance lead may edit only “ask me first”', async () => {
  const t = await scheduleWorld();
  const id = ok(await S.createSchedule(t.sdeps(), OWNER_ACTOR, sched(t.ids))).schedule.id;
  const edited = ok(await S.editSchedule(t.sdeps(), OWNER_ACTOR, id, { name: 'Rent and suppliers', items: [{ recipientId: t.ids.c, amount: '900' }] }));
  assert.equal(edited.schedule.name, 'Rent and suppliers');
  assert.equal(edited.schedule.itemCount, 1);
  assert.equal(edited.schedule.totalMinor, U(900).toString());
  assert.equal(edited.schedule.version, 2);
  assert.equal(edited.schedule.nextDueAt, edited.schedule.firstDueAt, 'a change to the payments leaves the time alone');
  ok(await S.editSchedule(t.sdeps(), FINANCE_LEAD, id, { name: 'Lead edit' }));
  refused(await S.editSchedule(t.sdeps(), FINANCE_LEAD, id, { mode: 'auto' }), 403, 'owner_only');
  refused(await S.editSchedule(t.sdeps(), STAFF_ACTOR, id, { name: 'No' }), 403);
  refused(await S.editSchedule(t.sdeps(), OWNER_ACTOR, id, { mode: 'sometimes' }), 400, 'bad_mode');
  refused(await S.editSchedule(t.sdeps(), OWNER_ACTOR, id, { name: '' }), 400, 'bad_name');
  refused(await S.editSchedule(t.sdeps(), OWNER_ACTOR, id, { items: [] }), 400, 'no_items');
  refused(await S.editSchedule(t.sdeps(), OWNER_ACTOR, 'psc_missing', { name: 'x' }), 404, 'schedule_not_found');
  assert.ok((await listAuthorityEvents(t.w.db, 'acme')).some((e) => e.action === 'schedule_changed' && e.ref === id));
});

test('only an owner makes a schedule automatic, and the Finance lead cannot edit one that is', async () => {
  const t = await scheduleWorld();
  const id = ok(await S.createSchedule(t.sdeps(), OWNER_ACTOR, sched(t.ids))).schedule.id;
  // The owner confirms the payments when making it automatic: the mode alone is not enough.
  refused(await S.editSchedule(t.sdeps(), OWNER_ACTOR, id, { mode: 'auto' }), 400, 'confirm_payments');
  const auto = ok(await S.editSchedule(t.sdeps(), OWNER_ACTOR, id, { mode: 'auto', items: [{ recipientId: t.ids.a, amount: '500', reference: 'INV-1' }, { recipientId: t.ids.b, amount: '750.50', reference: 'INV-2' }] }));
  assert.equal(auto.schedule.mode, 'auto');
  assert.deepEqual(auto.schedule.can, { edit: true, skip: true, stop: true, delete: true });
  refused(await S.editSchedule(t.sdeps(), FINANCE_LEAD, id, { name: 'Sneaky' }), 403, 'owner_only');
  refused(await S.skipRun(t.sdeps(), FINANCE_LEAD, id), 403, 'owner_only');
  refused(await S.stopSchedule(t.sdeps(), FINANCE_LEAD, id), 403, 'owner_only');
  refused(await S.deleteSchedule(t.sdeps(), FINANCE_LEAD, id), 403, 'owner_only');
  const seen = (await S.listScheduleViews(t.sdeps(), FINANCE_LEAD)).find((s) => s.id === id);
  assert.deepEqual(seen.can, { edit: false, skip: false, stop: false, delete: false }, 'the lead is shown no buttons for an automatic schedule');
  // Switching back to “ask me first” is the owner’s, at once.
  const back = ok(await S.editSchedule(t.sdeps(), OWNER_ACTOR, id, { mode: 'ask' }));
  assert.equal(back.schedule.mode, 'ask');
});

test('switching to automatic needs an hour before the next run; changing the time moves the next run and takes back the old one', async () => {
  const t = await scheduleWorld();
  const soon = new Date(Number(t0) + 10 * 60_000).toISOString();
  const id = ok(await S.createSchedule(t.sdeps(), OWNER_ACTOR, sched(t.ids, { firstDueAt: soon, cadence: 'once' }))).schedule.id;
  refused(await S.editSchedule(t.sdeps(), OWNER_ACTOR, id, { mode: 'auto' }), 400, 'due_too_soon');
  // A run was made for the old time and has not started.
  const sch = (await S.getScheduleView(t.sdeps(), OWNER_ACTOR, id));
  await insertRunOnce(t.w.db, { id: 'psr_old', scheduleId: id, orgId: 'acme', dueDate: dueDateOf(Date.parse(sch.nextDueAt)), dueAt: new Date(sch.nextDueAt), mode: 'ask', status: 'scheduled', createdAt: new Date(), updatedAt: new Date() });
  const later = new Date(Number(t0) + 5 * 86_400_000).toISOString();
  const moved = ok(await S.editSchedule(t.sdeps(), OWNER_ACTOR, id, { firstDueAt: later }));
  assert.equal(moved.schedule.nextDueAt, later);
  const runs = await listRuns(t.w.db, 'acme');
  assert.equal(runs.find((r) => r.id === 'psr_old').status, 'skipped', 'the run for the old time was taken back');
  assert.match(runs.find((r) => r.id === 'psr_old').reason, /Nothing was paid/);
});

test('skip takes the next run out at once and moves the schedule on; skipping again skips the one after', async () => {
  const t = await scheduleWorld();
  const created = ok(await S.createSchedule(t.sdeps(), OWNER_ACTOR, sched(t.ids, { cadence: 'weekly' }))).schedule;
  const first = Date.parse(created.firstDueAt);
  const one = ok(await S.skipRun(t.sdeps(), OWNER_ACTOR, created.id));
  assert.equal(one.run.status, 'skipped');
  assert.equal(one.run.dueDate, dueDateOf(first));
  assert.match(one.run.reason, /Nothing was paid/);
  const after = await S.getScheduleView(t.sdeps(), OWNER_ACTOR, created.id);
  assert.equal(Date.parse(after.nextDueAt), first + 7 * 86_400_000, 'the schedule moved on');
  const two = ok(await S.skipRun(t.sdeps(), OWNER_ACTOR, created.id));
  assert.equal(two.run.dueDate, dueDateOf(first + 7 * 86_400_000));
  refused(await S.skipRun(t.sdeps(), OWNER_ACTOR, created.id, { runId: one.run.id }), 409, 'run_finished');
  refused(await S.skipRun(t.sdeps(), OWNER_ACTOR, created.id, { runId: 'psr_nope' }), 404, 'run_not_found');
  assert.ok(t.notices.some((n) => n.kind === 'skipped' && n.runId === one.run.id), 'the owners are told');
  const once = ok(await S.createSchedule(t.sdeps(), OWNER_ACTOR, sched(t.ids, { clientKey: 'once_key_00001', cadence: 'once' }))).schedule;
  ok(await S.skipRun(t.sdeps(), OWNER_ACTOR, once.id));
  assert.equal((await S.getScheduleView(t.sdeps(), OWNER_ACTOR, once.id)).status, 'completed', 'a once schedule that is skipped is done');
  refused(await S.skipRun(t.sdeps(), OWNER_ACTOR, once.id), 409, 'nothing_to_skip');
});

test('stop ends the schedule at once and takes back a run waiting to start; resume starts it again from the next time; delete keeps the history', async () => {
  const t = await scheduleWorld();
  const created = ok(await S.createSchedule(t.sdeps(), OWNER_ACTOR, sched(t.ids, { cadence: 'weekly' }))).schedule;
  await insertRunOnce(t.w.db, { id: 'psr_wait', scheduleId: created.id, orgId: 'acme', dueDate: dueDateOf(Date.parse(created.nextDueAt)), dueAt: new Date(created.nextDueAt), mode: 'ask', status: 'scheduled', createdAt: new Date(), updatedAt: new Date() });
  const stopped = ok(await S.stopSchedule(t.sdeps(), OWNER_ACTOR, created.id));
  assert.equal(stopped.schedule.status, 'stopped');
  const run = (await listRuns(t.w.db, 'acme')).find((r) => r.id === 'psr_wait');
  assert.equal(run.status, 'skipped');
  assert.match(run.reason, /stopped/);
  ok(await S.stopSchedule(t.sdeps(), OWNER_ACTOR, created.id), 'stopping twice is stopping once');
  refused(await S.skipRun(t.sdeps(), OWNER_ACTOR, created.id), 409, 'nothing_to_skip');
  const resumed = ok(await S.resumeSchedule(t.sdeps(), OWNER_ACTOR, created.id));
  assert.equal(resumed.schedule.status, 'active');
  assert.ok(Date.parse(resumed.schedule.nextDueAt) > Number(t0), 'the next run is ahead; nothing missed is run late');
  refused(await S.resumeSchedule(t.sdeps(), OWNER_ACTOR, created.id), 409, 'not_stopped');
  ok(await S.deleteSchedule(t.sdeps(), OWNER_ACTOR, created.id));
  assert.equal((await S.listScheduleViews(t.sdeps(), OWNER_ACTOR)).length, 0);
  assert.equal(await S.getScheduleView(t.sdeps(), OWNER_ACTOR, created.id), null);
  refused(await S.deleteSchedule(t.sdeps(), OWNER_ACTOR, created.id), 404, 'schedule_not_found');
  const history = await S.listRunViews(t.sdeps());
  assert.ok(history.some((r) => r.id === 'psr_wait' && r.scheduleName === 'Monthly suppliers'), 'a deleted schedule’s runs stay in History under its name');
  const trail = (await listAuthorityEvents(t.w.db, 'acme')).map((e) => e.action);
  for (const a of ['schedule_stopped', 'schedule_resumed', 'schedule_deleted']) assert.ok(trail.includes(a), a);
});

test('another business’s schedules, runs and settings read as absent', async () => {
  const t = await scheduleWorld();
  const created = ok(await S.createSchedule(t.sdeps(), OWNER_ACTOR, sched(t.ids))).schedule;
  const northOwner = { userId: 'u-north', role: 'OWNER' };
  const north = () => t.sdeps('northwind');
  assert.deepEqual(await S.listScheduleViews(north(), northOwner), []);
  assert.equal(await S.getScheduleView(north(), northOwner, created.id), null);
  refused(await S.editSchedule(north(), northOwner, created.id, { name: 'Taken' }), 404, 'schedule_not_found');
  refused(await S.skipRun(north(), northOwner, created.id), 404, 'schedule_not_found');
  refused(await S.stopSchedule(north(), northOwner, created.id), 404, 'schedule_not_found');
  refused(await S.resumeSchedule(north(), northOwner, created.id), 404, 'schedule_not_found');
  refused(await S.deleteSchedule(north(), northOwner, created.id), 404, 'schedule_not_found');
  ok(await S.pauseAutomatic(north(), northOwner));
  assert.equal((await getSettings(t.w.db, 'acme'))?.autoPaused ?? false, false, 'pausing another business’s payments paused ours? it did not');
  assert.equal((await S.getScheduleView(t.sdeps(), OWNER_ACTOR, created.id)).name, 'Monthly suppliers');
  assert.deepEqual(await S.listRunViews(north()), []);
  // The same client key in another business is its own schedule.
  const own = await S.createSchedule(north(), northOwner, sched(t.ids));
  assert.equal(own.ok, false, 'northwind has no wallet or recipients of ours');
});

test('the kill switch: one owner pauses every automatic payment, and an owner turns it back on', async () => {
  const t = await scheduleWorld();
  refused(await S.pauseAutomatic(t.sdeps(), FINANCE_LEAD), 403, 'owner_only');
  refused(await S.pauseAutomatic(t.sdeps(), STAFF_ACTOR), 403, 'owner_only');
  assert.equal((await S.automaticStatus(t.sdeps())).paused, false);
  ok(await S.pauseAutomatic(t.sdeps(), OWNER_ACTOR));
  const status = await S.automaticStatus(t.sdeps());
  assert.equal(status.paused, true);
  assert.equal(status.pausedBy, 'u-founder');
  assert.ok(status.pausedAt);
  assert.ok(t.notices.some((n) => n.kind === 'paused' && n.by === 'u-founder'), 'every owner is told, with the name of whoever paused it');
  ok(await S.pauseAutomatic(t.sdeps(), OWNER_ACTOR), 'pausing twice is pausing once');
  refused(await S.resumeAutomatic(t.sdeps(), FINANCE_LEAD), 403, 'owner_only');
  ok(await S.resumeAutomatic(t.sdeps(), OWNER_ACTOR));
  assert.equal((await S.automaticStatus(t.sdeps())).paused, false);
  const trail = (await listAuthorityEvents(t.w.db, 'acme')).map((e) => e.action);
  assert.ok(trail.includes('automatic_payments_paused') && trail.includes('automatic_payments_resumed'));
});

test('the allowance: the owners give it through a signed request, change it, and take it back', async () => {
  const t = await scheduleWorld();
  const none = await S.automaticStatus(t.sdeps());
  assert.deepEqual(none.allowance, { state: 'none' });
  assert.equal(none.payer.ready, true);
  assert.equal(none.payer.kind, 'kms');
  assert.ok(none.payer.address.includes('…'), 'the payer’s address is masked');
  assert.equal(none.dailyCapMinor, U(5_000).toString(), 'the daily limit starts at the default');

  refused(await S.requestAllowance(t.sdeps(), FINANCE_LEAD, { perPaymentUsdc: '1000', dailyUsdc: '5000', monthlyUsdc: '20000', expiresInDays: 90 }), 403, 'owner_only');
  const bad = refused(await S.requestAllowance(t.sdeps(), OWNER_ACTOR, await t.confirmed({ perPaymentUsdc: '6000', dailyUsdc: '5000', monthlyUsdc: '20000', expiresInDays: 90 })), 400, 'bad_allowance');
  assert.match(bad.error, /one payment cannot be more than the daily/);
  refused(await S.requestAllowance(t.sdeps(), OWNER_ACTOR, await t.confirmed({ perPaymentUsdc: '1000', dailyUsdc: '5000', monthlyUsdc: '20000', expiresInDays: 400 })), 400, 'bad_allowance');

  const asked = ok(await S.requestAllowance(t.sdeps(), OWNER_ACTOR, await t.confirmed({ perPaymentUsdc: '1500', dailyUsdc: '4000', monthlyUsdc: '16000', expiresInDays: 60 })));
  assert.equal(asked.request.purpose, 'spend_rule', 'it is a spending-rule request the quorum signs, like any other');
  assert.equal(asked.request.status, 'collecting');
  assert.equal((await S.automaticStatus(t.sdeps())).allowance.state, 'none', 'nothing is in force until the owners sign');
  assert.equal((await signBy(t.w, asked.request, ['two', 'three'])).status, 'executed');

  const given = await S.automaticStatus(t.sdeps());
  assert.equal(given.allowance.state, 'active');
  assert.equal(given.allowance.perPaymentMaxMinor, U(1_500).toString());
  assert.equal(given.allowance.spendableNowMinor, U(16_000).toString(), 'the monthly cap is the allowance’s own');
  // The end of the 60th UTC day after today: midnight, at least 60 days and less than 61.
  assert.equal(BigInt(given.allowance.expiresAtMs) % DAY, 0n);
  assert.ok(BigInt(given.allowance.expiresAtMs) > t0 + 60n * DAY && BigInt(given.allowance.expiresAtMs) <= t0 + 61n * DAY);
  assert.equal(given.dailyCapMinor, U(4_000).toString(), 'the daily limit the owners set is held by the server');

  const changed = ok(await S.requestAllowance(t.sdeps(), OWNER_ACTOR, await t.confirmed({ perPaymentUsdc: '1000', dailyUsdc: '3000', monthlyUsdc: '9000', expiresInDays: 30 })));
  assert.equal((await signBy(t.w, changed.request, ['two', 'three'])).status, 'executed');
  const after = await S.automaticStatus(t.sdeps());
  assert.equal(after.allowance.perPaymentMaxMinor, U(1_000).toString());
  assert.equal(after.dailyCapMinor, U(3_000).toString());

  refused(await S.revokeAllowance(t.sdeps(), FINANCE_LEAD), 403, 'owner_only');
  const revoke = ok(await S.revokeAllowance(t.sdeps(), OWNER_ACTOR));
  assert.equal((await signBy(t.w, revoke.request, ['two', 'three'])).status, 'executed');
  assert.deepEqual((await S.automaticStatus(t.sdeps())).allowance, { state: 'none' }, 'taken back, it is gone');
  const trail = (await listAuthorityEvents(t.w.db, 'acme')).map((e) => e.action);
  assert.ok(trail.includes('automatic_allowance_requested') && trail.includes('automatic_allowance_revoke_requested'));
});

test('the allowance is asked for only where the payer, the spending rules and a wallet exist', async () => {
  const t = await scheduleWorld();
  const form = { perPaymentUsdc: '1000', dailyUsdc: '5000', monthlyUsdc: '20000', expiresInDays: 90 };
  t.state.payer = { ok: false, code: 'not_configured', reason: 'x' };
  refused(await S.requestAllowance(t.sdeps(), OWNER_ACTOR, await t.confirmed(form)), 409, 'payer_unavailable');
  refused(await S.revokeAllowance(t.sdeps(), OWNER_ACTOR), 409, 'payer_unavailable');
  assert.equal((await S.automaticStatus(t.sdeps())).payer.ready, false);
  t.state.payer = { ok: true, payer: t.payer };
  refused(await S.requestAllowance(t.sdeps('acme', { spend: undefined }), OWNER_ACTOR, form), 503, 'spending_rules_unavailable');
  refused(await S.requestAllowance(t.sdeps('acme', { spend: async () => null }), OWNER_ACTOR, form), 503, 'spending_rules_unavailable');
  // A spending-rule context made for another business is not ours.
  refused(await S.requestAllowance(t.sdeps('acme', { spend: { ...t.w.sc, orgId: 'northwind' } }), OWNER_ACTOR, form), 503, 'spending_rules_unavailable');
});

test('the scheduled payer’s rule is not an offboarded person’s: the spending rules do not offer to take it back', async () => {
  const t = await scheduleWorld();
  await t.allowance();
  const { readSpendingRules } = await import('../lib/server/spend-rules.ts');
  const view = await readSpendingRules(t.w.sc);
  assert.equal(view.ok, true);
  const rule = view.view.rules.find((r) => r.spender === PAYER);
  assert.ok(rule, 'the rule is read');
  // The payer is nobody’s passkey: unless it is named, the offboarding sweep would revoke it.
  assert.ok(Array.isArray(view.view.orphaned));
  assert.equal(rule.standing, 'member', 'the payer is Splash’s own spender, not a person who left');
  assert.ok(!view.view.orphaned.includes(PAYER), 'the payer is not listed as a rule to take back');
  // …and a person who is not a member still is.
  assert.equal(await (async () => (await readSpenderStanding(t.w.db, 'acme', { scheduledPayer: PAYER }))(WALLET_B))(), 'not_a_member');
});

test('a wallet B recipient is a real address on the policy, so the world is what the checks assume', async () => {
  const t = await scheduleWorld();
  const policy = [...t.w.spend.policies.values()][0];
  assert.ok(policy.recipients.some((r) => r.address === WALLET_B));
});
