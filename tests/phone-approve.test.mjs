/**
 * v2 Phase 3, brief 5.10: Approve, the approver's passkey sign screen and the
 * most important phone screen. It shows who is paid, how much, in what asset,
 * the fee and the rate, all read from the exact bytes on the person's own
 * device (reviewOnDevice), then asks for the passkey over those bytes and no
 * others.
 *
 * The facts are a pure function of the device's review (lib/approve/facts.ts),
 * so what the screen says is tested here as data; what the component must
 * contain is checked in its source (there is no browser in this suite; the
 * screenshots cover the rendering).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { approveFacts, cardSummary, closeOutcomeText, receiveApprox, rateText } from '../lib/approve/facts.ts';
import { formatMoney } from '../lib/formatMoney.ts';
import { copyViolations } from '../scripts/copy-rules.mjs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const A = (n) => `0x${String(n).repeat(64)}`;
const USDC = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';

const open = (over = {}) => ({ type: 'open_intent', asset: USDC, recipient: A(2), amountMinor: '5000000000', kind: 4, targetCurrency: 'PHP', fxRateUsdLocal: '58000000', beneficiaryRef: 'ab'.repeat(32), expiresAtMs: '1900000000000', ...over });
const pay = (over = {}) => ({ type: 'pay_intent', asset: USDC, maxFeeMinor: '1000000', settleByMs: '1', paysFromCommand: 0, intentFromCommand: 1, intent: null, ...over });
const withdraw = (amountMinor = '5001000000') => ({ type: 'withdraw', asset: USDC, amountMinor });
const payment = (o = {}, p = {}, w) => [withdraw(w), open(o), pay(p), { type: 'anchor_receipt' }, { type: 'delete_intent' }];
const review = (actions, extra = {}) => ({ actions, code: 'abcd 1234 ef56 7890', bytesHash: 'ab'.repeat(32), digest: 'D', ...extra });

test('a bank payment shows payee, amount, asset, fee and rate, from the bytes', () => {
  const f = approveFacts(review(payment()), { names: ['Santos Packaging Inc'] });
  assert.equal(f.kind, 'payment');
  assert.equal(f.asset, 'USDC');
  assert.equal(f.payments.length, 1);
  const p = f.payments[0];
  assert.equal(p.payeeName, 'Santos Packaging Inc');
  assert.equal(p.amount, '5,000.00');
  assert.equal(p.maxFee, '1.00');
  assert.equal(p.kindLabel, 'Bank payout');
  assert.deepEqual(p.rate, { currency: 'PHP', text: '1 USDC = 58.00 PHP', receiveApprox: '₱290,000.00' });
  assert.equal(f.leavesAtMost, '5,001.00');
  assert.equal(f.code, 'abcd 1234 ef56 7890');
  assert.equal(f.blocked, false);
});

test('the payee is the address in the bytes, in full and in groups of four, whatever name the page was given', () => {
  const f = approveFacts(review(payment({ kind: 0, targetCurrency: 'USD', fxRateUsdLocal: '1000000' })), { names: ['Cahaya Logistics'] });
  const p = f.payments[0];
  assert.equal(p.recipient, `0x ${'2222 '.repeat(16).trim()}`);
  assert.equal(p.kindLabel, 'Splash business');
  assert.equal(p.rate, null, 'a payment in USDC has no rate to show');
  // No name given: the address alone is shown, nothing is invented.
  assert.equal(approveFacts(review(payment())).payments[0].payeeName, null);
});

test('the rate is what the intent carries, in plain digits, and what it comes to is rounded down', () => {
  assert.equal(rateText('58000000'), '58.00');
  assert.equal(rateText('16250500000'), '16,250.50');
  assert.equal(rateText('58123456'), '58.123456');
  assert.equal(receiveApprox('5000000000', '58000000', 'PHP'), '₱290,000.00');
  assert.equal(receiveApprox('1000000', '16250500000', 'IDR'), formatMoney(16250n, 'IDR'), 'IDR has no minor unit, and the half rupiah is dropped');
  assert.equal(receiveApprox('1', '58000000', 'PHP'), '₱0.00', 'a dust amount rounds down, never up');
});

test('a batch says how many payments, and each is shown with its own payee, amount and fee bound', () => {
  const f = approveFacts(
    review([...payment({ recipient: A(2), amountMinor: '1000000000' }, { maxFeeMinor: '500000' }, '1000500000'), ...payment({ recipient: A(3), amountMinor: '2000000000' }, { maxFeeMinor: '600000' }, '2000600000')]),
    { names: ['One', 'Two'] },
  );
  assert.equal(f.kind, 'batch');
  assert.equal(f.payments.length, 2);
  assert.deepEqual(f.payments.map((p) => [p.payeeName, p.amount, p.maxFee]), [['One', '1,000.00', '0.50'], ['Two', '2,000.00', '0.60']]);
  assert.equal(f.leavesAtMost, '3,001.10', 'the total that can leave is every withdrawal added');
  assert.match(f.headline, /2 payments/);
});

test('a change to the wallet is worded, not shown as a payment, and a command that cannot be worded blocks signing', () => {
  const change = approveFacts(review([{ type: 'set_limits', policy: A(1), perPaymentMaxMinor: '2000000000', secondApprovalThresholdMinor: '750000000' }]));
  assert.equal(change.kind, 'change');
  assert.equal(change.payments.length, 0);
  assert.equal(change.steps.length, 1);
  assert.match(change.steps[0].line, /Change the limits/);
  assert.equal(change.blocked, false);
  const unknown = approveFacts(review([{ type: 'something_new_the_screen_cannot_word' }]));
  assert.equal(unknown.blocked, true, 'bytes whose meaning is not on the screen are never signed');
});

test('commands the payment panel already shows as rows are not said twice', () => {
  const f = approveFacts(review(payment()));
  assert.deepEqual(f.steps.map((s) => s.line), ['Record the receipt of this payment.', 'Remove the finished payment record.']);
  assert.ok(!f.steps.some((s) => /Open a payment|Take .* out of the wallet/.test(s.line)));
});

test('the facts are read only from the device review: no server decoding is an input', () => {
  const src = code(read('lib/approve/facts.ts'));
  assert.doesNotMatch(src, /fetch\(|\.description|server/i);
  assert.match(src, /DeviceReview/);
  assert.doesNotMatch(src, /sandbox|USE_MOCK_APIS|mock/i, 'nothing here can show a made-up result in production');
});

// ── The screen ────────────────────────────────────────────────────────────────

const screen = read('components/approve/ApproveScreen.tsx');
const panel = read('components/transfer/SignPanel.tsx');

test('the sign screen shows the five facts and the transaction code, and signs only after them', () => {
  for (const label of ['Pays', 'Amount', 'Asset', 'Splash fee at most', 'Rate', 'Transaction code']) assert.match(screen, new RegExp(label), label);
  assert.match(screen, /approveFacts\(/);
  assert.match(screen, /Sign with your passkey/);
  assert.match(screen, /If your WhatsApp message shows a different code, do not sign/);
  assert.match(screen, /groupAddress|payee\.recipient|p\.recipient/);
});

test('the passkey button is a 56px bar at the foot, clear of the home indicator, drawn in the body so a blurred card cannot hold it, and the tab bar steps aside for it', () => {
  assert.match(screen, /<PhoneBar>/);
  assert.match(screen, /min-h-14/);
  assert.match(screen, /pb-(2\d|3\d)/, 'the content clears the fixed bar');
  const bar = read('components/dashboard/PhoneBar.tsx');
  assert.match(bar, /fixed inset-x-0 bottom-0/);
  assert.match(bar, /env\(safe-area-inset-bottom\)/);
  assert.match(bar, /usePhoneBottomBar\(true\)/);
  assert.match(bar, /createPortal\(/, 'dash-surface blurs what is behind it, and a fixed element inside it is fixed to the card');
});

test('the passkey button cannot be pressed twice, and is off when the screen cannot word part of the request', () => {
  assert.match(screen, /disabled=\{busy \|\| blocked\}/);
  assert.match(panel, /setBusy\(true\)/);
  assert.match(panel, /if \(!reviewed\) return;/);
});

test('on a phone the sign panel hands the review to the Approve screen, and still signs the bytes that were reviewed', () => {
  assert.match(panel, /usePhone\(\)/);
  assert.match(panel, /<ApproveScreen\b/);
  assert.match(panel, /signWithPasskey\(passkey, reviewed\.transactionBytes\)/);
  assert.match(panel, /digest: reviewed\.digest/);
  assert.doesNotMatch(panel, /signWithPasskey\(passkey, view\./);
  assert.match(panel, /differsFromApproved\(review, expected\)/, 'the check against what was approved is the same on a phone');
  assert.match(panel, /autoReview/);
});

test('the desktop review shows the rate too', () => {
  assert.match(panel, /<dt className="text-\[#326273\]">Rate<\/dt>/);
});

test('a request that a signer opened from a link shows the review at once, and a decline or withdrawal is one tap and a confirmation', () => {
  const page = read('components/approve/ApproveDetail.tsx');
  assert.match(page, /autoReview/);
  assert.match(page, /method: 'DELETE'/);
  assert.match(page, /Decline/);
  assert.match(page, /Withdraw the request/);
  assert.match(page, /confirm/i);
});

// ── The pages ─────────────────────────────────────────────────────────────────

test('Approve is two pages: the list of what waits and one request, both in the session’s own business', () => {
  const list = read('app/dashboard/approve/page.tsx');
  const one = read('app/dashboard/approve/[id]/page.tsx');
  assert.match(list, /ApproveInbox/);
  assert.match(one, /ApproveDetail/);
  assert.match(one, /await params/);
  const inbox = read('components/approve/ApproveInbox.tsx');
  const detail = read('components/approve/ApproveDetail.tsx');
  const urls = [...code(inbox + detail).matchAll(/call(?:<[^>]*(?:<[^>]*>[^>]*)*>)?\(\s*[`'"]([^`'"]+)/g)].map((m) => m[1]);
  assert.ok(urls.length >= 2, `found ${urls.length} calls`);
  for (const url of urls) assert.match(url, /^\/api\/wallet\/signing-requests/, url);
  assert.doesNotMatch(code(inbox + detail), /orgId|accountId|\?org=|body: \{[^}]*address/, 'nothing about a business is sent: the server knows which');
});

test('the list decodes every request on the device, so a card says what it pays, and one that cannot be checked says so', () => {
  const inbox = read('components/approve/ApproveInbox.tsx');
  assert.match(inbox, /reviewRequest\(/);
  assert.match(read('lib/approve/facts.ts'), /reviewOnDevice\(/, 'the one reader of the bytes is the device’s');
  assert.match(inbox, /could not be checked/i);
  assert.match(inbox, /href=\{`\/dashboard\/approve\/\$\{/);
  assert.match(inbox, /min-h-1[1-9]|min-h-\[[6-9]\d/);
});

test('the empty and the failed list are sentences with a way on', () => {
  const inbox = read('components/approve/ApproveInbox.tsx');
  assert.match(inbox, /Nothing is waiting for your signature/);
  assert.match(inbox, /Try again/);
});

test('the Approve words pass the copy rules and use no coral, Demo, testnet or partner name', () => {
  for (const file of ['components/approve/ApproveScreen.tsx', 'components/approve/ApproveInbox.tsx', 'components/approve/ApproveDetail.tsx', 'lib/approve/facts.ts']) {
    const text = read(file);
    assert.deepEqual(copyViolations(file, text), [], file);
    assert.doesNotMatch(text, /E39774|coral|\bDemo\b|\bDEMO\b|Coming soon|testnet|non-custodial/i, file);
  }
});

// ── Review round 5.10: nothing hides behind a payment's headline ─────────────────────────────────────

const send = (amountMinor = '900000000', to = A(7)) => ({ type: 'send_funds', asset: USDC, recipient: to, amountMinor });
const usd = { kind: 0, targetCurrency: 'USD', fxRateUsdLocal: '1000000' };

test('a payment that also sends funds somewhere else is blocked, names the extra send, and counts what leaves', () => {
  const f = approveFacts(review([...payment({ ...usd, amountMinor: '250000000' }, { maxFeeMinor: '250000' }, '250250000'), withdraw('900000000'), send()]));
  assert.equal(f.kind, 'payment');
  assert.equal(f.headline, 'Pay 250.00 USDC');
  assert.equal(f.blocked, true);
  assert.match(f.blockedReason, /also/i);
  assert.deepEqual(f.unexpected.map((s) => s.line.split(' ')[0]), ['Send']);
  assert.equal(f.unexpected[0].fields.find((x) => x.address).value, A(7), 'the address is the one in the bytes, in full');
  assert.equal(f.leavesAtMost, '1,150.25');
  assert.match(f.mismatch, /more leaves the wallet/i);
});

test('a payment whose withdrawals are not exactly its amounts and fees is blocked even with no extra command', () => {
  const f = approveFacts(review(payment({ ...usd }, {}, '9000000000')));
  assert.equal(f.blocked, true);
  assert.match(f.mismatch, /more leaves the wallet|does not add up/i);
  assert.deepEqual(f.unexpected, [], 'no command is out of place; the sum is');
  const less = approveFacts(review(payment({ ...usd }, {}, '1000')));
  assert.equal(less.blocked, true, 'less than the payment needs does not add up either');
});

test('a batch adds up per payment: every payment and its fee bound, together, is every withdrawal', () => {
  const ok = approveFacts(review([...payment({ ...usd, recipient: A(2), amountMinor: '1000000000' }, { maxFeeMinor: '500000' }, '1000500000'), ...payment({ ...usd, recipient: A(3), amountMinor: '2000000000' }, { maxFeeMinor: '600000' }, '2000600000')]));
  assert.equal(ok.blocked, false);
  assert.equal(ok.mismatch, null);
  const extra = approveFacts(review([...payment({ ...usd, recipient: A(2), amountMinor: '1000000000' }, { maxFeeMinor: '500000' }, '1000500000'), ...payment({ ...usd, recipient: A(3), amountMinor: '2000000000' }, { maxFeeMinor: '600000' }, '2000600000'), withdraw('5000000'), send('5000000')]));
  assert.equal(extra.kind, 'batch');
  assert.equal(extra.blocked, true);
});

test('a payment that pays an intent opened elsewhere, or opens one it does not pay, is not a plain payment', () => {
  const own = approveFacts(review([withdraw(), open({ ...usd }), pay({ intent: { intentId: A(4), recipient: A(5), amountMinor: '5000000000', kind: 0, targetCurrency: 'USD', fxRateUsdLocal: '1000000', expiresAtMs: '1', asset: USDC } })]));
  assert.equal(own.blocked, true, 'one command opens a payment and the next pays a different one');
  const unpaid = approveFacts(review([withdraw(), open({ ...usd })]));
  assert.equal(unpaid.blocked, true, 'a payment opened and never paid is not what the headline says');
});

test('known bookkeeping is not an alarm: coins merged and joined for a payment, the receipt, the cleanup', () => {
  const f = approveFacts(review([{ type: 'merge_coins', coins: 3 }, { type: 'coin_to_balance', asset: USDC }, { type: 'join_balance', asset: USDC }, ...payment({ ...usd })]));
  assert.equal(f.blocked, false);
  assert.deepEqual(f.unexpected, []);
});

test('a currency the screen cannot word does not crash it: no rate is shown and the request is blocked', () => {
  for (const currency of ['MYR1', 'US$', '', 'x'.repeat(40), 'PH P']) {
    let f;
    assert.doesNotThrow(() => { f = approveFacts(review(payment({ targetCurrency: currency, fxRateUsdLocal: '4500000' }))); }, currency);
    assert.equal(f.blocked, true, currency);
    assert.match(f.blockedReason, /rate/i, currency);
    assert.equal(f.payments[0].rate, null, currency);
  }
});

test('a payment in a currency that is not USD with no rate in the bytes is blocked: the signer cannot see what is received', () => {
  const f = approveFacts(review(payment({ fxRateUsdLocal: '0' })));
  assert.equal(f.blocked, true);
  assert.match(f.blockedReason, /rate/i);
  const usdc = approveFacts(review(payment({ ...usd })));
  assert.equal(usdc.blocked, false, 'a payment in dollars has no rate to be missing');
});

test('every card says the same thing the screen would: a clean payment its amount, a blocked one to not sign, a change its first line and how many more', () => {
  assert.deepEqual(cardSummary(approveFacts(review(payment({ ...usd })))), { text: '5,000.00 USDC · Splash business', warn: false });
  const batch = approveFacts(review([...payment({ ...usd, recipient: A(2) }, {}, '5001000000'), ...payment({ ...usd, recipient: A(3) }, {}, '5001000000')]));
  assert.deepEqual(cardSummary(batch), { text: '2 payments in one transaction', warn: false });
  const blocked = cardSummary(approveFacts(review([...payment({ ...usd }), withdraw('1'), send('1')])));
  assert.equal(blocked.warn, true);
  assert.match(blocked.text, /^Do not sign/);
  const one = cardSummary(approveFacts(review([{ type: 'set_limits', policy: A(1), perPaymentMaxMinor: '2000000000', secondApprovalThresholdMinor: '750000000' }])));
  assert.match(one.text, /^Change the limits/);
  assert.doesNotMatch(one.text, /more/);
  const many = cardSummary(approveFacts(review([{ type: 'set_limits', policy: A(1), perPaymentMaxMinor: '2000000000', secondApprovalThresholdMinor: '750000000' }, { type: 'remove_spender', policy: A(1), spender: A(6) }, { type: 'remove_owner', address: A(8) }])));
  assert.match(many.text, /^Change the limits.* and 2 more changes$/);
  assert.equal(many.warn, false);
});

test('what the declining person is told is what happened: withdrawn, declined and still open, or declined and closed', () => {
  assert.match(closeOutcomeText('cancelled'), /withdrew/);
  assert.match(closeOutcomeText('declined'), /can still sign/);
  const closed = closeOutcomeText('declined_and_closed');
  assert.match(closed, /closed/);
  assert.match(closed, /nothing was sent/i);
  assert.doesNotMatch(closed, /can still sign/, 'it must not say the others can still sign a request that has closed');
  assert.match(closeOutcomeText(undefined), /declined/i, 'an answer it does not know is worded as the safe one');
});

test('the Approve screen opens the steps whenever one is not known bookkeeping, and says why it will not sign', () => {
  assert.match(screen, /open=\{facts\.kind === 'change' \|\| facts\.unexpected\.length > 0\}/);
  assert.match(screen, /facts\.blockedReason/);
  assert.match(code(read('components/approve/ApproveInbox.tsx')), /cardSummary\(/, 'the card is worded by the same facts, not by its first line');
});

test('the sign panel and the screen cannot crash on a request: one reading of the facts, blocked ones not signed', () => {
  assert.match(panel, /facts\.blocked|blocked = /);
  assert.match(panel, /blockedReason/);
  assert.doesNotMatch(panel, /approveFacts\(review\)\.payments\[0\]\?\.rate/, 'the rate is read from the one set of facts');
});

test('the requester can withdraw a request after signing it, and a person who declined a request that closed is told it closed', () => {
  const page = read('components/approve/ApproveDetail.tsx');
  assert.match(page, /closeOutcomeText\(/);
  assert.match(page, /requester \|\| !request\.you\.signed/);
});
