/**
 * v2 Phase 3, brief 5.4, the independent review's findings on what the person
 * sees and signs: the Review step shows who is paid by address as well as by
 * name; the signing screen signs the bytes that were reviewed and checks them
 * against the payment that was approved; a shared receipt can be stopped and
 * is not indexed; the pop-up keeps its focus; the Business/Person toggle is a
 * real radio group with 44px targets.
 *
 * The behaviour that can run in Node runs here; what a component must contain
 * is checked in its source (there is no browser in this suite; the
 * screenshots cover the rendering).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { groupAddress } from '../lib/transfer/addresses.ts';
import { differsFromApproved } from '../lib/transfer/approved.ts';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const ADDRESS = `0x${'1234abcd'.repeat(8)}`;

test('an address is shown in groups of four so two can be compared by eye', () => {
  assert.equal(groupAddress(ADDRESS), `0x ${'1234 abcd '.repeat(8).trim()}`);
  assert.equal(groupAddress('not an address'), 'not an address');
});

test('the transaction is checked against the payment that was approved: payee, amount and fee bound', () => {
  const same = { actions: [{ type: 'withdraw', amountMinor: '5001000000' }, { type: 'open_intent', recipient: ADDRESS, amountMinor: '5000000000' }, { type: 'pay_intent', maxFeeMinor: '1000000' }] };
  const approved = { recipient: ADDRESS, amountMinor: '5000000000', maxFeeMinor: '1000000' };
  assert.equal(differsFromApproved(same, approved), null);
  assert.equal(differsFromApproved(same, { ...approved, recipient: null }), null, 'a bank payout names no address on the review');
  assert.match(differsFromApproved({ actions: same.actions.map((a) => (a.type === 'open_intent' ? { ...a, recipient: `0x${'ab'.repeat(32)}` } : a)) }, approved), /different address/);
  assert.match(differsFromApproved({ actions: same.actions.map((a) => (a.type === 'open_intent' ? { ...a, amountMinor: '5000000001' } : a)) }, approved), /different amount/);
  assert.match(differsFromApproved({ actions: same.actions.map((a) => (a.type === 'pay_intent' ? { ...a, maxFeeMinor: '2000000' } : a)) }, approved), /different Splash fee/);
  assert.match(differsFromApproved({ actions: [] }, approved), /does not pay/);
});

test('the signing screen signs exactly the bytes that were reviewed, shows who is paid by name and full address, and closes a review the server changed', () => {
  const panel = read('components/transfer/SignPanel.tsx');
  assert.match(panel, /signWithPasskey\(passkey, reviewed\.transactionBytes\)/);
  assert.match(panel, /digest: reviewed\.digest/);
  assert.doesNotMatch(panel, /signWithPasskey\(passkey, view\./, 'the live request is never what is signed');
  assert.match(panel, /next\.digest !== reviewedDigest\.current/, 'a poll that brings other bytes closes the open review');
  assert.match(panel, /differsFromApproved\(review, expected\)/, 'the review is checked against the Review step');
  assert.match(panel, /groupAddress\(normalizeSuiAddress\(open\.recipient\)\)/, 'the full address, not a shortened one');
  assert.doesNotMatch(panel, /shortAddress/);
  assert.match(panel, /expected\?\.payeeName/);
});

test('the Review step shows the address and country of who is paid, and a new address needs a check', () => {
  const review = read('components/transfer/StepReview.tsx');
  assert.match(review, /groupAddress\(quote\.payee\.address\)/);
  assert.match(review, /Country: \{quote\.payee\.country\}/);
  assert.match(review, /recentlyAdded/);
  assert.match(review, /quote\.payee\?\.recentlyAdded === true && !addressChecked/, 'the payment cannot be approved until the new address is confirmed');
  assert.match(review, /expected: \{ recipient: quote\.payee\?\.address/, 'what was approved goes on to the signing screen');
});

test('a receipt link can be stopped by an owner, and the public page is not indexed and sends no referrer', () => {
  const route = read('app/api/wallet/transfers/[ref]/share/route.ts');
  assert.match(route, /export async function DELETE/);
  assert.match(route, /requireOwner\(found\.route, 'stop sharing a receipt'\)/);
  assert.match(route, /export async function GET/);
  assert.match(route, /revokeReceiptShares/);
  assert.match(route, /requirePayoutReader/, 'a viewer can neither make nor list links');
  const page = read('app/receipt/[token]/page.tsx');
  assert.match(page, /robots: \{ index: false, follow: false \}/);
  assert.match(page, /referrer: 'no-referrer'/);
  assert.match(read('components/transfer/StepReceipt.tsx'), /Stop sharing/);
});

test('the payout route validates before it seals: no bundle for a request about to be refused, and what is sealed is the parsed payment', () => {
  const route = read('app/api/wallet/payouts/route.ts');
  const check = route.indexOf('bigintField(body.amountMinor)');
  const seal = route.indexOf('makePaymentRecorder({');
  assert.ok(check > 0 && seal > check, 'the amount and fee are parsed before anything is sealed');
  assert.match(route, /if \(holder && amount !== null && amount > 0n && maxFee !== null\)/);
  assert.match(route, /amountMinor: amount\.toString\(\)/);
  assert.match(route, /\.slice\(0, 60\)/, 'the reference is bounded');
  assert.doesNotMatch(route, /String\(body\.amountMinor/);
});

test('the pop-up does not restart its focus handling when its parent renders, and the toggle is a real radio group with 44px targets', () => {
  const ui = read('components/transfer/ui.tsx');
  assert.match(ui, /closeRef\.current\(\)/);
  assert.match(ui, /\}, \[open\]\);/, 'the effect depends on open only');
  assert.doesNotMatch(ui, /\[open, onClose\]/);
  assert.match(ui, /tabIndex=\{on \? 0 : -1\}/, 'one Tab stop');
  assert.match(ui, /ArrowRight/);
  assert.match(ui, /ArrowLeft/);
  assert.match(ui, /className=\{`h-11 rounded-lg/);
  assert.doesNotMatch(ui, /h-9 rounded-lg/);
});
