/**
 * v2 Phase 3, brief 5.10: no approval, no draw.
 *
 * The signing message links to /dashboard/approve/[id]. A link is only an
 * address: the request it opens is read and nothing else. These tests hold the
 * service to that, below the screen:
 *
 *   - a payment that needs the owners' signatures draws nothing from the
 *     wallet until the quorum has signed: no signatures, one signature, the
 *     same owner twice, a read of the link any number of times: the chain
 *     sees no submission;
 *   - a payment a staff member asked for is only an ask: it opens no signing
 *     request and submits nothing; it is approved only by the request that
 *     executes, and a request that is withdrawn approves nothing;
 *   - another business's request, and a member who is not a signer, read as
 *     absent and sign nothing;
 *   - a signature replayed (after it was given, and after the request
 *     executed) changes nothing and submits nothing twice.
 *
 * PGlite with every migration, the wallet world's model chain and software
 * passkeys. Nothing reaches a network; nothing is signed for any network.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { eq } from 'drizzle-orm';
import { fromBase64, normalizeSuiAddress } from '@mysten/sui/utils';

import * as schema from '../lib/db/schema.ts';
import { LAUNCH_SCHEDULE, splashFee } from '../lib/fees/schedule.ts';
import { buildBusinessMultisig } from '../lib/wallet/business-multisig.ts';
import { acceptApprovalAsk, settleApprovalAsks } from '../lib/server/payment-approval-asks.ts';
import * as T from '../lib/server/wallet-transfers.ts';
import { readSigningRequest } from '../lib/server/wallet-signing-store.ts';
import { cancelSigningRequest, readRequestForSigner, signingInbox, submitPartialSignature } from '../lib/server/wallet-signing.ts';

import { world, T0 } from './fixtures/wallet-world.mjs';

const USDC = (n) => BigInt(Math.round(n * 1_000_000));
const SUPPLIER = normalizeSuiAddress(`0x${'77'.repeat(32)}`);
const OWNER = { userId: 'u-founder', role: 'OWNER' };
const STAFF = { userId: 'u-two', role: 'MAKER' };
const FEE = splashFee({ kind: 1, principalMinor: USDC(5_000), discountBps: 0, schedule: LAUNCH_SCHEDULE });
const sign = async (passkey, view) => (await passkey.keypair.signTransaction(fromBase64(view.transactionBytes))).signature;

async function setup() {
  const w = await world();
  const { startBusinessWallet } = await import('../lib/server/business-wallet.ts');
  const nominate = await startBusinessWallet(w.ctx, { orgId: 'acme', requestedBy: 'u-founder', founder: { userId: 'u-founder', passkeyPublicKey: w.keys.founder.publicKey }, owners: w.owners });
  await submitPartialSignature(w.signing, { orgId: 'acme', userId: 'u-founder', id: nominate.request.id, signature: await sign(w.keys.founder, nominate.request), digest: nominate.request.digest });
  const [register] = await signingInbox(w.signing, { orgId: 'acme', userId: 'u-two' });
  await submitPartialSignature(w.signing, { orgId: 'acme', userId: 'u-two', id: register.id, signature: await sign(w.keys.two, register), digest: register.digest });
  await submitPartialSignature(w.signing, { orgId: 'acme', userId: 'u-three', id: register.id, signature: await sign(w.keys.three, register), digest: register.digest });
  const wallet = buildBusinessMultisig({ members: w.owners });
  const members = { multisigPublicKey: wallet.multisigPublicKey, members: wallet.members.map((m) => ({ userId: m.userId, publicKey: m.suiPublicKey, weight: m.weight })) };
  const deps = () => ({
    db: w.db,
    orgId: 'acme',
    env: { NODE_ENV: 'test' },
    now: () => w.signing.now(),
    ctx: w.ctx,
    walletMembers: async () => ({ ok: true, address: wallet.address, members }),
    splashAddresses: async () => [w.sponsor.address],
    isBusinessWallet: async () => false,
    businessWallet: async () => null,
    searchBusinesses: async () => [],
    splashFee: async ({ kind, principalMinor }) => ({ feeMinor: splashFee({ kind, principalMinor, discountBps: 0, schedule: LAUNCH_SCHEDULE }), feesOn: true }),
    paymentRecord: async () => ({ ok: true, contentHash: new Uint8Array(32).fill(4), walrusBlobId: new TextEncoder().encode('blob-tx') }),
    requesterAddresses: async (userId) => (userId === 'u-two' ? [w.keys.two.address] : []),
  });
  await w.screenClear(SUPPLIER);
  const recipientId = await w.saveRecipient(SUPPLIER, { name: 'Luzon Components Inc.' });
  const base = w.executed.length;
  return { w, members, deps, recipientId, base };
}

const payment = (t, over = {}) => ({
  clientKey: 'tx_link_000001',
  payee: { kind: 'recipient', recipientId: t.recipientId },
  amountMinor: USDC(5_000).toString(),
  maxFeeMinor: FEE.toString(),
  reference: 'INV-0042',
  ...over,
});

async function signAs(t, userId, key, view) {
  return submitPartialSignature(t.w.signing, { orgId: 'acme', userId, id: view.id, signature: await sign(t.w.keys[key], view), digest: view.digest });
}

const draws = (t) => t.w.executed.length - t.base;

test('no approval, no draw: nothing leaves the wallet before the quorum has signed, however the link is opened', async () => {
  const t = await setup();
  const made = await T.createTransfer(t.deps(), OWNER, payment(t));
  assert.equal(made.ok, true, JSON.stringify(made));
  const view = made.signingRequest;
  assert.equal(made.transfer.status, 'awaiting_signatures');
  assert.equal(draws(t), 0, 'making the payment moves nothing');

  // Opening the link, as each signer and as often as they like, reads the request and nothing else.
  const rowsBefore = JSON.stringify(await t.w.db.select().from(schema.walletSigningSigners));
  for (const who of ['u-founder', 'u-two', 'u-three', 'u-two', 'u-two']) {
    const read = await readRequestForSigner(t.w.signing, { orgId: 'acme', userId: who, id: view.id });
    assert.equal(read.ok, true);
    assert.equal(read.request.status, 'collecting');
    assert.equal(read.request.digest, view.digest, 'the same bytes every time');
  }
  assert.equal(JSON.stringify(await t.w.db.select().from(schema.walletSigningSigners)), rowsBefore, 'no signature row was touched by reading');
  assert.equal(draws(t), 0);

  // One owner's signature is one of two.
  const first = await signAs(t, 'u-two', 'two', view);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.request.status, 'collecting');
  assert.equal(draws(t), 0, 'one of two owners is not an approval');

  // The same owner again is not a second approval.
  const again = await signAs(t, 'u-two', 'two', view);
  assert.equal(again.ok, false, 'a signature given twice is refused');
  assert.equal((await readRequestForSigner(t.w.signing, { orgId: 'acme', userId: 'u-two', id: view.id })).request.status, 'collecting');
  assert.equal(draws(t), 0, 'the same owner twice is still one approval');
  assert.equal((await T.getTransfer(t.deps(), made.transfer.id)).status, 'awaiting_signatures');

  // The recorded approval of a second owner is what makes the draw, once.
  const second = await signAs(t, 'u-three', 'three', view);
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.request.status, 'executed');
  assert.equal(draws(t), 1, 'the payment is submitted once, after the second owner');
  assert.equal((await T.getTransfer(t.deps(), made.transfer.id)).status, 'settled');

  // A signature after it executed, by anyone, is a replay: refused, nothing submitted again.
  const late = await signAs(t, 'u-founder', 'founder', view);
  assert.equal(late.ok, false);
  assert.equal(draws(t), 1, 'never a second draw');
  await t.w.client.close();
});

test('a payment withdrawn before it has its approvals draws nothing, and a signature on it afterwards is refused', async () => {
  const t = await setup();
  const made = await T.createTransfer(t.deps(), OWNER, payment(t, { clientKey: 'tx_link_000002' }));
  const view = made.signingRequest;
  assert.equal((await signAs(t, 'u-two', 'two', view)).ok, true);
  const closed = await cancelSigningRequest(t.w.signing, { orgId: 'acme', userId: 'u-founder', id: view.id });
  assert.equal(closed.ok, true, JSON.stringify(closed));
  const late = await signAs(t, 'u-three', 'three', view);
  assert.equal(late.ok, false, 'the link of a withdrawn request signs nothing');
  assert.equal(draws(t), 0);
  assert.notEqual((await T.getTransfer(t.deps(), made.transfer.id)).status, 'settled');
  await t.w.client.close();
});

test('another business’s request, and a member who is not a signer, read as absent and sign nothing', async () => {
  const t = await setup();
  const made = await T.createTransfer(t.deps(), OWNER, payment(t, { clientKey: 'tx_link_000003' }));
  const view = made.signingRequest;
  // The other business's person, with their own org: it is not theirs.
  const north = await readRequestForSigner(t.w.signing, { orgId: 'northwind', userId: 'u-north', id: view.id });
  assert.equal(north.ok, false);
  assert.equal(north.status, 404);
  // An acme person naming the other org does not reach it either way.
  const crossed = await readRequestForSigner(t.w.signing, { orgId: 'northwind', userId: 'u-two', id: view.id });
  assert.equal(crossed.ok, false);
  assert.equal(crossed.status, 404);
  // A member of acme who is not on the request.
  const outsider = await readRequestForSigner(t.w.signing, { orgId: 'acme', userId: 'u-nobody', id: view.id });
  assert.equal(outsider.ok, false);
  assert.equal(outsider.status, 404);
  // Their inbox has nothing to open, and signing from outside is refused without a draw.
  assert.deepEqual(await signingInbox(t.w.signing, { orgId: 'northwind', userId: 'u-north' }), []);
  const forced = await submitPartialSignature(t.w.signing, { orgId: 'northwind', userId: 'u-north', id: view.id, signature: await sign(t.w.keys.two, view), digest: view.digest });
  assert.equal(forced.ok, false);
  assert.equal(forced.status, 404);
  const rows = await t.w.db.select().from(schema.walletSigningSigners).where(eq(schema.walletSigningSigners.requestId, view.id));
  assert.equal(rows.filter((r) => r.signedAt).length, 0, 'no signature was stored');
  assert.equal(draws(t), 0);
  await t.w.client.close();
});

test('a payment staff asked for is an ask until an owner accepts it, and approved only by the request that executes', async () => {
  const t = await setup();
  const made = await T.createTransfer(t.deps(), STAFF, payment(t, { clientKey: 'tx_link_000004' }));
  assert.equal(made.ok, true, JSON.stringify(made));
  assert.equal(made.transfer.route, 'asked_owners');
  assert.equal(made.signingRequest ?? null, null, 'an ask has no request to sign, so no link to open');
  assert.equal(draws(t), 0, 'staff cannot draw: the ask is only an ask');

  const accepted = await acceptApprovalAsk(
    { db: t.w.db, ctx: t.w.ctx },
    { orgId: 'acme', userId: 'u-founder', askId: made.ask.id, mode: 'wallet_pays', wallet: t.members, maxFeeMinor: FEE, settleByMs: BigInt(T0.getTime() + 300_000) },
  );
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  const view = accepted.request;
  const askStatus = async () => (await t.w.db.select().from(schema.walletApprovalAsks).where(eq(schema.walletApprovalAsks.id, made.ask.id)))[0].status;
  assert.equal(await askStatus(), 'signing');
  assert.equal(draws(t), 0, 'accepting an ask asks for signatures; it pays nothing');

  assert.equal((await signAs(t, 'u-two', 'two', view)).ok, true);
  assert.equal(await askStatus(), 'signing', 'one of two is not approved');
  assert.equal(draws(t), 0);
  const done = await signAs(t, 'u-three', 'three', view);
  assert.equal(done.request.status, 'executed');
  assert.equal(draws(t), 1);
  // The executed request is what approves the ask (wallet-deps runs this on execution).
  assert.equal(await settleApprovalAsks(t.w.db, await readSigningRequest(t.w.db, 'acme', view.id)), 1);
  assert.equal(await askStatus(), 'approved', 'approved by the request that executed');
  await t.w.client.close();
});

test('an ask whose request was withdrawn is not approved and draws nothing', async () => {
  const t = await setup();
  const made = await T.createTransfer(t.deps(), STAFF, payment(t, { clientKey: 'tx_link_000005' }));
  const accepted = await acceptApprovalAsk(
    { db: t.w.db, ctx: t.w.ctx },
    { orgId: 'acme', userId: 'u-founder', askId: made.ask.id, mode: 'wallet_pays', wallet: t.members, maxFeeMinor: FEE, settleByMs: BigInt(T0.getTime() + 300_000) },
  );
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.equal((await signAs(t, 'u-two', 'two', accepted.request)).ok, true);
  const closed = await cancelSigningRequest(t.w.signing, { orgId: 'acme', userId: 'u-founder', id: accepted.request.id });
  assert.equal(closed.ok, true, JSON.stringify(closed));
  assert.equal(await settleApprovalAsks(t.w.db, await readSigningRequest(t.w.db, 'acme', accepted.request.id)), 0, 'a request that did not execute approves nothing');
  const [row] = await t.w.db.select().from(schema.walletApprovalAsks).where(eq(schema.walletApprovalAsks.id, made.ask.id));
  assert.notEqual(row.status, 'approved');
  assert.equal(draws(t), 0);
  await t.w.client.close();
});
