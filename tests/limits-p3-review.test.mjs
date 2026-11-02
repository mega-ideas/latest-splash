/**
 * The independent review of how a business's limits start and of the two-person rule (v2 Phase 3). Each test here is a
 * case the review reproduced, written to fail first.
 *
 *   second approver   the card's button says "Approve 400,000 USDC" after the first approver gave 400,000 of 900,000
 *                     asked; the click must agree with that figure, not ask for 900,000 and be refused
 *   ask again         a request that Splash declined (or the owner cancelled) is replayed by the same key; the page
 *                     must not say "Sent" for it
 *   words             the unchosen daily cap is said in a sentence; the staff card says its 30 days are automatic only
 *   a11y              the "How your limits started" block is a group with a name
 *   two tabs          two first-time saves with different answers leave one set of answers and one start
 *
 * Against a real database (PGlite with every migration), with an injected clock.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { eq } from 'drizzle-orm';

import { migratedDb } from './helpers/store-db.mjs';
import * as schema from '../lib/db/schema.ts';
import {
  cancelLimitRequest,
  decideLimitRequestForStaff,
  listLimitRequestsForStaff,
  requestHigherLimit,
} from '../lib/server/business-limits.ts';
import { askForHigherFromAnswers, saveLimitAnswers } from '../lib/server/limit-start.ts';
import { UNCHOSEN_DAILY_CAP } from '../lib/limits/rules.ts';
import { askedNoteWords, controlsAndLimitsWords } from '../lib/limits/start.ts';

const U = (usdc) => BigInt(Math.round(usdc * 1_000_000));
const T0 = new Date('2026-11-02T09:00:00Z');
const H = 3_600_000;
const at = (ms) => () => new Date(ms);
const VERIFIED = new Date('2026-10-01T00:00:00Z');
const COMPLIANCE = { email: 'mariam@splash.test', role: 'compliance' };
const OPERATIONS = { email: 'ops@splash.test', role: 'operations' };
const REASON = 'We now pay four hundred suppliers every week.';
const BIG = { monthlyUsdc: '2,000,000', paymentsPerWeek: '20', firstTransferUsdc: '500,000' };
const SMALL = { monthlyUsdc: '20,000', paymentsPerWeek: '5', firstTransferUsdc: '10,000' };

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

async function seeded() {
  const { client, db } = await migratedDb();
  await db.insert(schema.users).values({ id: 'u-owner', email: 'owner@acme.test', name: 'u-owner', emailVerifiedAt: VERIFIED });
  await db.insert(schema.memberships).values({ id: 'm-u-owner', userId: 'u-owner', orgId: 'acme', role: 'admin' });
  return { client, db };
}

// ─── Second approver: the button agrees with the figure it names ─────────────

test('the second approver of a smaller figure agrees through the card: the body it sends is the first approver’s figure', async () => {
  const { db } = await seeded();
  const { decisionBody, decisionChoices } = await import('../lib/limits/decision.ts');
  const made = await requestHigherLimit(db, { orgId: 'acme', actorUserId: 'u-owner', kind: 'daily', requested: '900,000', reason: REASON, requestKey: 'k-big-0001', now: at(T0.getTime()) });
  assert.equal(made.ok, true, JSON.stringify(made));
  const first = await decideLimitRequestForStaff(db, { requestId: made.request.id, staff: COMPLIANCE, action: 'approve_smaller', granted: '400,000', now: at(T0.getTime() + H) });
  assert.equal(first.stage, 'first_approval');

  // What the operations card shows.
  const queue = await listLimitRequestsForStaff(db, OPERATIONS, at(T0.getTime() + 2 * H));
  const card = queue.open.find((r) => r.id === made.request.id);
  assert.equal(card.approvals.first.figureWords, '400,000 USDC');
  assert.equal(card.approvals.youApprovedFirst, false);

  // The only way to agree is the first approver's figure; "as asked" and "a different smaller figure" are not offered.
  const choices = decisionChoices(card);
  assert.deepEqual(choices.map(([value]) => value), ['approve', 'decline']);
  assert.match(choices[0][1], /400,000 USDC/);
  assert.doesNotMatch(choices[0][1], /900,000/);

  // And clicking it sends that figure, which the server accepts as the second approval.
  const body = decisionBody(card, 'approve', { smaller: '', reason: '' });
  assert.deepEqual(body, { action: 'approve_smaller', granted: '400000' });
  const second = await decideLimitRequestForStaff(db, { requestId: made.request.id, staff: OPERATIONS, ...body, now: at(T0.getTime() + 2 * H) });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.stage, 'decided');
  assert.equal(second.request.granted, U(400_000).toString());
});

test('when the first approver approved the figure as asked, the second sends a plain approve; a card with no first approval sends what was chosen', async () => {
  const { decisionBody, decisionChoices } = await import('../lib/limits/decision.ts');
  const asked = { kind: 'daily', requested: U(300_000).toString(), approvals: { needed: 2, first: { figure: U(300_000).toString(), figureWords: '300,000 USDC' }, youApprovedFirst: false } };
  assert.deepEqual(decisionBody(asked, 'approve', { smaller: '', reason: '' }), { action: 'approve' });
  const none = { kind: 'daily', requested: U(300_000).toString(), approvals: { needed: 2, first: null, youApprovedFirst: false } };
  assert.deepEqual(decisionChoices(none).map(([value]) => value), ['approve', 'approve_smaller', 'decline']);
  assert.deepEqual(decisionBody(none, 'approve_smaller', { smaller: '250,000', reason: 'ignored' }), { action: 'approve_smaller', granted: '250,000' });
  assert.deepEqual(decisionBody(none, 'decline', { smaller: '250,000', reason: 'Not enough history yet to go higher.' }), { action: 'decline', reason: 'Not enough history yet to go higher.' });
  // Days are whole numbers.
  const days = { kind: 'days', requested: '300', approvals: { needed: 1, first: { figure: '200', figureWords: '200 days' }, youApprovedFirst: false } };
  assert.deepEqual(decisionBody(days, 'approve', { smaller: '', reason: '' }), { action: 'approve_smaller', granted: '200' });
  // The first approver sees the same choices as before: the button waits, decline stays.
  const mine = { kind: 'daily', requested: U(300_000).toString(), approvals: { needed: 2, first: { figure: U(300_000).toString(), figureWords: '300,000 USDC' }, youApprovedFirst: true } };
  assert.deepEqual(decisionChoices(mine).map(([value]) => value), ['approve', 'approve_smaller', 'decline']);
});

test('the staff card builds its request through the one helper, not from the raw choice', () => {
  const text = read('components/admin/AdminLimitRequests.tsx');
  assert.match(text, /decisionBody\(/);
  assert.match(text, /decisionChoices\(/);
  assert.doesNotMatch(text, /action: choice/, 'the body is not built from the raw choice');
});

// ─── Ask for higher limits: a closed request is not "sent" ───────────────────

test('asking again after Splash declined a request is said in words, not counted as sent', async () => {
  const { db } = await seeded();
  assert.equal((await saveLimitAnswers(db, { orgId: 'acme', actorUserId: 'u-owner', answers: BIG, now: at(T0.getTime()) })).ok, true);
  const first = await askForHigherFromAnswers(db, { orgId: 'acme', actorUserId: 'u-owner', now: at(T0.getTime() + H) });
  assert.deepEqual(first.asked.map((a) => a.kind).sort(), ['daily', 'monthly']);
  const monthly = first.asked.find((a) => a.kind === 'monthly');
  const declined = await decideLimitRequestForStaff(db, { requestId: monthly.request.id, staff: COMPLIANCE, action: 'decline', reason: 'Not enough history yet to go higher.', now: at(T0.getTime() + 2 * H) });
  assert.equal(declined.ok, true, JSON.stringify(declined));

  const again = await askForHigherFromAnswers(db, { orgId: 'acme', actorUserId: 'u-owner', now: at(T0.getTime() + 3 * H) });
  assert.equal(again.ok, true);
  assert.deepEqual(again.asked.map((a) => a.kind), ['daily'], 'the open one is still open, so it is the only one asked');
  assert.deepEqual(again.skipped.filter((s) => s.why === 'closed').map((s) => s.kind), ['monthly'], 'the declined one is closed, and said so');
  assert.equal((await db.select().from(schema.businessLimitRequests).where(eq(schema.businessLimitRequests.orgId, 'acme'))).length, 2, 'nothing new was written');
});

test('a request the owner cancelled is closed too; new answers are a new ask', async () => {
  const { db } = await seeded();
  assert.equal((await saveLimitAnswers(db, { orgId: 'acme', actorUserId: 'u-owner', answers: BIG, now: at(T0.getTime()) })).ok, true);
  const first = await askForHigherFromAnswers(db, { orgId: 'acme', actorUserId: 'u-owner', now: at(T0.getTime() + H) });
  const daily = first.asked.find((a) => a.kind === 'daily');
  assert.equal((await cancelLimitRequest(db, { orgId: 'acme', actorUserId: 'u-owner', requestId: daily.request.id, now: at(T0.getTime() + 2 * H) })).ok, true);
  const again = await askForHigherFromAnswers(db, { orgId: 'acme', actorUserId: 'u-owner', now: at(T0.getTime() + 3 * H) });
  assert.deepEqual(again.skipped.filter((s) => s.why === 'closed').map((s) => s.kind), ['daily']);
  assert.ok(!again.asked.some((a) => a.kind === 'daily'));
  // Changing the answers changes the key: that is a new ask.
  assert.equal((await saveLimitAnswers(db, { orgId: 'acme', actorUserId: 'u-owner', answers: { ...BIG, monthlyUsdc: '2,200,000' }, now: at(T0.getTime() + 4 * H) })).ok, true);
  const fresh = await askForHigherFromAnswers(db, { orgId: 'acme', actorUserId: 'u-owner', now: at(T0.getTime() + 5 * H) });
  assert.ok(fresh.asked.some((a) => a.kind === 'daily' && a.replayed === false));
});

test('the note the page shows says what happened to each limit: sent, already answered, or refused', () => {
  const sent = (kind) => ({ kind, replayed: false, request: {} });
  assert.match(askedNoteWords([sent('daily'), sent('monthly')], []), /^Sent\. Splash is reviewing your 2 requests\./);
  assert.match(askedNoteWords([sent('daily')], []), /^Sent\. Splash is reviewing your request\./);
  const closed = askedNoteWords([], [{ kind: 'monthly', why: 'closed' }]);
  assert.doesNotMatch(closed, /Sent/);
  assert.match(closed, /Splash already answered/);
  assert.match(closed, /In a month/);
  assert.match(closed, /change your answers|Ask for more/i);
  const refused = askedNoteWords([], [{ kind: 'daily', why: 'refused', error: 'That is more than the most a limit can be.' }]);
  assert.match(refused, /That is more than the most a limit can be\./);
  assert.doesNotMatch(refused, /nothing more to ask for/i, 'a refusal is not "nothing to ask for"');
  assert.match(askedNoteWords([], [{ kind: 'daily', why: 'fits' }, { kind: 'monthly', why: 'open' }]), /nothing more to ask for/i);
  const mixed = askedNoteWords([sent('daily')], [{ kind: 'monthly', why: 'closed' }]);
  assert.match(mixed, /Sent/);
  assert.match(mixed, /Splash already answered/);
});

test('the Limits card says it through askedNoteWords and does not invent its own "nothing more" sentence', () => {
  const text = read('components/settings/LimitsCard.tsx');
  assert.match(text, /askedNoteWords\(/);
  assert.doesNotMatch(text, /There is nothing more to ask for/);
});

// ─── Words ───────────────────────────────────────────────────────────────────

test('the Limits screen says a day of automatic payments is held to the unchosen cap until the owners choose one', () => {
  const limits = { per_payment: U(50_000), daily: U(100_000), monthly: U(500_000), days: 90n };
  const words = controlsAndLimitsWords({ perTransferUsd: 50_000, dailyUsd: 250_000 }, limits);
  assert.ok(words.limits.dailyNote, 'a sentence under the daily row');
  assert.match(words.limits.dailyNote, new RegExp(`${(UNCHOSEN_DAILY_CAP / 1_000_000n).toLocaleString('en-US')} USDC`));
  assert.match(words.limits.dailyNote, /choose|set|sign/i);
  const text = read('components/settings/LimitsCard.tsx');
  assert.match(text, /words\.limits\.dailyNote/);
});

test('the staff card says its 30 days count automatic payments only', () => {
  const text = read('components/admin/AdminLimitRequests.tsx');
  assert.match(text, /Automatic payments only/);
  assert.match(text, /not counted/);
});

test('"How your limits started" is a named group, not a bare div with a label', () => {
  const text = read('components/settings/LimitsCard.tsx');
  const tag = text.match(/<(div|section)\b[^>]*aria-labelledby="limits-start-title"[^>]*>/);
  assert.ok(tag, 'the block is labelled by its title');
  assert.ok(tag[1] === 'section' || /role="group"/.test(tag[0]), 'aria-labelledby on a plain div is ignored; give it a role');
});

// ─── Two tabs ────────────────────────────────────────────────────────────────

test('two first-time saves with different answers leave one set of answers, one start, and each tab is told what is stored', async () => {
  const { db } = await seeded();
  const [a, b] = await Promise.all([
    saveLimitAnswers(db, { orgId: 'acme', actorUserId: 'u-owner', answers: SMALL, now: at(T0.getTime()) }),
    saveLimitAnswers(db, { orgId: 'acme', actorUserId: 'u-owner', answers: BIG, now: at(T0.getTime() + 1) }),
  ]);
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(b.ok, true, JSON.stringify(b));
  const stored = await db.select().from(schema.businessLimitAnswers).where(eq(schema.businessLimitAnswers.orgId, 'acme'));
  assert.equal(stored.length, 1);
  assert.equal((await db.select().from(schema.businessLimits).where(eq(schema.businessLimits.orgId, 'acme'))).length, 3, 'started once');
  // The stored answers are one of the two submitted, whole: never a mixture.
  assert.ok([SMALL.monthlyUsdc, BIG.monthlyUsdc].includes(stored[0].monthlyText));
});
