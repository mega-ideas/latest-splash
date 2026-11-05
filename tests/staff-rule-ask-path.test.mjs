/**
 * v2 Phase 3, staff payments inside a rule: the page and the server say the
 * same thing, and a person the server turns away from paying alone always has
 * a way to ask the owners. Found by the independent review: the page counted
 * nothing already on its way, never sent "ask", and left a person stuck on a
 * button the server kept refusing.
 *
 * Pure rules run here; what a component or a route must contain is checked in
 * its source (the screenshots cover the rendering).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { approvalPlan, approvalReasonLines, APPROVAL_REASON_TEXT, STAFF_OPEN_LIMIT } from '../lib/transfer/plan.ts';
import { inFlightForPayee, paysAlone, staffFactsFrom } from '../lib/transfer/context.ts';
import { refusalAsksOwners, viaFor } from '../lib/transfer/send.ts';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const USDC = (n) => BigInt(Math.round(n * 1_000_000));
const WALLET = `0x${'77'.repeat(32)}`;
const ME = `0x${'a1'.repeat(32)}`;
const OTHER = `0x${'b2'.repeat(32)}`;
const NOW = Date.parse('2026-10-31T08:00:00Z');
const HOUR = 3_600_000;

const RULE = { status: 'active', perPaymentMaxMinor: USDC(5_000).toString(), spendableNowMinor: USDC(1_300).toString(), startsAtMs: null, expiresAtMs: String(NOW + 60 * 24 * HOUR), renewsAtMs: String(NOW + 80 * HOUR) };
const POLICY = { secondApprovalThresholdMinor: USDC(10_000).toString(), recipients: [{ address: WALLET, tag: 'wallet' }] };
const plan = (over = {}) =>
  approvalPlan({ role: 'MAKER', amountMinor: USDC(1_000), feeMinor: USDC(0.25), payee: { kind: 'wallet', wallet: 'self_custody', address: WALLET }, rule: RULE, policy: POLICY, runningTotalMinor: 0n, asset: 'USDC', nowMs: BigInt(NOW), settleByMs: BigInt(NOW + HOUR), ...over });

test('three payments waiting to be signed is the most a person has open; a fourth is the owners’ to approve', () => {
  assert.equal(STAFF_OPEN_LIMIT, 3);
  const flight = (openCount) => ({ spenderMinor: 0n, recipientMinor: 0n, openCount });
  assert.equal(plan({ inFlight: flight(2) }).route, 'staff_rule');
  const full = plan({ inFlight: flight(3) });
  assert.equal(full.route, 'ask_owners');
  assert.deepEqual(full.reasons, ['too_many_open']);
  assert.match(APPROVAL_REASON_TEXT.too_many_open, /3 payments waiting/);
  assert.match(APPROVAL_REASON_TEXT.staff_gas_share_used, /network-fee allowance/);
  assert.ok(!/—|–/.test(APPROVAL_REASON_TEXT.staff_gas_share_used));
});

test('the sentence for a cap that is short quotes what is left after what is already on its way', () => {
  const flight = { spenderMinor: USDC(1_000.25), recipientMinor: USDC(1_000), openCount: 1 };
  const p = plan({ inFlight: flight });
  assert.deepEqual(p.reasons, ['over_cap']);
  const [line] = approvalReasonLines(p, { rule: RULE, policy: POLICY, amountMinor: USDC(1_000), feeMinor: USDC(0.25), inFlight: flight, nowMs: NOW });
  assert.match(line, /299\.75 USDC left/);
  assert.doesNotMatch(line, /1,300\.00 USDC left/);
  assert.match(line, /1,000\.25 USDC is already on its way for you/);
  // A cap the window itself has used up says when it renews; one held only by payments on their way does not.
  const used = plan({ amountMinor: USDC(10), inFlight: { ...flight, spenderMinor: USDC(1_300) } });
  assert.deepEqual(used.reasons, ['cap_used_up']);
  const [heldLine] = approvalReasonLines(used, { rule: RULE, policy: POLICY, amountMinor: USDC(10), feeMinor: USDC(0.25), inFlight: { ...flight, spenderMinor: USDC(1_300) }, nowMs: NOW });
  assert.doesNotMatch(heldLine, /renews/);
  assert.match(heldLine, /not signed/);
  const chainUsed = plan({ rule: { ...RULE, spendableNowMinor: '0' } });
  const [chainLine] = approvalReasonLines(chainUsed, { rule: { ...RULE, spendableNowMinor: '0' }, policy: POLICY, amountMinor: USDC(1_000), nowMs: NOW });
  assert.match(chainLine, /renews in 3 days 8 hours \(16:00 UTC on 3 Nov\)/, 'a date the way the rest of the dashboard words one');
  assert.doesNotMatch(chainLine, /\d{4}-\d{2}-\d{2}/);
});

test('a rule that was taken back or replaced is worded for both', () => {
  assert.match(APPROVAL_REASON_TEXT.rule_revoked, /taken back or replaced/);
});

test('the facts the page plans with count every spender towards a recipient, and say whose passkey the rule is', () => {
  const rule = (spender, counted) => ({ spender, status: 'active', perPaymentMaxMinor: '1', allowances: [{ current: true, state: 'active', spendableNowMinor: '5' }], runningTotals: [{ recipient: WALLET, countedMinor: String(counted) }] });
  const view = { policy: { secondApprovalThresholdMinor: '10', recipients: [{ address: WALLET, tag: 'wallet' }] }, rules: [rule(ME, 6), rule(OTHER, 3)] };
  const facts = staffFactsFrom(view, [ME]);
  assert.equal(facts.runningTotals[WALLET.toLowerCase()], '9', 'the recipient’s total, whoever paid it');
  assert.equal(facts.spender, ME);
  assert.equal(staffFactsFrom(view, [`0x${'c3'.repeat(32)}`]).spender, null);
});

test('paying alone needs the policy, a gas sponsor and a passkey that is the rule’s own and can sign here', () => {
  const members = [{ address: ME, canSign: true }, { address: OTHER, canSign: true }];
  assert.equal(paysAlone({ hasPolicy: true, sponsored: true, spender: ME, members }), true);
  assert.equal(paysAlone({ hasPolicy: true, sponsored: true, spender: ME, members: [{ address: ME, canSign: false }, { address: OTHER, canSign: true }] }), false, 'another passkey that can sign is not the rule’s');
  assert.equal(paysAlone({ hasPolicy: true, sponsored: true, spender: null, members }), false);
  assert.equal(paysAlone({ hasPolicy: false, sponsored: true, spender: ME, members }), false);
  assert.equal(paysAlone({ hasPolicy: true, sponsored: false, spender: ME, members }), false);
});

test('what is already on its way reaches the page in the shape the plan counts', () => {
  const wire = { spenderMinor: '1000250000', openCount: 2, byRecipient: { [WALLET.toLowerCase()]: '1000000000' } };
  assert.deepEqual(inFlightForPayee(wire, WALLET), { spenderMinor: 1_000_250_000n, recipientMinor: 1_000_000_000n, openCount: 2 });
  assert.deepEqual(inFlightForPayee(wire, OTHER), { spenderMinor: 1_000_250_000n, recipientMinor: 0n, openCount: 2 });
  assert.deepEqual(inFlightForPayee(undefined, WALLET), { spenderMinor: 0n, recipientMinor: 0n, openCount: 0 });
});

test('every refusal that stops a person paying alone leaves a way to ask the owners with the same intent id', () => {
  for (const [status, code] of [[409, 'outside_rule'], [409, 'no_passkey_for_rule'], [503, 'staff_rule_unavailable'], [503, 'no_sponsor'], [502, 'rule_unreadable'], [429, 'staff_gas_share_used']]) {
    assert.equal(refusalAsksOwners(status, code), true, code);
  }
  for (const [status, code] of [[409, 'fee_changed'], [403, 'cannot_pay'], [400, 'bad_amount'], [409, 'funds_on_hold'], [0, undefined]]) {
    assert.equal(refusalAsksOwners(status, code), false, String(code));
  }
  assert.equal(viaFor('staff_rule', false), 'rule');
  assert.equal(viaFor('staff_rule', true), 'ask', 'after a refusal the same button asks the owners');
  assert.equal(viaFor('ask_owners', false), undefined);
  assert.equal(viaFor('owners_sign', false), undefined);
});

test('the review page keeps an ask path after a refusal, counts what is on its way, and the context route reports it', () => {
  const review = read('components/transfer/StepReview.tsx');
  assert.match(review, /refusalAsksOwners\(answer\.status, answer\.body\?\.code\)/);
  assert.match(review, /viaFor\(plan\?\.route, askInstead !== null\)/);
  assert.match(review, /askInstead/);
  assert.match(review, /inFlight: inFlightForPayee\(ctx\.inFlight, address\)/, 'the page plans with what is already on its way');
  assert.match(review, /inFlight: flight/, 'and says the reasons with it');
  assert.match(review, /Ask the owners to approve/);
  const route = read('app/api/wallet/transfers/context/route.ts');
  assert.match(route, /inFlight/);
  assert.match(route, /paysAlone\(/);
  assert.match(read('components/transfer/api.ts'), /inFlight/);
});
