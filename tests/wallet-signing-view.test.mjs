/**
 * The signing screen shows what the signature does (v2 brief 4.1, 5.5; review
 * of p3-5.5). A destination change, a limit, an allowance or a payout approval
 * is shown with its full fields, never folded into "Change your spending
 * rules". A command the page cannot word is labelled and blocks signing.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { RENDERED_ACTION_TYPES, signingItems } from '../lib/wallet-page/actions.ts';

const A = (n) => `0x${String(n).repeat(64)}`;
const text = (items) => items.map((i) => `${i.line} ${i.fields.map((f) => `${f.label}: ${f.value}`).join(' ')}`).join('\n');

test('every command the describer can return is worded by the signing screen', () => {
  const src = readFileSync(new URL('../lib/wallet/wallet-tx-describe.ts', import.meta.url), 'utf8');
  const start = src.indexOf('export type WalletAction');
  const end = src.indexOf('export type WalletTxDescription');
  const block = src.slice(start, end);
  const types = new Set();
  for (const m of block.matchAll(/type: '([a-z_]+(?:' \| '[a-z_]+)*)'/g)) for (const t of m[1].split("' | '")) types.add(t);
  assert.ok(types.size >= 30, `read ${types.size} command types`);
  for (const t of types) assert.ok(RENDERED_ACTION_TYPES.includes(t), `${t} has no wording on the signing screen`);
});

test('the fixed partner deposit address is shown in full and must match the Wallet page', () => {
  const items = signingItems([{ type: 'verify_beneficiary', policy: A(1), commitment: 'ab'.repeat(32), partnerDeposit: A(7) }]);
  assert.equal(items.length, 1);
  assert.ok(items[0].fields.some((f) => f.value === A(7) && f.address), 'the full address is a field');
  assert.match(text(items), /Wallet page/);
  assert.doesNotMatch(items[0].line, /^Change your spending rules\.$/);
});

test('recipients, spenders and owners are shown in full, not as 6 and 4 characters', () => {
  const items = signingItems([
    { type: 'send_funds', asset: 'x', recipient: A(2), amountMinor: '1000000' },
    { type: 'verify_recipient', policy: A(1), address: A(3), kind: 0 },
    { type: 'add_spender', policy: A(1), spender: A(4), role: 'staff', perPaymentMaxMinor: '500000000' },
    { type: 'add_owner', address: A(5) },
    { type: 'remove_owner', address: A(6) },
    { type: 'set_recovery_party', address: A(8) },
  ]);
  const all = text(items);
  for (const n of [2, 3, 4, 5, 6, 8]) assert.ok(all.includes(A(n)), `address ${n} is shown in full`);
  assert.match(all, /1\.00 USDC/);
  assert.match(all, /500\.00 USDC/);
});

test('limits, windows and allowances carry their numbers', () => {
  const items = signingItems([
    { type: 'set_limits', policy: A(1), perPaymentMaxMinor: '2000000000', secondApprovalThresholdMinor: '750000000' },
    { type: 'set_running_window', policy: A(1), windowMs: String(7 * 24 * 3600 * 1000) },
    { type: 'propose_allowance', asset: 'x', name: 'Rent', spender: A(9), lifetimeCapMinor: '9000000000', startsAtMs: null, expiresAtMs: '1900000000000', rateLimit: { window: { kind: 'calendar', months: 1 }, limitMinor: '300000000' } },
    { type: 'new_billing_allowance', asset: 'x', name: 'Plan', spender: A(5), lifetimeCapMinor: null, startsAtMs: null, expiresAtMs: '1900000000000', monthlyLimitMinor: '100000000' },
    { type: 'revoke_allowance', allowance: A(2), cap: A(3) },
    { type: 'revoke_billing_allowance', allowance: A(2), cap: A(3) },
  ]);
  const all = text(items);
  assert.match(all, /2,?000\.00 USDC/);
  assert.match(all, /750\.00 USDC/);
  assert.match(all, /7 days/);
  assert.ok(all.includes(A(9)));
  assert.match(all, /90,?000,?000\.00 USDC|9,?000\.00 USDC/);
  assert.match(all, /month/);
  assert.match(all, /1\.00 USDC|100\.00 USDC/);
  assert.equal(items.length, 6, 'one item per command, none folded');
});

test('a payout approval and a payment of an existing intent show the payee and the amount', () => {
  const intent = { intentId: A(1), recipient: A(2), amountMinor: '12000000', kind: 0, targetCurrency: 'MYR', fxRateUsdLocal: '1', expiresAtMs: '1', asset: 'x' };
  const items = signingItems([
    { type: 'approve_payout', policy: A(1), intent, payer: A(3), maxTotalMinor: '12500000', settleByMs: '1900000000000' },
    { type: 'pay_intent', asset: 'x', maxFeeMinor: '20000', settleByMs: '1', paysFromCommand: 0, intentFromCommand: null, intent },
  ]);
  const all = text(items);
  assert.ok(all.includes(A(2)) && all.includes(A(3)));
  assert.match(all, /12\.00 USDC/);
  assert.match(all, /12\.50 USDC/);
});

test('a command the page cannot word is labelled and blocks signing', () => {
  const items = signingItems([{ type: 'wat' }]);
  assert.equal(items.length, 1);
  assert.equal(items[0].unknown, true);
  assert.match(items[0].line, /Not shown here/);
  assert.match(items[0].line, /do not sign/i);
});

const panel = readFileSync(new URL('../components/transfer/SignPanel.tsx', import.meta.url), 'utf8');

test('the signing panel lists every item with its full fields and will not sign what it cannot word', () => {
  assert.match(panel, /signingItems\(/);
  assert.match(panel, /groupAddress\(f\.value\)|groupAddress\(field\.value\)/, 'addresses are grouped, in full');
  assert.match(panel, /unknown/, 'unknown commands are handled');
  assert.match(panel, /disabled=\{busy \|\| blocked\}/, 'signing is disabled for an unwordable request');
  assert.match(panel, /useId\(\)/, 'the heading id is unique per panel');
  assert.doesNotMatch(panel, /id="sig-h"/);
});
