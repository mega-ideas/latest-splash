/**
 * How a business's limits start (v2 Phase 3, Sky's decision): the starting figures, the one pure function that turns
 * a business's three answers into proposed limits, the two lines above which a raise needs two people at Splash, and
 * what an answer may look like.
 *
 *   figures     per payment 50,000 USDC and daily 100,000 USDC to start; they are starting points, not ceilings
 *   formula     monthly worked out from the answers; every proposal capped at the starting figures
 *   edges       zero, huge, text, negative, missing, hostile text
 *   two people  daily above 250,000 USDC or monthly above 2,500,000 USDC: two different Splash staff approvals
 *   controls    the Settings, Controls figures are shown with the Limits figures, in words that are true
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  DEFAULT_LIMITS,
  LARGE_GRANT_LINES,
  LIMIT_SANITY_MAX,
  allowanceLimitProblems,
  effectiveDailyCap,
  ceilingWords,
  grantProblems,
  needsTwoApprovals,
  raiseProblems,
} from '../lib/limits/rules.ts';
import { ANSWER_TEXT_MAX, FORMULA_VERSION, STARTING_MINIMUMS, cleanAnswerText, controlsAndLimitsWords, proposeStart, startWords } from '../lib/limits/start.ts';

const U = (usdc) => BigInt(Math.round(usdc * 1_000_000));
const answers = (monthlyUsdc, paymentsPerWeek, firstTransferUsdc) => ({ monthlyUsdc, paymentsPerWeek, firstTransferUsdc });
const text = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

// ─── The starting figures ────────────────────────────────────────────────────

test('a business starts at 50,000 USDC a payment and 100,000 a day, as starting points and not ceilings', () => {
  assert.equal(DEFAULT_LIMITS.per_payment, U(50_000));
  assert.equal(DEFAULT_LIMITS.daily, U(100_000));
  assert.equal(DEFAULT_LIMITS.monthly, U(500_000), 'the round-three monthly figure, now a starting point');
  assert.equal(DEFAULT_LIMITS.days, 90n);
  // The round-three ceilings (10,000 a payment, 50,000 a day, 500,000 a month) are gone: a limit can be asked for and granted above the start.
  assert.ok(LIMIT_SANITY_MAX.daily > DEFAULT_LIMITS.daily * 10n);
  assert.ok(LIMIT_SANITY_MAX.monthly > DEFAULT_LIMITS.monthly * 10n);
  assert.deepEqual(raiseProblems('daily', U(300_000), DEFAULT_LIMITS.daily), [], 'staff can be asked for more than the start');
  assert.deepEqual(grantProblems('monthly', U(3_000_000), U(3_000_000), DEFAULT_LIMITS.monthly), [], 'and can grant it');
  assert.match(raiseProblems('daily', LIMIT_SANITY_MAX.daily + 1n, DEFAULT_LIMITS.daily)[0], /does not offer more than|too large|typo/i, 'only an absurd figure is refused');
  const words = ceilingWords('daily');
  assert.doesNotMatch(words, /cannot raise|the most Splash will ever/i, 'the words no longer promise a ceiling');
});

test('the owners’ daily limit that was never chosen stays the 5,000 it always was, whatever the business starts at', () => {
  assert.equal(effectiveDailyCap(null, { ...DEFAULT_LIMITS }), U(5_000));
  assert.equal(effectiveDailyCap(U(80_000), { ...DEFAULT_LIMITS }), U(80_000), 'the owners’ own, up to the business limit');
  assert.equal(effectiveDailyCap(U(150_000), { ...DEFAULT_LIMITS }), U(100_000), 'never past the business limit');
});

test('an allowance is held to the business’s limits, which now start higher', () => {
  const form = { perPaymentMinor: U(9_000), dailyMinor: U(60_000), monthlyMinor: U(400_000), expiresInDays: 90 };
  assert.deepEqual(allowanceLimitProblems(form, { ...DEFAULT_LIMITS }), []);
});

// ─── The formula ─────────────────────────────────────────────────────────────

test('a small business is proposed figures worked out from what it said, and nothing is capped', () => {
  const p = proposeStart(answers('20,000', '5', '10,000'));
  assert.equal(p.ok, true, JSON.stringify(p));
  assert.equal(p.limits.monthly, U(30_000), 'half as much again as the month it expects');
  assert.equal(p.limits.per_payment, U(1_900), 'twice the average payment, to two figures, rounded up');
  assert.equal(p.limits.daily, U(3_000), 'a tenth of the month in a day, never less than a payment');
  assert.deepEqual({ ...p.wanted }, { ...p.limits }, 'nothing was held back');
  assert.deepEqual(p.cappedKinds, []);
  assert.equal(p.formulaVersion, FORMULA_VERSION);
});

test('a big business is capped at the starting figures, and the proposal says what it asked for beyond them', () => {
  const p = proposeStart(answers('2,000,000', '20', '500,000'));
  assert.equal(p.ok, true);
  assert.deepEqual({ ...p.limits }, { per_payment: U(47_000), daily: DEFAULT_LIMITS.daily, monthly: DEFAULT_LIMITS.monthly });
  assert.deepEqual({ ...p.wanted }, { per_payment: U(47_000), daily: U(300_000), monthly: U(3_000_000) });
  assert.deepEqual([...p.cappedKinds].sort(), ['daily', 'monthly']);
  for (const kind of ['per_payment', 'daily', 'monthly']) assert.ok(p.limits[kind] <= DEFAULT_LIMITS[kind], `${kind} never starts above the starting figure`);
});

test('the first transfer in counts as part of the month when it is the larger', () => {
  const p = proposeStart(answers('1,000', '2', '50,000'));
  assert.equal(p.ok, true);
  assert.equal(p.limits.monthly, U(75_000));
});

test('tiny answers still give a limit that can pay an invoice: the minimums', () => {
  const p = proposeStart(answers('50', '1', '50'));
  assert.equal(p.ok, true);
  assert.deepEqual({ ...p.limits }, { per_payment: STARTING_MINIMUMS.per_payment, daily: STARTING_MINIMUMS.daily, monthly: STARTING_MINIMUMS.monthly });
  for (const kind of ['per_payment', 'daily', 'monthly']) assert.ok(STARTING_MINIMUMS[kind] < DEFAULT_LIMITS[kind]);
  assert.ok(STARTING_MINIMUMS.per_payment <= STARTING_MINIMUMS.daily && STARTING_MINIMUMS.daily <= STARTING_MINIMUMS.monthly);
});

test('whatever the answers, a payment fits in a day and a day in a month', () => {
  for (const [m, w, f] of [['1', '1', '1'], ['99,999', '100000', '1'], ['5,000,000', '1', '5,000,000'], ['300', '40', '9,000'], ['12.5', '3', '0.01']]) {
    const p = proposeStart(answers(m, w, f));
    if (!p.ok) continue;
    assert.ok(p.limits.per_payment <= p.limits.daily && p.limits.daily <= p.limits.monthly, `${m}/${w}/${f}`);
    assert.ok(p.wanted.per_payment <= p.wanted.daily && p.wanted.daily <= p.wanted.monthly, `${m}/${w}/${f} wanted`);
  }
});

test('answers in plain words: commas, a dollar sign, USDC, k and m', () => {
  const same = proposeStart(answers('20,000', '5', '10,000'));
  for (const variant of [answers('20000', '5', '10000'), answers('$20,000', '5', '$10,000 USDC'), answers('20k', '5', '10k'), answers(' 20,000 USDC ', ' 5 ', '10,000')]) {
    const p = proposeStart(variant);
    assert.equal(p.ok, true, JSON.stringify(variant));
    assert.deepEqual({ ...p.limits }, { ...same.limits }, JSON.stringify(variant));
  }
  assert.equal(proposeStart(answers('1.5m', '10', '100k')).ok, true);
  assert.equal(proposeStart(answers(20000, 5, 10000)).ok, true, 'numbers from a script are fine too');
});

// ─── The edges: zero, huge, text, negative, missing ──────────────────────────

test('every answer that cannot be used is said in plain words, per answer, and the figures stay the starting ones', () => {
  const bad = [
    ['zero', answers('0', '5', '10,000'), 'monthlyUsdc'],
    ['zero a week', answers('20,000', '0', '10,000'), 'paymentsPerWeek'],
    ['zero first', answers('20,000', '5', '0'), 'firstTransferUsdc'],
    ['negative', answers('-20,000', '5', '10,000'), 'monthlyUsdc'],
    ['negative a week', answers('20,000', '-3', '10,000'), 'paymentsPerWeek'],
    ['text', answers('a lot', '5', '10,000'), 'monthlyUsdc'],
    ['text a week', answers('20,000', 'plenty', '10,000'), 'paymentsPerWeek'],
    ['half a payment', answers('20,000', '2.5', '10,000'), 'paymentsPerWeek'],
    ['missing', answers(undefined, '5', '10,000'), 'monthlyUsdc'],
    ['missing a week', answers('20,000', undefined, '10,000'), 'paymentsPerWeek'],
    ['missing first', answers('20,000', '5', ''), 'firstTransferUsdc'],
    ['null', answers('20,000', '5', null), 'firstTransferUsdc'],
    ['object', answers({ valueOf: () => 5 }, '5', '10,000'), 'monthlyUsdc'],
    ['array', answers([20000], '5', '10,000'), 'monthlyUsdc'],
    ['exponent', answers('1e9', '5', '10,000'), 'monthlyUsdc'],
    ['hex', answers('0x10', '5', '10,000'), 'monthlyUsdc'],
    ['infinity', answers(Infinity, '5', '10,000'), 'monthlyUsdc'],
    ['NaN', answers(NaN, '5', '10,000'), 'monthlyUsdc'],
    ['too many a week', answers('20,000', '1000000', '10,000'), 'paymentsPerWeek'],
    ['absurdly huge', answers('9'.repeat(40), '5', '10,000'), 'monthlyUsdc'],
    ['too long', answers('1'.repeat(ANSWER_TEXT_MAX + 1), '5', '10,000'), 'monthlyUsdc'],
  ];
  for (const [name, input, field] of bad) {
    const p = proposeStart(input);
    assert.equal(p.ok, false, name);
    assert.ok(p.problems[field], `${name}: says what is wrong with ${field}`);
    assert.match(p.problems[field], /^[A-Z]/, `${name}: a sentence`);
    assert.deepEqual({ per_payment: p.limits.per_payment, daily: p.limits.daily, monthly: p.limits.monthly }, { per_payment: DEFAULT_LIMITS.per_payment, daily: DEFAULT_LIMITS.daily, monthly: DEFAULT_LIMITS.monthly }, `${name}: nothing is invented`);
  }
});

test('a huge but real figure is accepted and capped, never believed past the sanity maximum', () => {
  const p = proposeStart(answers('900,000,000,000', '100,000', '900,000,000,000'));
  assert.equal(p.ok, true);
  assert.ok(p.limits.monthly <= DEFAULT_LIMITS.monthly);
  assert.ok(p.wanted.monthly <= LIMIT_SANITY_MAX.monthly, 'what it asks for is never past the sanity maximum');
  assert.ok(p.wanted.daily <= LIMIT_SANITY_MAX.daily);
  assert.ok(p.wanted.per_payment <= LIMIT_SANITY_MAX.per_payment);
});

test('hostile text is rejected, never echoed, never turned into a different number', () => {
  const hostile = [
    '<script>alert(1)</script>',
    '"><img src=x onerror=alert(1)>',
    "20,000'; DROP TABLE business_limits;--",
    '20,000\n5',
    '20\u0000000',
    '20​000',
    '‮20,000',
    '20,000\r\nX-Injected: yes',
    '${process.env.SECRET}',
    '{{7*7}}',
    '20,000'.padEnd(ANSWER_TEXT_MAX + 5, '0'),
    'ＡＢＣ',
  ];
  for (const raw of hostile) {
    const p = proposeStart(answers(raw, '5', '10,000'));
    assert.equal(p.ok, false, JSON.stringify(raw));
    const said = JSON.stringify(p.problems);
    assert.ok(!said.includes(raw.slice(0, 6)) || raw.slice(0, 6).trim() === '', `the problem does not echo ${JSON.stringify(raw)}`);
    assert.doesNotMatch(said, /<|>|DROP|script|\$\{|\{\{/, 'and carries none of its characters');
  }
  // Full-width digits mean what they look like, once normalised.
  assert.equal(proposeStart(answers('２０，０００', '5', '10,000')).ok, false, 'full-width digits and commas are not numbers we read');
});

test('cleanAnswerText: control and direction characters become spaces, space collapses, and the result is capped by rejection, not by cutting', () => {
  assert.equal(cleanAnswerText('  20,000  '), '20,000');
  assert.equal(cleanAnswerText('20\u0000\u0007000'), '20 000');
  assert.equal(cleanAnswerText('‮20,000‬'), '20,000');
  assert.equal(cleanAnswerText('a\n\tb'), 'a b');
  assert.equal(cleanAnswerText(undefined), '');
  assert.equal(cleanAnswerText({ toString: () => 'x' }), '');
  assert.equal(typeof ANSWER_TEXT_MAX, 'number');
  assert.ok(ANSWER_TEXT_MAX >= 20 && ANSWER_TEXT_MAX <= 60);
  assert.equal(cleanAnswerText('1'.repeat(500)).length, 500, 'it never cuts: a cut number is a different number');
});

test('the proposal carries what it was made from, so the same answers always give the same proposal', () => {
  const a = proposeStart(answers('20,000', '5', '10,000'));
  const b = proposeStart(answers('20000', ' 5', '10k'));
  assert.deepEqual({ ...a.limits }, { ...b.limits });
  assert.equal(a.parsed.monthlyMinor, U(20_000));
  assert.equal(a.parsed.paymentsPerWeek, 5);
  assert.equal(a.parsed.firstTransferMinor, U(10_000));
});

// ─── The words ────────────────────────────────────────────────────────────────

test('"We started you at ... because you told us ..." says the figures and the answers, in plain words', () => {
  const p = proposeStart(answers('20,000', '5', '10,000'));
  const words = startWords(p, { applied: true });
  assert.match(words.headline, /^We started you at 1,900 USDC a payment, 3,000 USDC a day and 30,000 USDC a month because you told us /);
  assert.match(words.headline, /about 20,000 USDC a month/);
  assert.match(words.headline, /5 payments a week/);
  assert.match(words.headline, /first transfer into your wallet would be 10,000 USDC/);
  assert.equal(words.capped, null);
  const big = startWords(proposeStart(answers('2,000,000', '20', '500,000')), { applied: true });
  assert.match(big.capped ?? '', /more than we start a business at/i);
  assert.match(big.capped ?? '', /300,000 USDC a day/);
  const later = startWords(p, { applied: false });
  assert.doesNotMatch(later.headline, /^We started you at/, 'a business that already ran was not started from its answers');
  assert.match(later.headline, /would start a new business at 1,900 USDC a payment/);
});

test('nothing in the words uses a banned phrase', () => {
  const all = [startWords(proposeStart(answers('2,000,000', '20', '500,000')), { applied: true }), startWords(proposeStart(answers('20,000', '5', '10,000')), { applied: false }), controlsAndLimitsWords({ perTransferUsd: 50_000, dailyUsd: 250_000 }, { ...DEFAULT_LIMITS })];
  const flat = JSON.stringify(all);
  assert.doesNotMatch(flat, /coming soon|demo|testnet|non-custodial|coral/i);
  assert.ok(!flat.includes('—'), 'no em dash');
});

// ─── Two people for a large grant ────────────────────────────────────────────

test('the two lines are constants in one place: daily above 250,000 USDC or monthly above 2,500,000 needs two people', () => {
  assert.equal(LARGE_GRANT_LINES.daily, U(250_000));
  assert.equal(LARGE_GRANT_LINES.monthly, U(2_500_000));
  assert.equal(needsTwoApprovals('daily', U(250_000)), false, 'exactly the line is one approval');
  assert.equal(needsTwoApprovals('daily', U(250_000) + 1n), true);
  assert.equal(needsTwoApprovals('monthly', U(2_500_000)), false);
  assert.equal(needsTwoApprovals('monthly', U(2_500_000) + 1n), true);
  assert.equal(needsTwoApprovals('per_payment', U(9_000_000)), false, 'only the daily and monthly lines are two-person lines');
  assert.equal(needsTwoApprovals('days', 366n), false);
  assert.equal(needsTwoApprovals('daily', U(100_000)), false);
  const source = text('lib/limits/rules.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal((source.match(/250_000/g) ?? []).length, 1, 'the daily line is written once');
  assert.equal((source.match(/2_500_000/g) ?? []).length, 1, 'the monthly line is written once');
  for (const file of ['lib/server/business-limits.ts', 'components/admin/AdminLimitRequests.tsx', 'components/settings/LimitsCard.tsx']) {
    const other = text(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(other, /250_000|2_500_000|250,000|2,500,000/, `${file} reads the lines from lib/limits/rules.ts`);
  }
});

// ─── Controls and Limits, together ───────────────────────────────────────────

test('the Controls and Limits block shows both sets of figures and says which payments each one holds, without claiming a rule the code does not have', () => {
  const block = controlsAndLimitsWords({ perTransferUsd: 50_000, dailyUsd: 250_000 }, { ...DEFAULT_LIMITS });
  const flat = JSON.stringify(block);
  assert.match(flat, /50,000 USD/);
  assert.match(flat, /250,000 USD/);
  assert.match(flat, /50,000 USDC/);
  assert.match(flat, /100,000 USDC/);
  assert.match(block.controls.says, /payments your team sends/i);
  assert.match(block.limits.says, /payments Splash makes for you automatically/i);
  assert.doesNotMatch(flat, /lower one (always )?wins/i, 'the code never holds one payment to both, so the page does not say a lower one wins');
  assert.match(block.order, /not held to both|one set|never both/i);
  // Controls figures that cannot be read are said so, not shown as zero.
  const unknown = controlsAndLimitsWords(null, { ...DEFAULT_LIMITS });
  assert.match(JSON.stringify(unknown), /could not be read/i);
});

test('no automatic payment path reads the Controls figures, so no payment is held to both sets (the claim the page must not make)', () => {
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const file of ['lib/server/scheduled-runner.ts', 'lib/server/scheduled-payments.ts', 'lib/schedule/auto-check.ts']) {
    assert.doesNotMatch(strip(text(file)), /readOrgSettings|perTransferLimitUsd|dailyLimitUsd|org-settings/, `${file} does not read the Controls figures`);
  }
  for (const file of ['app/api/transfers/authorize/route.ts', 'app/api/treasury/route.ts']) {
    assert.match(strip(text(file)), /checkAuthorizationLimits/, `${file} is where the Controls figures are enforced`);
    assert.doesNotMatch(strip(text(file)), /currentLimits|business-limits/, `${file} does not read the Limits`);
  }
});
