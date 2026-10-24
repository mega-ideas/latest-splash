/**
 * Sky's answers of 25 Oct on the Business Splash Wallet (v2 §4.1):
 *
 *   (3) STAFF may ask the owners to approve a payment (for example one over
 *       their spending rule), not only owners. The ask is scoped to the org,
 *       to the staff member's own payment, and audited; an owner turns it
 *       into the quorum's signing request.
 *   (4) Migration moves USDC only. A staff member may move the USDC in their
 *       own passkey wallet into the business wallet only once the highest
 *       authority has signed off: an owner, or a person in charge an owner
 *       appointed. The appointment is an off-chain role an owner grants and
 *       revokes, and every grant, revocation and sign-off is audited.
 *   (1) The hardware 2-of-3 check on testnet is run by ONE approver (Sky)
 *       with his own authenticators.
 *
 * PGlite with every migration, software passkeys and the model chain of
 * tests/fixtures/wallet-world.mjs. Nothing reaches a network.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { eq } from 'drizzle-orm';
import { fromBase64, normalizeSuiAddress } from '@mysten/sui/utils';

import { softPasskey } from './fixtures/soft-passkey.mjs';
import { ACCOUNT, OTHER_ACCOUNT, T0, USDC, world } from './fixtures/wallet-world.mjs';
import * as schema from '../lib/db/schema.ts';
import { buildBusinessMultisig } from '../lib/wallet/business-multisig.ts';
import { startBusinessWallet } from '../lib/server/business-wallet.ts';
import { signingInbox, submitPartialSignature } from '../lib/server/wallet-signing.ts';
import {
  appointPersonInCharge,
  highestAuthority,
  listAuthorityEvents,
  listPersonsInCharge,
  migrationClearance,
  prepareMigrationSignOff,
  revokePersonInCharge,
  signMigrationSignOff,
} from '../lib/server/wallet-authority.ts';
import {
  acceptApprovalAsk,
  askOwnersToApprove,
  cancelApprovalAsk,
  declineApprovalAsk,
  listApprovalAsks,
  settleApprovalAsks,
} from '../lib/server/payment-approval-asks.ts';

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
  const done = await signBy(w, register, 'two', 'three');
  assert.equal(done.status, 'executed');
  const wallet = buildBusinessMultisig({ members: w.owners });
  return { wallet, members: { multisigPublicKey: wallet.multisigPublicKey, members: wallet.members.map((m) => ({ userId: m.userId, publicKey: m.suiPublicKey, weight: m.weight })) } };
}

/** acme gains a staff member (maker), an approver (checker) and a viewer; northwind a staff member. */
async function withStaff(w) {
  const staff = softPasskey();
  const pic = softPasskey();
  const outsider = softPasskey();
  for (const [id, email, org, role] of [
    ['u-staff', 'staff@acme.test', 'acme', 'maker'],
    ['u-pic', 'pic@acme.test', 'acme', 'checker'],
    ['u-viewer', 'viewer@acme.test', 'acme', 'viewer'],
    ['u-north-staff', 'staff@northwind.test', 'northwind', 'maker'],
  ]) {
    await w.db.insert(schema.users).values({ id, email, name: id });
    await w.db.insert(schema.memberships).values({ id: `m-${id}`, userId: id, orgId: org, role });
  }
  return { staff, pic, outsider };
}

const INTENT = normalizeSuiAddress('0x' + '99'.repeat(32));
const PAYEE = normalizeSuiAddress('0x' + '77'.repeat(32));
const HASH = '04'.repeat(32);
const BLOB = Buffer.from('blob-1').toString('hex');

function intentBy(maker, overrides = {}) {
  return {
    id: INTENT,
    initialSharedVersion: 7,
    account: ACCOUNT,
    maker: normalizeSuiAddress(maker),
    recipient: PAYEE,
    beneficiaryRef: '',
    amountMinor: 12_500_000_000n,
    kind: 1,
    targetCurrency: 'USDC',
    fxRateUsdLocal: 1_000_000n,
    expiresAtMs: BigInt(T0.getTime() + 3 * 24 * 3600_000),
    status: 0,
    asset: USDC,
    ...overrides,
  };
}

/* ── (3) Staff ask the owners to approve ──────────────────────────────── */

test('(3) a staff member asks the owners to approve their own payment; owners see every ask, staff only their own', async () => {
  const w = await world();
  const { staff } = await withStaff(w);
  w.model.addIntent(intentBy(staff.address));

  const asked = await askOwnersToApprove({ db: w.db, ctx: w.ctx }, {
    orgId: 'acme', userId: 'u-staff', intentId: INTENT, contentHash: HASH, walrusBlobId: BLOB, requesterAddresses: [staff.address], note: 'Over my rule: the supplier invoice is 12,500 USDC',
  });
  assert.equal(asked.ok, true, JSON.stringify(asked));
  assert.equal(asked.ask.status, 'open');
  assert.equal(asked.ask.intent.recipient, PAYEE, 'the ask shows what the chain says, not what the client sent');
  assert.equal(asked.ask.intent.amountMinor, '12500000000');

  // One open ask per payment.
  const again = await askOwnersToApprove({ db: w.db, ctx: w.ctx }, { orgId: 'acme', userId: 'u-staff', intentId: INTENT, contentHash: HASH, walrusBlobId: BLOB, requesterAddresses: [staff.address] });
  assert.equal(again.ok, false);
  assert.equal(again.code, 'ask_open');

  const forOwner = await listApprovalAsks(w.db, { orgId: 'acme', userId: 'u-two' });
  assert.equal(forOwner.length, 1);
  const forStaff = await listApprovalAsks(w.db, { orgId: 'acme', userId: 'u-staff' });
  assert.equal(forStaff.length, 1);
  const forViewer = await listApprovalAsks(w.db, { orgId: 'acme', userId: 'u-viewer' });
  assert.equal(forViewer.length, 0, 'someone who neither asked nor approves sees none');
  const forNorthwind = await listApprovalAsks(w.db, { orgId: 'northwind', userId: 'u-north' });
  assert.equal(forNorthwind.length, 0, 'another business sees nothing');

  const events = await listAuthorityEvents(w.db, 'acme');
  assert.ok(events.some((e) => e.action === 'approval_requested' && e.actorUserId === 'u-staff' && e.ref === asked.ask.id));
  await w.client.close();
});

test("(3) a staff member cannot ask about another business's payment, someone else's payment, or as a viewer", async () => {
  const w = await world();
  const { staff, outsider } = await withStaff(w);
  w.model.addIntent(intentBy(outsider.address));
  const deps = { db: w.db, ctx: w.ctx };
  const base = { intentId: INTENT, contentHash: HASH, walrusBlobId: BLOB };

  const notMine = await askOwnersToApprove(deps, { ...base, orgId: 'acme', userId: 'u-staff', requesterAddresses: [staff.address] });
  assert.equal(notMine.ok, false);
  assert.equal(notMine.status, 403);
  assert.equal(notMine.code, 'not_your_payment');

  const viewer = await askOwnersToApprove(deps, { ...base, orgId: 'acme', userId: 'u-viewer', requesterAddresses: [outsider.address] });
  assert.equal(viewer.status, 403);

  // Another business's intent reads as absent.
  w.model.addIntent(intentBy(staff.address, { id: '0x' + '98'.repeat(32), account: OTHER_ACCOUNT }));
  const foreign = await askOwnersToApprove(deps, { ...base, intentId: '0x' + '98'.repeat(32), orgId: 'acme', userId: 'u-staff', requesterAddresses: [staff.address] });
  assert.equal(foreign.status, 404);

  // A payment that is no longer waiting, or has expired, cannot be asked about.
  w.model.addIntent(intentBy(staff.address, { id: '0x' + '97'.repeat(32), status: 1 }));
  const paid = await askOwnersToApprove(deps, { ...base, intentId: '0x' + '97'.repeat(32), orgId: 'acme', userId: 'u-staff', requesterAddresses: [staff.address] });
  assert.equal(paid.code, 'intent_not_open');
  w.model.addIntent(intentBy(staff.address, { id: '0x' + '96'.repeat(32), expiresAtMs: BigInt(T0.getTime() - 1) }));
  const lapsed = await askOwnersToApprove(deps, { ...base, intentId: '0x' + '96'.repeat(32), orgId: 'acme', userId: 'u-staff', requesterAddresses: [staff.address] });
  assert.equal(lapsed.code, 'intent_expired');

  // A malformed audit reference is refused before anything is stored.
  w.model.addIntent(intentBy(staff.address, { id: '0x' + '95'.repeat(32) }));
  const bad = await askOwnersToApprove(deps, { ...base, contentHash: 'zz', intentId: '0x' + '95'.repeat(32), orgId: 'acme', userId: 'u-staff', requesterAddresses: [staff.address] });
  assert.equal(bad.status, 400);
  assert.equal((await w.db.select().from(schema.walletApprovalAsks)).length, 0);
  await w.client.close();
});

test('(3) an owner accepts the ask: the quorum is asked to pay exactly that payment, and the ask closes when it lands', async () => {
  const w = await world();
  const { staff } = await withStaff(w);
  const { members } = await registered(w);
  w.model.addIntent(intentBy(staff.address));
  const deps = { db: w.db, ctx: w.ctx, now: () => T0 };
  const asked = await askOwnersToApprove(deps, { orgId: 'acme', userId: 'u-staff', intentId: INTENT, contentHash: HASH, walrusBlobId: BLOB, requesterAddresses: [staff.address] });

  // Staff cannot accept their own ask; an approver (checker) is not an owner either.
  const self = await acceptApprovalAsk(deps, { orgId: 'acme', userId: 'u-staff', askId: asked.ask.id, mode: 'wallet_pays', wallet: members, maxFeeMinor: 250_000n, settleByMs: BigInt(T0.getTime() + 300_000) });
  assert.equal(self.status, 403);
  const foreign = await acceptApprovalAsk(deps, { orgId: 'northwind', userId: 'u-north', askId: asked.ask.id, mode: 'wallet_pays', wallet: members, maxFeeMinor: 250_000n, settleByMs: BigInt(T0.getTime() + 300_000) });
  assert.equal(foreign.status, 404, "another business's owner cannot see it");

  const accepted = await acceptApprovalAsk(deps, { orgId: 'acme', userId: 'u-two', askId: asked.ask.id, mode: 'wallet_pays', wallet: members, maxFeeMinor: 250_000n, settleByMs: BigInt(T0.getTime() + 300_000) });
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.equal(accepted.ask.status, 'signing');
  const request = accepted.request;
  assert.equal(request.purpose, 'wallet_payment');
  assert.equal(request.description.actions[1].intent.intentId, INTENT);
  assert.equal(request.description.actions[1].intent.recipient, PAYEE);

  const done = await signBy(w, request, 'two', 'three');
  assert.equal(done.status, 'executed');
  const [row] = await w.db.select().from(schema.walletSigningRequests).where(eq(schema.walletSigningRequests.id, request.id));
  await settleApprovalAsks(w.db, { ...row, orgId: 'acme' });
  const [after] = await listApprovalAsks(w.db, { orgId: 'acme', userId: 'u-staff' });
  assert.equal(after.status, 'approved');

  const actions = (await listAuthorityEvents(w.db, 'acme')).map((e) => e.action);
  assert.ok(actions.includes('approval_accepted'));
  assert.ok(actions.includes('approval_completed'));
  await w.client.close();
});

test('(3) only the person who asked withdraws an ask; an owner declines one; nobody else can do either', async () => {
  const w = await world();
  const { staff } = await withStaff(w);
  w.model.addIntent(intentBy(staff.address));
  const deps = { db: w.db, ctx: w.ctx, now: () => T0 };
  const asked = await askOwnersToApprove(deps, { orgId: 'acme', userId: 'u-staff', intentId: INTENT, contentHash: HASH, walrusBlobId: BLOB, requesterAddresses: [staff.address] });

  const byOwner = await cancelApprovalAsk(w.db, { orgId: 'acme', userId: 'u-two', askId: asked.ask.id });
  assert.equal(byOwner.status, 403, 'an owner declines; withdrawing is the asker’s');
  const byStaff = await declineApprovalAsk(w.db, { orgId: 'acme', userId: 'u-staff', askId: asked.ask.id });
  assert.equal(byStaff.status, 403, 'staff cannot decline');
  const foreign = await declineApprovalAsk(w.db, { orgId: 'northwind', userId: 'u-north', askId: asked.ask.id });
  assert.equal(foreign.status, 404);

  const declined = await declineApprovalAsk(w.db, { orgId: 'acme', userId: 'u-three', askId: asked.ask.id, reason: 'Pay it next week' });
  assert.equal(declined.ok, true);
  const [after] = await listApprovalAsks(w.db, { orgId: 'acme', userId: 'u-staff' });
  assert.equal(after.status, 'declined');
  assert.equal(after.decidedBy, 'u-three');

  // Declined frees the payment for a fresh ask; the asker can withdraw that one.
  const second = await askOwnersToApprove(deps, { orgId: 'acme', userId: 'u-staff', intentId: INTENT, contentHash: HASH, walrusBlobId: BLOB, requesterAddresses: [staff.address] });
  assert.equal(second.ok, true);
  const withdrawn = await cancelApprovalAsk(w.db, { orgId: 'acme', userId: 'u-staff', askId: second.ask.id });
  assert.equal(withdrawn.ok, true);
  const actions = (await listAuthorityEvents(w.db, 'acme')).map((e) => e.action);
  assert.ok(actions.includes('approval_declined') && actions.includes('approval_withdrawn'));
  await w.client.close();
});

/* ── (4) The person in charge ─────────────────────────────────────────── */

test('(4) an owner appoints and revokes a person in charge; nobody else can; every change is audited', async () => {
  const w = await world();
  await withStaff(w);
  const now = () => T0;

  const byStaff = await appointPersonInCharge(w.db, { orgId: 'acme', actorUserId: 'u-staff', userId: 'u-pic', now });
  assert.equal(byStaff.status, 403);
  const foreign = await appointPersonInCharge(w.db, { orgId: 'acme', actorUserId: 'u-founder', userId: 'u-north-staff', now });
  assert.equal(foreign.status, 404, 'a member of another business cannot be appointed');
  const owner = await appointPersonInCharge(w.db, { orgId: 'acme', actorUserId: 'u-founder', userId: 'u-two', now });
  assert.equal(owner.code, 'already_an_owner');
  const viewer = await appointPersonInCharge(w.db, { orgId: 'acme', actorUserId: 'u-founder', userId: 'u-viewer', now });
  assert.equal(viewer.code, 'viewer_cannot_be_in_charge');

  const appointed = await appointPersonInCharge(w.db, { orgId: 'acme', actorUserId: 'u-founder', userId: 'u-pic', now });
  assert.equal(appointed.ok, true, JSON.stringify(appointed));
  assert.equal(await highestAuthority(w.db, 'acme', 'u-pic'), 'person_in_charge');
  assert.equal(await highestAuthority(w.db, 'acme', 'u-founder'), 'owner');
  assert.equal(await highestAuthority(w.db, 'acme', 'u-staff'), null);
  assert.equal(await highestAuthority(w.db, 'northwind', 'u-pic'), null, 'the role is per business');
  const twice = await appointPersonInCharge(w.db, { orgId: 'acme', actorUserId: 'u-two', userId: 'u-pic', now });
  assert.equal(twice.code, 'already_appointed');
  assert.deepEqual((await listPersonsInCharge(w.db, 'acme')).map((p) => [p.userId, p.grantedBy]), [['u-pic', 'u-founder']]);

  const revokeByPic = await revokePersonInCharge(w.db, { orgId: 'acme', actorUserId: 'u-pic', userId: 'u-pic', now });
  assert.equal(revokeByPic.status, 403);
  const revoked = await revokePersonInCharge(w.db, { orgId: 'acme', actorUserId: 'u-two', userId: 'u-pic', now });
  assert.equal(revoked.ok, true);
  assert.equal(await highestAuthority(w.db, 'acme', 'u-pic'), null);

  const events = await listAuthorityEvents(w.db, 'acme');
  assert.deepEqual(
    events.filter((e) => e.subjectUserId === 'u-pic').map((e) => [e.action, e.actorUserId]),
    [['person_in_charge_appointed', 'u-founder'], ['person_in_charge_revoked', 'u-two']],
  );
  // The audit trail cannot be rewritten.
  await assert.rejects(w.client.exec(`UPDATE wallet_authority_events SET actor_user_id = 'u-staff'`));
  await assert.rejects(w.client.exec(`DELETE FROM wallet_authority_events`));
  await w.client.close();
});

/* ── (4) Staff migration needs the highest authority's sign-off ───────── */

const WALLET = normalizeSuiAddress('0x' + 'b0'.repeat(32));

async function signOff(w, { by, passkey, member, from, to = WALLET, now = () => T0 }) {
  const prepared = await prepareMigrationSignOff(w.db, { orgId: 'acme', actorUserId: by, memberUserId: member, fromAddress: from, toWallet: to, now });
  if (!prepared.ok) return prepared;
  const { signature } = await passkey.keypair.signPersonalMessage(new TextEncoder().encode(prepared.signOff.message));
  return signMigrationSignOff(w.db, { orgId: 'acme', actorUserId: by, id: prepared.signOff.id, signature, signerAddress: passkey.address, now });
}

test('(4) a staff member moves their USDC only after an owner or the person in charge signs off', async () => {
  const w = await world();
  const { staff, pic } = await withStaff(w);
  const now = () => T0;
  const clear = (userId, from = staff.address, to = WALLET, at = now) => migrationClearance(w.db, { orgId: 'acme', userId, fromAddress: from, toWallet: to, now: at });

  const before = await clear('u-staff');
  assert.equal(before.ok, false);
  assert.equal(before.code, 'sign_off_needed');
  // An owner moves their own without one: they are the highest authority.
  assert.equal((await clear('u-two', w.keys.two.address)).ok, true);

  // The owner's sign-off: their passkey signs a statement naming the member,
  // the wallet the USDC leaves and the business wallet it goes to.
  const prepared = await prepareMigrationSignOff(w.db, { orgId: 'acme', actorUserId: 'u-two', memberUserId: 'u-staff', fromAddress: staff.address, toWallet: WALLET, now });
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  for (const part of ['USDC', staff.address, WALLET, 'u-staff', 'acme']) assert.ok(prepared.signOff.message.includes(part), part);
  const { signature } = await w.keys.two.keypair.signPersonalMessage(new TextEncoder().encode(prepared.signOff.message));
  const signed = await signMigrationSignOff(w.db, { orgId: 'acme', actorUserId: 'u-two', id: prepared.signOff.id, signature, signerAddress: w.keys.two.address, now });
  assert.equal(signed.ok, true, JSON.stringify(signed));

  const after = await clear('u-staff');
  assert.equal(after.ok, true);
  assert.equal(after.signedOffBy, 'u-two');
  // Only for that member, that wallet and that destination.
  assert.equal((await clear('u-staff', '0x' + '12'.repeat(32))).ok, false);
  assert.equal((await clear('u-staff', staff.address, '0x' + '13'.repeat(32))).ok, false, 'after a rotation the old sign-off does not move funds to the new wallet');
  // And only until it expires.
  assert.equal((await clear('u-staff', staff.address, WALLET, () => new Date(T0.getTime() + 25 * 3600_000))).ok, false);

  // The person in charge can sign off too, once appointed.
  const early = await signOff(w, { by: 'u-pic', passkey: pic, member: 'u-staff', from: '0x' + '12'.repeat(32) });
  assert.equal(early.status, 403, 'not in charge yet');
  await appointPersonInCharge(w.db, { orgId: 'acme', actorUserId: 'u-founder', userId: 'u-pic', now });
  const byPic = await signOff(w, { by: 'u-pic', passkey: pic, member: 'u-staff', from: '0x' + '12'.repeat(32) });
  assert.equal(byPic.ok, true, JSON.stringify(byPic));
  assert.equal((await clear('u-staff', '0x' + '12'.repeat(32))).ok, true);
  // Revoking the person in charge voids what they signed off and has not been used up.
  await revokePersonInCharge(w.db, { orgId: 'acme', actorUserId: 'u-founder', userId: 'u-pic', now });
  assert.equal((await clear('u-staff', '0x' + '12'.repeat(32))).ok, false);

  const actions = (await listAuthorityEvents(w.db, 'acme')).map((e) => e.action);
  assert.ok(actions.includes('migration_signed_off'));
  await w.client.close();
});

test('(4) a sign-off by staff, by the member themselves, with a wrong key or for an owner is refused', async () => {
  const w = await world();
  const { staff, pic, outsider } = await withStaff(w);
  await appointPersonInCharge(w.db, { orgId: 'acme', actorUserId: 'u-founder', userId: 'u-pic', now: () => T0 });

  const byStaff = await prepareMigrationSignOff(w.db, { orgId: 'acme', actorUserId: 'u-staff', memberUserId: 'u-viewer', fromAddress: outsider.address, toWallet: WALLET, now: () => T0 });
  assert.equal(byStaff.status, 403);
  const self = await prepareMigrationSignOff(w.db, { orgId: 'acme', actorUserId: 'u-pic', memberUserId: 'u-pic', fromAddress: pic.address, toWallet: WALLET, now: () => T0 });
  assert.equal(self.code, 'self_sign_off', 'nobody signs off their own move');
  const owner = await prepareMigrationSignOff(w.db, { orgId: 'acme', actorUserId: 'u-pic', memberUserId: 'u-two', fromAddress: w.keys.two.address, toWallet: WALLET, now: () => T0 });
  assert.equal(owner.code, 'not_needed');
  const foreign = await prepareMigrationSignOff(w.db, { orgId: 'acme', actorUserId: 'u-two', memberUserId: 'u-north-staff', fromAddress: outsider.address, toWallet: WALLET, now: () => T0 });
  assert.equal(foreign.status, 404);

  // The owner's statement, signed by someone else's passkey.
  const prepared = await prepareMigrationSignOff(w.db, { orgId: 'acme', actorUserId: 'u-two', memberUserId: 'u-staff', fromAddress: staff.address, toWallet: WALLET, now: () => T0 });
  const { signature: wrong } = await outsider.keypair.signPersonalMessage(new TextEncoder().encode(prepared.signOff.message));
  const forged = await signMigrationSignOff(w.db, { orgId: 'acme', actorUserId: 'u-two', id: prepared.signOff.id, signature: wrong, signerAddress: w.keys.two.address, now: () => T0 });
  assert.equal(forged.code, 'bad_signature');
  // Another statement's signature does not fit this one.
  const other = await prepareMigrationSignOff(w.db, { orgId: 'acme', actorUserId: 'u-two', memberUserId: 'u-staff', fromAddress: '0x' + '14'.repeat(32), toWallet: WALLET, now: () => T0 });
  const { signature: otherSig } = await w.keys.two.keypair.signPersonalMessage(new TextEncoder().encode(other.signOff.message));
  const swapped = await signMigrationSignOff(w.db, { orgId: 'acme', actorUserId: 'u-two', id: prepared.signOff.id, signature: otherSig, signerAddress: w.keys.two.address, now: () => T0 });
  assert.equal(swapped.code, 'bad_signature');
  // Only the person who prepared it signs it, and only in their business.
  const byThree = await signMigrationSignOff(w.db, { orgId: 'acme', actorUserId: 'u-three', id: prepared.signOff.id, signature: wrong, signerAddress: w.keys.three.address, now: () => T0 });
  assert.equal(byThree.status, 404);
  const late = await signMigrationSignOff(w.db, { orgId: 'acme', actorUserId: 'u-two', id: prepared.signOff.id, signature: otherSig, signerAddress: w.keys.two.address, now: () => new Date(T0.getTime() + 25 * 3600_000) });
  assert.equal(late.code, 'expired');
  assert.equal((await migrationClearance(w.db, { orgId: 'acme', userId: 'u-staff', fromAddress: staff.address, toWallet: WALLET, now: () => T0 })).ok, false);
  await w.client.close();
});

test('(4) the migration route moves USDC only and asks for the sign-off before building a staff transfer', async () => {
  const route = await readFile(new URL('../app/api/wallet/migration/route.ts', import.meta.url), 'utf8');
  assert.match(route, /migrationClearance\(/, 'the route checks the sign-off');
  assert.ok(route.indexOf('migrationClearance(') < route.indexOf('requestMigrationTransfer('), 'before building anything');
  assert.match(route, /walletUsdcType\(\)/, 'USDC is the only coin read');
  for (const file of ['app/api/wallet/persons-in-charge/route.ts', 'app/api/wallet/migration/sign-offs/route.ts', 'app/api/wallet/migration/sign-offs/[id]/route.ts', 'app/api/wallet/approval-asks/route.ts', 'app/api/wallet/approval-asks/[id]/route.ts']) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.match(source, /walletRoute\(request\)/, `${file}: the org comes from the session`);
    assert.doesNotMatch(source, /body\.orgId|searchParams\.get\('orgId'\)/, `${file}: never from the request`);
  }
});

/* ── (1) One approver runs the hardware check on testnet ──────────────── */

test('(1) the runbook and the mainnet gate say one approver runs the hardware 2-of-3 on testnet', async () => {
  const doc = await readFile(new URL('../docs/v2/phase2-business-wallet.md', import.meta.url), 'utf8');
  const runbook = doc.slice(doc.indexOf('## Runbook'));
  assert.match(runbook, /one approver/i);
  assert.match(runbook, /Sky/);
  assert.match(runbook, /three (of his own )?authenticators/i);
  assert.doesNotMatch(runbook, /three people/i);
  const checklist = await readFile(new URL('../docs/MAINNET-CHECKLIST.md', import.meta.url), 'utf8');
  assert.match(checklist, /one approver/i);
  const gate = await readFile(new URL('../lib/server/wallet-network-gate.ts', import.meta.url), 'utf8');
  assert.match(gate, /one approver/i);
  assert.doesNotMatch(gate, /three people/i);
});
