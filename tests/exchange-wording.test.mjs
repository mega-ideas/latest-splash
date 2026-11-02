/**
 * v2 Phase 3, the words on the exchange confirmation, after an independent review.
 *
 *   - The data-sharing sentence was untrue. The payment is an on-chain USDC
 *     transfer to an exchange account, not a DuitNow transfer, and the Travel
 *     Rule message goes to Splash's Travel Rule provider, which routes it to the
 *     exchange. It also left out things the message carries (the payment
 *     reference, the date, the link to the business's verification), and the last
 *     line of the screen said something else. Sky asked for the payment network to
 *     stay on the screen, so it does, as the way the exchange pays out.
 *   - A name or a title cut at 40 characters could split an emoji and send a lone
 *     surrogate, which is not valid text for the provider.
 *   - A name or a title could imitate the rest of the "Sent by" line (a colon, the
 *     words "Sent by").
 *   - The institution-naming exception is a reviewed list in code that the flags
 *     are checked against; it is not computed from the flags.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { disclosureText, purposeTextOf, senderOf } from '../lib/compliance/exchange-disclosure.ts';
import { sumsubTravelRuleBody } from '../lib/compliance/sumsub.ts';
import * as N from '../lib/compliance/payment-networks.ts';
import { parseSignedPartners } from '../lib/partners/signed-partners.ts';

const SIGNED_PARTNERS = parseSignedPartners(undefined);

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const party = (over = {}) => ({ legalName: 'Acme Trading Sdn Bhd', registrationNumber: '201901234567', country: 'MY', town: 'Kuala Lumpur', street: '8 Jalan Ampang', postCode: '50450', ...over });
const disclosure = (over = {}) => ({
  version: 1,
  intentId: 'tx_key_000001',
  paymentRef: `0x${'ab'.repeat(32)}`,
  amountMinor: '1000000000',
  asset: 'USDC',
  sender: { userId: 'u-maker', name: 'Aisha Rahman', title: 'CFO' },
  business: { ...party(), walletAddress: `0x${'11'.repeat(32)}` },
  beneficiary: { ...party({ legalName: 'Manila Supplies Inc', registrationNumber: null, country: 'PH', town: 'Makati', street: null, postCode: null }), exchange: 'pdax', accountReference: `0x${'22'.repeat(32)}` },
  purpose: { code: 'invoice', label: 'Paying a supplier invoice' },
  ...over,
});

// ─── The sharing sentence ───────────────────────────────────────────────────

test('the sharing sentence says the exchange pays out over the network, not that the payment is a transfer on it, and that it goes through Splash\'s Travel Rule provider', () => {
  const text = disclosureText(disclosure());
  assert.doesNotMatch(text.sharing, /payout partner/i, 'the old sentence');
  assert.doesNotMatch(text.sharing, /receives this payment over/i, 'the payment is not made over that network');
  assert.match(text.sharing, /exchange that holds the account/);
  assert.match(text.sharing, /pays out in the Philippines over InstaPay or PESONet/);
  assert.match(text.sharing, /Splash’s Travel Rule provider/);
});

test('the sentence lists everything the message carries, including the reference, the date and the link to the business\'s verification', () => {
  const sentence = disclosureText(disclosure()).sharing;
  for (const what of [/registered name/i, /registration number/i, /address/i, /wallet/i, /amount/i, /payment details/i, /payment reference/i, /date/i, /verification/i]) assert.match(sentence, what, String(what));
  // And those really are in the body the provider is sent.
  const body = sumsubTravelRuleBody({
    orgId: 'acme', applicantId: 'a1', intentId: 'tx_key_000001', amountMinor: 1_000_000_000n, at: new Date('2026-11-02T09:00:00Z'), purpose: 'Sent by Acme: x',
    originator: { legalName: 'Acme Trading Sdn Bhd', registrationNumber: '201901234567', country: 'MY', town: 'Kuala Lumpur', street: '8 Jalan Ampang', postCode: '50450', walletAddress: `0x${'11'.repeat(32)}` },
    beneficiary: { exchange: 'pdax', depositAddress: `0x${'22'.repeat(32)}`, legalName: 'Manila Supplies Inc', registrationNumber: null, country: 'PH', town: 'Makati', street: null, postCode: null },
  });
  assert.equal(body.txnId, 'tx_key_000001');
  assert.ok(body.txnDate);
  assert.ok(body.applicant.externalUserId);
});

test('the last line of the screen agrees with the sentence: through Splash\'s Travel Rule provider, to the exchange', () => {
  const text = disclosureText(disclosure());
  const last = text.lines.find((l) => /sends this once/i.test(l));
  assert.ok(last);
  assert.match(last, /through Splash’s Travel Rule provider/);
  assert.doesNotMatch(last, /through its Travel Rule provider/);
});

test('a flagged corridor still names the institution in the sentence, and the unflagged never does', () => {
  const flagged = { ...N.PAYMENT_NETWORKS, PH: { ...N.PAYMENT_NETWORKS.PH, mustNameReceivingInstitution: true } };
  assert.match(disclosureText(disclosure(), flagged).sharing, /PDAX/);
  assert.doesNotMatch(JSON.stringify(disclosureText(disclosure())), /PDAX/);
  assert.deepEqual([...SIGNED_PARTNERS], [], 'nothing is signed, and the institution is named anyway where compliance requires it');
});

// ─── A cut never splits a character ─────────────────────────────────────────

test('a name or a title cut at the limit never ends in half an emoji', () => {
  const name = `${'A'.repeat(39)}😀tail`;
  const title = `${'B'.repeat(39)}😀tail`;
  const d = disclosure({ sender: { userId: 'u', name, title } });
  const sender = senderOf(d);
  const text = purposeTextOf(d);
  for (const s of [sender, text]) assert.doesNotMatch(s, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/, 'no lone surrogate');
  for (const s of [sender, text]) assert.equal(s, s.toWellFormed(), 'valid text');
  // The business name and the whole line are cut by characters too.
  const long = disclosure({ sender: { userId: 'u', name: null }, business: { ...party({ legalName: `${'C'.repeat(79)}😀` }), walletAddress: '0x1' } });
  assert.equal(senderOf(long), senderOf(long).toWellFormed());
  const whole = purposeTextOf(disclosure({ sender: { userId: 'u', name: 'N'.repeat(40), title: 'T'.repeat(40) }, purpose: { code: 'invoice', label: `${'P'.repeat(60)}😀😀😀` } }));
  assert.equal(whole, whole.toWellFormed());
  assert.ok(Array.from(whole).length <= 140);
});

// ─── A name cannot dress itself as the rest of the line ─────────────────────

test('a name or a title with a colon or the words "Sent by" cannot imitate the structure of the line', () => {
  const eve = purposeTextOf(disclosure({ sender: { userId: 'u', name: 'Eve Sent by Mallory: refund', title: 'Admin CEO' } }));
  assert.equal((eve.match(/:/g) ?? []).length, 1, 'only the real colon survives');
  assert.equal((eve.match(/Sent by/gi) ?? []).length, 1, 'only the real "Sent by"');
  const title = purposeTextOf(disclosure({ sender: { userId: 'u', name: 'Eve', title: 'x: A refund to a customer' } }));
  assert.equal((title.match(/:/g) ?? []).length, 1);
  assert.match(title, /^Sent by Eve \(x A refund to a customer\): Paying a supplier invoice$/);
  // An ordinary name and title are untouched.
  assert.equal(purposeTextOf(disclosure()), 'Sent by Aisha Rahman (CFO): Paying a supplier invoice');
  assert.equal(purposeTextOf(disclosure({ sender: { userId: 'u', name: 'Ng Wei Sent', title: 'Head of Sending' } })), 'Sent by Ng Wei Sent (Head of Sending): Paying a supplier invoice');
});

// ─── The institution-naming exception is a reviewed list ────────────────────

test('the recorded exceptions are a literal reviewed list in code, and every flagged corridor is on it', () => {
  const source = read('lib/compliance/payment-networks.ts');
  assert.match(source, /export const INSTITUTION_NAMING_EXCEPTIONS: readonly Corridor\[\] = \[\s*\]/, 'a literal, not computed from the flags');
  assert.doesNotMatch(source, /INSTITUTION_NAMING_EXCEPTIONS[^\n]*= institutionNamingExceptions\(/);
  // Anyone who flags a corridor must also record it on the list, or this fails.
  assert.deepEqual([...N.institutionNamingExceptions(N.PAYMENT_NETWORKS)].sort(), [...N.INSTITUTION_NAMING_EXCEPTIONS].sort());
});

test('a flagged corridor names the institution while no partner is signed, and the copy check keeps banning partner names elsewhere', () => {
  assert.deepEqual([...SIGNED_PARTNERS], []);
  const flagged = { ...N.PAYMENT_NETWORKS, MY: { ...N.PAYMENT_NETWORKS.MY, mustNameReceivingInstitution: true } };
  const words = N.networkWords('hata', flagged);
  assert.ok(words.institution, 'named although nothing is signed');
  assert.match(read('scripts/check-copy.mjs'), /\\bHata\\b/);
});
