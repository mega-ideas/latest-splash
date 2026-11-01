/**
 * v2 Phase 3, "Can pay exchange accounts alone": what the owner and the staff
 * member see, and how the routes and the signing gate are wired. The
 * behaviour that runs in Node runs in tests/exchange-alone-*.test.mjs; here
 * the words are checked as words, and what a component or a route must
 * contain is checked in its source (the screenshots cover the rendering).
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

import { APPROVAL_REASON_TEXT } from '../lib/transfer/plan.ts';
import { EXCHANGE_PURPOSES, disclosureText, exchangePurpose } from '../lib/compliance/exchange-disclosure.ts';
import { EXCHANGE_ALONE_LABEL, EXCHANGE_ALONE_WORDS } from '../lib/team/view.ts';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const disclosure = () => ({
  version: 1,
  intentId: 'tx_key_000001',
  paymentRef: `0x${'ab'.repeat(32)}`,
  amountMinor: '1250000000',
  asset: 'USDC',
  sender: { userId: 'u-staff', name: 'Mei Tan' },
  business: { legalName: 'Acme Trading Sdn Bhd', registrationNumber: '201901234567', country: 'MY', town: 'Kuala Lumpur', street: '8 Jalan Ampang', postCode: '50450', walletAddress: `0x${'cd'.repeat(32)}` },
  beneficiary: { legalName: 'Dela Cruz Trading Corp', registrationNumber: 'CS201912345', country: 'PH', town: 'Makati', street: '1 Ayala Ave', postCode: null, exchange: 'pdax', accountReference: `0x${'79'.repeat(32)}` },
  purpose: { code: 'invoice', label: exchangePurpose('invoice').label },
});

test('the purposes a person can pick are a short, fixed list in plain words', () => {
  assert.ok(EXCHANGE_PURPOSES.length >= 4 && EXCHANGE_PURPOSES.length <= 8);
  for (const p of EXCHANGE_PURPOSES) {
    assert.match(p.code, /^[a-z_]+$/);
    assert.match(p.label, /^[A-Z]/);
    assert.doesNotMatch(p.label, /—|–|coming soon|demo|testnet|non-custodial/i);
  }
  assert.equal(exchangePurpose('nope'), null);
  assert.equal(exchangePurpose(undefined), null);
});

test('the message says, in plain words, what is shared with the exchange, and what is not', () => {
  const text = disclosureText(disclosure());
  const all = [text.headline, ...text.lines].join('\n');
  for (const must of [/Mei Tan/, /Acme Trading Sdn Bhd/, /201901234567/, /our Philippines payout partner/, /Dela Cruz Trading Corp/, /0x79/, /1,250(\.00)? USDC/, /invoice/i]) assert.match(all, must);
  assert.doesNotMatch(all, /PDAX/, 'a partner is named only once its agreement is signed');
  const signed = disclosureText(disclosure(), new Set(['pdax']));
  assert.match([signed.headline, ...signed.lines].join('\n'), /PDAX/);
  assert.match(text.headline, /share/i);
  assert.match(all, /exchange/i);
  assert.match(all, /Splash/);
  assert.doesNotMatch(all, /—|–|coming soon|demo|testnet|non-custodial|licen[cs]ed/i);
  // Nothing is promised that the exchange does: no guarantee of approval or timing.
  assert.doesNotMatch(all, /guarantee|instant|immediately/i);
});

test('the owner’s words say what the switch means, and that it is theirs to change at any time', () => {
  assert.equal(EXCHANGE_ALONE_LABEL, 'Can pay exchange accounts alone');
  const words = EXCHANGE_ALONE_WORDS.join(' ');
  assert.match(words, /spending rule/i);
  assert.match(words, /Travel Rule|shared with the exchange/i);
  assert.match(words, /any time/i);
  assert.match(words, /owners? still sign|signs? it themselves|their own passkey/i);
  assert.doesNotMatch(words, /—|–|coming soon|demo|testnet|non-custodial|licen[cs]ed/i);
});

test('the reasons a staff member reads when the switch is off, or the rule does not hold the exchange as an exchange', () => {
  assert.match(APPROVAL_REASON_TEXT.exchange_needs_owners, /Travel Rule/);
  assert.match(APPROVAL_REASON_TEXT.exchange_needs_owners, /owner/i);
  assert.match(APPROVAL_REASON_TEXT.exchange_not_verified_as_exchange, /exchange/i);
  assert.match(APPROVAL_REASON_TEXT.exchange_not_verified_as_exchange, /owner/i);
  for (const key of ['exchange_needs_owners', 'exchange_not_verified_as_exchange']) {
    assert.doesNotMatch(APPROVAL_REASON_TEXT[key], /—|–/);
    assert.match(APPROVAL_REASON_TEXT[key], /^[A-Z]/);
  }
});

test('Settings: the owner’s switch sits in Manage, beside the others, saves as it is switched, and is named with its words', () => {
  const dialog = read('components/team/MemberDialog.tsx');
  assert.match(dialog, /EXCHANGE_ALONE_LABEL/);
  assert.match(dialog, /EXCHANGE_ALONE_WORDS/);
  assert.match(dialog, /controls\.exchangeAlone/);
  assert.match(dialog, /pay_exchange_alone/);
  assert.match(dialog, /aria-disabled=\{busy !== null\}/, 'the switch stays focusable while it saves');
  const card = read('components/settings/TeamCard.tsx');
  assert.match(card, /payExchangeAlone/, 'the list says who can');
});

test('Transfer: the staff member reads what will be shared and confirms it before paying alone; the server is sent the confirmation', () => {
  const review = read('components/transfer/StepReview.tsx');
  assert.match(review, /ExchangeDisclosure/);
  assert.match(review, /exchangeDisclosure:/);
  assert.match(review, /exchange_disclosure_changed/);
  const panel = read('components/transfer/ExchangeDisclosure.tsx');
  assert.match(panel, /\/api\/wallet\/transfers\/exchange-disclosure/);
  assert.match(panel, /type="checkbox"/, 'an explicit confirmation');
  assert.match(panel, /<select|SelectInput/, 'the purpose is picked from the list');
  assert.match(panel, /role="alert"/, 'a refusal is announced');
  assert.doesNotMatch(code(panel), /coming soon|\bdemo\b|testnet|non-custodial|coral/i);
  const ctx = read('components/transfer/api.ts');
  assert.match(ctx, /payExchangeAlone/);
});

test('the routes: the preview and the payment take the business from the session, and the context tells the page whether the person may', () => {
  const preview = read('app/api/wallet/transfers/exchange-disclosure/route.ts');
  assert.match(preview, /transferRoute\(request\)/, 'the session’s business, never the request’s');
  assert.match(preview, /previewExchangeDisclosure/);
  assert.match(preview, /Idempotency-Key|idempotency-key/i);
  assert.doesNotMatch(preview, /body\.orgId|body\.businessId/);
  const route = read('app/api/wallet/transfers/route.ts');
  assert.match(route, /exchangeDisclosure: body\.exchangeDisclosure/);
  const context = read('app/api/wallet/transfers/context/route.ts');
  assert.match(context, /payExchangeAlone/);
  const live = read('lib/server/wallet-transfers-deps.ts');
  assert.match(live, /payExchangeAlone:/);
  assert.match(live, /exchangeAloneOf/);
});

test('the signing gate reads the owner’s switch and the stored message before every signature on a staff exchange payment', () => {
  const gate = read('lib/server/payment-compliance-gate.ts');
  assert.match(gate, /exchangeAloneOf/);
  assert.match(gate, /exchange_alone_off/);
  assert.match(gate, /disclosure_missing/);
  assert.match(gate, /disclosure_mismatch/);
  const control = read('app/api/team/members/[userId]/access/route.ts');
  assert.match(control, /pay_exchange_alone/);
});

test('migration 0077 adds the kind and the stored message, and changes no applied migration', () => {
  const files = readdirSync(new URL('../drizzle/', import.meta.url)).filter((f) => /^0077_/.test(f));
  assert.equal(files.length, 1);
  const sql = read(`drizzle/${files[0]}`);
  assert.match(sql, /pay_exchange_alone/);
  assert.match(sql, /wallet_transfer_disclosures/);
  assert.match(sql, /append-only|no_rewrite|BEFORE UPDATE/i);
  assert.doesNotMatch(sql.replace(/--.*$/gm, ''), /insert\s+into\s+"?wallet_member_access/i);
});

test('the staff-in-rule and team documents say what changed', () => {
  assert.match(read('docs/v2/phase3-team-roles.md'), /Can pay exchange accounts alone/);
  assert.match(read('docs/v2/phase3-staff-in-rule.md'), /pay_exchange_alone|Can pay exchange accounts alone/);
});
