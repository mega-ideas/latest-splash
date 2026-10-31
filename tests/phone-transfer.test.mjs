/**
 * v2 Phase 3, brief 5.10: Transfer on a phone asks one question per screen.
 *
 * The order of the screens and what each needs before "Continue" is a pure
 * rule (lib/transfer/phone-steps.ts), so it is tested as data. The bank form's
 * checks are one rule shared by the desktop form and the phone (lib/transfer/
 * bank-form.ts). The phone sends nothing of its own: the quote, the fee
 * bound, the intent id as the idempotency key and the signing are the same
 * Review step's as on a desktop, and this checks the phone cannot make a
 * second payment by walking back and forward.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { BANK_BLANK, beneficiaryBody, validateBank } from '../lib/transfer/bank-form.ts';
import { defaultScreen, nextScreen, prevScreen, progressOf, screenReady, screensFor, stepOf } from '../lib/transfer/phone-steps.ts';
import { copyViolations } from '../scripts/copy-rules.mjs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const state = (over = {}) => ({ payeeType: null, adding: false, holder: 'business', owner: true, ...over });

test('before a payee type is chosen there is one screen; after it, only the questions that apply', () => {
  assert.deepEqual(screensFor(state()), ['who']);
  assert.deepEqual(screensFor(state({ payeeType: 'splash_business' })), ['who', 'business', 'amount', 'reference', 'review', 'receipt']);
  assert.deepEqual(screensFor(state({ payeeType: 'wallet' })), ['who', 'address', 'amount', 'reference', 'review', 'receipt']);
  assert.deepEqual(screensFor(state({ payeeType: 'bank' })), ['who', 'supplier', 'amount', 'purpose', 'source', 'reference', 'review', 'receipt']);
});

test('adding a supplier’s bank account is one question at a time, and a person needs no company number', () => {
  const business = screensFor(state({ payeeType: 'bank', adding: true, holder: 'business' }));
  assert.deepEqual(business.slice(0, 12), ['who', 'supplier', 'b.country', 'b.holder', 'b.name', 'b.registration', 'b.bank', 'b.account', 'b.city', 'b.relationship', 'b.confirm', 'amount']);
  const person = screensFor(state({ payeeType: 'bank', adding: true, holder: 'person' }));
  assert.ok(!person.includes('b.registration'));
  assert.equal(person.length, business.length - 1);
  // Only an owner adds a supplier's account: for anyone else the questions are never asked.
  assert.deepEqual(screensFor(state({ payeeType: 'bank', adding: true, owner: false })), screensFor(state({ payeeType: 'bank', adding: false })));
});

test('each screen belongs to one of the five steps the desktop flow keeps its draft by', () => {
  assert.equal(stepOf('who'), 1);
  for (const s of ['supplier', 'business', 'address', 'b.country', 'b.confirm']) assert.equal(stepOf(s), 2, s);
  for (const s of ['amount', 'purpose', 'source', 'reference']) assert.equal(stepOf(s), 3, s);
  assert.equal(stepOf('review'), 4);
  assert.equal(stepOf('receipt'), 5);
  const s = state({ payeeType: 'bank' });
  assert.equal(defaultScreen(1, s), 'who');
  assert.equal(defaultScreen(2, s), 'supplier');
  assert.equal(defaultScreen(2, state({ payeeType: 'wallet' })), 'address');
  assert.equal(defaultScreen(3, s), 'amount', 'a draft kept from before opens at the amount');
  assert.equal(defaultScreen(4, s), 'review');
  assert.equal(defaultScreen(5, s), 'receipt');
});

test('next and back walk the list and stop at its ends; back from the first screen is nowhere, and the receipt has no back', () => {
  const s = state({ payeeType: 'bank' });
  assert.equal(nextScreen('who', s), 'supplier');
  assert.equal(nextScreen('supplier', s), 'amount');
  assert.equal(nextScreen('source', s), 'reference');
  assert.equal(nextScreen('review', s), 'receipt');
  assert.equal(nextScreen('receipt', s), null);
  assert.equal(prevScreen('who', s), null);
  assert.equal(prevScreen('amount', s), 'supplier');
  assert.equal(prevScreen('review', s), 'reference');
  assert.equal(prevScreen('receipt', s), null, 'a paid payment is not walked back into');
  assert.equal(prevScreen('b.name', state({ payeeType: 'bank', adding: true })), 'b.holder');
  assert.equal(prevScreen('amount', state({ payeeType: 'bank', adding: false })), 'supplier', 'once the account is saved the form questions are gone from the way back');
});

test('progress counts the questions before the receipt and never exceeds them', () => {
  const s = state({ payeeType: 'splash_business' });
  assert.deepEqual(progressOf('who', s), { n: 1, of: 5 });
  assert.deepEqual(progressOf('review', s), { n: 5, of: 5 });
  assert.deepEqual(progressOf('receipt', s), { n: 5, of: 5 });
  assert.deepEqual(progressOf('who', state()), { n: 1, of: 1 });
});

const input = (over = {}) => ({ payeeType: 'bank', chosen: null, amountText: '', purposeCode: '', sourceOfFunds: '', fundsOk: false, bank: { ...BANK_BLANK }, ...over });
const bankChosen = { kind: 'bank', beneficiaryId: 'b1', name: 'Santos', country: 'PH', currency: 'PHP', last4: '0391' };

test('a screen is ready only when its own question is answered', () => {
  assert.equal(screenReady('who', input({ payeeType: null })), false);
  assert.equal(screenReady('who', input()), true);
  assert.equal(screenReady('supplier', input()), false);
  assert.equal(screenReady('supplier', input({ chosen: bankChosen })), true);
  assert.equal(screenReady('supplier', input({ chosen: { kind: 'splash_business', businessId: 'x', name: 'N', country: null } })), false, 'a business chosen for another kind of payee is not a supplier');
  assert.equal(screenReady('business', input({ payeeType: 'splash_business', chosen: { kind: 'splash_business', businessId: 'x', name: 'N', country: null } })), true);
  assert.equal(screenReady('address', input({ payeeType: 'wallet', chosen: { kind: 'recipient', recipientId: 'r', name: 'R', deliveryKind: 'SELF_CUSTODY', address: '0x1', blocked: null } })), true);
  assert.equal(screenReady('address', input({ payeeType: 'wallet', chosen: { kind: 'recipient', recipientId: 'r', name: 'R', deliveryKind: 'SELF_CUSTODY', address: '0x1', blocked: 'Not proven yet' } })), false, 'a recipient that cannot be paid yet is not a way on');
  assert.equal(screenReady('amount', input({ amountText: '10', fundsOk: true })), true);
  assert.equal(screenReady('amount', input({ amountText: '10', fundsOk: false })), false, 'short of funds the next question waits for the top-up');
  assert.equal(screenReady('amount', input({ amountText: '0', fundsOk: true })), false);
  assert.equal(screenReady('amount', input({ amountText: '1.0000001', fundsOk: true })), false, 'more than six decimals');
  assert.equal(screenReady('purpose', input()), false);
  assert.equal(screenReady('purpose', input({ purposeCode: 'GDDS' })), true);
  assert.equal(screenReady('source', input({ sourceOfFunds: 'BUSINESS_PROFITS' })), true);
  assert.equal(screenReady('reference', input()), true, 'a reference is optional');
  assert.equal(screenReady('review', input()), true);
});

test('the supplier form’s screens each wait for their own field', () => {
  const b = (over) => input({ bank: { ...BANK_BLANK, ...over } });
  assert.equal(screenReady('b.country', b({ country: 'PH' })), true);
  assert.equal(screenReady('b.country', b({ country: 'MY' })), false, 'a corridor under Pilot access is a request for access, not a way on');
  assert.equal(screenReady('b.holder', b({})), true);
  assert.equal(screenReady('b.name', b({ holderName: ' ' })), false);
  assert.equal(screenReady('b.name', b({ holderName: 'Santos Packaging Inc' })), true);
  assert.equal(screenReady('b.registration', b({ registrationNumber: '' })), false);
  assert.equal(screenReady('b.registration', b({ registrationNumber: 'CS201912345' })), true);
  assert.equal(screenReady('b.bank', b({ bankCode: '' })), false);
  assert.equal(screenReady('b.bank', b({ bankCode: 'BNORPHMM' })), true);
  assert.equal(screenReady('b.account', b({ accountNumber: 'abc' })), false);
  assert.equal(screenReady('b.account', b({ accountNumber: '0012345678' })), true);
  assert.equal(screenReady('b.city', b({ city: '' })), false);
  assert.equal(screenReady('b.city', b({ city: 'Makati' })), true);
  assert.equal(screenReady('b.relationship', b({})), true);
});

// ── The bank form, shared with the desktop ───────────────────────────────────

test('a blank bank form is refused with the desktop form’s own words, and a person is not asked for a company number', () => {
  const blank = validateBank(BANK_BLANK);
  assert.equal(blank.accountAddress, null);
  assert.equal(blank.errors.holderName, 'Enter the name the bank holds on the account.');
  assert.equal(blank.errors.bankCode, 'Enter the bank code.');
  assert.equal(blank.errors.city, 'Enter the town or city.');
  assert.equal(blank.errors.registrationNumber, 'Enter the company registration number.');
  assert.ok(blank.errors.accountNumber, 'an account number is checked as an account number, never as a Sui address');
  assert.doesNotMatch(JSON.stringify(blank.errors), /Sui address/i);
  const person = validateBank({ ...BANK_BLANK, holder: 'person' });
  assert.equal(person.errors.registrationNumber, undefined);
});

test('a complete form makes the request the desktop form makes: the name, the bank, the number and the address, and a business’s registration', () => {
  const form = { ...BANK_BLANK, holderName: ' Santos Packaging Inc ', bankCode: ' BNORPHMM ', accountNumber: '0012345678', registrationNumber: ' CS201912345 ', street: ' 1 Ayala ', city: ' Makati ', postCode: '', relationship: 'supplier' };
  const checked = validateBank(form);
  assert.deepEqual(checked.errors, {});
  assert.ok(checked.accountAddress);
  const body = beneficiaryBody(form, checked.accountAddress);
  assert.equal(body.holderName, 'Santos Packaging Inc');
  assert.equal(body.country, 'PH');
  assert.equal(body.bankCode, 'BNORPHMM');
  assert.equal(body.accountNumber, checked.accountAddress);
  assert.deepEqual(body.address, { streetName: '1 Ayala', postCode: undefined, townName: 'Makati', country: 'PH' });
  assert.equal(body.registrationNumber, 'CS201912345');
  assert.equal(body.registrationScheme, 'CINC');
  assert.equal(body.relationship, 'supplier');
  const person = beneficiaryBody({ ...form, holder: 'person' }, checked.accountAddress);
  assert.equal(person.registrationNumber, undefined);
  assert.equal(person.registrationScheme, undefined);
  assert.doesNotMatch(JSON.stringify(body), /orgId|accountId/, 'the business is the session’s, never the form’s');
});

// ── The phone flow, in its source ────────────────────────────────────────────

const phone = read('components/transfer/PhoneTransfer.tsx');
const flow = read('components/transfer/TransferFlow.tsx');

test('the flow shows the phone layout on a phone and keeps its one set of state and handlers', () => {
  assert.match(flow, /usePhone\(\)/);
  assert.match(flow, /<PhoneTransfer\b/);
  for (const prop of ['flow=', 'patch=', 'ctx=', 'balance=', 'recipients=', 'beneficiaries=', 'made=', 'onMade=', 'onExecuted=', 'onRestart=', 'topUpId=']) assert.match(flow.slice(flow.indexOf('<PhoneTransfer')), new RegExp(prop), prop);
  assert.match(flow, /<HowItWorks open=\{how\}/, 'How it works is on a phone too');
});

test('every screen is one question with its own heading, and the phone says where the person is', () => {
  assert.match(phone, /screensFor\(/);
  assert.match(phone, /progressOf\(/);
  assert.match(phone, /Question \{progress\.n\} of \{progress\.of\}/);
  assert.match(phone, /<h1\b/);
  for (const id of ['who', 'supplier', 'business', 'address', 'b.country', 'b.holder', 'b.name', 'b.registration', 'b.bank', 'b.account', 'b.city', 'b.relationship', 'b.confirm', 'amount', 'purpose', 'source', 'reference', 'review', 'receipt']) {
    assert.match(phone, new RegExp(`'${id.replace('.', '\\.')}'`), `${id} has a screen`);
  }
});

test('the action is a 56px bar at the foot, clear of the home indicator, with Back above the keyboard’s reach and a close that keeps the draft', () => {
  assert.match(phone, /fixed inset-x-0 bottom-0/);
  assert.match(phone, /env\(safe-area-inset-bottom\)/);
  assert.match(phone, /min-h-14/);
  assert.match(phone, /usePhoneBottomBar\(true\)/);
  assert.match(phone, /aria-label="Back"/);
  assert.match(phone, /Continue/);
  assert.match(phone, /disabled=\{!ready/);
});

test('walking back and forward never makes a second intent id: the phone only moves the screen', () => {
  assert.doesNotMatch(code(phone), /newIntentKey|intentKey:|crypto\.randomUUID|getRandomValues/, 'the key is the flow’s, made once per payment');
  assert.match(phone, /StepReview\b/, 'the review, the fee bound, the quote and the key are the one Review step’s');
  assert.doesNotMatch(code(phone), /\/api\/wallet\/(transfers|payouts)\b(?!\/beneficiaries)/, 'the phone makes no payment of its own');
  assert.match(phone, /StepReceipt\b/);
});

test('a new supplier’s account is saved through the one save the desktop form uses', () => {
  const save = read('components/transfer/bank-save.ts');
  assert.match(save, /\/api\/wallet\/payouts\/beneficiaries/);
  assert.match(save, /validateBank\(/);
  assert.match(phone, /saveBeneficiary\(/);
  assert.match(read('components/transfer/DetailsBank.tsx'), /saveBeneficiary\(/);
  assert.doesNotMatch(code(phone), /\/api\/wallet\/payouts\/beneficiaries/);
});

test('a corridor that is not live is a request for access on the phone as it is on the desktop, never a quote', () => {
  assert.match(phone, /<PilotAccess\b/);
  assert.match(read('components/transfer/DetailsBank.tsx'), /<PilotAccess\b/);
  const pilot = read('components/transfer/PilotAccess.tsx');
  assert.match(pilot, /Pilot access/);
  assert.match(pilot, /Request access/);
  assert.match(pilot, /\/api\/waitlist/);
});

test('only an owner is asked the supplier questions; anyone else is told whom to ask', () => {
  assert.match(phone, /Only an owner can add a supplier&rsquo;s bank account/);
  assert.match(phone, /ctx\?\.role === 'OWNER'/);
});

test('the amount screen shows the wallet balance and the shortfall, and tops up from a verified source', () => {
  assert.match(phone, /useAmountPlan\(/);
  assert.match(phone, /<TopUpPanel\b/);
  assert.match(phone, /Short by \{formatUsdc\(funds\.shortByMinor\)\} USDC/);
  assert.match(phone, /inputMode="decimal"/);
  const plan = read('components/transfer/amount-plan.ts');
  assert.match(plan, /export function useAmountPlan\(/);
  assert.match(plan, /fundsCheck\(/);
  assert.match(read('components/transfer/StepAmount.tsx'), /useAmountPlan\(/, 'the desktop step computes its funds the same way');
});

test('inputs on a phone are 16px or larger, so the browser does not zoom the page in, and every control is 44px', () => {
  assert.match(phone, /text-base|text-\[16px\]|text-lg|text-2xl|text-3xl/);
  assert.doesNotMatch(phone, /text-\[1[0-5]px\]/);
  assert.doesNotMatch(phone, /h-(?:[1-9]|10)\b(?! rounded-full)(?=[^\n]*<button)/, 'no button shorter than 44px');
});

test('the phone Transfer words pass the copy rules and use no coral, Demo, testnet or partner name', () => {
  for (const file of ['components/transfer/PhoneTransfer.tsx', 'components/transfer/PilotAccess.tsx', 'components/transfer/bank-save.ts', 'lib/transfer/phone-steps.ts', 'lib/transfer/bank-form.ts']) {
    const text = read(file);
    assert.deepEqual(copyViolations(file, text), [], file);
    assert.doesNotMatch(text, /E39774|coral|\bDemo\b|\bDEMO\b|Coming soon|testnet|non-custodial/i, file);
  }
});
