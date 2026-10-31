import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { canonicalRecord, makePaymentRecorder } from '../lib/server/payment-record.ts';

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

const record = { orgId: 'org_1', transferId: 'wd_abc12345', payer: 'Acme Sdn Bhd', payee: 'Acme Sdn Bhd', amountMinor: '5000000', maxFeeMinor: '0', reference: 'Withdrawal to own bank account' };
const demoSeal = { encrypt: async () => ({ ciphertext: 'c', policy: { policyId: 'demo', mode: 'demo' } }) };
const liveSeal = { encrypt: async () => ({ ciphertext: 'c', policy: { policyId: 'p', mode: 'live' } }) };
const demoStore = async () => ({ blobId: 'demo_blob', mode: 'demo' });
const liveStore = async () => ({ blobId: 'blob_live', mode: 'live' });

test('in production a withdrawal’s bundle is never made under a demo Seal policy or a demo Walrus blob, and no hash is invented', async () => {
  const prod = { NODE_ENV: 'production' };
  for (const [seal, store] of [[demoSeal, liveStore], [liveSeal, demoStore], [demoSeal, demoStore]]) {
    const out = await makePaymentRecorder({ seal, store, env: prod })(record);
    assert.equal(out.ok, false);
    assert.equal(out.status, 503);
    assert.equal(out.code, 'record_unavailable');
    assert.equal('contentHash' in out, false, 'a refusal carries no hash');
  }
  const failing = await makePaymentRecorder({ seal: liveSeal, store: async () => { throw new Error('publisher down'); }, env: prod })(record);
  assert.equal(failing.ok, false);
  assert.doesNotMatch(JSON.stringify(failing), /publisher down/);
});

test('with a live policy and blob the bundle is made, and the same payment always has the same hash', async () => {
  const prod = { NODE_ENV: 'production' };
  const a = await makePaymentRecorder({ seal: liveSeal, store: liveStore, env: prod })(record);
  const b = await makePaymentRecorder({ seal: liveSeal, store: liveStore, env: prod })(record);
  assert.equal(a.ok, true);
  assert.equal(a.mode, 'live');
  assert.deepEqual(Buffer.from(a.contentHash), Buffer.from(b.contentHash));
  const other = await makePaymentRecorder({ seal: liveSeal, store: liveStore, env: prod })({ ...record, amountMinor: '5000001' });
  assert.notDeepEqual(Buffer.from(a.contentHash), Buffer.from(other.contentHash), 'another amount is another record');
  assert.match(canonicalRecord(record), /"payee":"Acme Sdn Bhd"/);
});
