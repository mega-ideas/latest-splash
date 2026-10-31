import assert from 'node:assert/strict';
import test from 'node:test';

import { copyViolations } from '../scripts/copy-rules.mjs';
import { HOLD_REASON_TEXT } from '../lib/funding/wallet-funding.ts';
import { depositLine, fundingHistory, holdReasonText, requestTitle, sourceLine, withdrawalLine } from '../lib/wallet-page/labels.ts';
import { plainActions } from '../lib/wallet-page/actions.ts';

/**
 * v2 Phase 3, brief 5.5: the words on the Wallet page for funding, funding
 * sources, withdrawals and signing requests. Each says what is true and what
 * to do next, with no licence claim, no partner name and no internal code.
 */

const ALL = [
  ...Object.values(HOLD_REASON_TEXT),
];

test('every reason a deposit can be held has a sentence on the page, the same as the server gives', () => {
  for (const [reason, text] of Object.entries(HOLD_REASON_TEXT)) assert.equal(holdReasonText(reason), text, reason);
  assert.match(holdReasonText('something_new'), /checked/i, 'an unknown reason still reads as a check, never as a code');
  assert.doesNotMatch(holdReasonText('something_new'), /something_new/);
});

test('a deposit is cleared, held with its reasons, or blocked for good', () => {
  const cleared = depositLine({ asset: 'USDC', amountMinor: '25000000', status: 'cleared', holdReasons: [], arrivedAt: '2026-10-30T10:00:00Z' });
  assert.deepEqual([cleared.amount, cleared.state, cleared.tone], ['25.00 USDC', 'Ready to use', 'ok']);
  const held = depositLine({ asset: 'USDC', amountMinor: '1000000', status: 'held', holdReasons: ['source_unverified', 'not_screened'], arrivedAt: null });
  assert.equal(held.state, 'Held, not spent');
  assert.equal(held.reasons.length, 2);
  const blocked = depositLine({ asset: 'USDC', amountMinor: '1000000', status: 'blocked', holdReasons: [], arrivedAt: null });
  assert.equal(blocked.tone, 'bad');
  assert.match(blocked.state, /blocked/i);
  assert.match(blocked.note, /screening|support/i, 'a blocked deposit says who can look at it');
});

test('USDT and USDsui are shown as the coin that arrived, never counted as USDC, and the conversion is stated as it is', () => {
  const usdt = depositLine({ asset: 'USDT', amountMinor: '40000000', status: 'cleared', holdReasons: [], arrivedAt: null });
  assert.equal(usdt.amount, '40.00 USDT');
  assert.match(usdt.note, /not counted as USDC|not USDC/i);
  const history = fundingHistory([
    { asset: 'USDC', amountMinor: '1000000', status: 'cleared', holdReasons: [], arrivedAt: '2026-10-29T10:00:00Z' },
    { asset: 'USDSUI', amountMinor: '2000000', status: 'cleared', holdReasons: [], arrivedAt: '2026-10-30T10:00:00Z' },
    { asset: 'USDT', amountMinor: '3000000', status: 'held', holdReasons: ['source_unverified'], arrivedAt: null },
  ]);
  assert.equal(history.converted.length, 2, 'the coins that need converting are their own list');
  assert.equal(history.usdc.length, 1);
  assert.equal(history.converted[0].amount, '2.00 USDsui');
});

test('a funding source is verified, or checking with the way it gets checked', () => {
  assert.deepEqual(sourceLine({ kind: 'bank_account', status: 'verified', last4: '4821', label: 'Operating account' }).state, 'Verified');
  const bank = sourceLine({ kind: 'bank_account', status: 'pending', last4: '4821', label: 'Operating account' });
  assert.equal(bank.state, 'Checking');
  assert.match(bank.next, /first deposit/);
  const wallet = sourceLine({ kind: 'wallet', status: 'pending', last4: null, label: 'Treasury wallet' });
  assert.match(wallet.next, /sign/i, 'a wallet is proven with a signature');
  assert.equal(sourceLine({ kind: 'card', status: 'revoked', last4: '1111', label: 'Card' }).state, 'Removed');
  assert.equal(sourceLine({ kind: 'bank_account', status: 'rejected', last4: '1', label: 'x' }).state, 'Not accepted');
});

test('a withdrawal reads as where it is, and a returned one says the USDC came back', () => {
  assert.equal(withdrawalLine('awaiting_signatures').state, 'Waiting for your owners to sign');
  assert.equal(withdrawalLine('paid_out').tone, 'ok');
  assert.match(withdrawalLine('returned').state, /returned/i);
  assert.match(withdrawalLine('returned').note, /back in your wallet/i);
  assert.equal(withdrawalLine('failed').tone, 'bad');
  assert.doesNotMatch(withdrawalLine('mystery').state, /mystery/);
});

test('every kind of signing request has a title a person understands', () => {
  for (const purpose of ['nominate_wallet', 'register_wallet', 'rotate_wallet', 'confirm_wallet_rotation', 'cancel_wallet_rotation', 'wallet_membership', 'wallet_payment', 'migration_transfer', 'rotation_transfer', 'spend_policy', 'spend_rule', 'spend_approval', 'withdrawal', 'partner_test_deposit', 'partner_payout', 'subscription']) {
    const t = requestTitle(purpose);
    assert.ok(t.length > 8 && !/_/.test(t), `${purpose}: ${t}`);
  }
  assert.match(requestTitle('register_wallet'), /Create your business wallet/);
  assert.match(requestTitle('migration_transfer'), /Move your USDC/);
});

test('what a transaction does is listed in plain words from the decoded commands, and unknown ones say so', () => {
  const lines = plainActions([
    { type: 'register_wallet', wallet: `0x${'11'.repeat(32)}`, threshold: 2, members: [{ address: 'a', weight: 1 }, { address: 'b', weight: 1 }, { address: 'c', weight: 1 }], singleSignerAck: false },
    { type: 'merge_coins', coins: 3 },
    { type: 'send_funds', asset: '0x2::usdc::USDC', recipient: `0x${'22'.repeat(32)}`, amountMinor: '5000000' },
    { type: 'withdraw', asset: '0x2::usdc::USDC', amountMinor: '5000000' },
    { type: 'wat' },
  ]);
  assert.match(lines[0], /2 of 3/);
  assert.match(lines[1], /3 USDC coins/);
  assert.match(lines[2], /5\.00 USDC/);
  assert.match(lines[2], /0x2222/);
  assert.equal(lines.length, 5);
  assert.match(lines[4], /Not shown here.*do not sign/i, 'a command the page does not know is labelled, never dropped or shown as code');
});

test('no sentence here claims a licence, names a partner, says coming soon or mentions the test network', () => {
  const sentences = [
    ...ALL,
    ...['cleared', 'held', 'blocked'].flatMap((s) => {
      const d = depositLine({ asset: 'USDC', amountMinor: '1', status: s, holdReasons: ['source_unverified'], arrivedAt: null });
      return [d.state, d.note, ...d.reasons];
    }),
    ...['awaiting_signatures', 'sent', 'partner_received', 'paid_out', 'failed', 'returned', 'cancelled', 'preparing'].flatMap((s) => [withdrawalLine(s).state, withdrawalLine(s).note]),
  ];
  for (const text of sentences) {
    assert.doesNotMatch(text, /coming soon|testnet|licen[cs]ed|non-custodial|\bdemo\b|hata|fiuu|pdax|durianpay|halliday|stripe|transfi/i, text);
  }
  assert.deepEqual(copyViolations('components/wallet/labels.tsx', sentences.join('\n')), []);
});
