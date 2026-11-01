/**
 * The reviewer's findings on the limits section (v2 Phase 3), as tests:
 *
 *   keeps what runs   A business that already runs on an allowance or a daily limit
 *                     above the standard figures keeps it when limits arrive
 *                     (migration 0079): its automatic payments do not stop on deploy.
 *   restore           An owner who lowers a limit by mistake puts it back at once, up
 *                     to the highest figure the business has legitimately held;
 *                     going higher than that is still a request to Splash.
 *   monthly           The monthly limit holds at run time, not only when an allowance
 *                     is asked for: the last 30 days of automatic payments count.
 *   no fail-open      A run that is not told the business's limit is handed back.
 *   notices           When a limit has already started, the owners get one notice
 *                     (it started), not an "it will start" followed by "it started".
 *   the queue         Splash staff see the latest decisions first and how many
 *                     earlier requests the business has made; two staff deciding at
 *                     once decide once.
 *
 * PGlite with every migration (and, for the first, the migrations up to 0078, a
 * business's data, then 0079).
 */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

import { PGlite } from '@electric-sql/pglite';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';

import { migratedDb } from './helpers/store-db.mjs';
import * as schema from '../lib/db/schema.ts';
import { evaluateAutoRun } from '../lib/schedule/auto-check.ts';
import { FALLBACK_TEXT } from '../lib/schedule/rules.ts';
import {
  currentLimits,
  decideLimitRequestForStaff,
  listLimitRequestsForStaff,
  lowerLimit,
  readLimitsView,
  requestHigherLimit,
  restoreLimit,
  runLimitChangesForCron,
  sendLimitNotices,
} from '../lib/server/business-limits.ts';
import { appointFinanceLead } from '../lib/server/team-admin.ts';
import { listAuthorityEvents } from '../lib/server/wallet-authority.ts';
import { DEFAULT_LIMITS, LIMIT_CEILINGS, allowanceLimitProblems, effectiveDailyCap, effectiveAtMs, lowerNeedsConfirm, restoreProblems } from '../lib/limits/rules.ts';

const U = (usdc) => BigInt(Math.round(usdc * 1_000_000));
const T0 = new Date('2026-11-02T09:00:00Z');
const H = 3_600_000;
const at = (ms) => () => new Date(ms);
const VERIFIED = new Date('2026-10-01T00:00:00Z');
const REASON = 'We now pay six suppliers on the first of each month.';
const COMPLIANCE = { email: 'mariam@splash.test', role: 'compliance' };
const OPERATIONS = { email: 'ops@splash.test', role: 'operations' };

let seq = 0;
const key = () => `keep-key-${String(++seq).padStart(6, '0')}`;

async function seeded() {
  const { client, db } = await migratedDb();
  const people = [
    ['u-owner', 'owner@acme.test', 'acme', 'admin'],
    ['u-lead', 'lead@acme.test', 'acme', 'checker'],
    ['u-maker', 'maker@acme.test', 'acme', 'maker'],
    ['u-n-owner', 'owner@northwind.test', 'northwind', 'admin'],
  ];
  for (const [id, email, org, role] of people) {
    await db.insert(schema.users).values({ id, email, name: id, emailVerifiedAt: VERIFIED });
    await db.insert(schema.memberships).values({ id: `m-${id}`, userId: id, orgId: org, role });
  }
  const appointed = await appointFinanceLead(db, { orgId: 'acme', actorUserId: 'u-owner', userId: 'u-lead', now: () => T0 });
  assert.equal(appointed.ok, true, JSON.stringify(appointed));
  return { client, db };
}
const ask = (db, over = {}) => requestHigherLimit(db, { orgId: 'acme', actorUserId: 'u-owner', kind: 'daily', requested: '8,000', reason: REASON, requestKey: key(), now: at(T0.getTime()), ...over });
const decide = (db, id, over = {}) => decideLimitRequestForStaff(db, { requestId: id, staff: COMPLIANCE, action: 'approve', now: at(T0.getTime() + H), ...over });
const lower = (db, kind, value, over = {}) => lowerLimit(db, { orgId: 'acme', actorUserId: 'u-owner', kind, value, now: at(T0.getTime()), ...over });
const restore = (db, kind, value, over = {}) => restoreLimit(db, { orgId: 'acme', actorUserId: 'u-owner', kind, value, now: at(T0.getTime() + H), ...over });
const actions = async (db, orgId = 'acme') => (await listAuthorityEvents(db, orgId)).map((e) => e.action);

/** Approve a request and let its 24 hour notice pass, so the higher limit is in force. */
async function raised(db, kind, requested) {
  const made = await ask(db, { kind, requested });
  assert.equal(made.ok, true, JSON.stringify(made));
  assert.equal((await decide(db, made.request.id)).ok, true);
  const start = effectiveAtMs(T0.getTime() + H);
  await currentLimits(db, 'acme', at(start));
  return start;
}

// ─── 1. A business that already runs keeps what it runs on ──────────────────

async function dbBefore0079() {
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
  const before = files.filter((f) => f < '0079');
  const after = files.filter((f) => f >= '0079');
  assert.ok(after.length > 0, 'migration 0079 exists');
  await run(before);
  return { client, db, apply: () => run(after) };
}

const signingRequest = (id, org, status) =>
  `INSERT INTO wallet_signing_requests (id, org_id, purpose, dedupe_key, sender_address, signer_kind, threshold, gas_mode, tx_bytes, tx_digest, bytes_hash, summary, status, requested_by, expires_at)
   VALUES ('${id}', '${org}', 'wallet_membership', 'dk-${id}', '0x${'aa'.repeat(32)}', 'single', 1, 'sponsored', 'bytes', 'digest-${id}', 'hash-${id}', '{}'::jsonb, '${status}', 'u-1', now() + interval '1 day')`;
const allowanceEvent = (id, org, ref, per, monthly, days, createdAt) =>
  `INSERT INTO wallet_authority_events (id, org_id, actor_user_id, action, ref, detail, created_at)
   VALUES ('${id}', '${org}', 'u-1', 'automatic_allowance_requested', '${ref}', '{"perPaymentMinor":"${per}","dailyMinor":"0","monthlyMinor":"${monthly}","days":${days}}'::jsonb, '${createdAt}')`;

test('migration 0079: a business already running on a bigger allowance or daily limit keeps it, up to the ceilings, and nothing else gets a row', async () => {
  const { client, db, apply } = await dbBefore0079();
  await client.exec(`INSERT INTO organizations (id, name) VALUES ('acme', 'Acme'), ('bigco', 'Bigco'), ('small', 'Small'), ('plain', 'Plain'), ('failed', 'Failed')`);
  await client.exec(`INSERT INTO users (id, email, name) VALUES ('u-1', 'u1@example.test', 'U1')`);
  // Acme: an older allowance (9,000 a payment) and the one that is running now (5,000 a payment, 30,000 a month, 180 days), a daily limit of 8,000.
  await client.exec(signingRequest('wsr-old', 'acme', 'executed'));
  await client.exec(signingRequest('wsr-now', 'acme', 'executed'));
  await client.exec(signingRequest('wsr-bad', 'acme', 'failed'));
  await client.exec(allowanceEvent('wae-1', 'acme', 'wsr-old', U(9_000), U(40_000), 365, '2026-09-01T00:00:00Z'));
  await client.exec(allowanceEvent('wae-2', 'acme', 'wsr-now', U(5_000), U(30_000), 180, '2026-10-01T00:00:00Z'));
  await client.exec(allowanceEvent('wae-3', 'acme', 'wsr-bad', U(10_000), U(90_000), 366, '2026-10-15T00:00:00Z'));
  await client.exec(`INSERT INTO scheduled_payment_settings (org_id, daily_cap_minor) VALUES ('acme', ${U(8_000)}), ('bigco', ${U(90_000)}), ('small', ${U(3_000)})`);
  // Bigco asked for more than any ceiling.
  await client.exec(signingRequest('wsr-big', 'bigco', 'executed'));
  await client.exec(allowanceEvent('wae-4', 'bigco', 'wsr-big', U(20_000), U(900_000), 366, '2026-10-01T00:00:00Z'));
  // Small is below the standard on everything; Plain has nothing; Failed's only allowance never executed.
  await client.exec(signingRequest('wsr-small', 'small', 'executed'));
  await client.exec(allowanceEvent('wae-5', 'small', 'wsr-small', U(1_500), U(6_000), 30, '2026-10-01T00:00:00Z'));
  await client.exec(signingRequest('wsr-f', 'failed', 'failed'));
  await client.exec(allowanceEvent('wae-6', 'failed', 'wsr-f', U(7_000), U(70_000), 300, '2026-10-01T00:00:00Z'));

  await apply();

  const acme = await currentLimits(db, 'acme', at(T0.getTime()));
  assert.deepEqual({ ...acme }, { per_payment: U(5_000), daily: U(8_000), monthly: U(30_000), days: 180n }, 'the allowance that is running, and the owners’ daily limit');
  const big = await currentLimits(db, 'bigco', at(T0.getTime()));
  assert.deepEqual({ ...big }, { per_payment: LIMIT_CEILINGS.per_payment, daily: LIMIT_CEILINGS.daily, monthly: LIMIT_CEILINGS.monthly, days: LIMIT_CEILINGS.days }, 'never above a ceiling');
  for (const org of ['small', 'plain', 'failed']) {
    assert.deepEqual({ ...(await currentLimits(db, org, at(T0.getTime()))) }, { ...DEFAULT_LIMITS }, `${org} keeps the standard`);
  }
  const rows = await db.select().from(schema.businessLimits);
  assert.equal(rows.filter((r) => r.orgId === 'acme').length, 4);
  assert.equal(rows.filter((r) => ['small', 'plain', 'failed'].includes(r.orgId)).length, 0, 'no row where the standard already covers it');
  for (const r of rows) {
    assert.equal(r.changedBy, 'system:migration');
    assert.equal(r.source, 'raised');
    assert.equal(r.heldMax, r.value, 'what it keeps is the highest it has held');
  }
  const trail = await listAuthorityEvents(db, 'acme');
  const kept = trail.filter((e) => e.action === 'limit_change_applied');
  assert.equal(kept.length, 4, 'one line on the trail per limit kept');
  assert.ok(kept.every((e) => e.actorUserId === 'system:migration'));
  assert.equal(trail.filter((e) => e.actorUserId === 'system:migration' && e.detail.kind === 'daily')[0].detail.after, U(8_000).toString());
  // The view says why, in words that are true.
  await db.insert(schema.memberships).values({ id: 'm-u-1', userId: 'u-1', orgId: 'acme', role: 'admin' });
  const view = await readLimitsView(db, { orgId: 'acme', userId: 'u-1', now: at(T0.getTime()) });
  assert.equal(view.ok, true, JSON.stringify(view));
  const per = view.view.limits.find((l) => l.kind === 'per_payment');
  assert.match(per.why, /already ran on this before limits/i);
  assert.doesNotMatch(per.why, /because you asked/i);
});

test('a business that was already paying 5,000 a payment is still paid automatically after the migration, and the form still takes the allowance it has', async () => {
  const { client, db, apply } = await dbBefore0079();
  await client.exec(`INSERT INTO organizations (id, name) VALUES ('acme', 'Acme')`);
  await client.exec(`INSERT INTO users (id, email, name) VALUES ('u-1', 'u1@example.test', 'U1')`);
  await client.exec(signingRequest('wsr-now', 'acme', 'executed'));
  await client.exec(allowanceEvent('wae-2', 'acme', 'wsr-now', U(5_000), U(30_000), 180, '2026-10-01T00:00:00Z'));
  await client.exec(`INSERT INTO scheduled_payment_settings (org_id, daily_cap_minor) VALUES ('acme', ${U(8_000)})`);
  await apply();
  const limits = await currentLimits(db, 'acme', at(T0.getTime()));
  const A = '0x' + '71'.repeat(32);
  const amountMinor = U(4_000);
  const fee = U(0.8);
  const verdict = evaluateAutoRun(
    {
      nowMs: T0.getTime(), settleWindowMs: 15 * 60_000, paused: false, ownerCreated: true, payerReady: true, sponsorReady: true, ruleReadable: true,
      rule: { status: 'active', perPaymentMaxMinor: U(5_000).toString(), spendableNowMinor: U(30_000).toString(), startsAtMs: null, expiresAtMs: String(T0.getTime() + 90 * 86_400_000), renewsAtMs: String(T0.getTime() + 20 * 86_400_000) },
      policy: { secondApprovalThresholdMinor: U(10_000).toString(), recipients: [{ address: A, tag: 'wallet' }] },
      runningTotals: {},
      dailyCapMinor: effectiveDailyCap(U(8_000), limits),
      perPaymentLimitMinor: limits.per_payment,
      monthlyLimitMinor: limits.monthly,
      dailyUsedMinor: 0n,
      monthlyUsedMinor: 0n,
      walletBalanceMinor: U(50_000),
    },
    [{ position: 1, name: 'Santos Supplies Inc', saved: { address: A, amountMinor, feeMinor: fee, feeKind: 1 }, now: { address: A, kind: 1 }, paidBefore: true, cleared: true, currentFeeMinor: fee }],
  );
  assert.equal(verdict.ok, true, String(verdict.text));
  assert.equal(effectiveDailyCap(U(8_000), limits), U(8_000), 'the 8,000 daily limit the owners set is not cut back to 5,000');
  const form = { perPaymentMinor: U(5_000), dailyMinor: U(8_000), monthlyMinor: U(30_000), expiresInDays: 180 };
  assert.deepEqual(allowanceLimitProblems(form, limits), [], 'the owners can give the same allowance again');
});

// ─── 2. Restore: an owner undoes their own lowering at once ─────────────────

test('an owner who lowers a limit by mistake puts it back at once, with nothing asked of Splash', async () => {
  const { db } = await seeded();
  assert.equal((await lower(db, 'per_payment', '2')).ok, true);
  assert.equal((await currentLimits(db, 'acme', at(T0.getTime()))).per_payment, U(2));
  const back = await restore(db, 'per_payment', '2,000');
  assert.equal(back.ok, true, JSON.stringify(back));
  assert.equal(back.current, U(2_000).toString());
  assert.equal((await currentLimits(db, 'acme', at(T0.getTime() + H))).per_payment, U(2_000), 'in force at once, with no notice');
  assert.equal((await db.select().from(schema.businessLimitRequests)).length, 0, 'and no request was made');
  const event = (await listAuthorityEvents(db, 'acme')).find((e) => e.action === 'limit_restored');
  assert.ok(event, 'the trail has a line for it');
  assert.equal(event.actorUserId, 'u-owner');
  assert.equal(event.detail.before, U(2).toString());
  assert.equal(event.detail.after, U(2_000).toString());
});

test('putting a limit back twice to the same figure is one change, not an error and not a second line on the trail', async () => {
  const { db } = await seeded();
  await lower(db, 'monthly', '1,000');
  const first = await restore(db, 'monthly', '20,000');
  const again = await restore(db, 'monthly', '20,000');
  assert.equal(first.ok, true);
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal((await actions(db)).filter((a) => a === 'limit_restored').length, 1);
});

test('restore goes up to the highest figure the business has held, and no higher; a figure that is not higher is refused', async () => {
  const { db } = await seeded();
  await lower(db, 'daily', '100');
  const high = await restore(db, 'daily', '5,001');
  assert.equal(high.ok, false);
  assert.equal(high.status, 400);
  assert.equal(high.code, 'above_held');
  assert.match(high.error, /5,000 USDC/);
  assert.match(high.error, /ask Splash/i);
  const same = await restore(db, 'daily', '100');
  assert.equal(same.ok, false);
  assert.equal(same.status, 400);
  const part = await restore(db, 'daily', '1,000');
  assert.equal(part.ok, true);
  assert.equal((await currentLimits(db, 'acme', at(T0.getTime() + H))).daily, U(1_000));
  const rest = await restore(db, 'daily', '5,000', { now: at(T0.getTime() + 2 * H) });
  assert.equal(rest.ok, true, 'and the rest of the way later');
  assert.equal((await currentLimits(db, 'acme', at(T0.getTime() + 2 * H))).daily, U(5_000));
  const notLowered = await restore(db, 'monthly', '25,000');
  assert.equal(notLowered.ok, false, 'a limit that was never lowered has nothing to restore');
  assert.equal(notLowered.code, 'above_held');
});

test('a limit Splash raised is remembered: after lowering it, the owner restores the raised figure at once', async () => {
  const { db } = await seeded();
  const start = await raised(db, 'per_payment', '5,000');
  assert.equal((await currentLimits(db, 'acme', at(start))).per_payment, U(5_000));
  const low = await lower(db, 'per_payment', '100', { now: at(start + H) });
  assert.equal(low.ok, true);
  const back = await restore(db, 'per_payment', '5,000', { now: at(start + 2 * H) });
  assert.equal(back.ok, true, JSON.stringify(back));
  assert.equal((await currentLimits(db, 'acme', at(start + 2 * H))).per_payment, U(5_000));
  const past = await restore(db, 'per_payment', '6,000', { now: at(start + 2 * H) });
  assert.equal(past.code, 'above_held', 'past what was granted is a request');
});

test('asking Splash for a figure the business already held is pointed to Restore; a figure above it is a request as before', async () => {
  const { db } = await seeded();
  await lower(db, 'per_payment', '2');
  const same = await ask(db, { kind: 'per_payment', requested: '2,000' });
  assert.equal(same.ok, false);
  assert.equal(same.status, 409);
  assert.equal(same.code, 'restore_instead');
  assert.match(same.error, /Restore/);
  const more = await ask(db, { kind: 'per_payment', requested: '3,000' });
  assert.equal(more.ok, true, 'above what it held is a request to Splash');
  const back = await restore(db, 'per_payment', '2,000');
  assert.equal(back.ok, true);
  assert.equal((await db.select().from(schema.businessLimitRequests)).filter((r) => r.status === 'pending').length, 1, 'the request above stays open');
});

test('only an owner restores; the Finance lead and other businesses are refused, and one business’s restore touches no other', async () => {
  const { db } = await seeded();
  await lower(db, 'daily', '100');
  for (const [who, code] of [['u-lead', 'owner_only'], ['u-maker', 'not_allowed'], ['u-n-owner', 'not_allowed']]) {
    const r = await restore(db, 'daily', '1,000', { actorUserId: who });
    assert.equal(r.ok, false, who);
    assert.equal(r.status, 403, who);
    assert.equal(r.code, code, who);
  }
  assert.equal((await currentLimits(db, 'acme', at(T0.getTime() + H))).daily, U(100));
  await lowerLimit(db, { orgId: 'northwind', actorUserId: 'u-n-owner', kind: 'daily', value: '50', now: at(T0.getTime()) });
  assert.equal((await restore(db, 'daily', '1,000')).ok, true);
  assert.equal((await currentLimits(db, 'northwind', at(T0.getTime() + H))).daily, U(50), 'northwind is untouched');
});

test('the view tells the owner what can be put back', async () => {
  const { db } = await seeded();
  await lower(db, 'monthly', '1,000');
  const view = await readLimitsView(db, { orgId: 'acme', userId: 'u-owner', now: at(T0.getTime()) });
  const monthly = view.view.limits.find((l) => l.kind === 'monthly');
  assert.equal(monthly.canRestore, true);
  assert.equal(monthly.heldWords, '20,000 USDC');
  assert.equal(monthly.source, 'lowered');
  const daily = view.view.limits.find((l) => l.kind === 'daily');
  assert.equal(daily.canRestore, false, 'a limit at its highest has nothing to put back');
  await restore(db, 'monthly', '20,000');
  const after = (await readLimitsView(db, { orgId: 'acme', userId: 'u-owner', now: at(T0.getTime() + H) })).view.limits.find((l) => l.kind === 'monthly');
  assert.equal(after.canRestore, false);
  assert.equal(after.source, 'restored');
  assert.match(after.why, /put it back/i);
});

test('the pure rules: what restore accepts, and when a lowering asks for a second look', () => {
  assert.deepEqual(restoreProblems('per_payment', U(1_500), U(100), U(2_000)), []);
  assert.equal(restoreProblems('per_payment', U(2_500), U(100), U(2_000)).length, 1);
  assert.equal(restoreProblems('per_payment', U(100), U(100), U(2_000)).length, 1);
  assert.equal(restoreProblems('days', 60n, 7n, 90n).length, 0);
  assert.equal(lowerNeedsConfirm('per_payment', U(2), U(2_000)), true, '2 for 2,000 looks like a missing zero');
  assert.equal(lowerNeedsConfirm('per_payment', U(199.99), U(2_000)), true, 'under a tenth');
  assert.equal(lowerNeedsConfirm('per_payment', U(200), U(2_000)), false, 'a tenth or more');
  assert.equal(lowerNeedsConfirm('days', 5n, 90n), true);
  assert.equal(lowerNeedsConfirm('days', 30n, 90n), false);
});

// ─── 3. The monthly limit holds at run time; a missing limit hands the run back ──

const NOW = Date.parse('2026-11-03T16:00:00Z');
const PAYEE = '0x' + '71'.repeat(32);
const fee = (amount) => ((amount * 2n) / 10_000n > U(0.25) ? (amount * 2n) / 10_000n : U(0.25));
const facts = (over = {}) => ({
  nowMs: NOW, settleWindowMs: 15 * 60_000, paused: false, ownerCreated: true, payerReady: true, sponsorReady: true, ruleReadable: true,
  rule: { status: 'active', perPaymentMaxMinor: U(2_000).toString(), spendableNowMinor: U(30_000).toString(), startsAtMs: null, expiresAtMs: String(NOW + 90 * 86_400_000), renewsAtMs: String(NOW + 20 * 86_400_000) },
  policy: { secondApprovalThresholdMinor: U(10_000).toString(), recipients: [{ address: PAYEE, tag: 'wallet' }] },
  runningTotals: {}, dailyCapMinor: U(5_000), perPaymentLimitMinor: U(2_000), monthlyLimitMinor: U(20_000), dailyUsedMinor: 0n, monthlyUsedMinor: 0n, walletBalanceMinor: U(50_000), ...over,
});
const item = (usdc) => {
  const amountMinor = U(usdc);
  return { position: 1, name: 'Santos Supplies Inc', saved: { address: PAYEE, amountMinor, feeMinor: fee(amountMinor), feeKind: 1 }, now: { address: PAYEE, kind: 1 }, paidBefore: true, cleared: true, currentFeeMinor: fee(amountMinor) };
};

test('the last 30 days of automatic payments count against the monthly limit: over it hands the run back, exactly at it is paid', () => {
  const run = [item(500)];
  const need = U(500) + fee(U(500));
  assert.equal(evaluateAutoRun(facts({ monthlyUsedMinor: U(20_000) - need }), run).ok, true, 'exactly at the limit is paid');
  const over = evaluateAutoRun(facts({ monthlyUsedMinor: U(20_000) - need + 1n }), run);
  assert.equal(over.ok, false);
  assert.equal(over.code, 'monthly_limit');
  assert.match(over.text, /monthly limit/);
  assert.equal(over.text, FALLBACK_TEXT.monthly_limit);
  assert.equal(evaluateAutoRun(facts({ monthlyLimitMinor: U(300) }), run).code, 'monthly_limit', 'a limit the owners lowered after signing the allowance holds');
});

test('a run that is not told the business’s limits is handed back, not paid', () => {
  const run = [item(500)];
  const noPer = facts();
  delete noPer.perPaymentLimitMinor;
  assert.equal(evaluateAutoRun(noPer, run).ok, false, 'no per-payment limit given');
  assert.equal(evaluateAutoRun(noPer, run).code, 'over_payment_limit');
  const noMonthly = facts();
  delete noMonthly.monthlyLimitMinor;
  assert.equal(evaluateAutoRun(noMonthly, run).ok, false, 'no monthly limit given');
});

// ─── 4. One notice when a limit has already started ─────────────────────────

test('when the approval notice never reached the owners and the limit has now started, they get the started notice alone', async () => {
  const { db } = await seeded();
  const made = await ask(db, { kind: 'daily', requested: '8,000' });
  assert.equal((await decide(db, made.request.id)).ok, true);
  const sent = [];
  // First send: nobody is reached.
  const first = await sendLimitNotices(db, { notify: async () => 0, now: at(T0.getTime() + H) });
  assert.equal(first.failed, 1);
  const start = effectiveAtMs(T0.getTime() + H);
  const cron = await runLimitChangesForCron(db, { notify: async (_org, n) => { sent.push(n); return 1; }, now: at(start + 60_000) });
  assert.equal(cron.applied, 1);
  assert.equal(sent.length, 1, 'one notice');
  assert.match(sent[0].subject, /has started/i);
  assert.doesNotMatch(sent[0].text, /Until then your limit stays/);
  const again = await runLimitChangesForCron(db, { notify: async (_org, n) => { sent.push(n); return 1; }, now: at(start + 120_000) });
  assert.equal(again.sent, 0, 'and nothing more');
});

// ─── 5. The staff queue ──────────────────────────────────────────────────────

test('the queue shows the latest decisions first, and how many earlier requests the business has made', async () => {
  const { db } = await seeded();
  const a = await ask(db, { kind: 'daily', requested: '8,000' });
  const b = await ask(db, { kind: 'monthly', requested: '30,000' });
  const c = await ask(db, { kind: 'per_payment', requested: '3,000' });
  // Decided in the order c, a, b: the queue must show b, a, c.
  assert.equal((await decide(db, c.request.id, { now: at(T0.getTime() + 1 * H) })).ok, true);
  assert.equal((await decide(db, a.request.id, { action: 'decline', reason: 'Please send your bank statement first.', now: at(T0.getTime() + 2 * H) })).ok, true);
  assert.equal((await decide(db, b.request.id, { now: at(T0.getTime() + 3 * H) })).ok, true);
  const list = await listLimitRequestsForStaff(db, COMPLIANCE, at(T0.getTime() + 4 * H));
  assert.equal(list.ok, true);
  assert.deepEqual(list.recent.map((r) => r.id), [b.request.id, a.request.id, c.request.id]);
  const d = await ask(db, { kind: 'days', requested: '120', requestKey: key(), now: at(T0.getTime() + 5 * H) });
  const after = await listLimitRequestsForStaff(db, COMPLIANCE, at(T0.getTime() + 6 * H));
  const open = after.open.find((r) => r.id === d.request.id);
  assert.equal(open.earlierRequests, 3, 'three earlier requests from this business');
});

test('two staff deciding the same request at once decide it once: one wins, the other is told it was decided', async () => {
  const { db } = await seeded();
  const made = await ask(db);
  const [x, y] = await Promise.all([
    decide(db, made.request.id, { staff: COMPLIANCE, action: 'approve' }),
    decide(db, made.request.id, { staff: OPERATIONS, action: 'decline', reason: 'We need more about the business first.' }),
  ]);
  const results = [x, y];
  assert.equal(results.filter((r) => r.ok && !r.replayed).length, 1, 'exactly one decision was made');
  const loser = results.find((r) => !r.ok);
  assert.ok(loser, 'the other is refused');
  assert.equal(loser.status, 409);
  assert.equal(loser.code, 'already_decided');
  const trail = await actions(db);
  assert.equal(trail.filter((a) => a === 'limit_request_approved' || a === 'limit_request_declined').length, 1, 'one line on the trail');
  const [row] = await db.select().from(schema.businessLimitRequests).where(and(eq(schema.businessLimitRequests.id, made.request.id)));
  assert.ok(row.status === 'approved' || row.status === 'declined');
});
