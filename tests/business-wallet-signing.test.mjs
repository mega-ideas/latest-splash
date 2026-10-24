/**
 * The Business Splash Wallet's signature collection (v2 §4.1, review B10).
 *
 * The owners' passkeys make a multisig; the founder nominates it; the
 * multisig registers itself. Each signer signs the exact stored bytes on their
 * own device, the server checks every partial signature against those bytes
 * and that signer's key, combines them at the threshold, and submits with the
 * sponsor's signature. These tests drive that end to end against PGlite with
 * every migration, real SIP-9 passkey signatures from software keys
 * (tests/fixtures/soft-passkey.mjs), and a scripted chain. Nothing reaches a
 * network, and nothing is signed for any network.
 *
 * Paths covered: combine, expiry, wrong signer, tampered bytes, replay,
 * cross-tenant, plus simulate-before-sign, the sponsor's refusals and the
 * one-submission race.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { MultiSigPublicKey } from '@mysten/sui/multisig';
import { Transaction } from '@mysten/sui/transactions';
import { fromBase64, toBase58, toBase64 } from '@mysten/sui/utils';
import { isValidTransactionSignature } from '@mysten/sui/verify';

import { migratedDb } from './helpers/store-db.mjs';
import { softPasskey } from './fixtures/soft-passkey.mjs';
import * as schema from '../lib/db/schema.ts';
import { buildBusinessMultisig } from '../lib/wallet/business-multisig.ts';
import { describeWalletTransaction } from '../lib/wallet/wallet-tx-describe.ts';
import { nominateWalletTx } from '../lib/server/sui-v2-builders.ts';
import {
  continueWalletSteps,
  detectMemberFunds,
  requestMigrationTransfer,
  requestWalletPayment,
  startBusinessWallet,
} from '../lib/server/business-wallet.ts';
import {
  cancelSigningRequest,
  readRequestForSigner,
  signingInbox,
  submitPartialSignature,
} from '../lib/server/wallet-signing.ts';
import { countLingeringSignaturesForStaff, expireSigningRequestsForStaff } from '../lib/server/wallet-signing-store.ts';

const CORE = '0x' + 'c0'.repeat(32);
const ACCOUNT = '0x' + 'ac'.repeat(32);
const OTHER_ACCOUNT = '0x' + 'ad'.repeat(32);
const CONFIG = '0x' + 'cf'.repeat(32);
const FEES = '0x' + 'fe'.repeat(32);
const REGISTRY = '0x' + 'ee'.repeat(32);
const USDC = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';
const CHAIN_ID = toBase58(new Uint8Array(32).fill(7));

const chainCfg = {
  corePackageId: CORE,
  complianceConfig: { objectId: CONFIG, initialSharedVersion: 3 },
  feeConfig: { objectId: FEES, initialSharedVersion: 4 },
  registry: { objectId: REGISTRY, initialSharedVersion: 5 },
  usdcType: USDC,
};
const expect = { corePackageId: CORE, accountId: ACCOUNT, complianceConfigId: CONFIG, feeConfigId: FEES, registryId: REGISTRY, usdcType: USDC };

const T0 = new Date('2026-10-25T08:00:00Z');

async function world({ simulateOk = true, sponsor: withSponsor = true } = {}) {
  const { client, db } = await migratedDb();
  for (const [id, email, org] of [
    ['u-founder', 'founder@acme.test', 'acme'],
    ['u-two', 'two@acme.test', 'acme'],
    ['u-three', 'three@acme.test', 'acme'],
    ['u-north', 'north@northwind.test', 'northwind'],
  ]) {
    await db.insert(schema.users).values({ id, email, name: id });
    await db.insert(schema.memberships).values({ id: `m-${id}`, userId: id, orgId: org, role: 'admin' });
  }
  const keys = { founder: softPasskey(), two: softPasskey(), three: softPasskey(), north: softPasskey() };

  const sponsorKey = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(0x5a));
  let nonce = 1;
  const sponsor = {
    address: sponsorKey.toSuiAddress(),
    gasFor: async () => ({ owner: sponsorKey.toSuiAddress(), price: 1000n, budget: 20_000_000n, epoch: 900n, chain: CHAIN_ID, nonce: nonce++ }),
    sign: async (bytes) => (await sponsorKey.signTransaction(bytes)).signature,
  };

  const executed = [];
  const simulated = [];
  const chain = {
    simulate: async (bytes) => {
      simulated.push(bytes);
      return simulateOk ? { success: true, balanceChanges: [{ address: '0x1', coinType: USDC, amount: '-5' }] } : { success: false, error: 'MoveAbort(E_NOT_THE_FOUNDER)' };
    },
    execute: async (bytes, signatures) => {
      executed.push({ bytes, signatures });
      const { TransactionDataBuilder } = await import('@mysten/sui/transactions');
      return { digest: TransactionDataBuilder.getDigestFromBytes(bytes), success: true };
    },
  };

  let now = T0;
  const notices = [];
  const signing = {
    db,
    chain,
    sponsor: withSponsor ? sponsor : null,
    expect,
    now: () => now,
    notifier: { notify: async (n) => (notices.push(n), { delivered: n.userIds, unreachable: [] }) },
  };
  const ctx = {
    signing,
    chain: chainCfg,
    account: { objectId: ACCOUNT, initialSharedVersion: 9 },
    validity: async () => ({ epoch: 900n, chain: CHAIN_ID, nonce: nonce++ }),
  };
  signing.onExecuted = async (request) => {
    await continueWalletSteps(ctx, request);
  };
  const owners = [
    { userId: 'u-founder', publicKey: keys.founder.publicKey },
    { userId: 'u-two', publicKey: keys.two.publicKey },
    { userId: 'u-three', publicKey: keys.three.publicKey },
  ];
  return {
    client,
    db,
    keys,
    sponsor,
    sponsorKey,
    chain,
    executed,
    simulated,
    signing,
    ctx,
    owners,
    notices,
    setNow: (d) => {
      now = d;
    },
  };
}

async function sign(passkey, view) {
  return (await passkey.keypair.signTransaction(fromBase64(view.transactionBytes))).signature;
}

async function startWallet(w) {
  const started = await startBusinessWallet(w.ctx, {
    orgId: 'acme',
    requestedBy: 'u-founder',
    founder: { userId: 'u-founder', passkeyPublicKey: w.keys.founder.publicKey },
    owners: w.owners,
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  return started.request;
}

async function nominateAndOpenRegistration(w) {
  const nominate = await startWallet(w);
  const done = await submitPartialSignature(w.signing, {
    orgId: 'acme',
    userId: 'u-founder',
    id: nominate.id,
    signature: await sign(w.keys.founder, nominate),
    digest: nominate.digest,
  });
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(done.request.status, 'executed');
  const inbox = await signingInbox(w.signing, { orgId: 'acme', userId: 'u-two' });
  assert.equal(inbox.length, 1, 'the registration request reaches every member once the nomination lands');
  return { nominate, register: inbox[0] };
}

/* ── The multisig ─────────────────────────────────────────────────────── */

test('the wallet is 2-of-N by default, and single-signer only when the business chose it', () => {
  const a = softPasskey();
  const b = softPasskey();
  const c = softPasskey();
  const wallet = buildBusinessMultisig({ members: [a, b, c].map((k, i) => ({ userId: `u${i}`, publicKey: k.publicKey })) });
  assert.equal(wallet.threshold, 2);
  assert.equal(wallet.singleSigner, false);
  assert.equal(wallet.members.length, 3);
  assert.equal(wallet.members[0].address, a.address, "a member's address is their own passkey address, which must be an owner");

  assert.throws(() => buildBusinessMultisig({ members: [{ userId: 'u0', publicKey: a.publicKey }] }), /chooses it/);
  const solo = buildBusinessMultisig({ members: [{ userId: 'u0', publicKey: a.publicKey }], singleSignerChosen: true });
  assert.equal(solo.singleSigner, true);
  assert.equal(solo.threshold, 1);

  // Weights [2,1,1] under threshold 2 are a one-person wallet, whatever the threshold says.
  assert.throws(
    () => buildBusinessMultisig({ members: [{ userId: 'u0', publicKey: a.publicKey, weight: 2 }, { userId: 'u1', publicKey: b.publicKey }, { userId: 'u2', publicKey: c.publicKey }], threshold: 2 }),
    /chooses it/,
  );
  assert.throws(() => buildBusinessMultisig({ members: [{ userId: 'u0', publicKey: a.publicKey }, { userId: 'u1', publicKey: a.publicKey }] }), /listed for two members/);
});

/* ── Combine ──────────────────────────────────────────────────────────── */

test('combine: the founder nominates, two of three members register, and the server submits once with the sponsor', async () => {
  const w = await world();
  const { nominate, register } = await nominateAndOpenRegistration(w);

  // The nomination: one signature, the founder's, plus the sponsor's.
  assert.equal(w.executed.length, 1);
  assert.equal(w.executed[0].signatures.length, 2);
  assert.equal(await isValidTransactionSignature(w.executed[0].bytes, w.executed[0].signatures[1], { address: w.sponsor.address }), true);
  const nominated = nominate.description.actions[0];
  assert.equal(nominated.type, 'nominate_wallet');

  // The registration names the same wallet the founder nominated, and it is the sender.
  const reg = register.description.actions[0];
  assert.equal(reg.type, 'register_wallet');
  assert.equal(reg.wallet, nominated.wallet);
  assert.equal(register.sender, nominated.wallet);
  assert.equal(reg.threshold, 2);
  assert.deepEqual(reg.members.map((m) => m.address).sort(), [w.keys.founder.address, w.keys.two.address, w.keys.three.address].sort());
  assert.equal(register.description.gas.owner, w.sponsor.address.toLowerCase());
  assert.equal(register.description.gas.fromAddressBalance, true);

  const first = await submitPartialSignature(w.signing, { orgId: 'acme', userId: 'u-two', id: register.id, signature: await sign(w.keys.two, register), digest: register.digest });
  assert.equal(first.ok, true);
  assert.equal(first.request.status, 'collecting');
  assert.equal(first.request.signedWeight, 1);
  assert.equal(w.executed.length, 1, 'one of two signatures submits nothing');

  const second = await submitPartialSignature(w.signing, { orgId: 'acme', userId: 'u-three', id: register.id, signature: await sign(w.keys.three, register), digest: register.digest });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.request.status, 'executed');
  assert.equal(w.executed.length, 2);

  const [walletSig, sponsorSig] = w.executed[1].signatures;
  const bytes = w.executed[1].bytes;
  assert.equal(toBase64(bytes), register.transactionBytes, 'the bytes submitted are the bytes signed');
  const ms = MultiSigPublicKey.fromPublicKeys({
    threshold: 2,
    publicKeys: [w.keys.founder, w.keys.two, w.keys.three].map((k) => ({ publicKey: k.keypair.getPublicKey(), weight: 1 })),
  });
  assert.equal(ms.toSuiAddress(), register.sender);
  assert.equal(await ms.verifyTransaction(bytes, walletSig), true, 'the combined signature is the multisig signing the bytes');
  assert.equal(await isValidTransactionSignature(bytes, sponsorSig, { address: w.sponsor.address }), true);

  // Every partial signature is gone once the request closed.
  assert.equal(await countLingeringSignaturesForStaff(w.db), 0);
  const rows = await w.db.select().from(schema.walletSigningSigners);
  assert.ok(rows.every((r) => r.signature === null));
  assert.ok(rows.filter((r) => r.signedAt).every((r) => /^[0-9a-f]{64}$/.test(r.signatureSha256)), 'a hash stays as evidence');
  await w.client.close();
});

test('two final signatures racing submit the transaction once', async () => {
  const w = await world();
  const { register } = await nominateAndOpenRegistration(w);
  const [a, b] = await Promise.all([
    submitPartialSignature(w.signing, { orgId: 'acme', userId: 'u-two', id: register.id, signature: await sign(w.keys.two, register), digest: register.digest }),
    submitPartialSignature(w.signing, { orgId: 'acme', userId: 'u-three', id: register.id, signature: await sign(w.keys.three, register), digest: register.digest }),
  ]);
  assert.equal(a.ok && b.ok, true);
  const rows = await w.db.select().from(schema.walletSigningRequests);
  assert.equal(w.executed.length, 2, `the nomination and one registration, never two ${JSON.stringify(rows.map((r) => [r.purpose, r.status, r.error]))} ${JSON.stringify([a.request.status, b.request.status])}`);
  await w.client.close();
});

test('combine: signatures arriving out of member order still make one valid multisig signature', async () => {
  const w = await world();
  const { register } = await nominateAndOpenRegistration(w);
  // The last member signs first, the first member second.
  await submitPartialSignature(w.signing, { orgId: 'acme', userId: 'u-three', id: register.id, signature: await sign(w.keys.three, register), digest: register.digest });
  const done = await submitPartialSignature(w.signing, { orgId: 'acme', userId: 'u-founder', id: register.id, signature: await sign(w.keys.founder, register), digest: register.digest });
  assert.equal(done.request.status, 'executed');
  const ms = MultiSigPublicKey.fromPublicKeys({
    threshold: 2,
    publicKeys: [w.keys.founder, w.keys.two, w.keys.three].map((k) => ({ publicKey: k.keypair.getPublicKey(), weight: 1 })),
  });
  assert.equal(await ms.verifyTransaction(w.executed[1].bytes, w.executed[1].signatures[0]), true);
  await w.client.close();
});

/* ── Expiry ───────────────────────────────────────────────────────────── */

test('expiry: a request older than its expiry takes no signature, and the sweep clears what it held', async () => {
  const w = await world();
  const { register } = await nominateAndOpenRegistration(w);
  assert.ok(new Date(register.expiresAt).getTime() - T0.getTime() <= 24 * 3600_000, 'at most 24 hours');

  const ok = await submitPartialSignature(w.signing, { orgId: 'acme', userId: 'u-two', id: register.id, signature: await sign(w.keys.two, register), digest: register.digest });
  assert.equal(ok.ok, true);
  const held = await w.db.select().from(schema.walletSigningSigners);
  assert.ok(held.some((r) => r.signature !== null), 'held while collecting');

  w.setNow(new Date(new Date(register.expiresAt).getTime() + 1));
  const late = await submitPartialSignature(w.signing, { orgId: 'acme', userId: 'u-three', id: register.id, signature: await sign(w.keys.three, register), digest: register.digest });
  assert.equal(late.ok, false);
  assert.equal(late.status, 410);
  assert.equal(w.executed.length, 1, 'nothing more was submitted');
  assert.equal(await countLingeringSignaturesForStaff(w.db), 0);
  assert.deepEqual(await signingInbox(w.signing, { orgId: 'acme', userId: 'u-three' }), []);
  await w.client.close();
});

test('expiry: the sweep closes every expired request in every org and clears its signatures', async () => {
  const w = await world();
  const { register } = await nominateAndOpenRegistration(w);
  await submitPartialSignature(w.signing, { orgId: 'acme', userId: 'u-two', id: register.id, signature: await sign(w.keys.two, register), digest: register.digest });
  assert.equal(await expireSigningRequestsForStaff(w.db, T0), 0, 'nothing has expired yet');
  assert.equal(await expireSigningRequestsForStaff(w.db, new Date(T0.getTime() + 25 * 3600_000)), 1);
  const [row] = await w.db.select().from(schema.walletSigningRequests).where((await import('drizzle-orm')).eq(schema.walletSigningRequests.id, register.id));
  assert.equal(row.status, 'expired');
  assert.equal(await countLingeringSignaturesForStaff(w.db), 0);
  await w.client.close();
});

/* ── Wrong signer ─────────────────────────────────────────────────────── */

test('wrong signer: someone not on the request, or a signer using another key, is refused', async () => {
  const w = await world();
  const { register } = await nominateAndOpenRegistration(w);

  // A member of the same org who is not a signer of the nomination's request...
  const nominateRows = await w.db.select().from(schema.walletSigningRequests);
  const nominate = nominateRows.find((r) => r.purpose === 'nominate_wallet');
  const notMine = await submitPartialSignature(w.signing, { orgId: 'acme', userId: 'u-two', id: nominate.id, signature: 'AA==', digest: nominate.txDigest });
  assert.equal(notMine.ok, false);
  assert.equal(notMine.code, 'not_a_signer');

  // ...and a signer presenting a signature made by another member's key.
  const borrowed = await submitPartialSignature(w.signing, { orgId: 'acme', userId: 'u-two', id: register.id, signature: await sign(w.keys.three, register), digest: register.digest });
  assert.equal(borrowed.ok, false);
  assert.equal(borrowed.code, 'bad_signature');

  // A key outside the wallet altogether.
  const stranger = await submitPartialSignature(w.signing, { orgId: 'acme', userId: 'u-two', id: register.id, signature: await sign(w.keys.north, register), digest: register.digest });
  assert.equal(stranger.code, 'bad_signature');

  // A whole multisig signature where one member's part belongs.
  const ms = MultiSigPublicKey.fromPublicKeys({ threshold: 1, publicKeys: [{ publicKey: w.keys.two.keypair.getPublicKey(), weight: 1 }] });
  const whole = ms.combinePartialSignatures([await sign(w.keys.two, register)]);
  const asWhole = await submitPartialSignature(w.signing, { orgId: 'acme', userId: 'u-two', id: register.id, signature: whole, digest: register.digest });
  assert.equal(asWhole.code, 'bad_signature');
  assert.equal(w.executed.length, 1);
  await w.client.close();
});

/* ── Tampered bytes ───────────────────────────────────────────────────── */

test('tampered bytes: a signature over other bytes, or a different digest, is refused', async () => {
  const w = await world();
  const { register } = await nominateAndOpenRegistration(w);

  // The signer was shown (or a compromised client built) a different transaction.
  const gas = await w.sponsor.gasFor();
  const other = await nominateWalletTx(chainCfg, {
    founder: w.keys.two.address,
    account: { objectId: ACCOUNT, initialSharedVersion: 9 },
    wallet: '0x' + '66'.repeat(32),
    singleSigner: false,
    gas,
  });
  const overOther = (await w.keys.two.keypair.signTransaction(other)).signature;
  const tampered = await submitPartialSignature(w.signing, { orgId: 'acme', userId: 'u-two', id: register.id, signature: overOther, digest: register.digest });
  assert.equal(tampered.ok, false);
  assert.equal(tampered.code, 'bad_signature');

  const wrongDigest = await submitPartialSignature(w.signing, { orgId: 'acme', userId: 'u-two', id: register.id, signature: await sign(w.keys.two, register), digest: 'GZ' + register.digest.slice(2) });
  assert.equal(wrongDigest.code, 'digest_mismatch');

  // The view is decoded from the stored bytes, so it cannot drift from them.
  const view = await readRequestForSigner(w.signing, { orgId: 'acme', userId: 'u-two', id: register.id });
  assert.deepEqual(view.request.description, describeWalletTransaction(fromBase64(view.request.transactionBytes), expect));
  assert.equal(view.request.digest, register.digest);
  assert.equal(view.request.you.mustSign, true);
  await w.client.close();
});

/* ── Replay ───────────────────────────────────────────────────────────── */

test('replay: a second signature from one signer, a signature moved to another request, and a signature after execution are refused', async () => {
  const w = await world();
  const { nominate, register } = await nominateAndOpenRegistration(w);

  const sig = await sign(w.keys.two, register);
  const once = await submitPartialSignature(w.signing, { orgId: 'acme', userId: 'u-two', id: register.id, signature: sig, digest: register.digest });
  assert.equal(once.ok, true);
  const twice = await submitPartialSignature(w.signing, { orgId: 'acme', userId: 'u-two', id: register.id, signature: sig, digest: register.digest });
  assert.equal(twice.code, 'already_signed', 'one signer cannot count twice');
  assert.equal(w.executed.length, 1);

  // The founder's signature on the executed nomination, replayed.
  const founderSig = await sign(w.keys.founder, nominate);
  const again = await submitPartialSignature(w.signing, { orgId: 'acme', userId: 'u-founder', id: nominate.id, signature: founderSig, digest: nominate.digest });
  assert.equal(again.code, 'closed');
  // ...and moved onto the registration.
  const moved = await submitPartialSignature(w.signing, { orgId: 'acme', userId: 'u-founder', id: register.id, signature: founderSig, digest: register.digest });
  assert.equal(moved.code, 'bad_signature');
  assert.equal(w.executed.length, 1);
  await w.client.close();
});

/* ── Cross-tenant ─────────────────────────────────────────────────────── */

test("cross-tenant: another org's request reads as absent, takes no signature, and is not in their inbox", async () => {
  const w = await world();
  const { register } = await nominateAndOpenRegistration(w);

  const read = await readRequestForSigner(w.signing, { orgId: 'northwind', userId: 'u-north', id: register.id });
  assert.equal(read.status, 404);
  // Even naming a real signer's user id under the other org.
  const asTwo = await readRequestForSigner(w.signing, { orgId: 'northwind', userId: 'u-two', id: register.id });
  assert.equal(asTwo.status, 404);
  const signed = await submitPartialSignature(w.signing, { orgId: 'northwind', userId: 'u-two', id: register.id, signature: await sign(w.keys.two, register), digest: register.digest });
  assert.equal(signed.status, 404);
  assert.deepEqual(await signingInbox(w.signing, { orgId: 'northwind', userId: 'u-two' }), []);
  const cancel = await cancelSigningRequest(w.signing, { orgId: 'northwind', userId: 'u-north', id: register.id });
  assert.equal(cancel.status, 404);

  // A transaction naming another org's account is refused when it is opened.
  const otherCtx = { ...w.ctx, account: { objectId: OTHER_ACCOUNT, initialSharedVersion: 9 } };
  const foreign = await startBusinessWallet(otherCtx, {
    orgId: 'acme',
    requestedBy: 'u-founder',
    founder: { userId: 'u-founder', passkeyPublicKey: w.keys.founder.publicKey },
    owners: w.owners,
  });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.code, 'wrong_object');
  await w.client.close();
});

/* ── Simulate before sign, and the sponsor ───────────────────────────── */

test('nobody is asked to sign bytes that do not simulate', async () => {
  const w = await world({ simulateOk: false });
  const started = await startBusinessWallet(w.ctx, {
    orgId: 'acme',
    requestedBy: 'u-founder',
    founder: { userId: 'u-founder', passkeyPublicKey: w.keys.founder.publicKey },
    owners: w.owners,
  });
  assert.equal(started.ok, false);
  assert.equal(started.code, 'simulation_failed');
  assert.equal((await w.db.select().from(schema.walletSigningRequests)).length, 0);
  assert.equal(w.notices.length, 0, 'and nobody was messaged');
  await w.client.close();
});

test('without a sponsor no wallet request is opened: the wallet holds no SUI', async () => {
  const w = await world({ sponsor: false });
  const started = await startBusinessWallet(w.ctx, {
    orgId: 'acme',
    requestedBy: 'u-founder',
    founder: { userId: 'u-founder', passkeyPublicKey: w.keys.founder.publicKey },
    owners: w.owners,
  });
  assert.equal(started.ok, false);
  assert.equal(started.status, 503);
  await w.client.close();
});

test('one open wallet creation per org at a time', async () => {
  const w = await world();
  await startWallet(w);
  const second = await startBusinessWallet(w.ctx, {
    orgId: 'acme',
    requestedBy: 'u-founder',
    founder: { userId: 'u-founder', passkeyPublicKey: w.keys.founder.publicKey },
    owners: w.owners,
  });
  assert.equal(second.ok, false);
  assert.equal(second.code, 'request_open');
  await w.client.close();
});

/* ── Payments: the screen comes from the PTB ─────────────────────────── */

async function registeredWallet(w) {
  const wallet = buildBusinessMultisig({ members: w.owners });
  return { wallet, members: { multisigPublicKey: wallet.multisigPublicKey, members: wallet.members.map((m) => ({ userId: m.userId, publicKey: m.suiPublicKey, weight: m.weight })) } };
}

const bytes32 = (b) => new Uint8Array(32).fill(b);

function payment(overrides = {}) {
  return {
    paymentRef: bytes32(1),
    recipient: '0x' + '77'.repeat(32),
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
    ...overrides,
  };
}

test('a wallet payment shows payee, amount, asset and the fee bound read from its bytes, and expires with its quote', async () => {
  const w = await world();
  const { wallet, members } = await registeredWallet(w);
  const opened = await requestWalletPayment(w.ctx, { orgId: 'acme', requestedBy: 'u-two', wallet: members, payment: payment() });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  const d = opened.request.description;
  assert.deepEqual(d.actions.map((a) => a.type), ['withdraw', 'open_intent', 'pay_intent', 'anchor_receipt', 'delete_intent']);
  assert.equal(d.sender, wallet.address);
  assert.equal(d.actions[0].amountMinor, '250250000', 'the wallet withdraws principal + max_fee from its own address balance');
  assert.equal(d.actions[1].recipient, '0x' + '77'.repeat(32));
  assert.equal(d.actions[1].amountMinor, '250000000');
  assert.equal(d.actions[1].asset, USDC);
  assert.equal(d.actions[2].maxFeeMinor, '250000');
  assert.equal(new Date(opened.request.expiresAt).getTime(), T0.getTime() + 5 * 60_000, 'the request dies with the quote');
  assert.equal(w.notices.length, 1);

  // The same payment reference cannot be asked for twice while open.
  const again = await requestWalletPayment(w.ctx, { orgId: 'acme', requestedBy: 'u-two', wallet: members, payment: payment() });
  assert.equal(again.code, 'request_open');

  const stale = await requestWalletPayment(w.ctx, { orgId: 'acme', requestedBy: 'u-two', wallet: members, payment: payment({ paymentRef: bytes32(9), settleByMs: BigInt(T0.getTime() - 1) }) });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'quote_expired');

  const crossChain = await requestWalletPayment(w.ctx, { orgId: 'acme', requestedBy: 'u-two', wallet: members, payment: payment({ paymentRef: bytes32(8), kind: 3 }) });
  assert.equal(crossChain.code, 'cross_chain_not_built');
  await w.client.close();
});

/* ── Migration: each member's own plain transfer ─────────────────────── */

test('migration: funds left in member wallets are found, and each member moves theirs alone, gasless', async () => {
  const w = await world();
  const { wallet } = await registeredWallet(w);
  const balances = new Map([
    [w.keys.two.address, { coinMinor: 3_000_000n, addressBalanceMinor: 2_000_000n }],
    [w.keys.three.address, { coinMinor: 0n, addressBalanceMinor: 0n }],
  ]);
  const found = await detectMemberFunds(async (address) => balances.get(address) ?? { coinMinor: 0n, addressBalanceMinor: 0n }, [
    { userId: 'u-two', address: w.keys.two.address },
    { userId: 'u-three', address: w.keys.three.address },
  ]);
  assert.deepEqual(found.map((f) => [f.userId, f.usdcMinor]), [['u-two', 5_000_000n]]);

  const coin = { objectId: '0x' + '3c'.repeat(32), version: 12, digest: toBase58(new Uint8Array(32).fill(1)) };
  const opened = await requestMigrationTransfer(w.ctx, {
    orgId: 'acme',
    member: { userId: 'u-two', passkeyPublicKey: w.keys.two.publicKey },
    businessWallet: wallet.address,
    coins: [coin],
    addressBalanceMinor: 2_000_000n,
    gasless: true,
  });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  const d = opened.request.description;
  assert.equal(d.sender, w.keys.two.address);
  assert.equal(d.gas.price, '0');
  assert.equal(d.gas.owner, w.keys.two.address, 'gasless: nobody else pays');
  const send = d.actions.at(-1);
  assert.equal(send.type, 'send_funds');
  assert.equal(send.recipient, wallet.address);
  assert.equal(opened.request.signers.length, 1, 'the member signs alone');

  const done = await submitPartialSignature(w.signing, { orgId: 'acme', userId: 'u-two', id: opened.request.id, signature: await sign(w.keys.two, opened.request), digest: opened.request.digest });
  assert.equal(done.ok, true);
  assert.equal(done.request.status, 'executed');
  assert.equal(w.executed.at(-1).signatures.length, 1, 'no sponsor signature on a gasless transfer');

  // Another member cannot move this member's funds, and a transfer elsewhere is not a migration.
  const elsewhere = await requestMigrationTransfer(w.ctx, {
    orgId: 'acme',
    member: { userId: 'u-three', passkeyPublicKey: w.keys.three.publicKey },
    businessWallet: w.keys.three.address,
    coins: [],
    addressBalanceMinor: 1_000_000n,
    gasless: true,
  });
  assert.equal(elsewhere.code, 'same_wallet');
  await w.client.close();
});

test('a cancelled request clears its signatures', async () => {
  const w = await world();
  const { register } = await nominateAndOpenRegistration(w);
  await submitPartialSignature(w.signing, { orgId: 'acme', userId: 'u-two', id: register.id, signature: await sign(w.keys.two, register), digest: register.digest });
  const cancelled = await cancelSigningRequest(w.signing, { orgId: 'acme', userId: 'u-founder', id: register.id });
  assert.equal(cancelled.ok, true);
  assert.equal(await countLingeringSignaturesForStaff(w.db), 0);
  await w.client.close();
});

test('the transaction bytes decode the same way on any device', async () => {
  const w = await world();
  const nominate = await startWallet(w);
  const data = Transaction.from(fromBase64(nominate.transactionBytes)).getData();
  assert.equal(data.gasData.payment.length, 0, 'no gas coin in any wallet transaction');
  assert.equal(data.expiration.$kind, 'ValidDuring');
  assert.equal(nominate.bytesHash.length, 64);
  await w.client.close();
});

/* ── The message, and the routes' scoping ─────────────────────────────── */

test('the WhatsApp request says what the bytes do and carries no link, code or bytes', async () => {
  const { walletSignatureMessage } = await import('../lib/server/approval-requests.ts');
  const w = await world();
  const { register } = await nominateAndOpenRegistration(w);
  const text = walletSignatureMessage({
    orgName: 'Acme Trading',
    purpose: 'register_wallet',
    description: register.description,
    threshold: 2,
    signerCount: 3,
    expiresAt: new Date(register.expiresAt),
    now: T0,
  });
  assert.match(text, /register the business wallet 0x[0-9a-f]{4}…[0-9a-f]{4}: 2 of 3 owners sign/);
  assert.match(text, new RegExp(register.bytesHash.slice(0, 8)));
  assert.doesNotMatch(text, /https?:\/\//);
  assert.ok(!text.includes(register.transactionBytes.slice(0, 24)), 'no transaction bytes');
  assert.match(text, /expires in 24 hours/);
  await w.client.close();
});

test('every wallet route takes the org from the session, never the request', async () => {
  const { readFile } = await import('node:fs/promises');
  const front = await readFile(new URL('../lib/server/wallet-route.ts', import.meta.url), 'utf8');
  assert.match(front, /requireSessionAccount\(auth\.session\)/);
  for (const route of [
    'app/api/wallet/business/route.ts',
    'app/api/wallet/signing-requests/route.ts',
    'app/api/wallet/signing-requests/[id]/route.ts',
    'app/api/wallet/signing-requests/[id]/signatures/route.ts',
    'app/api/wallet/migration/route.ts',
  ]) {
    const source = await readFile(new URL(`../${route}`, import.meta.url), 'utf8');
    assert.match(source, /walletRoute\(request\)/, `${route} goes through walletRoute`);
    assert.doesNotMatch(source, /body\.(orgId|accountId|userId)|searchParams/, `${route} reads no org, account or user from the request`);
  }
  const deps = await readFile(new URL('../lib/server/wallet-deps.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(deps.replace(/\/\*[\s\S]*?\*\//g, ''), /SPLASH_BUSINESS_ACCOUNT_ID|resolveBusinessAccountId/, 'no single-tenant fallback account');
});
