/**
 * v2 Phase 3, staff payments inside a rule: what the person sees. Transfer
 * says, in the voice of the rest of the dashboard, who approves and why: a
 * payment inside the rule is theirs to sign with their own passkey; anything
 * outside it goes to the owners, with the reason and its numbers.
 *
 * The behaviour that can run in Node runs here; what a component must
 * contain is checked in its source (there is no browser in this suite; the
 * screenshots cover the rendering).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { APPROVAL_REASON_TEXT } from '../lib/transfer/plan.ts';
import { requestTitle } from '../lib/wallet-page/labels.ts';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('step 4 sends a payment inside the rule as "pay alone or tell me why not", and shows the owners’ reasons with their numbers', () => {
  const review = read('components/transfer/StepReview.tsx');
  assert.match(review, /approvalReasonLines\(/, 'the reasons are said with the limit, what is left and when it renews');
  assert.match(review, /via: plan\?\.route === 'staff_rule' \? 'rule' : undefined/, 'a page that said "within your rule" sends via rule, so a stale page is refused in words, never asked silently');
  assert.match(review, /code === 'outside_rule'/, 'the refusal is shown, and the quote and rule are read again');
  assert.match(review, /Pay now/, 'the button for a payment inside the rule');
  assert.match(review, /Ask the owners to approve/, 'the button for one outside it');
  assert.match(review, /plan\.route === 'staff_rule'/);
  assert.match(review, /Within your spending rule/, 'the section says which route this is');
  assert.match(review, /made\.route === 'staff_rule'/, 'the signing step is worded for the person who signs it');
  assert.match(review, /plan: answer\.body\?\.plan/, 'what the server decided, and why, comes back to the page');
  assert.doesNotMatch(review, /APPROVAL_REASON_TEXT\[r\]/, 'no bare reason list: the numbers are in the lines');
});

test('the signing panel names the one signer, "you", and says the rule is why nobody else has to sign', () => {
  const panel = read('components/transfer/SignPanel.tsx');
  assert.match(panel, /staff_rule_payment/);
  assert.match(panel, /Waiting for your signature/);
  assert.match(panel, /within your spending rule/i);
  assert.match(panel, /pay\.underRule/, 'what leaves the wallet comes from the draw under the allowance in the bytes');
  assert.match(panel, /signWithPasskey\(passkey, reviewed\.transactionBytes\)/, 'still the reviewed bytes, never the live request');
  const api = read('components/transfer/api.ts');
  assert.match(api, /purpose\?: string/);
});

test('the approve screens treat a payment under a rule as a payment', () => {
  assert.match(read('components/approve/ApproveDetail.tsx'), /'staff_rule_payment'/);
  assert.equal(requestTitle('staff_rule_payment'), 'Approve a payment under your spending rule');
  assert.match(read('components/approve/ApproveScreen.tsx'), /Within your spending rule, so you sign this yourself with your passkey/, 'on a phone the one signer is not told "each owner signs"');
  assert.match(read('components/transfer/SignPanel.tsx'), /withinRule=\{underRule\}/);
  const flow = read('components/transfer/flow.ts');
  assert.match(flow, /'owners_sign' \| 'asked_owners' \| 'staff_rule'/);
  assert.match(flow, /plan\?: \{ reasons: string\[\]; lines: string\[\] \}/);
});

test('"How it works" says who signs a staff member’s payment, and the context route reports whether paying under a rule is available', () => {
  const how = read('components/transfer/HowItWorks.tsx');
  assert.match(how, /spending rule covers the payment/);
  assert.match(how, /signs it alone with their own passkey/);
  const route = read('app/api/wallet/transfers/context/route.ts');
  assert.match(route, /staffRulePaymentsWired: wired/);
  assert.doesNotMatch(route, /STAFF_RULE_PAYMENTS_WIRED/);
});

test('the live wiring knows the new purpose: compliance before each signature, the invoice told once it executes, the evidence, the owner notice', () => {
  const deps = read('lib/server/wallet-deps.ts');
  assert.match(deps, /request\.purpose === 'wallet_payment' \|\| request\.purpose === 'spend_approval' \|\| request\.purpose === 'staff_rule_payment'/);
  assert.match(deps, /request\.purpose === 'wallet_payment' \|\| request\.purpose === 'staff_rule_payment'/);
  assert.match(read('lib/server/payment-compliance-gate.ts'), /request\.purpose !== 'staff_rule_payment'/);
  assert.match(read('lib/server/controls-evidence.ts'), /'staff_rule_payment'/);
  assert.match(read('lib/server/approval-requests.ts'), /case 'staff_rule_payment'/);
  const live = read('lib/server/wallet-transfers-deps.ts');
  assert.match(live, /staffSigner:/);
  assert.match(live, /m\.canSign/, 'only a passkey that can sign on this site');
  assert.match(live, /liveSpendContext\(route\)/, 'the chain client is the route’s own, for the session’s business');
});

test('the words a staff member reads stay in the dashboard’s voice: plain sentences, no promises Splash cannot keep', () => {
  const all = [...Object.values(APPROVAL_REASON_TEXT), ...['components/transfer/StepReview.tsx', 'components/transfer/SignPanel.tsx', 'components/transfer/HowItWorks.tsx'].map(read)].join('\n');
  assert.doesNotMatch(all, /coming soon|\bdemo\b|testnet|non-custodial|licen[cs]ed|same-day|zero fees/i);
  for (const text of Object.values(APPROVAL_REASON_TEXT)) {
    assert.doesNotMatch(text, /—|–/, text);
    assert.match(text, /^[A-Z]/);
  }
});
