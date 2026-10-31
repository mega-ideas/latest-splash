/**
 * What the Finance lead can and cannot do ON CHAIN (v2 Phase 3). Nothing in
 * Move changes: the role only lets that person START a request to add a
 * signer. The request is the wallet's own: it is signed by the wallet's
 * signers, who read the decoded bytes first, and a Finance lead who is not one
 * of them cannot add a signature.
 *
 * PGlite with every migration, software passkeys and the model chain of
 * tests/fixtures/wallet-world.mjs. Nothing reaches a network.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { fromBase64 } from '@mysten/sui/utils';

import { softPasskey } from './fixtures/soft-passkey.mjs';
import { world } from './fixtures/wallet-world.mjs';
import * as schema from '../lib/db/schema.ts';
import { buildBusinessMultisig } from '../lib/wallet/business-multisig.ts';
import { changeWalletMembership, startBusinessWallet } from '../lib/server/business-wallet.ts';
import { appointFinanceLead } from '../lib/server/team-admin.ts';
import { signingInbox, submitPartialSignature } from '../lib/server/wallet-signing.ts';

async function sign(passkey, view) {
  return (await passkey.keypair.signTransaction(fromBase64(view.transactionBytes))).signature;
}

async function signBy(w, view, ...who) {
  let last;
  for (const name of who) {
    last = await submitPartialSignature(w.signing, { orgId: 'acme', userId: name === 'founder' ? 'u-founder' : `u-${name}`, id: view.id, signature: await sign(w.keys[name], view), digest: view.digest });
    assert.equal(last.ok, true, JSON.stringify(last));
  }
  return last.request;
}

async function registered(w) {
  const started = await startBusinessWallet(w.ctx, { orgId: 'acme', requestedBy: 'u-founder', founder: { userId: 'u-founder', passkeyPublicKey: w.keys.founder.publicKey }, owners: w.owners });
  assert.equal(started.ok, true, JSON.stringify(started));
  await signBy(w, started.request, 'founder');
  const [register] = await signingInbox(w.signing, { orgId: 'acme', userId: 'u-two' });
  assert.equal((await signBy(w, register, 'two', 'three')).status, 'executed');
  const wallet = buildBusinessMultisig({ members: w.owners });
  return { wallet, members: { multisigPublicKey: wallet.multisigPublicKey, members: wallet.members.map((m) => ({ userId: m.userId, publicKey: m.suiPublicKey, weight: m.weight })) } };
}

test('the Finance lead starts a request to add a signer; they cannot sign it; the wallet\'s signers decide', async () => {
  const w = await world();
  const { members } = await registered(w);
  const lead = softPasskey();
  await w.db.insert(schema.users).values({ id: 'u-lead', email: 'lead@acme.test', name: 'Lead', emailVerifiedAt: new Date('2026-10-01T00:00:00Z') });
  await w.db.insert(schema.memberships).values({ id: 'm-lead', userId: 'u-lead', orgId: 'acme', role: 'checker' });
  assert.equal((await appointFinanceLead(w.db, { orgId: 'acme', actorUserId: 'u-founder', userId: 'u-lead', now: () => new Date('2026-10-30T09:00:00Z') })).ok, true);

  const newcomer = softPasskey();
  const started = await changeWalletMembership(w.ctx, { orgId: 'acme', requestedBy: 'u-lead', wallet: members, change: 'add_owner', address: newcomer.address });
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.equal(started.request.requestedBy ?? 'u-lead', 'u-lead');
  assert.deepEqual(started.request.description.actions.map((a) => [a.type, a.address]), [['add_owner', newcomer.address]]);

  const sentBefore = w.executed.length;
  // The Finance lead is not a signer: their own passkey's signature is refused, and nothing is collected.
  const attempt = await submitPartialSignature(w.signing, { orgId: 'acme', userId: 'u-lead', id: started.request.id, signature: await sign(lead, started.request), digest: started.request.digest });
  assert.equal(attempt.ok, false);
  assert.equal(attempt.status, 403);
  assert.equal(attempt.code, 'not_a_signer');
  assert.equal(w.executed.length, sentBefore, 'nothing was sent');

  // They also do not see the request in the signing inbox (it is for the signers).
  assert.deepEqual((await signingInbox(w.signing, { orgId: 'acme', userId: 'u-lead' })).filter((r) => r.id === started.request.id), []);

  // The owners' quorum signs it, and only then does it execute.
  const done = await signBy(w, started.request, 'founder', 'two');
  assert.equal(done.status, 'executed');
  assert.equal(w.executed.length, sentBefore + 1);
  await w.client.close();
});
