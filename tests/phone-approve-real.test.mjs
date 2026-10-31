/**
 * v2 Phase 3, brief 5.10: the Approve screen over a real request.
 *
 * A payment request is made by the server from real transaction bytes (the
 * wallet world builds them, signs nothing for any network and sends nothing),
 * an owner's inbox hands it over, and the phone decodes the bytes on its own
 * device (reviewOnDevice) and words them (approveFacts): the payee, amount,
 * asset, fee bound and rate on the screen are the bytes' own. Another
 * business's inbox and read are empty and absent, and bytes that were changed
 * after the digest was made are not shown at all.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { fromBase64, toBase64 } from '@mysten/sui/utils';

import { buildBusinessMultisig } from '../lib/wallet/business-multisig.ts';
import { requestWalletPayment, startBusinessWallet } from '../lib/server/business-wallet.ts';
import { readRequestForSigner, signingInbox, submitPartialSignature } from '../lib/server/wallet-signing.ts';
import { reviewRequest } from '../lib/approve/facts.ts';
import { waitingForMe } from '../lib/dashboard/phone.ts';

import { T0, world } from './fixtures/wallet-world.mjs';

const bytes32 = (b) => new Uint8Array(32).fill(b);
const sign = async (passkey, view) => (await passkey.keypair.signTransaction(fromBase64(view.transactionBytes))).signature;
const PAYEE = '0x' + '77'.repeat(32);

async function registeredWallet(w) {
  const started = await startBusinessWallet(w.ctx, { orgId: 'acme', requestedBy: 'u-founder', founder: { userId: 'u-founder', passkeyPublicKey: w.keys.founder.publicKey }, owners: w.owners });
  assert.equal(started.ok, true, JSON.stringify(started));
  const nominated = await submitPartialSignature(w.signing, { orgId: 'acme', userId: 'u-founder', id: started.request.id, signature: await sign(w.keys.founder, started.request), digest: started.request.digest });
  assert.equal(nominated.ok, true, JSON.stringify(nominated));
  const [register] = await signingInbox(w.signing, { orgId: 'acme', userId: 'u-two' });
  await submitPartialSignature(w.signing, { orgId: 'acme', userId: 'u-two', id: register.id, signature: await sign(w.keys.two, register), digest: register.digest });
  const done = await submitPartialSignature(w.signing, { orgId: 'acme', userId: 'u-three', id: register.id, signature: await sign(w.keys.three, register), digest: register.digest });
  assert.equal(done.request.status, 'executed', JSON.stringify(done));
  w.notices.length = 0;
  const wallet = buildBusinessMultisig({ members: w.owners });
  return { wallet, members: { multisigPublicKey: wallet.multisigPublicKey, members: wallet.members.map((m) => ({ userId: m.userId, publicKey: m.suiPublicKey, weight: m.weight })) } };
}

const payment = (over = {}) => ({
  paymentRef: bytes32(1),
  recipient: PAYEE,
  beneficiaryRef: new Uint8Array(),
  amountMinor: 250_000_000n,
  targetCurrency: 'USDC',
  fxRateUsdLocal: 1_000_000n,
  commitment: bytes32(2),
  kind: 1,
  railCommitment: bytes32(3),
  expiresAtMs: BigInt(T0.getTime() + 7 * 24 * 3600_000),
  maxFeeMinor: 250_000n,
  settleByMs: BigInt(T0.getTime() + 5 * 60_000),
  contentHash: bytes32(4),
  walrusBlobId: new TextEncoder().encode('blob-1'),
  ...over,
});

async function openPayment(w, members, over = {}) {
  await w.screenClear(PAYEE);
  await w.saveRecipient(PAYEE);
  const opened = await requestWalletPayment(w.ctx, { orgId: 'acme', requestedBy: 'u-two', wallet: members, payment: payment(over) });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  return opened;
}

test('an owner’s inbox request, decoded on the device, shows the payee, amount, asset and fee bound the bytes carry', async () => {
  const w = await world();
  const { members } = await registeredWallet(w);
  await openPayment(w, members);
  const [view] = await signingInbox(w.signing, { orgId: 'acme', userId: 'u-three' });
  const reviewed = reviewRequest(view, { names: ['Cahaya Logistics'] });
  assert.equal(reviewed.ok, true, JSON.stringify(reviewed));
  const f = reviewed.facts;
  assert.equal(f.kind, 'payment');
  assert.equal(f.asset, 'USDC');
  assert.equal(f.payments[0].amount, '250.00');
  assert.equal(f.payments[0].maxFee, '0.25');
  assert.equal(f.payments[0].payeeName, 'Cahaya Logistics');
  assert.equal(f.payments[0].recipient.replaceAll(' ', ''), PAYEE, 'the payee is the address in the bytes, in full');
  assert.equal(f.payments[0].rate, null, 'a payment in USDC has no rate');
  assert.equal(f.leavesAtMost, '250.25');
  assert.equal(f.blocked, false);
  assert.match(f.code, /^[0-9a-f]{4} [0-9a-f]{4} [0-9a-f]{4} [0-9a-f]{4}$/, 'the code to compare with the WhatsApp message');
  assert.equal(waitingForMe([{ ...view }]), 1, 'it is waiting for this signer, and the tab bar counts it');
  await w.client.close();
});

test('bytes changed after the digest was made are not shown, and the card says it could not be checked', async () => {
  const w = await world();
  const { members } = await registeredWallet(w);
  await openPayment(w, members);
  const [view] = await signingInbox(w.signing, { orgId: 'acme', userId: 'u-three' });
  const bytes = fromBase64(view.transactionBytes);
  bytes[bytes.length - 1] ^= 0xff;
  const tampered = reviewRequest({ ...view, transactionBytes: toBase64(bytes) }, {});
  assert.equal(tampered.ok, false);
  assert.match(tampered.message, /could not be checked/i);
  assert.match(tampered.message, /do not sign/i);
  // A digest swapped for another request's is no better.
  const swapped = reviewRequest({ ...view, digest: 'AAAA' }, {});
  assert.equal(swapped.ok, false);
  await w.client.close();
});

test('another business’s inbox and read are empty and absent, so its phone has nothing to decode', async () => {
  const w = await world();
  const { members } = await registeredWallet(w);
  const opened = await openPayment(w, members);
  assert.deepEqual(await signingInbox(w.signing, { orgId: 'northwind', userId: 'u-three' }), []);
  const read = await readRequestForSigner(w.signing, { orgId: 'northwind', userId: 'u-three', id: opened.request.id });
  assert.equal(read.status, 404);
  assert.equal(waitingForMe((await signingInbox(w.signing, { orgId: 'northwind', userId: 'u-three' }))), 0);
  await w.client.close();
});

test('a signature given twice from a phone is one signature: the second is closed or already counted, and nothing is submitted twice', async () => {
  const w = await world();
  const { members } = await registeredWallet(w);
  await openPayment(w, members);
  const [view] = await signingInbox(w.signing, { orgId: 'acme', userId: 'u-three' });
  const signature = await sign(w.keys.three, view);
  const first = await submitPartialSignature(w.signing, { orgId: 'acme', userId: 'u-three', id: view.id, signature, digest: view.digest });
  assert.equal(first.ok, true, JSON.stringify(first));
  const before = w.executed.length;
  const again = await submitPartialSignature(w.signing, { orgId: 'acme', userId: 'u-three', id: view.id, signature, digest: view.digest });
  assert.ok(again.ok === false || again.request?.you?.signed === true, 'the double tap is refused or answers the signature already given');
  assert.equal(w.executed.length, before, 'nothing was submitted by the second tap');
  assert.equal(waitingForMe(await signingInbox(w.signing, { orgId: 'acme', userId: 'u-three' })), 0, 'it leaves this signer’s count once they have signed');
  await w.client.close();
});
