/**
 * Review findings on the ladder for requests nobody approves (v2 Phase 3, p3-no-approver).
 *
 *   1. the first run after a deploy must not tell a lapse for a week of old, ended requests;
 *   2. the requester's Updates entry carries the whole notice, so the names of who was asked are on the screen;
 *   3. the count of approvers counts owners who are signers of the wallet that exists, not every owner with a passkey;
 *   4. "Remind them now" with nobody to remind says so and keeps the cooldown free;
 *   5. a lapse and a reminder by hand are readable on the team's trail;
 *   6. a request the ladder could not tell is logged by id, and a mail outage reaches the cron's health answer;
 *   7. e-mail is bounded (step 0 does not wait on the provider), capped in every branch and has one key per notice;
 *   8. a person who left the business is not e-mailed a notice written before they left.
 *
 * A real database (PGlite with every migration) and an injected clock.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { and, eq } from 'drizzle-orm';

import { migratedDb } from './helpers/store-db.mjs';
import * as schema from '../lib/db/schema.ts';
import { LAPSE_NOTICE_WINDOW_MS } from '../lib/approve/wait.ts';
import * as wait from '../lib/server/approval-wait.ts';
const { MAX_EMAIL_ATTEMPTS, loadSubject, remindNow, sweepApprovalWaitsForStaff, tellApproversNow, waitingFor } = wait;
const approversOf = (...args) => wait.approversOf(...args);
import { listAuthorityEvents } from '../lib/server/wallet-authority.ts';
import { TEAM_ACTIONS, activitySummary } from '../lib/team/view.ts';
import { listTeamActivity } from '../lib/server/team-admin.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = new Date('2026-11-02T09:00:00Z');
const at = (ms) => new Date(T0.getTime() + ms);
const ENV = { NODE_ENV: 'test' };
const APP = 'http://localhost:3000';
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const PEOPLE = [
  ['u-owner', 'Asha Rahman', 'owner@acme.test', 'acme', 'admin', null],
  ['u-owner2', 'Ben Okafor', 'owner2@acme.test', 'acme', 'admin', 'CFO'],
  ['u-owner3', 'Chen Wei', 'owner3@acme.test', 'acme', 'admin', null],
  ['u-maker', 'Dana Maker', 'maker@acme.test', 'acme', 'maker', null],
];

async function seeded() {
  const { client, db } = await migratedDb();
  for (const [id, name, email, org, role, title] of PEOPLE) {
    await db.insert(schema.users).values({ id, email, name, emailVerifiedAt: T0 });
    await db.insert(schema.memberships).values({ id: `m-${id}`, userId: id, orgId: org, role, title });
  }
  return { client, db };
}

function mailbox(fail = () => false) {
  const sent = [];
  const keys = [];
  let calls = 0;
  return {
    sent,
    keys,
    get calls() { return calls; },
    async sendMessage(message) {
      calls += 1;
      keys.push(message.idempotencyKey);
      if (fail(calls, message)) throw new Error('provider refused');
      sent.push(message);
      return { providerRef: `ref-${calls}` };
    },
  };
}

async function signing(db, over = {}) {
  const { id = `wsr_${randomUUID()}`, orgId = 'acme', requestedBy = 'u-owner', signers = ['u-owner', 'u-owner2', 'u-owner3'], createdAt = T0, ttlMs = 24 * HOUR, purpose = 'wallet_payment', status = 'collecting', keys = {}, signed = [] } = over;
  await db.insert(schema.walletSigningRequests).values({
    id, orgId, purpose, dedupeKey: id, senderAddress: `0x${'ab'.repeat(32)}`, signerKind: 'multisig', multisigPublicKey: 'msig', threshold: 2, gasMode: 'sponsored',
    txBytes: 'AAAA', txDigest: `digest-${id}`, bytesHash: 'h'.repeat(64), summary: {}, status, requestedBy, expiresAt: new Date(createdAt.getTime() + ttlMs), createdAt,
  });
  await db.insert(schema.walletSigningSigners).values(
    signers.map((userId, i) => ({
      requestId: id, orgId, userId, address: `0x${(i + 1).toString(16).padStart(64, '0')}`, publicKey: keys[userId] ?? `pk-${id}-${userId}`, weight: 1,
      ...(signed.includes(userId) ? { signedAt: createdAt, signature: 'sig' } : {}),
    })),
  );
  return id;
}

const sweep = (db, now, mail, over = {}) => sweepApprovalWaitsForStaff(db, { now: () => now, mail, appUrl: APP, env: ENV, ...over });
const stepsOf = async (db, id) => (await db.select().from(schema.approvalWaitSteps).where(eq(schema.approvalWaitSteps.subjectId, id))).map((r) => r.step).sort();
const noticesOf = (db, id, step) => db.select().from(schema.approvalNotices).where(step ? and(eq(schema.approvalNotices.subjectId, id), eq(schema.approvalNotices.step, step)) : eq(schema.approvalNotices.subjectId, id));

// ─── 1. The first run after a deploy ────────────────────────────────────────

test('the first run after the deploy does not tell a lapse for requests that ended before the ladder began', async () => {
  const { client, db } = await seeded();
  const old = [];
  for (let i = 0; i < 3; i += 1) old.push(await signing(db, { status: 'expired', createdAt: at(-3 * 24 * HOUR), requestedBy: 'u-maker' }));
  const mail = mailbox();
  const first = await sweep(db, T0, mail);
  assert.equal(first.lapsed, 0, 'three days of history is history, not news');
  for (const id of old) {
    assert.deepEqual(await stepsOf(db, id), []);
    assert.equal((await noticesOf(db, id)).length, 0);
  }
  assert.equal(mail.sent.length, 0);
  assert.equal((await listAuthorityEvents(db, 'acme')).filter((e) => e.action === 'approval_lapsed').length, 0);
  await client.close();
});

test('a lapse is told only for a request the ladder began on, and only for a day after its end', async () => {
  assert.equal(LAPSE_NOTICE_WINDOW_MS, 24 * HOUR, 'the cron interval plus a margin, not a week');
  const { client, db } = await seeded();
  const mail = mailbox();
  // Asked by the ladder, then ended 2 hours ago: told.
  const live = await signing(db, { requestedBy: 'u-maker', ttlMs: 2 * HOUR });
  await sweep(db, T0, mail);
  assert.ok((await stepsOf(db, live)).includes('asked'));
  assert.equal((await sweep(db, at(4 * HOUR), mail)).lapsed, 1);
  assert.ok((await stepsOf(db, live)).includes('lapsed'));
  // Ended with no step ever recorded (made before the ladder existed): not told, even only an hour after its end.
  const before = await signing(db, { requestedBy: 'u-maker', createdAt: at(3 * HOUR), ttlMs: HOUR, status: 'expired' });
  assert.equal((await sweep(db, at(5 * HOUR), mail)).lapsed, 0);
  assert.deepEqual(await stepsOf(db, before), []);
  // Asked, but the cron was down for more than a day after its end: history.
  const late = await signing(db, { requestedBy: 'u-maker', createdAt: at(10 * HOUR), ttlMs: HOUR });
  await sweep(db, at(10 * HOUR), mail);
  assert.equal((await sweep(db, at(10 * HOUR + 26 * HOUR), mail)).lapsed, 0);
  assert.ok(!(await stepsOf(db, late)).includes('lapsed'));
  await client.close();
});

// ─── 2. The requester's Updates carry the names ─────────────────────────────

test('the requester’s update says who was asked, and the page shows the whole notice', async () => {
  const { client, db } = await seeded();
  await signing(db, { requestedBy: 'u-owner', signers: ['u-owner', 'u-owner2', 'u-owner3'] });
  const mail = mailbox();
  await sweep(db, T0, mail);
  await sweep(db, at(10 * MIN), mail);
  const mine = await waitingFor(db, { now: () => at(11 * MIN) }, { orgId: 'acme', userId: 'u-owner' });
  const note = mine.notices.find((n) => n.step === 'reminder_10m');
  assert.ok(note, 'the requester has the 10 minute notice');
  assert.match(note.body, /Ben Okafor \(CFO\)/);
  assert.match(note.body, /Chen Wei \(Owner\)/);
  const page = read('components/approve/WaitingForOthers.tsx');
  assert.doesNotMatch(page.replace(/\/\*[\s\S]*?\*\//g, ''), /\.split\(/, 'no part of a notice is cut off');
  assert.match(page, /whitespace-pre-line[^"]*">\{n\.body\}<\/p>/, 'the whole body is shown, paragraph breaks kept');
  await client.close();
});

// ─── 3. Approvers are signers of the wallet that exists ─────────────────────

test('the approver count counts owners who sign for the wallet that exists, and says how many owners do not yet', async () => {
  const { client, db } = await seeded();
  let n = 0;
  const passkey = (userId, publicKey) => {
    n += 1;
    return { id: `pk-${n}`, userId, credentialId: `cred-${n}`, publicKey, suiAddress: `0x${String(n).padStart(64, '0')}`, rpId: 'splash.test' };
  };
  for (const u of ['u-owner', 'u-owner2', 'u-owner3']) await db.insert(schema.passkeyCredentials).values(passkey(u, `key-${u}`));
  // No wallet yet: nothing to be a signer of, so owners with a working passkey are the people who will sign.
  assert.deepEqual(await approversOf(db, 'acme', 'splash.test'), { count: 3, ownersNotSigning: 0, walletKnown: false });

  // A wallet of two signers is registered; the third owner was added after, and cannot sign its requests until it is rotated.
  await signing(db, { purpose: 'register_wallet', status: 'executed', signers: ['u-owner', 'u-owner2'], keys: { 'u-owner': 'key-u-owner', 'u-owner2': 'key-u-owner2' }, requestedBy: 'u-owner' });
  assert.deepEqual(await approversOf(db, 'acme', 'splash.test'), { count: 2, ownersNotSigning: 1, walletKnown: true });

  // A rotation that took the third owner in makes three; the older registration no longer counts.
  await signing(db, { purpose: 'confirm_wallet_rotation', status: 'executed', createdAt: at(HOUR), signers: ['u-owner', 'u-owner2', 'u-owner3'], keys: { 'u-owner': 'key-u-owner', 'u-owner2': 'key-u-owner2', 'u-owner3': 'key-u-owner3' }, requestedBy: 'u-owner' });
  assert.deepEqual(await approversOf(db, 'acme', 'splash.test'), { count: 3, ownersNotSigning: 0, walletKnown: true });

  // An owner whose passkey is not the key the wallet holds (a new passkey since) cannot sign either.
  await db.update(schema.passkeyCredentials).set({ revokedAt: T0 }).where(eq(schema.passkeyCredentials.userId, 'u-owner3'));
  await db.insert(schema.passkeyCredentials).values(passkey('u-owner3', 'a-different-key'));
  assert.deepEqual(await approversOf(db, 'acme', 'splash.test'), { count: 2, ownersNotSigning: 1, walletKnown: true });
  await client.close();
});

test('the warning route tells owners about owners who are not yet wallet signers, in plain words', () => {
  const route = read('app/api/team/approvers/route.ts');
  assert.match(route, /approversOf\(db, orgId, relyingPartyId\(\)\)/);
  assert.match(route, /ownersNotSigning/);
  const card = read('components/team/FewApprovers.tsx');
  assert.match(card, /note/);
});

// ─── 4. Remind them now with nobody to remind ───────────────────────────────

test('"Remind them now" with nobody else to remind says so and leaves the cooldown alone', async () => {
  const { client, db } = await seeded();
  // The other signer has signed; the person who asked is the only one left.
  const id = await signing(db, { requestedBy: 'u-owner', signers: ['u-owner', 'u-owner2'], signed: ['u-owner2'] });
  const deps = { now: () => at(MIN), mail: mailbox(), appUrl: APP, env: ENV };
  const r = await remindNow(db, deps, { orgId: 'acme', userId: 'u-owner', kind: 'signing', id });
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
  assert.equal(r.code, 'nobody_to_remind');
  assert.equal(r.error, 'There is nobody else to remind. You are the one who must approve it.');
  assert.deepEqual(await stepsOf(db, id), [], 'no step is written, so no cooldown starts');
  assert.equal((await listAuthorityEvents(db, 'acme')).filter((e) => e.action === 'approval_reminded').length, 0);
  const mine = await waitingFor(db, { now: () => at(MIN) }, { orgId: 'acme', userId: 'u-maker' });
  assert.deepEqual(mine.waiting, []);
  const owner3 = (await waitingFor(db, { now: () => at(MIN) }, { orgId: 'acme', userId: 'u-owner3' })).waiting[0];
  assert.equal(owner3.canRemind, true, 'an owner who is not the only one left can still remind');
  const owner = await loadSubject(db, 'acme', 'signing', id, at(MIN));
  assert.deepEqual(owner.approvers, ['u-owner']);
  const page = read('components/approve/WaitingForOthers.tsx');
  assert.match(page, /answer\.body\?\.reminded/, 'the page says who was reminded only when someone was');
  await client.close();
});

// ─── 5. The trail shows them ────────────────────────────────────────────────

test('a lapse and a reminder by hand are lines the team can read, with no amount and no payee', async () => {
  assert.ok(TEAM_ACTIONS.includes('approval_lapsed'));
  assert.ok(TEAM_ACTIONS.includes('approval_reminded'));
  assert.equal(activitySummary({ action: 'approval_lapsed', detail: { kind: 'signing' }, actorName: 'Splash', subjectName: null }), 'Nobody approved a request for the business wallet in time. Nothing was paid.');
  assert.equal(activitySummary({ action: 'approval_lapsed', detail: { kind: 'ask' }, actorName: 'Splash', subjectName: null }), 'Nobody approved a payment a team member asked the owners to approve in time. Nothing was paid.');
  assert.equal(activitySummary({ action: 'approval_reminded', detail: { kind: 'signing', reminded: 2 }, actorName: 'Asha', subjectName: null }), 'Asha reminded 2 people to approve a request for the business wallet.');
  assert.equal(activitySummary({ action: 'approval_reminded', detail: { kind: 'ask', reminded: 1 }, actorName: 'Asha', subjectName: null }), 'Asha reminded 1 person to approve a payment a team member asked the owners to approve.');

  const { client, db } = await seeded();
  const id = await signing(db, { requestedBy: 'u-maker', ttlMs: 2 * HOUR });
  const mail = mailbox();
  await sweep(db, T0, mail);
  await remindNow(db, { now: () => at(MIN), mail, appUrl: APP, env: ENV }, { orgId: 'acme', userId: 'u-maker', kind: 'signing', id });
  await sweep(db, at(3 * HOUR), mail);
  const lines = (await listTeamActivity(db, 'acme')).map((l) => l.summary);
  assert.ok(lines.includes('Dana Maker reminded 3 people to approve a request for the business wallet.'), lines.join(' | '));
  assert.ok(lines.includes('Nobody approved a request for the business wallet in time. Nothing was paid.'), lines.join(' | '));
  for (const line of lines) assert.doesNotMatch(line, /\d[\d,]*\.\d{2}|USDC|0x[0-9a-f]{4}/);
  await client.close();
});

// ─── 6. Failures are seen ───────────────────────────────────────────────────

test('a request the ladder could not tell is logged by id and kind of failure, and counted', async () => {
  const { client, db } = await seeded();
  const id = await signing(db, { requestedBy: 'u-maker' });
  const broken = new Proxy(db, { get: (target, prop, receiver) => (prop === 'transaction' ? async () => { throw new Error('boom 12.50 Asha'); } : Reflect.get(target, prop, receiver)) });
  const lines = [];
  const warn = console.warn;
  console.warn = (...args) => lines.push(args.map(String).join(' '));
  let result;
  try {
    result = await sweep(broken, T0, mailbox());
  } finally {
    console.warn = warn;
  }
  assert.equal(result.errors, 1);
  assert.deepEqual(lines, [`[approval-wait] request ${id} could not be told: Error`], 'an id and the kind of failure, never the message');
  await client.close();
});

test('a mail outage reaches the sweep’s health answer; a quiet day does not', async () => {
  const { client, db } = await seeded();
  const id = await signing(db, { signers: ['u-owner', 'u-owner2'] });
  const bad = mailbox(() => true);
  const quiet = console.warn;
  console.warn = () => {};
  try {
    let last;
    for (const t of [0, MIN, 2 * MIN]) last = await sweep(db, at(t), bad);
    assert.equal(last.emailTrouble, 1, 'a notice whose three tries all failed');
    assert.equal((await noticesOf(db, id, 'asked'))[0].emailAttempts, MAX_EMAIL_ATTEMPTS);
    // An hour after the last try it is no longer news.
    assert.equal((await sweep(db, at(2 * MIN + 2 * HOUR), mailbox())).emailTrouble, 0);
  } finally {
    console.warn = quiet;
  }
  // Production with no sender: the notice cannot leave, and the scheduler is told.
  const id2 = await signing(db, { signers: ['u-owner', 'u-owner2'], createdAt: at(5 * HOUR) });
  const prod = await sweepApprovalWaitsForStaff(db, { now: () => at(5 * HOUR), appUrl: 'https://app.example.com', env: { NODE_ENV: 'production' } });
  assert.ok(prod.emails.skipped >= 1);
  assert.ok(prod.emailTrouble >= 1);
  assert.equal((await noticesOf(db, id2, 'asked'))[0].emailState, 'pending');
  // The same in development is not trouble.
  const dev = await sweepApprovalWaitsForStaff(db, { now: () => at(5 * HOUR + MIN), appUrl: APP, env: ENV, mail: null });
  assert.equal(dev.emailTrouble, 0);
  const route = read('app/api/cron/wallet-signing/route.ts');
  assert.match(route, /waits\.emailTrouble > 0/);
  assert.match(route, /emailTrouble: 0/);
  await client.close();
});

// ─── 7. E-mail is bounded ───────────────────────────────────────────────────

test('step 0 does not wait on a mail provider that does not answer; the cron sends what is left', async () => {
  const { client, db } = await seeded();
  const id = await signing(db, { requestedBy: 'u-maker', signers: ['u-owner', 'u-owner2'] });
  const hanging = { async sendMessage() { return new Promise(() => {}); } };
  const started = Date.now();
  const step = await Promise.race([
    tellApproversNow(db, { orgId: 'acme', kind: 'signing', id }, { now: () => T0, mail: hanging, appUrl: APP, env: ENV, emailBudgetMs: 50 }),
    new Promise((resolve) => setTimeout(() => resolve('hung'), 5000)),
  ]);
  assert.equal(step, 'asked', 'the request was told in the app and the call came back');
  assert.ok(Date.now() - started < 4000);
  assert.equal((await noticesOf(db, id, 'asked')).length, 2);
  // The notice left 'sending' with the provider silent: after the lease the cron claims it once more, within its tries.
  const ok = mailbox();
  const later = await sweep(db, at(11 * MIN), ok);
  assert.equal(later.emails.sent, 2);
  await client.close();
});

test('a notice stuck in sending is claimed again only while it has tries left, and keeps one key for its life', async () => {
  const { client, db } = await seeded();
  const id = await signing(db, { signers: ['u-owner', 'u-owner2'] });
  const dead = mailbox(() => true);
  const quiet = console.warn;
  console.warn = () => {};
  try {
    await sweep(db, T0, dead);
    await sweep(db, at(MIN), dead);
  } finally {
    console.warn = quiet;
  }
  assert.equal(dead.keys.length, 2);
  assert.equal(dead.keys[0], dead.keys[1], 'a retry is the same message to the provider, not a new one');
  assert.match(dead.keys[0], /^splash-approval-apn_[0-9a-f-]+$/);
  // A run that dies after claiming leaves 'sending' with every try used: it is not claimed again.
  const [n] = await noticesOf(db, id, 'asked');
  await db.update(schema.approvalNotices).set({ emailState: 'sending', emailAttempts: MAX_EMAIL_ATTEMPTS, emailClaimedAt: T0 }).where(eq(schema.approvalNotices.id, n.id));
  const after = mailbox();
  await sweep(db, at(HOUR), after);
  assert.equal(after.calls, 0);
  await client.close();
});

// ─── 8. Someone who left is not e-mailed ────────────────────────────────────

test('a notice written before a person left the business is not e-mailed to them afterwards', async () => {
  const { client, db } = await seeded();
  const id = await signing(db, { signers: ['u-owner', 'u-owner2', 'u-owner3'] });
  const dead = mailbox(() => true);
  const quiet = console.warn;
  console.warn = () => {};
  try {
    await sweep(db, T0, dead);
  } finally {
    console.warn = quiet;
  }
  await db.delete(schema.memberships).where(eq(schema.memberships.userId, 'u-owner2'));
  const mail = mailbox();
  await sweep(db, at(MIN), mail);
  assert.deepEqual(mail.sent.map((m) => m.to), ['owner3@acme.test'], 'the one who is still a member');
  assert.equal((await noticesOf(db, id, 'asked')).length, 2, 'the notice itself is kept');
  await client.close();
});
