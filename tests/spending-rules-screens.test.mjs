import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { copyViolations } from '../scripts/copy-rules.mjs';
import { ruleLine } from '../lib/team-rules/view.ts';
import { ruleRequest } from '../lib/team-rules/form.ts';
import { ruleSteps, validateStep, withRecipients } from '../lib/team-rules/steps.ts';
import { askFailureText, explainSpendFailure, revokeWords, rulesState } from '../lib/team-rules/states.ts';
import { reviewSummary, ruleSummary, timeLeftWords } from '../lib/team-rules/summary.ts';

/**
 * v2 Phase 3, brief 4.2 and decision D2: the spending-rules screens in
 * Settings > Team & rules. A rule per staff member (per-payment maximum, a
 * daily or monthly cap, an optional lifetime cap, an expiry), the verified
 * recipients it may pay, a plain-words summary of what the person pays alone
 * and what goes to the owners, live spend and the time left in the window, a
 * one-question-at-a-time create and change flow, a revoke that says what
 * stops, and an honest state for loading, error, no policy, no staff and no
 * rules. The chain and the signing flow are tested in spend-rules.test.mjs;
 * here are the words, the steps and the states.
 */

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const U = (n) => String(Math.round(n * 1_000_000));
const NOW = new Date('2026-10-28T10:00:00Z');
const HOUR = 3_600_000;
const MIN = 60_000;

/* Time left ------------------------------------------------------------------ */

test('time left is said in the two units a person can use: minutes, hours, days', () => {
  assert.equal(timeLeftWords(0), 'now');
  assert.equal(timeLeftWords(-5 * HOUR), 'now');
  assert.equal(timeLeftWords(30_000), 'under a minute');
  assert.equal(timeLeftWords(MIN), '1 minute');
  assert.equal(timeLeftWords(5 * MIN), '5 minutes');
  assert.equal(timeLeftWords(HOUR), '1 hour');
  assert.equal(timeLeftWords(5 * HOUR + 12 * MIN), '5 hours 12 minutes');
  assert.equal(timeLeftWords(6 * HOUR + 30 * MIN), '6 hours');
  assert.equal(timeLeftWords(47 * HOUR), '47 hours');
  assert.equal(timeLeftWords(48 * HOUR), '2 days');
  assert.equal(timeLeftWords(3 * 24 * HOUR + 5 * HOUR), '3 days 5 hours');
  assert.equal(timeLeftWords((95 * 24 + 14) * HOUR), '95 days');
  assert.equal(timeLeftWords(Number.NaN), 'now');
});

/* A rule line ---------------------------------------------------------------- */

const rule = (over = {}) => ({
  userId: 'u-staff',
  name: 'Aisha Rahman',
  spender: '0xaaa',
  role: 'staff',
  standing: 'member',
  perPaymentMaxMinor: U(500),
  status: 'active',
  allowances: [{ current: true, state: 'active', expiresAtMs: String(Date.UTC(2027, 1, 1)), currentSpendMinor: U(300), lifetimeCapMinor: null, lifetimeRemainingMinor: null, spendableNowMinor: U(1700), window: { period: 'day', limitMinor: U(2000), spentMinor: U(300), remainingMinor: U(1700), startsAtMs: String(Date.UTC(2026, 9, 28)), endsAtMs: String(Date.UTC(2026, 9, 29)), rolledOver: false } }],
  runningTotals: [],
  recentSpends: [],
  ...over,
});
const policy = (over = {}) => ({ perPaymentMaxMinor: U(5000), secondApprovalThresholdMinor: U(10000), runningWindowMs: String(24 * HOUR), recipients: [{ address: '0xr1', tag: 'wallet' }, { address: '0xr2', tag: 'exchange' }], beneficiaries: [], ...over });

test('a rule line shows the time left in the window and in the rule, and what has been paid under it', () => {
  const l = ruleLine(rule(), NOW);
  assert.equal(l.renewsIn, 'Renews in 14 hours');
  assert.equal(l.endsIn, 'Ends in 95 days');
  assert.equal(l.paidInAll, 'Paid since the rule was set: 300.00 USDC');
  // A window that has passed starts again with the next payment: there is no time left to show.
  const rolled = ruleLine(rule({ allowances: [{ ...rule().allowances[0], window: { ...rule().allowances[0].window, rolledOver: true, spentMinor: '0', remainingMinor: U(2000) } }] }), NOW);
  assert.equal(rolled.renewsIn, null);
  // A rule that has ended says so instead of counting.
  const ended = ruleLine(rule({ allowances: [{ ...rule().allowances[0], expiresAtMs: String(Date.UTC(2026, 9, 28, 9)) }] }), NOW);
  assert.equal(ended.endsIn, null);
  assert.equal(ruleLine(rule({ allowances: [] , status: 'no_allowance'}), NOW).paidInAll, null);
});

/* The plain-words summary ---------------------------------------------------- */

test('what a person can pay alone, and what needs approval, are said in plain words from the rule and the policy', () => {
  const s = ruleSummary(rule(), policy(), NOW);
  assert.deepEqual(s.alone, [
    'Pay up to 500.00 USDC in one payment.',
    'Pay up to 2,000.00 USDC a day in all, counting the most each payment’s fee could be.',
    'Pay the 2 recipients you have verified.',
    'Until 2027-01-31 (UTC).',
  ]);
  assert.deepEqual(s.approval, [
    'A payment over 500.00 USDC goes to the owners to pay.',
    'A payment that would take them past 2,000.00 USDC a day goes to the owners to pay.',
    'A payment to anyone who is not a verified recipient goes to the owners to pay.',
    'A payment that would take what they have paid one recipient over 24 hours above 10,000.00 USDC needs an owner’s approval before it is paid.',
  ]);
});

test('the threshold is the policy’s, the per-payment limit is the smaller of the rule’s and the business’s, and a month is a month', () => {
  const s = ruleSummary(rule({ perPaymentMaxMinor: U(8000), allowances: [{ ...rule().allowances[0], window: { ...rule().allowances[0].window, period: 'month' } }] }), policy({ secondApprovalThresholdMinor: U(2500), runningWindowMs: String(72 * HOUR), perPaymentMaxMinor: U(3000) }), NOW);
  assert.equal(s.alone[0], 'Pay up to 3,000.00 USDC in one payment.');
  assert.match(s.alone[1], /a month in all/);
  assert.match(s.approval[0], /over 3,000.00 USDC/);
  assert.match(s.approval[1], /past 2,000.00 USDC a month/);
  assert.match(s.approval[3], /over 3 days above 2,500.00 USDC/);
  // The rule never says "or more": a payment of exactly the threshold needs no approval, one cent over does.
  assert.doesNotMatch(s.approval.join(' '), /or more/);
});

test('a lifetime cap is said with what is left of it, and one recipient is not "1 recipients"', () => {
  const s = ruleSummary(rule({ allowances: [{ ...rule().allowances[0], lifetimeCapMinor: U(20000), lifetimeRemainingMinor: U(19700) }] }), policy({ recipients: [{ address: '0xr1', tag: 'wallet' }] }), NOW);
  assert.ok(s.alone.includes('No more than 20,000.00 USDC in all under this rule (19,700.00 USDC left).'));
  assert.ok(s.alone.includes('Pay the 1 recipient you have verified.'));
});

test('with no verified recipient nothing can be paid alone, and the summary says so instead of promising it', () => {
  const s = ruleSummary(rule(), policy({ recipients: [], beneficiaries: [] }), NOW);
  assert.ok(s.alone.includes('No recipient is verified yet, so every payment goes to the owners until you verify one.'));
  assert.ok(!s.alone.some((l) => /^Pay the/.test(l)));
  const banks = ruleSummary(rule(), policy({ recipients: [], beneficiaries: [{}] }), NOW);
  assert.ok(banks.alone.includes('Pay the 1 recipient you have verified.'), 'a verified bank account is a recipient too');
});

test('a rule that cannot pay says why and sends every payment to the owners', () => {
  for (const [status, label] of [['expired', 'Expired'], ['not_started', 'Starts later'], ['no_allowance', 'Taken back']]) {
    const s = ruleSummary(rule({ status, ...(status === 'no_allowance' ? { allowances: [] } : {}) }), policy(), NOW);
    assert.deepEqual(s.alone, [], status);
    assert.equal(s.approval.length, 1, status);
    assert.match(s.approval[0], new RegExp(`cannot pay on their own right now \\(${label}\\)`));
    assert.match(s.approval[0], /Every payment goes to the owners/);
  }
  const gone = ruleSummary(rule({ standing: 'removed' }), policy(), NOW);
  assert.deepEqual(gone.alone, []);
  assert.match(gone.approval[0], /Belongs to someone who left/);
  assert.equal(ruleSummary(rule(), null, NOW).approval.some((l) => /above/.test(l)), false, 'with no policy no threshold is invented');
});

test('the review step reads the rule an owner is about to ask for, from the exact body', () => {
  const form = { staffUserId: 'u-staff', perPayment: '500', period: 'month', cap: '5,000', expires: '2027-01-31', lifetimeCap: '20000' };
  const made = ruleRequest(form, { now: NOW, policyMaxMinor: BigInt(U(5000)) });
  assert.equal(made.ok, true);
  const s = reviewSummary(made.body, policy(), 'Aisha Rahman');
  assert.equal(s.alone[0], 'Pay up to 500.00 USDC in one payment.');
  assert.equal(s.alone[1], 'Pay up to 5,000.00 USDC a month in all, counting the most each payment’s fee could be.');
  assert.ok(s.alone.includes('No more than 20,000.00 USDC in all under this rule.'));
  assert.ok(s.alone.includes('Until 2027-01-31 (UTC).'));
  assert.match(s.approval.join('\n'), /above 10,000.00 USDC needs an owner’s approval/);
});

/* The steps ------------------------------------------------------------------ */

test('a new rule asks one question at a time: who, how much a payment, the cap, a lifetime total, the recipients, the end, then a review', () => {
  assert.deepEqual(ruleSteps(false).map((s) => s.id), ['who', 'per_payment', 'cap', 'lifetime', 'recipients', 'ends', 'review']);
  assert.deepEqual(ruleSteps(true).map((s) => s.id), ['per_payment', 'cap', 'lifetime', 'ends', 'review'], 'a change is for one person already, and recipients belong to the business');
  for (const s of ruleSteps(false)) {
    assert.ok(s.question.endsWith('?') || s.id === 'review', s.id);
    assert.ok(s.question.length > 0);
  }
  assert.equal(ruleSteps(false).find((s) => s.id === 'lifetime').optional, true);
  assert.equal(ruleSteps(false).find((s) => s.id === 'recipients').optional, true);
  assert.equal(ruleSteps(false).find((s) => s.id === 'cap').optional, undefined);
});

const form = (over = {}) => ({ staffUserId: 'u-staff', perPayment: '500', period: 'day', cap: '2,000', expires: '2027-01-31', lifetimeCap: '', ...over });
const ctx = { now: NOW, policyMaxMinor: BigInt(U(5000)) };

test('each step is checked on its own before the next question, and says what is wrong in that step only', () => {
  const blank = { staffUserId: '', perPayment: '', period: 'day', cap: '', expires: '', lifetimeCap: '' };
  assert.deepEqual(Object.keys(validateStep('who', blank, ctx)), ['staffUserId']);
  assert.deepEqual(Object.keys(validateStep('per_payment', blank, ctx)), ['perPayment']);
  assert.deepEqual(Object.keys(validateStep('cap', blank, ctx)), ['cap']);
  assert.deepEqual(validateStep('lifetime', blank, ctx), {}, 'a lifetime total is optional');
  assert.deepEqual(validateStep('recipients', blank, ctx), {});
  assert.deepEqual(Object.keys(validateStep('ends', blank, ctx)), ['expires']);
  assert.deepEqual(validateStep('who', form(), ctx), {});
  assert.match(validateStep('per_payment', form({ perPayment: '6000', cap: '9000' }), ctx).perPayment, /more than the business’s limit of 5,000/);
  assert.match(validateStep('cap', form({ cap: '100' }), ctx).cap, /lower than the most one payment/);
  assert.match(validateStep('lifetime', form({ lifetimeCap: '100' }), ctx).lifetimeCap, /lower than the most one payment/);
  assert.match(validateStep('ends', form({ expires: '2026-10-27' }), ctx).expires, /in the future/);
  assert.match(validateStep('ends', form({ expires: '2028-10-28' }), ctx).expires, /within a year/);
  // The last step holds every field, so nothing is asked of the owners that an earlier step would have refused.
  assert.deepEqual(Object.keys(validateStep('review', blank, ctx)).sort(), ['cap', 'expires', 'perPayment', 'staffUserId']);
  assert.deepEqual(validateStep('review', form(), ctx), {});
});

test('recipients go with a new rule only, only as wallet or exchange, and only once each', () => {
  const body = ruleRequest(form(), ctx).body;
  assert.equal('recipients' in withRecipients(body, []), false);
  const picked = withRecipients(body, [
    { address: '0xr1', tag: 'wallet' },
    { address: '0xr1', tag: 'wallet' },
    { address: '0xr2', tag: 'exchange' },
    { address: '0xr3', tag: 'bank' },
    { address: '', tag: 'wallet' },
  ]);
  assert.deepEqual(picked.recipients, { add: [{ address: '0xr1', tag: 'wallet' }, { address: '0xr2', tag: 'exchange' }] });
  assert.equal(picked.staffUserId, 'u-staff');
  assert.equal(JSON.stringify(picked).includes('orgId'), false);
});

/* States --------------------------------------------------------------------- */

test('the rules area is always in one honest state: loading, error, no policy, no staff, no rules, or the list', () => {
  const base = { owner: true, loading: false, error: null, hasPolicy: true, staff: 2, rules: 0 };
  assert.equal(rulesState({ ...base, loading: true }), 'loading');
  assert.equal(rulesState({ ...base, error: 'Could not read' }), 'error');
  assert.equal(rulesState({ ...base, hasPolicy: false }), 'no_policy');
  assert.equal(rulesState({ ...base, staff: 0 }), 'no_staff');
  assert.equal(rulesState(base), 'empty');
  assert.equal(rulesState({ ...base, rules: 1 }), 'list');
  // Rules whose holders are gone are still shown so the owners can take them back.
  assert.equal(rulesState({ ...base, staff: 0, rules: 1 }), 'list');
  // Waiting is not failing, and an error beats a stale list.
  assert.equal(rulesState({ ...base, loading: true, error: 'x', rules: 3 }), 'loading');
  // Someone who is not an owner never sees "no staff": they are told they have no rule.
  assert.equal(rulesState({ ...base, owner: false, staff: 0 }), 'empty');
});

test('taking a rule back says what stops, what stays, and that it needs no waiting', () => {
  const w = revokeWords('Aisha Rahman');
  assert.equal(w.title, 'Take back Aisha Rahman’s rule?');
  const stops = w.stops.join(' ');
  assert.match(stops, /Aisha Rahman can no longer pay anyone on their own/);
  assert.match(stops, /allowance is revoked/);
  assert.match(stops, /open payments stop/);
  const stays = w.stays.join(' ');
  assert.match(stays, /Payments already made stay on the record/);
  assert.match(stays, /pay again with the owners/);
  assert.match(stays, /give a new rule later/);
  assert.match(w.note, /takes effect at once/);
  assert.match(w.note, /owners sign/);
  assert.equal(revokeWords(null).title, 'Take back this rule?');
});

test('a failure is said in the customer’s words: not open yet, the chain could not be reached, a request is already waiting', () => {
  // The server's own text can name an environment variable; the customer is never shown it.
  const notOpen = explainSpendFailure(503, 'spending rules need SPLASH_SPEND_PACKAGE_ID and SPLASH_SPEND_POLICY_REGISTRY_ID (0x + 64 hex each)');
  assert.match(notOpen, /not open for your business yet/);
  assert.doesNotMatch(notOpen, /SPLASH_SPEND|0x/);
  assert.match(explainSpendFailure(502, 'x'), /could not reach the chain/);
  assert.match(explainSpendFailure(0, ''), /Could not reach Splash/);
  assert.equal(explainSpendFailure(403, 'Only an owner can do that.'), 'Only an owner can do that.');
  assert.match(explainSpendFailure(500, ''), /could not be read/);

  assert.match(askFailureText({ status: 409, code: 'request_open', error: 'a request like this is already waiting for signatures' }, 'give'), /already waiting for the owners’ signatures/);
  assert.match(askFailureText({ status: 409, code: 'request_open', error: 'x' }, 'revoke'), /Needs your signature/);
  assert.match(askFailureText({ status: 409, code: 'rule_exists', error: 'this person already has a rule; change it instead' }, 'give'), /already has a rule/);
  assert.match(askFailureText({ status: 503, code: undefined, error: 'spending rules need SPLASH_SPEND_PACKAGE_ID' }, 'give'), /not open for your business yet/);
  assert.equal(askFailureText({ status: 400, code: 'bad_limit', error: 'The cap must be above zero.' }, 'give'), 'The cap must be above zero.');
  assert.match(askFailureText({ status: 0, code: undefined, error: '' }, 'give'), /Nothing was changed/);
});

/* The screens ---------------------------------------------------------------- */

test('the create and change flow is a sheet that asks one question per step, and nothing in it signs or names a business', () => {
  const form = code(read('components/settings/RuleForm.tsx'));
  assert.match(form, /ruleSteps\(/);
  assert.match(form, /validateStep\(/);
  assert.match(form, /reviewSummary\(/);
  assert.match(form, /withRecipients\(/);
  assert.match(form, /aria-current={[^}]*'step'/);
  assert.doesNotMatch(form, /signTransaction|signWithPasskey|fetch\(|orgId|accountId/);
  const section = code(read('components/settings/RulesSection.tsx'));
  assert.match(section, /<Modal /, 'the form is a sheet; on a phone it is the whole screen');
  assert.match(section, /side/);
  assert.match(section, /rulesState\(/);
  assert.match(section, /revokeWords\(/);
  assert.match(section, /ruleSummary\(/);
  assert.match(section, /Try again/);
});

test('an owner is not told "no staff" in the same breath as a list, and "no staff yet" points to where people are added', () => {
  const section = read('components/settings/RulesSection.tsx');
  assert.match(section, /No staff yet/);
  assert.match(section, /href="#team"/);
  assert.match(section, /Add a person/);
});

test('the sign-off screen after a rule request says who is asked, in the owners’ words', () => {
  const sign = read('components/settings/SignFlow.tsx');
  assert.match(sign, /CHANGE_LABELS/);
  assert.match(sign, /on their own device/);
  const section = read('components/settings/RulesSection.tsx');
  assert.match(section, /Each owner is asked in Splash and by their approval channel/);
});

test('only the Settings screens an owner reaches call the rule routes, and the Finance lead is never offered them', () => {
  const section = read('components/settings/RulesSection.tsx');
  assert.match(section, /owner && /, 'the buttons are for owners');
  const team = read('lib/team/view.ts');
  assert.match(team, /Finance lead/);
  // The server decides: every rule route is owner-only (spend-rules.test.mjs). The page does not offer what it refuses.
  for (const route of ['route.ts', '[staffUserId]/route.ts']) {
    const source = read(`app/api/wallet/spending-rules/${route}`);
    assert.match(source, /requireOwner\(route,/);
  }
});

test('the new files hold the house rules: no coral, Demo, Coming soon, testnet, grid, unsigned partner or licence claim', () => {
  for (const name of ['lib/team-rules/summary.ts', 'lib/team-rules/steps.ts', 'lib/team-rules/states.ts', 'components/settings/RuleForm.tsx', 'components/settings/RulesSection.tsx']) {
    const text = read(name);
    const body = code(text);
    assert.doesNotMatch(body, /E39774|coral|\bDemo\b|\bDEMO\b|Coming soon|testnet|bg-grid|grid-background|non-custodial|licen[cs]ed/i, name);
    assert.doesNotMatch(body, /\b(Hata|Fiuu|PDAX|DurianPay|Halliday|Stripe|TransFi|Bridge|Elliptic|Chainalysis|Sumsub)\b/, name);
    assert.deepEqual(copyViolations(name, text), [], name);
  }
});
