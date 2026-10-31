import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/**
 * v2 Phase 3, brief 5.5 (Withdraw to own bank): the audit bundle behind a
 * withdrawal is the server's to make, as it already is for a supplier payout.
 * A client that names its own content hash and Walrus blob could anchor
 * anything on chain under the owners' signatures.
 */

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('the withdrawal route seals the record itself and ignores a bundle the client names', () => {
  const route = read('app/api/wallet/withdrawals/route.ts');
  assert.doesNotMatch(code(route), /contentHash: body\.|walrusBlobId: body\./, 'a client cannot name the audit bundle');
  assert.match(route, /makePaymentRecorder/);
  assert.match(route, /sealAdapter/);
  assert.match(route, /storeEncryptedInvoice/);
});

test('the withdrawal route checks cheaply before it seals, and a retry seals nothing', () => {
  const route = read('app/api/wallet/withdrawals/route.ts');
  const prior = route.indexOf('withdrawalByClientKey(');
  const check = route.indexOf('bigintField(body.amountMinor)');
  const seal = route.indexOf('makePaymentRecorder({');
  assert.ok(prior > 0 && check > prior && seal > check, 'a retry is answered before the amount is parsed, and the amount before anything is sealed');
  assert.match(route, /if \(!prior && clientKey\)/);
  assert.match(route, /amountMinor: amount\.toString\(\)/);
  assert.doesNotMatch(route, /String\(body\.amountMinor/);
});

test('the sealed record names the business and the bank account holder the business saved, not text from the request', () => {
  const route = read('app/api/wallet/withdrawals/route.ts');
  assert.match(route, /companyName\(\)/);
  assert.match(route, /listWithdrawalDestinations/);
});
