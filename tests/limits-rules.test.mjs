/**
 * A business's limits on automatic payments (v2 Phase 3): the figures, the
 * ceilings in code, what an owner may ask for, what staff may grant, what an
 * owner may lower to, the 24 hour notice and the words. Pure: no database.
 *
 * What each function does to a real database, cross-tenant included, is
 * tests/business-limits.test.mjs.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_LIMITS,
  LIMIT_CEILINGS,
  LIMIT_FLOORS,
  LIMIT_KINDS,
  LIMIT_NOTICE_MS,
  WHAT_HAPPENS_NEXT,
  allowanceLimitProblems,
  cleanReason,
  effectiveAtMs,
  effectiveDailyCap,
  formatLimit,
  grantProblems,
  lowerProblems,
  parseLimitValue,
  raiseProblems,
  reasonProblems,
  requestPhase,
  requestSentence,
  stricter,
} from '../lib/limits/rules.ts';
import { limitNoticeText } from '../lib/limits/notice.ts';
import { ALLOWANCE_DEFAULTS, ALLOWANCE_MAX_DAYS, AUTO_APPROVAL_CEILING_MINOR } from '../lib/schedule/rules.ts';

const U = (usdc) => BigInt(Math.round(usdc * 1_000_000));

test('every business starts with the Mode B defaults: 2,000 a payment, 5,000 a day, 20,000 a month, 90 days', () => {
  assert.deepEqual(
    { ...DEFAULT_LIMITS },
    { per_payment: U(2_000), daily: U(5_000), monthly: U(20_000), days: 90n },
  );
  assert.equal(DEFAULT_LIMITS.per_payment, BigInt(ALLOWANCE_DEFAULTS.perPaymentUsdc) * 1_000_000n, 'one source for the defaults');
  assert.deepEqual([...LIMIT_KINDS], ['per_payment', 'daily', 'monthly', 'days']);
});

test('the ceilings are in code: the per-payment ceiling is the 10,000 USDC an owner must always approve, and an allowance lasts at most a year', () => {
  assert.equal(LIMIT_CEILINGS.per_payment, AUTO_APPROVAL_CEILING_MINOR);
  assert.equal(LIMIT_CEILINGS.per_payment, U(10_000));
  assert.equal(LIMIT_CEILINGS.days, BigInt(ALLOWANCE_MAX_DAYS));
  for (const kind of LIMIT_KINDS) {
    assert.ok(LIMIT_CEILINGS[kind] > DEFAULT_LIMITS[kind], `${kind}: there is room above the default`);
    assert.ok(LIMIT_FLOORS[kind] < DEFAULT_LIMITS[kind], `${kind}: and room below it`);
  }
  assert.ok(LIMIT_CEILINGS.daily >= LIMIT_CEILINGS.per_payment && LIMIT_CEILINGS.monthly >= LIMIT_CEILINGS.daily, 'the ceilings keep the order a payment, a day and a month have');
});

test('the notice is 24 hours, and an approval starts it from the moment of the decision', () => {
  assert.equal(LIMIT_NOTICE_MS, 24 * 60 * 60 * 1000);
  assert.equal(effectiveAtMs(1_000), 1_000 + 86_400_000);
  assert.equal(WHAT_HAPPENS_NEXT, 'Splash reviews this. If approved it starts after a 24 hour notice.');
});

test('figures are read as an owner types them', () => {
  assert.equal(parseLimitValue('per_payment', '3,000'), U(3_000));
  assert.equal(parseLimitValue('daily', 7500.5), U(7_500.5));
  assert.equal(parseLimitValue('per_payment', '0'), null);
  assert.equal(parseLimitValue('per_payment', '-5'), null);
  assert.equal(parseLimitValue('per_payment', 'lots'), null);
  assert.equal(parseLimitValue('days', '120'), 120n);
  assert.equal(parseLimitValue('days', 120), 120n);
  assert.equal(parseLimitValue('days', '1.5'), null);
  assert.equal(parseLimitValue('days', '0'), null);
  assert.equal(parseLimitValue('days', ''), null);
  assert.equal(formatLimit('per_payment', U(2_000)), '2,000 USDC');
  assert.equal(formatLimit('days', 90n), '90 days');
  assert.equal(formatLimit('days', 1n), '1 day');
});

test('an owner may ask for a figure above the limit and inside the ceiling, and for nothing else', () => {
  assert.deepEqual(raiseProblems('daily', U(8_000), U(5_000)), []);
  assert.deepEqual(raiseProblems('daily', LIMIT_CEILINGS.daily, U(5_000)), [], 'exactly the ceiling is allowed');
  assert.match(raiseProblems('daily', U(5_000), U(5_000))[0], /not higher than your limit of 5,000 USDC/);
  assert.match(raiseProblems('daily', U(4_000), U(5_000))[0], /not higher/);
  assert.match(raiseProblems('daily', LIMIT_CEILINGS.daily + 1n, U(5_000))[0], /does not offer more than 50,000 USDC/);
  assert.match(raiseProblems('days', 400n, 90n)[0], /at most 366 days/);
});

test('the per-payment ceiling is the owners’ approval line, and it says so', () => {
  const over = raiseProblems('per_payment', U(10_000) + 1n, U(2_000));
  assert.equal(over.length, 1);
  assert.match(over[0], /cannot raise this above 10,000 USDC/);
  assert.match(over[0], /without an owner approving the payment/);
  assert.deepEqual(raiseProblems('per_payment', U(10_000), U(2_000)), [], 'the line itself is the most');
});

test('staff may grant a figure above the limit, no more than was asked and inside the ceiling', () => {
  assert.deepEqual(grantProblems('monthly', U(30_000), U(40_000), U(20_000)), []);
  assert.deepEqual(grantProblems('monthly', U(40_000), U(40_000), U(20_000)), []);
  assert.match(grantProblems('monthly', U(20_000), U(40_000), U(20_000))[0], /must be higher than/);
  assert.match(grantProblems('monthly', U(41_000), U(40_000), U(20_000))[0], /cannot be more than the 40,000 USDC the owner asked for/);
  assert.match(grantProblems('monthly', LIMIT_CEILINGS.monthly + 1n, LIMIT_CEILINGS.monthly + 5n, U(20_000))[0], /does not offer more than/);
});

test('an owner may lower to a figure below the limit and above the floor', () => {
  assert.deepEqual(lowerProblems('daily', U(1_000), U(5_000)), []);
  assert.deepEqual(lowerProblems('days', 1n, 90n), []);
  assert.match(lowerProblems('daily', U(5_000), U(5_000))[0], /not lower than your limit/);
  assert.match(lowerProblems('daily', U(6_000), U(5_000))[0], /ask Splash for one/);
  assert.match(lowerProblems('daily', 0n, U(5_000))[0], /above zero/);
  assert.match(lowerProblems('days', 0n, 90n)[0], /at least one day/);
});

test('a reason is a sentence in the owner’s own words', () => {
  assert.deepEqual(reasonProblems('We pay three suppliers on the first of the month.'), []);
  assert.match(reasonProblems('')[0], /at least 10 characters/);
  assert.match(reasonProblems('   more   ')[0], /at least 10 characters/);
  assert.match(reasonProblems('x'.repeat(501))[0], /500 characters or fewer/);
  assert.match(reasonProblems('no', 10)[0], /10 characters/);
  assert.equal(cleanReason('  one   two\nthree '), 'one two three');
  assert.equal(cleanReason(null), '');
});

test('an allowance is held to the business’s limits, with the same sentences on the page and on the server', () => {
  const limits = { ...DEFAULT_LIMITS };
  const fits = { perPaymentMinor: U(2_000), dailyMinor: U(5_000), monthlyMinor: U(20_000), expiresInDays: 90 };
  assert.deepEqual(allowanceLimitProblems(fits, limits), []);
  const over = allowanceLimitProblems({ perPaymentMinor: U(3_000), dailyMinor: U(6_000), monthlyMinor: U(21_000), expiresInDays: 91 }, limits);
  assert.equal(over.length, 4);
  assert.match(over[0], /one payment cannot be more than your business’s limit of 2,000 USDC/);
  assert.match(over[1], /daily limit cannot be more than your business’s limit of 5,000 USDC/);
  assert.match(over[2], /monthly limit cannot be more than your business’s limit of 20,000 USDC/);
  assert.match(over[3], /cannot last more than your business’s limit of 90 days/);
  for (const p of over) assert.match(p, /ask Splash for a higher limit in Settings, Limits/);
  // A raised limit lets the same allowance through; a lowered one stops what used to fit.
  assert.deepEqual(allowanceLimitProblems({ perPaymentMinor: U(3_000), dailyMinor: U(6_000), monthlyMinor: U(21_000), expiresInDays: 91 }, { per_payment: U(3_000), daily: U(6_000), monthly: U(21_000), days: 91n }), []);
  assert.equal(allowanceLimitProblems(fits, { ...limits, daily: U(1_000) }).length, 1);
  assert.equal(stricter(U(5), U(3)), U(3));
});

test('the daily limit automatic runs are held to: the owners’ own, else the standard, never more than the business’s', () => {
  const limits = { ...DEFAULT_LIMITS };
  assert.equal(effectiveDailyCap(null, limits), U(5_000), 'none set: the standard');
  assert.equal(effectiveDailyCap(U(3_000), limits), U(3_000), 'the owners’ own, lower');
  assert.equal(effectiveDailyCap(U(9_000), limits), U(5_000), 'the owners’ own can never lift the business’s');
  assert.equal(effectiveDailyCap(null, { ...limits, daily: U(12_000) }), U(5_000), 'a limit Splash raised does not raise what the owners never chose');
  assert.equal(effectiveDailyCap(U(9_000), { ...limits, daily: U(12_000) }), U(9_000), 'but the owners may choose up to it');
  assert.equal(effectiveDailyCap(null, { ...limits, daily: U(1_000) }), U(1_000), 'a lowered limit holds');
});

test('a request is asked, then waiting out its notice, then in force; or declined, or cancelled', () => {
  const T = Date.parse('2026-11-02T10:00:00Z');
  const approvedAt = T;
  const effective = effectiveAtMs(approvedAt);
  const facts = (over = {}) => ({ status: 'pending', requestedValue: U(8_000), grantedValue: null, effectiveAtMs: null, declineReason: null, ...over });
  assert.equal(requestPhase(facts(), T), 'asked');
  const approved = facts({ status: 'approved', grantedValue: U(8_000), effectiveAtMs: effective });
  assert.equal(requestPhase(approved, T), 'waiting');
  assert.equal(requestPhase(approved, effective - 1), 'waiting', 'one millisecond before it starts');
  assert.equal(requestPhase(approved, effective), 'in_force', 'at the moment it starts');
  assert.equal(requestPhase(facts({ status: 'applied', grantedValue: U(8_000), effectiveAtMs: effective }), effective + 1), 'in_force');
  assert.equal(requestPhase(facts({ status: 'declined' }), T), 'declined');
  assert.equal(requestPhase(facts({ status: 'cancelled' }), T), 'cancelled');
  assert.match(requestSentence('daily', facts(), U(5_000), T), /Splash is reviewing it\. Your limit stays 5,000 USDC/);
  assert.match(requestSentence('daily', approved, U(5_000), T), /starts 10:00 UTC on 3 Nov, after a 24 hour notice\. Until then your limit stays 5,000 USDC\. You can cancel before it starts/);
  assert.match(requestSentence('daily', facts({ status: 'approved', grantedValue: U(7_000), effectiveAtMs: effective }), U(5_000), T), /approved 7,000 USDC, less than the 8,000 USDC you asked for/);
  assert.match(requestSentence('daily', facts({ status: 'declined', declineReason: 'Your volume does not need it yet.' }), U(5_000), T), /declined the request for 8,000 USDC\. Your volume does not need it yet\./);
});

test('the notices tell the owners the figure, when it starts and that they can cancel; a decline says why', () => {
  const T = Date.parse('2026-11-02T10:00:00Z');
  const approved = limitNoticeText({ kind: 'approved', limit: 'daily', requested: U(8_000), granted: U(8_000), before: U(5_000), startsAtMs: effectiveAtMs(T), reason: null });
  assert.equal(approved.subject, 'Splash approved a higher limit');
  assert.match(approved.text, /8,000 USDC, up from 5,000 USDC/);
  assert.match(approved.text, /starts 10:00 UTC on 3 Nov, after a 24 hour notice/);
  assert.match(approved.text, /Any owner can cancel it before it starts/);
  const smaller = limitNoticeText({ kind: 'approved', limit: 'daily', requested: U(8_000), granted: U(6_000), before: U(5_000), startsAtMs: effectiveAtMs(T), reason: null });
  assert.match(smaller.text, /less than the 8,000 USDC you asked for/);
  const declined = limitNoticeText({ kind: 'declined', limit: 'per_payment', requested: U(5_000), granted: null, before: U(2_000), startsAtMs: null, reason: 'We need two more months of payment history.' });
  assert.match(declined.text, /We need two more months of payment history\./);
  assert.match(declined.text, /Your limit stays 2,000 USDC/);
  const started = limitNoticeText({ kind: 'started', limit: 'days', requested: 180n, granted: 180n, before: 90n, startsAtMs: effectiveAtMs(T), reason: null });
  assert.match(started.text, /now 180 days, up from 90 days/);
  for (const n of [approved, smaller, declined, started]) {
    assert.doesNotMatch(n.subject + n.text, /[—–]/, 'no dashes as punctuation');
    assert.doesNotMatch(n.subject + n.text, /testnet|demo|coming soon/i);
  }
});
