/**
 * The three questions a new business answers, and what is done with the answers (v2 Phase 3, Sky's decision),
 * against a real database (PGlite with every migration), with an injected clock.
 *
 *   save        owners only; the business is the session's; a bad answer is refused in words and saves nothing
 *   start       a new business (no limits yet) is started at the proposal, once; an existing business is never
 *               changed by answering (it keeps what it runs on) and is shown the proposal to ask for
 *   hostile     the owner's own words are checked, never echoed, never put in the trail or the console
 *   twice       a double click, a second tab and a retry save once and start once
 *   ask         "Ask for higher limits" uses the request path, one request per limit, keyed so it asks once
 *   staff       the queue card shows the answers, the KYB tier and the last 30 days beside the request
 *   migration   0086 gives every existing business the figures it already runs on; nothing is lowered or raised
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';

import { migratedDb } from './helpers/store-db.mjs';
import { LEGACY_LIMITS, pinLegacyLimits } from './helpers/limits-legacy.mjs';
import * as schema from '../lib/db/schema.ts';
import { DEFAULT_LIMITS } from '../lib/limits/rules.ts';
import { currentLimits, listLimitRequestsForStaff, readLimitsView, requestHigherLimit } from '../lib/server/business-limits.ts';
import { askForHigherFromAnswers, limitAnswersNeeded, saveLimitAnswers } from '../lib/server/limit-start.ts';
import { readOnboardingStateForOrg } from '../lib/server/onboarding.ts';
import { appointFinanceLead } from '../lib/server/team-admin.ts';
import { listAuthorityEvents } from '../lib/server/wallet-authority.ts';

const U = (usdc) => BigInt(Math.round(usdc * 1_000_000));
const T0 = new Date('2026-11-02T09:00:00Z');
const H = 3_600_000;
const at = (ms) => () => new Date(ms);
const VERIFIED = new Date('2026-10-01T00:00:00Z');
const COMPLIANCE = { email: 'mariam@splash.test', role: 'compliance' };

const SMALL = { monthlyUsdc: '20,000', paymentsPerWeek: '5', firstTransferUsdc: '10,000' };
const BIG = { monthlyUsdc: '2,000,000', paymentsPerWeek: '20', firstTransferUsdc: '500,000' };

async function seeded() {
  const { client, db } = await migratedDb();
  await client.exec(`INSERT INTO organizations (id, name, kyb_tier, kyb_lifecycle) VALUES ('oldco', 'Oldco Supplies', 'tier-2', 'ACTIVE')`);
  const people = [
    ['u-owner', 'owner@acme.test', 'acme', 'admin'],
    ['u-lead', 'lead@acme.test', 'acme', 'checker'],
    ['u-maker', 'maker@acme.test', 'acme', 'maker'],
    ['u-n-owner', 'owner@northwind.test', 'northwind', 'admin'],
    ['u-old-owner', 'owner@oldco.test', 'oldco', 'admin'],
    ['u-stranger', 'stranger@example.test', null, null],
  ];
  for (const [id, email, org, role] of people) {
    await db.insert(schema.users).values({ id, email, name: id, emailVerifiedAt: VERIFIED });
    if (org) await db.insert(schema.memberships).values({ id: `m-${id}`, userId: id, orgId: org, role });
  }
  const appointed = await appointFinanceLead(db, { orgId: 'acme', actorUserId: 'u-owner', userId: 'u-lead', now: () => T0 });
  assert.equal(appointed.ok, true, JSON.stringify(appointed));
  // Oldco is a business that existed before: it has the rows migration 0086 gives it.
  await pinLegacyLimits(db, ['oldco']);
  return { client, db };
}

const save = (db, over = {}) => saveLimitAnswers(db, { orgId: 'acme', actorUserId: 'u-owner', answers: SMALL, now: at(T0.getTime()), ...over });
// The Finance lead's appointment is part of the fixture, not of what these tests are about.
const trailOf = async (db, orgId = 'acme') => (await listAuthorityEvents(db, orgId)).filter((e) => e.action !== 'finance_lead_appointed');
const actions = async (db, orgId = 'acme') => (await trailOf(db, orgId)).map((e) => e.action);
const rowsOf = async (db, orgId) => db.select().from(schema.businessLimits).where(eq(schema.businessLimits.orgId, orgId));
const answersOf = async (db, orgId) => db.select().from(schema.businessLimitAnswers).where(eq(schema.businessLimitAnswers.orgId, orgId));

// ─── A new business: the answers are saved and become its start ──────────────

test('a new business answers once: the answers are saved with the proposal, and the proposal is what it starts at', async () => {
  const { db } = await seeded();
  assert.equal(await limitAnswersNeeded(db, 'acme'), true, 'a new business is asked');
  assert.equal((await readOnboardingStateForOrg(db, 'acme')).limitStart.ask, true, 'the setup page shows the questions to it');
  assert.equal((await readOnboardingStateForOrg(db, 'oldco')).limitStart.ask, false, 'and not to a business that already runs');
  assert.equal((await readOnboardingStateForOrg(db, 'acme')).complete, false, 'the questions are not a step: nothing waits on them');
  assert.deepEqual({ ...(await currentLimits(db, 'acme', at(T0.getTime()))) }, { ...DEFAULT_LIMITS }, 'with no answers it starts at the starting figures');
  const done = await save(db);
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(done.applied, true);
  assert.equal(done.replayed, false);
  assert.equal(done.start.applied, true);
  assert.match(done.start.headline, /^We started you at 1,900 USDC a payment, 3,000 USDC a day and 30,000 USDC a month because you told us /);

  const now = await currentLimits(db, 'acme', at(T0.getTime()));
  assert.deepEqual({ per_payment: now.per_payment, daily: now.daily, monthly: now.monthly, days: now.days }, { per_payment: U(1_900), daily: U(3_000), monthly: U(30_000), days: 90n });

  const rows = await rowsOf(db, 'acme');
  assert.deepEqual(rows.map((r) => r.kind).sort(), ['daily', 'monthly', 'per_payment'], 'the three amounts; the length of an allowance is not worked out from the answers');
  for (const r of rows) {
    assert.equal(r.source, 'starting');
    assert.equal(r.changedBy, 'system:onboarding');
    assert.equal(r.heldMax, r.value, 'the most the business has held is where it started: going higher is a request');
  }
  const [saved] = await answersOf(db, 'acme');
  assert.equal(saved.monthlyMinor, U(20_000));
  assert.equal(saved.perWeek, 5);
  assert.equal(saved.firstMinor, U(10_000));
  assert.equal(saved.monthlyText, '20,000');
  assert.equal(saved.proposedDaily, U(3_000));
  assert.equal(saved.wantedDaily, U(3_000));
  assert.equal(saved.version, 1);
  assert.equal(saved.answeredBy, 'u-owner');
  assert.ok(saved.appliedAt, 'recorded as started');
  assert.equal(await limitAnswersNeeded(db, 'acme'), false, 'and not asked again');
  const state = await readOnboardingStateForOrg(db, 'acme');
  assert.equal(state.limitStart.ask, false);
});

test('the trail says the answers were saved and the limits started, and holds none of the answers', async () => {
  const { db } = await seeded();
  const logged = [];
  const originals = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  for (const name of Object.keys(originals)) console[name] = (...args) => logged.push(args.map(String).join(' '));
  try {
    const out = await save(db, { answers: { monthlyUsdc: '23,456', paymentsPerWeek: '7', firstTransferUsdc: '8,765' } });
    assert.equal(out.ok, true, JSON.stringify(out));
  } finally {
    Object.assign(console, originals);
  }
  const trail = await trailOf(db, 'acme');
  assert.deepEqual(trail.map((e) => e.action), ['limit_answers_saved', 'limit_change_applied', 'limit_change_applied', 'limit_change_applied']);
  assert.ok(trail.slice(1).every((e) => e.actorUserId === 'system:onboarding'));
  const flat = JSON.stringify(trail.map((e) => ({ a: e.action, d: e.detail, r: e.ref })));
  for (const piece of ['23,456', '23456', '8,765', '8765']) assert.ok(!flat.includes(piece), `the trail does not hold ${piece}`);
  assert.deepEqual(logged.filter((line) => /23,456|23456|8,765|8765/.test(line)), [], 'and neither does the console');
});

// ─── Who may answer, and whose business ──────────────────────────────────────

test('only an owner answers: the Finance lead, a team member, a stranger and a person of another business are refused, and nothing is written', async () => {
  const { db } = await seeded();
  for (const [actor, code] of [['u-lead', 'owner_only'], ['u-maker', 'not_allowed'], ['u-stranger', 'not_allowed'], ['u-n-owner', 'not_allowed']]) {
    const out = await save(db, { actorUserId: actor });
    assert.equal(out.ok, false, actor);
    assert.equal(out.status, 403, actor);
    assert.equal(out.code, code, actor);
  }
  assert.deepEqual(await answersOf(db, 'acme'), []);
  assert.deepEqual(await rowsOf(db, 'acme'), []);
  assert.deepEqual(await actions(db), []);
});

test('the business is the caller’s and nobody else’s: northwind’s answers start northwind only', async () => {
  const { db } = await seeded();
  assert.equal((await save(db)).ok, true);
  const theirs = await save(db, { orgId: 'northwind', actorUserId: 'u-n-owner', answers: BIG });
  assert.equal(theirs.ok, true, JSON.stringify(theirs));
  assert.equal((await currentLimits(db, 'acme', at(T0.getTime()))).daily, U(3_000));
  assert.equal((await currentLimits(db, 'northwind', at(T0.getTime()))).daily, DEFAULT_LIMITS.daily);
  assert.equal((await answersOf(db, 'acme')).length, 1);
  assert.equal((await answersOf(db, 'northwind')).length, 1);
  assert.equal((await answersOf(db, 'acme'))[0].monthlyMinor, U(20_000));
  assert.equal((await answersOf(db, 'northwind'))[0].monthlyMinor, U(2_000_000));
  // acme's owner cannot answer for northwind by naming it: the actor is not a member there.
  const cross = await save(db, { orgId: 'northwind', actorUserId: 'u-owner' });
  assert.equal(cross.ok, false);
  assert.equal(cross.status, 403);
  assert.equal(await limitAnswersNeeded(db, 'oldco'), false, 'a business that already runs is not asked');
});

// ─── Bad and hostile answers ─────────────────────────────────────────────────

test('a bad answer is refused in words, says which answer, saves nothing and starts nothing', async () => {
  const { db } = await seeded();
  const cases = [
    [{ ...SMALL, monthlyUsdc: '0' }, 'monthlyUsdc'],
    [{ ...SMALL, monthlyUsdc: '-5' }, 'monthlyUsdc'],
    [{ ...SMALL, paymentsPerWeek: 'lots' }, 'paymentsPerWeek'],
    [{ ...SMALL, firstTransferUsdc: '' }, 'firstTransferUsdc'],
    [{ monthlyUsdc: '20,000', paymentsPerWeek: '5' }, 'firstTransferUsdc'],
    [null, 'monthlyUsdc'],
    ['20,000', 'monthlyUsdc'],
  ];
  for (const [answers, field] of cases) {
    const out = await save(db, { answers });
    assert.equal(out.ok, false, JSON.stringify(answers));
    assert.equal(out.status, 400);
    assert.equal(out.code, 'bad_answers');
    assert.ok(out.details.problems[field], `${JSON.stringify(answers)} names ${field}`);
  }
  assert.deepEqual(await answersOf(db, 'acme'), []);
  assert.deepEqual(await rowsOf(db, 'acme'), []);
  assert.deepEqual(await actions(db), []);
  assert.equal(await limitAnswersNeeded(db, 'acme'), true, 'still to be asked');
});

test('hostile words never reach the database, the trail, the console or the reply', async () => {
  const { db } = await seeded();
  const hostile = ['<script>alert(1)</script>', "20,000'; DROP TABLE business_limits;--", '20,000\n5\n', '‮20,000', '"><img src=x onerror=alert(1)>', 'x'.repeat(5000)];
  const logged = [];
  const originals = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  for (const name of Object.keys(originals)) console[name] = (...args) => logged.push(args.map(String).join(' '));
  const replies = [];
  try {
    for (const raw of hostile) {
      for (const field of ['monthlyUsdc', 'paymentsPerWeek', 'firstTransferUsdc']) {
        const out = await save(db, { answers: { ...SMALL, [field]: raw } });
        assert.equal(out.ok, false, `${field}: ${raw.slice(0, 20)}`);
        replies.push(JSON.stringify(out));
      }
    }
  } finally {
    Object.assign(console, originals);
  }
  assert.deepEqual(await answersOf(db, 'acme'), []);
  assert.deepEqual(await rowsOf(db, 'acme'), []);
  assert.deepEqual(await actions(db), []);
  for (const reply of replies) assert.doesNotMatch(reply, /<script|DROP TABLE|onerror|xxxxx|‮/);
  assert.deepEqual(logged.filter((line) => /DROP TABLE|<script|onerror|xxxxx/.test(line)), []);
  assert.equal((await db.select().from(schema.businessLimits)).length, 4, 'the table is there and holds only the pinned business');
});

test('what is stored is the answer as the owner wrote it, trimmed, and nothing longer than the cap', async () => {
  const { db } = await seeded();
  const out = await save(db, { answers: { monthlyUsdc: '  $20k  USDC ', paymentsPerWeek: ' 5 ', firstTransferUsdc: '10,000' } });
  assert.equal(out.ok, true, JSON.stringify(out));
  const [saved] = await answersOf(db, 'acme');
  assert.equal(saved.monthlyText, '$20k USDC');
  assert.equal(saved.perWeekText, '5');
  assert.ok(saved.monthlyText.length <= 40 && saved.perWeekText.length <= 40 && saved.firstText.length <= 40);
  assert.equal(saved.monthlyMinor, U(20_000));
});

// ─── Twice ───────────────────────────────────────────────────────────────────

test('a double click, a retry and a second tab save once and start once', async () => {
  const { db } = await seeded();
  const results = await Promise.all([save(db), save(db), save(db)]);
  assert.ok(results.every((r) => r.ok), JSON.stringify(results));
  assert.equal(results.filter((r) => r.applied && !r.replayed).length, 1, 'one of them started the limits');
  assert.equal((await answersOf(db, 'acme')).length, 1);
  assert.equal((await rowsOf(db, 'acme')).length, 3);
  const trail = await actions(db);
  assert.equal(trail.filter((a) => a === 'limit_change_applied').length, 3, 'three lines for three limits, once');
  assert.equal(trail.filter((a) => a === 'limit_answers_saved').length, 1, 'one line for the answers');
  const again = await save(db);
  assert.equal(again.ok, true);
  assert.equal(again.replayed, true, 'the same answers again are the same save');
  assert.equal((await answersOf(db, 'acme'))[0].version, 1);
  assert.equal((await actions(db)).length, trail.length, 'and write nothing');
});

test('different answers later are saved for the reviewer, and never move a limit that has started', async () => {
  const { db } = await seeded();
  assert.equal((await save(db)).ok, true);
  const later = await save(db, { answers: BIG, now: at(T0.getTime() + 5 * H) });
  assert.equal(later.ok, true, JSON.stringify(later));
  assert.equal(later.applied, true, 'the start stays the one it was');
  assert.equal(later.replayed, false);
  const [saved] = await answersOf(db, 'acme');
  assert.equal(saved.version, 2);
  assert.equal(saved.monthlyMinor, U(2_000_000));
  assert.equal(saved.wantedDaily, U(300_000));
  assert.equal((await currentLimits(db, 'acme', at(T0.getTime() + 6 * H))).daily, U(3_000), 'nothing moved');
  assert.equal((await actions(db)).filter((a) => a === 'limit_change_applied').length, 3);
});

// ─── An existing business ────────────────────────────────────────────────────

test('an existing business that answers keeps what it runs on, is shown the proposal and has to ask for it', async () => {
  const { db } = await seeded();
  assert.equal(await limitAnswersNeeded(db, 'oldco'), false);
  const out = await saveLimitAnswers(db, { orgId: 'oldco', actorUserId: 'u-old-owner', answers: SMALL, now: at(T0.getTime()) });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.applied, false);
  assert.doesNotMatch(out.start.headline, /^We started you at/);
  assert.match(out.start.headline, /would start a new business at 1,900 USDC a payment/);
  const now = await currentLimits(db, 'oldco', at(T0.getTime()));
  assert.deepEqual({ ...now }, { ...LEGACY_LIMITS }, 'nothing is lowered or changed');
  assert.deepEqual((await rowsOf(db, 'oldco')).map((r) => r.source), ['raised', 'raised', 'raised', 'raised']);
  const [saved] = await answersOf(db, 'oldco');
  assert.equal(saved.appliedAt, null, 'recorded as not used to start the limits');
  assert.equal((await actions(db, 'oldco')).filter((a) => a === 'limit_change_applied').length, 0);
});

// ─── What the owner sees ─────────────────────────────────────────────────────

test('the Limits screen tells the owners what they were started at and why, in plain words', async () => {
  const { db } = await seeded();
  const before = await readLimitsView(db, { orgId: 'acme', userId: 'u-owner', now: at(T0.getTime()) });
  assert.equal(before.ok, true);
  assert.equal(before.view.start.answered, false);
  assert.equal(before.view.start.ask, true, 'a new business can answer from here');
  assert.equal((await save(db)).ok, true);
  const view = (await readLimitsView(db, { orgId: 'acme', userId: 'u-owner', now: at(T0.getTime()) })).view;
  assert.equal(view.start.answered, true);
  assert.equal(view.start.ask, false);
  assert.match(view.start.headline, /^We started you at 1,900 USDC a payment, 3,000 USDC a day and 30,000 USDC a month because you told us /);
  assert.equal(view.start.canAskHigher, false, 'nothing was held back');
  const per = view.limits.find((l) => l.kind === 'per_payment');
  assert.equal(per.source, 'starting');
  assert.match(per.why, /^We started you at 1,900 USDC because you told us /);
  assert.equal(per.canRestore, false);
  // The Finance lead sees it and cannot ask.
  const lead = (await readLimitsView(db, { orgId: 'acme', userId: 'u-lead', now: at(T0.getTime()) })).view;
  assert.equal(lead.start.canAskHigher, false);
  assert.equal(lead.start.ask, false);
});

test('a business whose answers were capped is offered "Ask for higher limits"; an existing one is offered it when its proposal is above its limits', async () => {
  const { db } = await seeded();
  assert.equal((await save(db, { answers: BIG })).ok, true);
  const view = (await readLimitsView(db, { orgId: 'acme', userId: 'u-owner', now: at(T0.getTime()) })).view;
  assert.equal(view.start.canAskHigher, true);
  assert.match(view.start.capped, /more than we start a business at/i);
  assert.match(view.start.capped, /300,000 USDC a day/);
  assert.deepEqual(view.limits.find((l) => l.kind === 'daily').current, DEFAULT_LIMITS.daily.toString());
  assert.equal((await saveLimitAnswers(db, { orgId: 'oldco', actorUserId: 'u-old-owner', answers: SMALL, now: at(T0.getTime()) })).ok, true);
  const old = (await readLimitsView(db, { orgId: 'oldco', userId: 'u-old-owner', now: at(T0.getTime()) })).view;
  assert.equal(old.start.canAskHigher, true, '1,900 a payment is not above 2,000, but 3,000 a day is not above 5,000 either, 30,000 a month is');
});

// ─── Ask for higher limits ───────────────────────────────────────────────────

test('"Ask for higher limits" asks for what the answers wanted, one request per limit, once', async () => {
  const { db } = await seeded();
  assert.equal((await save(db, { answers: BIG })).ok, true);
  const first = await askForHigherFromAnswers(db, { orgId: 'acme', actorUserId: 'u-owner', now: at(T0.getTime() + H) });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.deepEqual(first.asked.map((a) => a.kind).sort(), ['daily', 'monthly'], 'per payment fits, so it is not asked');
  assert.ok(first.asked.every((a) => a.replayed === false && a.request.phase === 'asked'));
  assert.deepEqual(first.asked.map((a) => [a.kind, a.request.requested]).sort(), [['daily', U(300_000).toString()], ['monthly', U(3_000_000).toString()]]);
  const rows = await db.select().from(schema.businessLimitRequests).where(eq(schema.businessLimitRequests.orgId, 'acme'));
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.requestedBy === 'u-owner' && r.status === 'pending'));
  assert.ok(rows.every((r) => r.reason.length >= 10), 'a reason, so the request path accepts it');
  assert.ok(rows.every((r) => !/\d/.test(r.reason)), 'the reason carries no figure, so none of the answers');

  const second = await askForHigherFromAnswers(db, { orgId: 'acme', actorUserId: 'u-owner', now: at(T0.getTime() + 2 * H) });
  assert.equal(second.ok, true);
  assert.ok(second.asked.every((a) => a.replayed), 'a double click asks once');
  assert.equal((await db.select().from(schema.businessLimitRequests).where(eq(schema.businessLimitRequests.orgId, 'acme'))).length, 2);
  const trail = await actions(db);
  assert.equal(trail.filter((a) => a === 'limit_raise_requested').length, 2);
  const events = JSON.stringify((await listAuthorityEvents(db, 'acme')).filter((e) => e.action === 'limit_raise_requested').map((e) => e.detail));
  assert.ok(!events.includes('2,000,000') && !events.includes('2000000'), 'the trail line holds the figure asked for, not the answers');
});

test('asking again after new answers is a new ask; asking with no answers, or as anyone but an owner, is refused', async () => {
  const { db } = await seeded();
  const none = await askForHigherFromAnswers(db, { orgId: 'acme', actorUserId: 'u-owner', now: at(T0.getTime()) });
  assert.equal(none.ok, false);
  assert.equal(none.code, 'no_answers');
  assert.equal((await save(db, { answers: BIG })).ok, true);
  for (const [actor, code] of [['u-lead', 'owner_only'], ['u-maker', 'not_allowed'], ['u-stranger', 'not_allowed'], ['u-n-owner', 'not_allowed']]) {
    const out = await askForHigherFromAnswers(db, { orgId: 'acme', actorUserId: actor, now: at(T0.getTime()) });
    assert.equal(out.ok, false, actor);
    assert.equal(out.code, code, actor);
  }
  assert.equal((await db.select().from(schema.businessLimitRequests)).length, 0);
  const first = await askForHigherFromAnswers(db, { orgId: 'acme', actorUserId: 'u-owner', now: at(T0.getTime()) });
  assert.equal(first.ok, true);
  assert.equal(first.asked.length, 2);
  // Northwind has no answers of its own: acme's do not start a request there.
  const other = await askForHigherFromAnswers(db, { orgId: 'northwind', actorUserId: 'u-n-owner', now: at(T0.getTime()) });
  assert.equal(other.code, 'no_answers');
});

test('the figures come from the stored answers, never from the request', async () => {
  const { db } = await seeded();
  assert.equal((await save(db, { answers: BIG })).ok, true);
  const out = await askForHigherFromAnswers(db, { orgId: 'acme', actorUserId: 'u-owner', requested: '99,999,999', kind: 'daily', now: at(T0.getTime()) });
  assert.equal(out.ok, true);
  assert.ok(out.asked.every((a) => a.request.requested !== U(99_999_999).toString()));
});

// ─── The staff card ──────────────────────────────────────────────────────────

test('the staff card shows the business’s KYB tier, its answers and its last 30 days of use beside the request', async () => {
  const { client, db } = await seeded();
  // Oldco answered later and asks for more; it has paid some automatic payments.
  assert.equal((await saveLimitAnswers(db, { orgId: 'oldco', actorUserId: 'u-old-owner', answers: BIG, now: at(T0.getTime()) })).ok, true);
  const asked = await requestHigherLimit(db, { orgId: 'oldco', actorUserId: 'u-old-owner', kind: 'daily', requested: '40,000', reason: 'We now pay many suppliers each week.', requestKey: 'staff-card-key-1', now: at(T0.getTime()) });
  assert.equal(asked.ok, true, JSON.stringify(asked));
  await client.exec(`SET session_replication_role = replica`);
  const pay = (id, day, amount, status = 'paid') =>
    client.exec(`INSERT INTO payment_schedule_run_payments (id, run_id, org_id, position, payment_ref, payee_name, address, amount_minor, max_fee_minor, fee_kind, status, attempted_at)
      VALUES ('${id}', 'run-1', 'oldco', ${Number(id.slice(-1))}, '${id.slice(-1).repeat(64)}', 'Supplier', '0x${'ab'.repeat(32)}', ${amount}, 0, 0, '${status}', '${day}')`);
  await pay('p-1', '2026-10-30T10:00:00Z', U(1_200));
  await pay('p-2', '2026-10-30T11:00:00Z', U(1_800));
  await pay('p-3', '2026-10-20T10:00:00Z', U(900));
  await pay('p-4', '2026-09-20T10:00:00Z', U(7_000));
  await pay('p-5', '2026-10-25T10:00:00Z', U(5_000), 'failed');
  await client.exec(`SET session_replication_role = origin`);

  const queue = await listLimitRequestsForStaff(db, COMPLIANCE, at(T0.getTime()));
  assert.equal(queue.ok, true, JSON.stringify(queue));
  const card = queue.open.find((r) => r.org.id === 'oldco');
  assert.ok(card, 'the request is in the queue');
  assert.equal(card.context.kybTier, 'tier-2');
  assert.match(card.context.kybStateWords, /verified|active/i);
  assert.equal(card.context.answers.monthlyText, '2,000,000');
  assert.equal(card.context.answers.perWeekText, '20');
  assert.equal(card.context.answers.firstText, '500,000');
  assert.match(card.context.answers.proposedWords.daily, /100,000 USDC/);
  assert.match(card.context.answers.wantedWords.daily, /300,000 USDC/);
  assert.equal(card.context.use30.payments, 3, 'paid payments in the last 30 days: not the failed one, not the old one');
  assert.match(card.context.use30.totalWords, /3,900 USDC/);
  assert.match(card.context.use30.largestWords, /1,800 USDC/);
  assert.match(card.context.use30.busiestDayWords, /3,000 USDC/);
  // Another business's card carries its own context only.
  const acme = await save(db);
  assert.equal(acme.ok, true);
  const mine = await requestHigherLimit(db, { orgId: 'acme', actorUserId: 'u-owner', kind: 'daily', requested: '8,000', reason: 'We now pay six suppliers on the first of each month.', requestKey: 'staff-card-key-2', now: at(T0.getTime()) });
  assert.equal(mine.ok, true, JSON.stringify(mine));
  const both = await listLimitRequestsForStaff(db, COMPLIANCE, at(T0.getTime()));
  const acmeCard = both.open.find((r) => r.org.id === 'acme');
  assert.equal(acmeCard.context.kybTier, null);
  assert.equal(acmeCard.context.answers.monthlyText, '20,000');
  assert.equal(acmeCard.context.use30.payments, 0);
  assert.match(acmeCard.context.use30.totalWords, /0 USDC/);
});

test('a business with no answers has a card that says so, and the queue still opens', async () => {
  const { db } = await seeded();
  const asked = await requestHigherLimit(db, { orgId: 'oldco', actorUserId: 'u-old-owner', kind: 'daily', requested: '8,000', reason: 'We now pay six suppliers on the first of each month.', requestKey: 'no-answers-key', now: at(T0.getTime()) });
  assert.equal(asked.ok, true);
  const queue = await listLimitRequestsForStaff(db, COMPLIANCE, at(T0.getTime()));
  assert.equal(queue.open[0].context.answers, null);
  assert.equal(queue.open[0].context.use30.payments, 0);
});

// ─── Migration 0086 ──────────────────────────────────────────────────────────

async function dbBefore0086() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  const dir = new URL('../drizzle/', import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const run = async (list) => {
    for (const file of list) {
      const text = await readFile(new URL(file, dir), 'utf8');
      for (const statement of text.split('--> statement-breakpoint')) {
        const trimmed = statement.trim();
        if (trimmed) await client.exec(trimmed);
      }
    }
  };
  const after = files.filter((f) => f >= '0086');
  assert.ok(after.length > 0, 'migration 0086 exists');
  assert.ok(after[0].startsWith('0086_'), after[0]);
  await run(files.filter((f) => f < '0086'));
  return { client, db, apply: () => run(after), files };
}

test('migration 0086: every business that exists keeps the figures it runs on; nothing is lowered, raised or changed; a new business starts higher', async () => {
  const { client, db, apply } = await dbBefore0086();
  await client.exec(`INSERT INTO organizations (id, name) VALUES ('plain', 'Plain'), ('kept', 'Kept'), ('low', 'Low')`);
  // Kept already runs on a bigger daily limit (migration 0079 gave it a row); Low lowered its monthly limit.
  await client.exec(`INSERT INTO business_limits (org_id, kind, value, source, changed_by, held_max) VALUES
    ('kept', 'daily', ${U(8_000)}, 'raised', 'system:migration', ${U(8_000)}),
    ('low', 'monthly', ${U(1_000)}, 'lowered', 'u-1', ${U(20_000)})`);
  await apply();

  const rows = async (org) => Object.fromEntries((await db.select().from(schema.businessLimits).where(eq(schema.businessLimits.orgId, org))).map((r) => [r.kind, r]));
  const plain = await rows('plain');
  assert.deepEqual({ per_payment: plain.per_payment.value, daily: plain.daily.value, monthly: plain.monthly.value, days: plain.days.value }, { ...LEGACY_LIMITS });
  assert.ok(Object.values(plain).every((r) => r.source === 'raised' && r.changedBy === 'system:migration' && r.heldMax === r.value), 'kept, with nothing to restore beyond it');
  const kept = await rows('kept');
  assert.equal(kept.daily.value, U(8_000), 'what 0079 kept stays');
  assert.equal(kept.monthly.value, U(20_000));
  const low = await rows('low');
  assert.equal(low.monthly.value, U(1_000), 'a lowered limit stays lowered');
  assert.equal(low.monthly.source, 'lowered');
  assert.equal(low.monthly.heldMax, U(20_000), 'and can still be put back');
  for (const org of ['plain', 'kept', 'low']) assert.equal(Object.keys(await rows(org)).length, 4);

  const events = await db.select().from(schema.walletAuthorityEvents).where(eq(schema.walletAuthorityEvents.orgId, 'plain'));
  assert.equal(events.length, 4);
  assert.ok(events.every((e) => e.action === 'limit_change_applied' && e.actorUserId === 'system:migration'));
  assert.ok(events.every((e) => e.detail.before === e.detail.after), 'a line that says nothing changed');

  // Running it again writes nothing more.
  const dir = new URL('../drizzle/', import.meta.url);
  const file = (await readdir(dir)).find((f) => f.startsWith('0086_'));
  const text = await readFile(new URL(file, dir), 'utf8');
  const pin = text.split('--> statement-breakpoint').filter((s) => /system:migration/.test(s) && /INSERT INTO "business_limits"/.test(s));
  assert.equal(pin.length, 1, 'the pinning is one statement');
  await client.exec(pin[0]);
  assert.equal((await db.select().from(schema.businessLimits)).length, 12);
  assert.equal((await db.select().from(schema.walletAuthorityEvents).where(eq(schema.walletAuthorityEvents.orgId, 'plain'))).length, 4);

  // A business made after the migration has no rows and starts at the new figures.
  await client.exec(`INSERT INTO organizations (id, name) VALUES ('fresh', 'Fresh')`);
  assert.deepEqual({ ...(await currentLimits(db, 'fresh', at(T0.getTime()))) }, { ...DEFAULT_LIMITS });
  assert.deepEqual({ ...(await currentLimits(db, 'plain', at(T0.getTime()))) }, { ...LEGACY_LIMITS });
});

test('migration 0086: the new constraints hold the rule in the database', async () => {
  const { client, db, apply } = await dbBefore0086();
  await apply();
  await client.exec(`INSERT INTO organizations (id, name) VALUES ('acme', 'Acme')`);
  await client.exec(`INSERT INTO users (id, email, name) VALUES ('u-1', 'u1@example.test', 'U1')`);
  const insert = (id, kind, requested, granted, extra = '') =>
    client.exec(`INSERT INTO business_limit_requests (id, org_id, kind, requested_value, current_value, granted_value, reason, request_key, requested_by, requested_at, status, decided_by, decided_at, effective_at, applied_at ${extra ? ', ' + extra.split('|')[0] : ''})
      VALUES ('${id}', 'acme', '${kind}', ${requested}, ${U(1)}, ${granted}, 'a reason that is long enough', 'key-${id}-xxxx', 'u-1', now(), 'applied', 'operator:a@splash.test', now(), now() + interval '25 hours', now() ${extra ? ', ' + extra.split('|')[1] : ''})`);
  await assert.rejects(insert('big-1', 'daily', U(300_000), U(300_000)), /business_limit_requests_large|check/i, 'a large daily grant with one approver is refused');
  await assert.rejects(insert('big-2', 'monthly', U(3_000_000), U(3_000_000)), /business_limit_requests_large|check/i, 'and a large monthly one');
  await insert('ok-1', 'daily', U(250_000), U(250_000));
  await insert('ok-2', 'monthly', U(2_500_000), U(2_500_000));
  await assert.rejects(
    insert('same', 'daily', U(300_000), U(300_000), `first_approved_by, first_approver_role, first_approved_at, first_granted_value, decided_role|'operator:a@splash.test', 'compliance', now(), ${U(300_000)}, 'operations'`),
    /business_limit_requests_two_people|check/i,
    'the same person twice is refused',
  );
  await assert.rejects(
    insert('roles', 'daily', U(300_000), U(300_000), `first_approved_by, first_approver_role, first_approved_at, first_granted_value, decided_role|'operator:b@splash.test', 'operations', now(), ${U(300_000)}, 'operations'`),
    /business_limit_requests_two_roles|check/i,
    'two people of the same role are refused',
  );
  await insert('two', 'daily', U(300_000), U(300_000), `first_approved_by, first_approver_role, first_approved_at, first_granted_value, decided_role|'operator:b@splash.test', 'compliance', now(), ${U(300_000)}, 'operations'`);
  void db;
});
