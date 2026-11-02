/**
 * When nobody who can approve answers (v2 Phase 3, p3-no-approver; Sky's question).
 *
 * Money is never approved by default, by Splash, or by a timer. A request that waits for people who can
 * approve it is told to them at 0, 10 minutes, 1 hour and 4 hours (each ONCE, however often the cron runs),
 * the person who asked is told at 10 minutes who was asked, and a request nobody approves lapses UNPAID at
 * its existing end, in plain words, to the person who asked and to the owners. A late approval is refused in
 * the same words. A real database (PGlite with every migration) and an injected clock; no timer anywhere.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { and, eq } from 'drizzle-orm';

import { migratedDb } from './helpers/store-db.mjs';
import * as schema from '../lib/db/schema.ts';
import { LADDER, LAPSE_WORDS, MIN_APPROVERS, REMIND_NOW_COOLDOWN_MS, fewApproversWarning, stepToSend } from '../lib/approve/wait.ts';
import { loadSubject, remindNow, sweepApprovalWaitsForStaff, tellApproversNow, waitingFor } from '../lib/server/approval-wait.ts';
import { listAuthorityEvents } from '../lib/server/wallet-authority.ts';
import { expireSigningRequestsForStaff } from '../lib/server/wallet-signing-store.ts';
import { submitPartialSignature } from '../lib/server/wallet-signing.ts';
import { acceptApprovalAsk } from '../lib/server/payment-approval-asks.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = new Date('2026-11-02T09:00:00Z');
const at = (ms) => new Date(T0.getTime() + ms);
const ENV = { NODE_ENV: 'test' };
const APP = 'http://localhost:3000';

const PEOPLE = [
  ['u-owner', 'Asha Rahman', 'owner@acme.test', 'acme', 'admin', null],
  ['u-owner2', 'Ben Okafor', 'owner2@acme.test', 'acme', 'admin', 'CFO'],
  ['u-owner3', 'Chen Wei', 'owner3@acme.test', 'acme', 'admin', null],
  ['u-maker', 'Dana Maker', 'maker@acme.test', 'acme', 'maker', null],
  ['u-appr', 'Eli Approver', 'appr@acme.test', 'acme', 'checker', null],
  ['u-viewer', 'Fay Viewer', 'viewer@acme.test', 'acme', 'viewer', null],
  ['u-n-owner', 'Nora North', 'owner@northwind.test', 'northwind', 'admin', null],
  ['u-n-maker', 'Noel North', 'maker@northwind.test', 'northwind', 'maker', null],
];

async function seeded() {
  const { client, db } = await migratedDb();
  for (const [id, name, email, org, role, title] of PEOPLE) {
    await db.insert(schema.users).values({ id, email, name, emailVerifiedAt: T0 });
    await db.insert(schema.memberships).values({ id: `m-${id}`, userId: id, orgId: org, role, title });
  }
  return { client, db };
}

/** A mailbox that records every message and can be told to fail. */
function mailbox(fail = () => false) {
  const sent = [];
  let calls = 0;
  return {
    sent,
    get calls() { return calls; },
    async sendMessage(message) {
      calls += 1;
      if (fail(calls, message)) throw new Error('provider refused');
      sent.push(message);
      return { providerRef: `ref-${calls}` };
    },
  };
}

let seq = 0;
/** A request collecting signatures, written straight into the table: the ladder reads state, not bytes. */
async function signing(db, over = {}) {
  const { id = `wsr_${randomUUID()}`, orgId = 'acme', requestedBy = 'u-owner', signers = ['u-owner', 'u-owner2', 'u-owner3'], createdAt = T0, ttlMs = 24 * HOUR, purpose = 'wallet_payment', status = 'collecting' } = over;
  seq += 1;
  await db.insert(schema.walletSigningRequests).values({
    id, orgId, purpose, dedupeKey: id, senderAddress: `0x${'ab'.repeat(32)}`, signerKind: 'multisig', multisigPublicKey: 'msig', threshold: 2, gasMode: 'sponsored',
    txBytes: 'AAAA', txDigest: `digest-${id}`, bytesHash: 'h'.repeat(64), summary: {}, status, requestedBy, expiresAt: new Date(createdAt.getTime() + ttlMs), createdAt,
  });
  await db.insert(schema.walletSigningSigners).values(
    signers.map((userId, i) => ({ requestId: id, orgId, userId, address: `0x${String(seq * 10 + i).padStart(2, '0').repeat(32)}`.slice(0, 66), publicKey: `pk-${id}-${userId}`, weight: 1 })),
  );
  return id;
}

async function ask(db, over = {}) {
  const { id = `wpa_${randomUUID()}`, orgId = 'acme', requestedBy = 'u-maker', createdAt = T0, ttlMs = 24 * HOUR, status = 'open' } = over;
  await db.insert(schema.walletApprovalAsks).values({
    id, orgId, intentId: `0x${randomUUID().replace(/-/g, '').padEnd(64, '0')}`, requestedBy, intent: { source: 'intent', amountMinor: '25000000000' }, note: null,
    contentHash: 'c'.repeat(64), walrusBlobId: 'ab', status, expiresAt: new Date(createdAt.getTime() + ttlMs), createdAt, updatedAt: createdAt,
  });
  return id;
}

const sweep = (db, now, mail, over = {}) => sweepApprovalWaitsForStaff(db, { now: () => now, mail, appUrl: APP, env: ENV, ...over });
const stepsOf = async (db, id) => (await db.select().from(schema.approvalWaitSteps).where(eq(schema.approvalWaitSteps.subjectId, id))).map((r) => r.step).sort();
const noticesOf = (db, id, step) => db.select().from(schema.approvalNotices).where(step ? and(eq(schema.approvalNotices.subjectId, id), eq(schema.approvalNotices.step, step)) : eq(schema.approvalNotices.subjectId, id));
const who = (rows) => rows.map((r) => r.userId).sort();

// ─── The ladder's timing is one constant, and the choice of step is pure ────

test('the ladder is 0, 10 minutes, 1 hour and 4 hours, written once; the step to send is pure', () => {
  assert.deepEqual(LADDER.map((l) => [l.step, l.afterMs]), [['asked', 0], ['reminder_10m', 10 * MIN], ['reminder_1h', HOUR], ['reminder_4h', 4 * HOUR]]);
  assert.equal(REMIND_NOW_COOLDOWN_MS, 10 * MIN);
  assert.equal(MIN_APPROVERS, 3);
  const none = new Set();
  assert.equal(stepToSend(0, none), 'asked');
  assert.equal(stepToSend(9 * MIN, new Set(['asked'])), null);
  assert.equal(stepToSend(10 * MIN, new Set(['asked'])), 'reminder_10m');
  assert.equal(stepToSend(10 * MIN, new Set(['asked', 'reminder_10m'])), null, 'a step already sent is never sent again');
  assert.equal(stepToSend(HOUR, new Set(['asked', 'reminder_10m'])), 'reminder_1h');
  assert.equal(stepToSend(4 * HOUR, new Set(['asked', 'reminder_10m', 'reminder_1h'])), 'reminder_4h');
  // A cron that was down is not a flood: the approvers hear "asked" first, then only the latest step that is due.
  assert.equal(stepToSend(5 * HOUR, none), 'asked');
  assert.equal(stepToSend(5 * HOUR, new Set(['asked'])), 'reminder_4h');
  assert.equal(stepToSend(5 * HOUR, new Set(['asked', 'reminder_4h'])), null, 'an earlier step is never made up after a later one');
});

test('the Limits and Team warning counts people, says it plainly and blocks nothing', () => {
  assert.equal(fewApproversWarning(3), null);
  assert.equal(fewApproversWarning(12), null);
  assert.equal(fewApproversWarning(2), 'Only 2 people can approve payments. If they are all away, payments wait. Add another approver.');
  assert.equal(fewApproversWarning(1), 'Only 1 person can approve payments. If they are all away, payments wait. Add another approver.');
  assert.match(fewApproversWarning(0), /^Nobody can approve payments/);
});

// ─── A request waiting for signatures ───────────────────────────────────────

test('notices go out at 0, 10 minutes, 1 hour and 4 hours, each exactly once, even if the cron runs twice', async () => {
  const { client, db } = await seeded();
  const id = await signing(db);
  const mail = mailbox();

  // 0: every person who can approve it, at once, in the app and by e-mail. The person who asked is in the app already.
  const first = await sweep(db, at(0), mail);
  assert.deepEqual(first.steps, [{ kind: 'signing', step: 'asked' }]);
  assert.deepEqual(who(await noticesOf(db, id, 'asked')), ['u-owner2', 'u-owner3']);
  assert.deepEqual(mail.sent.map((m) => m.to).sort(), ['owner2@acme.test', 'owner3@acme.test']);
  const again = await sweep(db, at(0), mail);
  assert.deepEqual(again.steps, [], 'the cron ran twice: nothing is sent twice');
  assert.equal(mail.sent.length, 2);

  // Nothing between steps.
  assert.deepEqual((await sweep(db, at(9 * MIN), mail)).steps, []);
  assert.deepEqual((await sweep(db, at(9 * MIN + 59_999), mail)).steps, []);

  // 10 minutes: the approvers again, and the person who asked is told plainly who was asked.
  assert.deepEqual((await sweep(db, at(10 * MIN), mail)).steps, [{ kind: 'signing', step: 'reminder_10m' }]);
  assert.deepEqual((await sweep(db, at(10 * MIN), mail)).steps, []);
  assert.deepEqual(who(await noticesOf(db, id, 'reminder_10m')), ['u-owner', 'u-owner2', 'u-owner3']);
  const [mine] = (await noticesOf(db, id, 'reminder_10m')).filter((n) => n.userId === 'u-owner');
  assert.equal(mine.audience, 'requester');
  assert.match(mine.body, /Nobody has answered/);
  assert.match(mine.body, /Ben Okafor \(CFO\)/, 'who was asked, with their title');
  assert.match(mine.body, /Chen Wei \(Owner\)/);
  assert.doesNotMatch(mine.body, /Asha Rahman/, 'the person who asked is not listed as asked');
  assert.equal(mail.sent.length, 2 + 3);

  assert.deepEqual((await sweep(db, at(HOUR - 1), mail)).steps, []);
  assert.deepEqual((await sweep(db, at(HOUR), mail)).steps, [{ kind: 'signing', step: 'reminder_1h' }]);
  assert.deepEqual((await sweep(db, at(HOUR), mail)).steps, []);
  assert.deepEqual((await sweep(db, at(4 * HOUR - 1), mail)).steps, []);
  assert.deepEqual((await sweep(db, at(4 * HOUR), mail)).steps, [{ kind: 'signing', step: 'reminder_4h' }]);
  assert.deepEqual((await sweep(db, at(4 * HOUR), mail)).steps, []);
  assert.deepEqual((await sweep(db, at(10 * HOUR), mail)).steps, [], 'after the 4 hour reminder there is nothing more until it ends');

  assert.deepEqual(await stepsOf(db, id), ['asked', 'reminder_10m', 'reminder_1h', 'reminder_4h']);
  const perStep = Object.fromEntries(LADDER.map((l) => [l.step, 0]));
  for (const n of await noticesOf(db, id)) perStep[n.step] += 1;
  assert.deepEqual(perStep, { asked: 2, reminder_10m: 3, reminder_1h: 3, reminder_4h: 3 });
  await client.close();
});

test('two crons at the same moment send each step once', async () => {
  const { client, db } = await seeded();
  const id = await signing(db);
  const mail = mailbox();
  await Promise.all([sweep(db, at(0), mail), sweep(db, at(0), mail), tellApproversNow(db, { orgId: 'acme', kind: 'signing', id }, { now: () => at(0), mail, appUrl: APP, env: ENV })]);
  assert.deepEqual(await stepsOf(db, id), ['asked']);
  assert.equal((await noticesOf(db, id)).length, 2);
  assert.equal(mail.sent.length, 2, 'two e-mails, one each');
  await Promise.all([sweep(db, at(10 * MIN), mail), sweep(db, at(10 * MIN), mail)]);
  assert.equal((await noticesOf(db, id, 'reminder_10m')).length, 3);
  assert.equal(mail.sent.length, 2 + 3);
  await client.close();
});

test('a person who has signed or declined is not reminded, and a person who left is never told', async () => {
  const { client, db } = await seeded();
  const id = await signing(db, { signers: ['u-owner', 'u-owner2', 'u-owner3'] });
  const mail = mailbox();
  await sweep(db, at(0), mail);
  await db.update(schema.walletSigningSigners).set({ signedAt: at(20 * MIN) }).where(and(eq(schema.walletSigningSigners.requestId, id), eq(schema.walletSigningSigners.userId, 'u-owner2')));
  await sweep(db, at(HOUR), mail);
  assert.deepEqual(who(await noticesOf(db, id, 'reminder_1h')), ['u-owner', 'u-owner3'], 'Ben signed; Asha has not, and is a signer too');
  await db.delete(schema.memberships).where(eq(schema.memberships.userId, 'u-owner3'));
  await sweep(db, at(4 * HOUR), mail);
  assert.deepEqual(who(await noticesOf(db, id, 'reminder_4h')), ['u-owner'], 'Chen left the business: not told');
  await client.close();
});

test('every notice carries the one-tap link to the signed-in Approve page, and nothing else', async () => {
  const { client, db } = await seeded();
  const id = await signing(db);
  const mail = mailbox();
  await sweep(db, at(0), mail);
  for (const n of await noticesOf(db, id)) assert.equal(n.linkPath, `/dashboard/approve/${id}`);
  for (const m of mail.sent) {
    assert.ok(m.text.includes(`${APP}/dashboard/approve/${id}`), 'the e-mail links to the request');
    assert.doesNotMatch(m.text, /[?#]|token|code=/i, 'no query, no fragment, no token');
    assert.match(m.text, /sign in/i);
    assert.match(m.text, /nothing happens from the link alone/i);
    assert.match(m.subject, /^Needs your approval/);
  }
  const a = await waitingFor(db, { now: () => at(MIN) }, { orgId: 'acme', userId: 'u-owner2' });
  assert.equal(a.notices.length, 1);
  assert.equal(a.notices[0].linkPath, `/dashboard/approve/${id}`);
  assert.match(a.notices[0].title, /Needs your approval/);
  await client.close();
});

test('a notice never carries an amount, a payee, an address or a secret', async () => {
  const { client, db } = await seeded();
  const id = await signing(db, { purpose: 'withdrawal' });
  const mail = mailbox();
  for (const t of [0, 10 * MIN, HOUR, 4 * HOUR]) await sweep(db, at(t), mail);
  await sweep(db, at(25 * HOUR), mail);
  const all = await noticesOf(db, id);
  assert.ok(all.length >= 9);
  for (const n of all) {
    const text = `${n.title}\n${n.body}`;
    assert.doesNotMatch(text, /\d[\d,]*\.\d{2}|USDC|USD|0x[0-9a-f]{4}/i, 'no amount, asset or address');
    assert.doesNotMatch(text, /coming soon|demo|testnet|non-custodial|licen[cs]ed/i);
  }
  for (const m of mail.sent) assert.doesNotMatch(`${m.subject}${m.text}`, /\d[\d,]*\.\d{2}|USDC|0x[0-9a-f]{4}/i);
  await client.close();
});

// ─── The lapse ──────────────────────────────────────────────────────────────

test('a request nobody approves lapses unpaid at its existing end, once, to the person who asked and the owners, with a trail line', async () => {
  const { client, db } = await seeded();
  const id = await signing(db, { requestedBy: 'u-maker', signers: ['u-owner', 'u-owner2', 'u-owner3'] });
  const mail = mailbox();
  await sweep(db, at(0), mail);
  await sweep(db, at(24 * HOUR - 1), mail);
  assert.ok(!(await stepsOf(db, id)).includes('lapsed'), 'still open until its end');
  const before = mail.sent.length;

  const lapse = await sweep(db, at(24 * HOUR), mail);
  assert.equal(lapse.lapsed, 1);
  assert.deepEqual(who(await noticesOf(db, id, 'lapsed')), ['u-maker', 'u-owner', 'u-owner2', 'u-owner3']);
  const audiences = Object.fromEntries((await noticesOf(db, id, 'lapsed')).map((n) => [n.userId, n.audience]));
  assert.deepEqual(audiences, { 'u-maker': 'requester', 'u-owner': 'owner', 'u-owner2': 'owner', 'u-owner3': 'owner' });
  for (const n of await noticesOf(db, id, 'lapsed')) {
    assert.match(n.body, /Nobody approved in time\. Nothing was paid\. Ask again\./);
    assert.ok(n.body.startsWith(LAPSE_WORDS));
  }
  assert.equal(mail.sent.length - before, 4);

  // The cron runs again, and the closing sweep runs: still one lapse, one trail line.
  await sweep(db, at(24 * HOUR), mail);
  assert.equal(await expireSigningRequestsForStaff(db, at(24 * HOUR + MIN)), 1);
  await sweep(db, at(24 * HOUR + 5 * MIN), mail);
  await sweep(db, at(30 * HOUR), mail);
  assert.equal((await noticesOf(db, id, 'lapsed')).length, 4);
  assert.equal(mail.sent.length - before, 4);
  const lines = (await listAuthorityEvents(db, 'acme')).filter((e) => e.action === 'approval_lapsed');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].ref, id);
  assert.equal(lines[0].actorUserId, 'system:approval_lapse');
  const [row] = await db.select().from(schema.walletSigningRequests).where(eq(schema.walletSigningRequests.id, id));
  assert.equal(row.status, 'expired');
  assert.equal(row.executedDigest, null, 'nothing was paid');
  // No more reminders after it ended.
  assert.deepEqual(await stepsOf(db, id), ['asked', 'lapsed', 'reminder_4h'], 'the cron that came late sent the latest reminder once, and nothing after the end');
  await client.close();
});

test('a request only its own maker signs (a staff payment under their own rule, a move of their own USDC) is not waiting for anyone else', async () => {
  const { client, db } = await seeded();
  const own = await signing(db, { requestedBy: 'u-maker', signers: ['u-maker'], purpose: 'staff_rule_payment' });
  const move = await signing(db, { requestedBy: 'u-owner', signers: ['u-owner'], purpose: 'migration_transfer', ttlMs: HOUR });
  const mail = mailbox();
  for (const t of [0, 10 * MIN, HOUR, 4 * HOUR, 25 * HOUR]) await sweep(db, at(t), mail);
  for (const id of [own, move]) {
    assert.deepEqual(await stepsOf(db, id), [], 'no reminder and no lapse notice for a request nobody else was asked about');
    assert.equal((await noticesOf(db, id)).length, 0);
  }
  assert.equal(mail.sent.length, 0);
  assert.equal((await listAuthorityEvents(db, 'acme')).filter((e) => e.action === 'approval_lapsed').length, 0);
  assert.deepEqual((await waitingFor(db, { now: () => at(30 * MIN) }, { orgId: 'acme', userId: 'u-maker' })).waiting, [], 'and it is not listed as waiting for others');
  await client.close();
});

test('a request that was approved, withdrawn or declined does not lapse; one that ended long ago is history', async () => {
  const { client, db } = await seeded();
  const done = await signing(db, { status: 'executed' });
  const gone = await signing(db, { status: 'cancelled' });
  const old = await signing(db, { createdAt: new Date(T0.getTime() - 30 * 24 * HOUR), status: 'expired' });
  const mail = mailbox();
  const r = await sweep(db, at(48 * HOUR), mail);
  assert.equal(r.lapsed, 0);
  for (const id of [done, gone, old]) assert.deepEqual(await stepsOf(db, id), []);
  assert.equal(mail.sent.length, 0);
  await client.close();
});

test('a late approval of a lapsed request is refused in the same words and pays nothing', async () => {
  const { client, db } = await seeded();
  const id = await signing(db);
  const deps = { db, now: () => at(25 * HOUR) };
  const input = { orgId: 'acme', userId: 'u-owner2', id, signature: 'x', digest: `digest-${id}` };
  // Past its end but not yet closed by the sweep.
  const late = await submitPartialSignature(deps, input);
  assert.equal(late.ok, false);
  assert.equal(late.status, 410);
  assert.equal(late.error, LAPSE_WORDS);
  // After the sweep closed it.
  await expireSigningRequestsForStaff(db, at(25 * HOUR));
  const closed = await submitPartialSignature(deps, input);
  assert.equal(closed.ok, false);
  assert.equal(closed.error, LAPSE_WORDS);
  const [row] = await db.select().from(schema.walletSigningSigners).where(and(eq(schema.walletSigningSigners.requestId, id), eq(schema.walletSigningSigners.userId, 'u-owner2')));
  assert.equal(row.signedAt, null, 'no signature was kept');
  // An open request still says what it said before.
  const other = await signing(db);
  const stillOpen = await submitPartialSignature({ db, now: () => at(HOUR) }, { ...input, id: other, digest: 'not-the-digest' });
  assert.equal(stillOpen.code, 'digest_mismatch');
  await client.close();
});

// ─── Staff payments above the line: an ask the owners have not answered ─────

test('an ask nobody answers follows the same ladder and lapses the same way; accepting it late is refused', async () => {
  const { client, db } = await seeded();
  const id = await ask(db, { requestedBy: 'u-maker', ttlMs: 3 * HOUR });
  const mail = mailbox();
  await sweep(db, at(0), mail);
  assert.deepEqual(who(await noticesOf(db, id, 'asked')), ['u-owner', 'u-owner2', 'u-owner3'], 'every owner, and only the owners');
  await sweep(db, at(10 * MIN), mail);
  const asker = (await noticesOf(db, id, 'reminder_10m')).find((n) => n.userId === 'u-maker');
  assert.equal(asker.audience, 'requester');
  assert.match(asker.body, /Asha Rahman \(Owner\)/);
  assert.match(asker.body, /Nobody has answered/);
  await sweep(db, at(HOUR), mail);
  assert.deepEqual(await stepsOf(db, id), ['asked', 'reminder_10m', 'reminder_1h']);
  await sweep(db, at(3 * HOUR), mail);
  assert.deepEqual(who(await noticesOf(db, id, 'lapsed')), ['u-maker', 'u-owner', 'u-owner2', 'u-owner3']);
  assert.equal((await listAuthorityEvents(db, 'acme')).filter((e) => e.action === 'approval_lapsed' && e.ref === id).length, 1);
  assert.deepEqual((await sweep(db, at(4 * HOUR), mail)).steps, [], 'no reminder after it ended');

  const late = await acceptApprovalAsk({ db, ctx: {}, now: () => at(3 * HOUR + MIN) }, { orgId: 'acme', userId: 'u-owner', askId: id, mode: 'wallet_pays', maxFeeMinor: 1n, settleByMs: 1n });
  assert.equal(late.ok, false);
  assert.equal(late.error, LAPSE_WORDS);
  await client.close();
});

// ─── Remind them now ────────────────────────────────────────────────────────

test('Remind them now: the person who asked or an owner, once per 10 minutes, to the people who can still approve', async () => {
  const { client, db } = await seeded();
  const id = await signing(db, { requestedBy: 'u-maker' });
  const mail = mailbox();
  await sweep(db, at(0), mail);
  const deps = (t) => ({ now: () => at(t), mail, appUrl: APP, env: ENV });
  const press = (t, userId = 'u-maker') => remindNow(db, deps(t), { orgId: 'acme', userId, kind: 'signing', id });

  const one = await press(2 * MIN);
  assert.equal(one.ok, true, JSON.stringify(one));
  assert.equal(one.reminded, 3);
  assert.deepEqual(who(await noticesOf(db, id, 'manual_1')), ['u-owner', 'u-owner2', 'u-owner3']);
  assert.match((await noticesOf(db, id, 'manual_1'))[0].title, /^Reminder/);
  assert.equal(mail.sent.filter((m) => /^Reminder/.test(m.subject)).length, 3);

  const soon = await press(2 * MIN + 30_000);
  assert.equal(soon.ok, false);
  assert.equal(soon.status, 429);
  assert.equal(soon.code, 'too_soon');
  assert.ok(soon.retryAfterSec > 0 && soon.retryAfterSec <= 600);
  assert.equal((await noticesOf(db, id, 'manual_2')).length, 0);
  assert.equal((await press(12 * MIN - 1)).status, 429);

  const owner = await press(12 * MIN, 'u-owner');
  assert.equal(owner.ok, true, 'an owner may remind too, and is not reminded of their own reminder');
  assert.deepEqual(who(await noticesOf(db, id, 'manual_2')), ['u-owner2', 'u-owner3']);

  const lines = (await listAuthorityEvents(db, 'acme')).filter((e) => e.action === 'approval_reminded');
  assert.deepEqual(lines.map((e) => e.actorUserId).sort(), ['u-maker', 'u-owner']);
  await client.close();
});

test('two presses of Remind them now at once send one reminder', async () => {
  const { client, db } = await seeded();
  const id = await signing(db, { requestedBy: 'u-maker' });
  const mail = mailbox();
  const deps = { now: () => at(MIN), mail, appUrl: APP, env: ENV };
  const both = await Promise.all([remindNow(db, deps, { orgId: 'acme', userId: 'u-maker', kind: 'signing', id }), remindNow(db, deps, { orgId: 'acme', userId: 'u-owner', kind: 'signing', id })]);
  assert.equal(both.filter((r) => r.ok).length, 1);
  assert.equal(both.filter((r) => r.status === 429).length, 1);
  assert.equal((await db.select().from(schema.approvalWaitSteps).where(eq(schema.approvalWaitSteps.subjectId, id))).filter((r) => r.step.startsWith('manual_')).length, 1);
  await client.close();
});

test('only the person who asked or an owner may remind; nobody else, and nobody of another business', async () => {
  const { client, db } = await seeded();
  const id = await signing(db, { requestedBy: 'u-maker', signers: ['u-owner', 'u-owner2', 'u-appr'] });
  const deps = { now: () => at(MIN), mail: mailbox(), appUrl: APP, env: ENV };
  const press = (userId, over = {}) => remindNow(db, deps, { orgId: 'acme', userId, kind: 'signing', id, ...over });
  const approver = await press('u-appr');
  assert.equal(approver.status, 403, 'a signer who is not an owner and did not ask');
  assert.equal(approver.code, 'not_allowed');
  assert.equal((await press('u-viewer')).status, 404);
  assert.equal((await press('u-n-owner')).status, 404, 'an owner of another business: absent');
  assert.equal((await press('u-n-owner', { orgId: 'northwind' })).status, 404, 'the id does not exist in their own business');
  assert.equal((await press('nobody')).status, 404);
  assert.equal((await press('u-maker', { id: 'wsr_missing' })).status, 404);
  assert.equal((await db.select().from(schema.approvalWaitSteps).where(eq(schema.approvalWaitSteps.subjectId, id))).length, 0, 'nothing was written');
  await client.close();
});

test('a request that has run out cannot be reminded: it says so in the lapse words', async () => {
  const { client, db } = await seeded();
  const id = await signing(db, { requestedBy: 'u-maker' });
  const deps = { now: () => at(25 * HOUR), mail: mailbox(), appUrl: APP, env: ENV };
  const r = await remindNow(db, deps, { orgId: 'acme', userId: 'u-maker', kind: 'signing', id });
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
  assert.equal(r.error, LAPSE_WORDS);
  const gone = await signing(db, { status: 'cancelled', requestedBy: 'u-maker' });
  assert.equal((await remindNow(db, deps, { orgId: 'acme', userId: 'u-maker', kind: 'signing', id: gone })).code, 'not_open');
  await client.close();
});

test('an ask can be reminded by the staff member who made it or by an owner', async () => {
  const { client, db } = await seeded();
  const id = await ask(db, { requestedBy: 'u-maker' });
  const deps = { now: () => at(5 * MIN), mail: mailbox(), appUrl: APP, env: ENV };
  const r = await remindNow(db, deps, { orgId: 'acme', userId: 'u-maker', kind: 'ask', id });
  assert.equal(r.ok, true);
  assert.deepEqual(who(await noticesOf(db, id, 'manual_1')), ['u-owner', 'u-owner2', 'u-owner3']);
  assert.equal((await remindNow(db, deps, { orgId: 'acme', userId: 'u-appr', kind: 'ask', id })).status, 404, 'an approver who did not ask: not theirs to remind');
  await client.close();
});

// ─── What the Approve page shows ────────────────────────────────────────────

test('the person who asked sees who is asked and that nobody has answered; they can cancel; an owner can remind but not cancel', async () => {
  const { client, db } = await seeded();
  const id = await signing(db, { requestedBy: 'u-maker', signers: ['u-owner', 'u-owner2'] });
  const deps = { now: () => at(30 * MIN), mail: mailbox() };
  const mine = await waitingFor(db, deps, { orgId: 'acme', userId: 'u-maker' });
  assert.equal(mine.waiting.length, 1);
  const w = mine.waiting[0];
  assert.equal(w.id, id);
  assert.equal(w.askedBy, 'You');
  assert.deepEqual(w.waitingOn.sort(), ['Asha Rahman (Owner)', 'Ben Okafor (CFO)']);
  assert.equal(w.nobodyAnswered, true);
  assert.equal(w.canCancel, true);
  assert.equal(w.canRemind, true);
  assert.equal(w.remindAt, null);
  assert.equal(w.expiresAt, at(24 * HOUR).toISOString());
  // An owner who must sign it themselves has it in their Approve list, not here; the third owner is not a signer of it and sees it.
  assert.equal((await waitingFor(db, deps, { orgId: 'acme', userId: 'u-owner' })).waiting.length, 0);
  const third = (await waitingFor(db, deps, { orgId: 'acme', userId: 'u-owner3' })).waiting[0];
  assert.equal(third.id, id);
  assert.equal(third.canCancel, false);
  assert.equal(third.canRemind, true);
  assert.equal(third.askedBy, 'Dana Maker (Staff)');
  // Someone else on the team, and another business, see nothing of it.
  assert.deepEqual((await waitingFor(db, deps, { orgId: 'acme', userId: 'u-viewer' })).waiting, []);
  assert.deepEqual(await waitingFor(db, deps, { orgId: 'northwind', userId: 'u-n-owner' }), { waiting: [], notices: [] });
  assert.deepEqual(await waitingFor(db, deps, { orgId: 'acme', userId: 'u-n-owner' }), { waiting: [], notices: [] }, 'not a member of this business');
  // After a press the page says when it may be pressed again.
  await remindNow(db, { ...deps, appUrl: APP, env: ENV }, { orgId: 'acme', userId: 'u-maker', kind: 'signing', id });
  const after = (await waitingFor(db, deps, { orgId: 'acme', userId: 'u-maker' })).waiting[0];
  assert.equal(after.remindAt, at(40 * MIN).toISOString());
  await client.close();
});

// ─── Business isolation ─────────────────────────────────────────────────────

test('cross-tenant: one business’s waiting request tells nobody in another, and its id reads as absent there', async () => {
  const { client, db } = await seeded();
  const id = await signing(db);
  // A signer row naming a person of another business (it cannot happen through the service) is still never told.
  await db.insert(schema.walletSigningSigners).values({ requestId: id, orgId: 'acme', userId: 'u-n-owner', address: `0x${'ee'.repeat(32)}`, publicKey: 'pk-ee', weight: 1 });
  const nw = await signing(db, { orgId: 'northwind', requestedBy: 'u-n-maker', signers: ['u-n-owner'] });
  const mail = mailbox();
  await sweep(db, at(0), mail);
  await sweep(db, at(25 * HOUR), mail);
  const acme = new Set((await noticesOf(db, id)).map((n) => n.userId));
  assert.ok(!acme.has('u-n-owner') && !acme.has('u-n-maker'));
  const north = (await noticesOf(db, nw)).map((n) => n.userId);
  assert.ok(north.every((u) => u.startsWith('u-n-')), 'northwind’s notices go to northwind’s people');
  assert.ok(mail.sent.every((m) => (m.to.endsWith('northwind.test') ? true : m.to.endsWith('acme.test'))));
  assert.equal(await loadSubject(db, 'northwind', 'signing', id, at(0)), null);
  assert.equal(await loadSubject(db, 'acme', 'signing', nw, at(0)), null);
  assert.equal((await listAuthorityEvents(db, 'northwind')).filter((e) => e.ref === id).length, 0);
  assert.equal((await listAuthorityEvents(db, 'acme')).filter((e) => e.ref === nw).length, 0);
  await client.close();
});

// ─── E-mail ─────────────────────────────────────────────────────────────────

test('an e-mail that fails is tried again, three times at most, and never blocks the notice in the app', async () => {
  const { client, db } = await seeded();
  const id = await signing(db, { signers: ['u-owner', 'u-owner2'] });
  const mail = mailbox((n, m) => m.to === 'owner2@acme.test');
  await sweep(db, at(0), mail);
  const notice = () => noticesOf(db, id, 'asked').then((r) => r[0]);
  assert.equal((await notice()).emailState, 'failed');
  assert.equal((await notice()).emailAttempts, 1);
  assert.equal((await waitingFor(db, { now: () => at(MIN), mail }, { orgId: 'acme', userId: 'u-owner2' })).notices.length, 1, 'the app has it');
  await sweep(db, at(MIN), mail);
  await sweep(db, at(2 * MIN), mail);
  assert.equal((await notice()).emailAttempts, 3);
  const calls = mail.calls;
  await sweep(db, at(3 * MIN), mail);
  assert.equal(mail.calls, calls, 'three tries and no more');
  // The one that works goes once.
  const ok = mailbox();
  const id2 = await signing(db, { signers: ['u-owner', 'u-owner2'], createdAt: at(10 * MIN) });
  await sweep(db, at(10 * MIN), ok);
  await sweep(db, at(10 * MIN), ok);
  assert.equal(ok.sent.filter((m) => m.to === 'owner2@acme.test' && /^Needs your approval/.test(m.subject)).length, 1);
  assert.equal((await noticesOf(db, id2, 'asked'))[0].emailState, 'sent');
  await client.close();
});

test('with no sender (production without e-mail) the notices stay in the app and nothing is sent or invented', async () => {
  const { client, db } = await seeded();
  const id = await signing(db, { signers: ['u-owner', 'u-owner2'] });
  const result = await sweepApprovalWaitsForStaff(db, { now: () => at(0), appUrl: 'https://app.example.com', env: { NODE_ENV: 'production' } });
  assert.deepEqual(result.steps, [{ kind: 'signing', step: 'asked' }]);
  assert.equal(result.emails.sent, 0);
  assert.equal(result.emails.skipped, 1);
  const [n] = await noticesOf(db, id, 'asked');
  assert.equal(n.emailState, 'pending');
  assert.equal(n.emailAttempts, 0);
  assert.equal((await waitingFor(db, { now: () => at(MIN) }, { orgId: 'acme', userId: 'u-owner2' })).notices.length, 1);
  // Once a sender exists, the e-mail goes.
  const mail = mailbox();
  await sweep(db, at(MIN), mail);
  assert.equal(mail.sent.length, 1);
  await client.close();
});

test('a link is made only where it is safe: production needs https and a public name', async () => {
  const { client, db } = await seeded();
  const id = await signing(db, { signers: ['u-owner', 'u-owner2'] });
  const mail = mailbox();
  await sweep(db, at(0), mail, { appUrl: 'http://10.0.0.5:3000', env: { NODE_ENV: 'production' } });
  assert.equal(mail.sent.length, 1);
  assert.doesNotMatch(mail.sent[0].text, /http/);
  assert.match(mail.sent[0].text, /go to Approve/);
  const stored = await noticesOf(db, id, 'asked');
  assert.equal(stored[0].linkPath, `/dashboard/approve/${id}`);
  await client.close();
});

test('logs name an id and the kind of failure, never a person, an address or a figure', async () => {
  const { client, db } = await seeded();
  await signing(db, { signers: ['u-owner', 'u-owner2'] });
  const lines = [];
  const originals = {};
  for (const level of ['log', 'info', 'warn', 'error']) {
    originals[level] = console[level];
    console[level] = (...args) => lines.push(args.map(String).join(' '));
  }
  try {
    const mail = mailbox(() => true);
    await sweep(db, at(0), mail);
    await sweep(db, at(25 * HOUR), mail);
  } finally {
    Object.assign(console, originals);
  }
  assert.ok(lines.length > 0, 'a refused e-mail is logged');
  for (const line of lines) {
    assert.doesNotMatch(line, /Asha|Ben|Chen|owner2?@|acme\.test|\d[\d,]*\.\d{2}|USDC|0x[0-9a-f]{4}|asked for/i, line);
    assert.match(line, /^\[approval-wait\] e-mail for notice apn_[0-9a-f-]+ did not go: (Error|\w+)$/);
  }
  await client.close();
});

// ─── Who can really approve ─────────────────────────────────────────────────

test('the approver count is people who can really sign, not members', async () => {
  const { client, db } = await seeded();
  const { approverCountOf } = await import('../lib/server/approval-wait.ts');
  let n = 0;
  const key = (userId, over = {}) => {
    n += 1;
    return { id: `pk-${n}`, userId, credentialId: `cred-${n}`, publicKey: `key-${n}`, suiAddress: `0x${String(n).padStart(64, '0')}`, rpId: 'splash.test', ...over };
  };
  assert.equal(await approverCountOf(db, 'acme', 'splash.test'), 0, 'three owners, none can sign yet');
  await db.insert(schema.passkeyCredentials).values(key('u-owner'));
  assert.equal(await approverCountOf(db, 'acme', 'splash.test'), 1);
  await db.insert(schema.passkeyCredentials).values(key('u-owner2'));
  await db.insert(schema.passkeyCredentials).values(key('u-owner3', { rpId: 'localhost' }));
  assert.equal(await approverCountOf(db, 'acme', 'splash.test'), 2, 'a passkey for another site cannot sign here');
  await db.insert(schema.passkeyCredentials).values(key('u-owner3', { revokedAt: T0 }));
  assert.equal(await approverCountOf(db, 'acme', 'splash.test'), 2, 'a revoked passkey cannot sign');
  // Staff, an approver and a viewer with a passkey do not sign the business wallet.
  for (const u of ['u-maker', 'u-appr', 'u-viewer']) await db.insert(schema.passkeyCredentials).values(key(u));
  assert.equal(await approverCountOf(db, 'acme', 'splash.test'), 2);
  assert.equal(await approverCountOf(db, 'northwind', 'splash.test'), 0, 'another business’s count is its own');
  await db.insert(schema.passkeyCredentials).values(key('u-n-owner'));
  assert.equal(await approverCountOf(db, 'northwind', 'splash.test'), 1);
  assert.equal(await approverCountOf(db, 'acme', 'splash.test'), 2);
  await db.insert(schema.passkeyCredentials).values(key('u-owner3'));
  assert.equal(await approverCountOf(db, 'acme', 'splash.test'), 3);
  assert.equal(fewApproversWarning(await approverCountOf(db, 'acme', 'splash.test')), null);
  await client.close();
});

// ─── The tables ─────────────────────────────────────────────────────────────

test('the database holds the idempotency: one row per request and step, one notice per person and step', async () => {
  const { client, db } = await seeded();
  const id = await signing(db);
  await db.insert(schema.approvalWaitSteps).values({ subjectKind: 'signing', subjectId: id, step: 'asked', orgId: 'acme' });
  await assert.rejects(db.insert(schema.approvalWaitSteps).values({ subjectKind: 'signing', subjectId: id, step: 'asked', orgId: 'acme' }));
  await assert.rejects(db.insert(schema.approvalWaitSteps).values({ subjectKind: 'signing', subjectId: id, step: 'whenever', orgId: 'acme' }), 'only the steps of the ladder');
  await assert.rejects(db.insert(schema.approvalWaitSteps).values({ subjectKind: 'payment', subjectId: id, step: 'lapsed', orgId: 'acme' }));
  const notice = { orgId: 'acme', subjectKind: 'signing', subjectId: id, step: 'asked', userId: 'u-owner2', audience: 'approver', title: 't', body: 'b', linkPath: '/dashboard/approve' };
  await db.insert(schema.approvalNotices).values({ id: 'apn_1', ...notice });
  await assert.rejects(db.insert(schema.approvalNotices).values({ id: 'apn_2', ...notice }), 'one notice per person and step');
  await assert.rejects(db.insert(schema.approvalNotices).values({ id: 'apn_3', ...notice, step: 'reminder_1h', userId: 'u-owner3' }), 'a notice needs its step row');
  await assert.rejects(db.insert(schema.approvalNotices).values({ id: 'apn_4', ...notice, userId: 'u-owner3', audience: 'everyone' }));
  await client.close();
});
