/**
 * v2 Phase 3 (p3-labels): "Declined by <who>", from the signing request's own
 * record of who declined, on a real database (PGlite, every migration, the
 * wallet world's model chain). Nothing reaches a network; nothing is signed for
 * any network.
 *
 *   - a payment or batch the owners declined names who declined it, in the order
 *     they declined, two names and then "and N more";
 *   - a request its sender withdrew stays "Withdrawn" and names nobody, even when
 *     an owner had declined before it was withdrawn;
 *   - a payment a staff member asked the owners to approve and an owner declined
 *     names that owner;
 *   - no usable name reads "Declined by an owner";
 *   - a name is read only through the business's own record: another business
 *     reads none of it, by list, by id or by the store's own read;
 *   - a hostile or very long name is said as plain words or not at all.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { fromBase64, normalizeSuiAddress } from '@mysten/sui/utils';
import { eq } from 'drizzle-orm';

import * as schema from '../lib/db/schema.ts';
import { LAUNCH_SCHEDULE, splashFee } from '../lib/fees/schedule.ts';
import { buildBusinessMultisig } from '../lib/wallet/business-multisig.ts';
import { buildHistory } from '../lib/history-page/entries.ts';
import * as T from '../lib/server/wallet-transfers.ts';
import * as B from '../lib/server/wallet-batches.ts';
import { declineApprovalAsk } from '../lib/server/payment-approval-asks.ts';
import { cancelSigningRequest, declineSigningRequest, submitPartialSignature } from '../lib/server/wallet-signing.ts';
import { askDeclinerOf, declinersOfRequests } from '../lib/server/wallet-signing-store.ts';

import { world, T0 } from './fixtures/wallet-world.mjs';

const USDC = (n) => BigInt(Math.round(n * 1_000_000));
const OPERATOR = normalizeSuiAddress(`0x${'0e'.repeat(32)}`);
const SUPPLIER_WALLET = normalizeSuiAddress(`0x${'77'.repeat(32)}`);
const WALLET_A = normalizeSuiAddress(`0x${'71'.repeat(32)}`);
const WALLET_B = normalizeSuiAddress(`0x${'72'.repeat(32)}`);
const NORTH_WALLET = normalizeSuiAddress(`0x${'99'.repeat(32)}`);
const OWNER = { userId: 'u-founder', role: 'OWNER' };

async function sign(passkey, view) {
  return (await passkey.keypair.signTransaction(fromBase64(view.transactionBytes))).signature;
}

async function setup() {
  const w = await world();
  const { startBusinessWallet } = await import('../lib/server/business-wallet.ts');
  const { signingInbox } = await import('../lib/server/wallet-signing.ts');
  const nominate = await startBusinessWallet(w.ctx, { orgId: 'acme', requestedBy: 'u-founder', founder: { userId: 'u-founder', passkeyPublicKey: w.keys.founder.publicKey }, owners: w.owners });
  assert.equal(nominate.ok, true, JSON.stringify(nominate));
  await submitPartialSignature(w.signing, { orgId: 'acme', userId: 'u-founder', id: nominate.request.id, signature: await sign(w.keys.founder, nominate.request), digest: nominate.request.digest });
  const [register] = await signingInbox(w.signing, { orgId: 'acme', userId: 'u-two' });
  await submitPartialSignature(w.signing, { orgId: 'acme', userId: 'u-two', id: register.id, signature: await sign(w.keys.two, register), digest: register.digest });
  await submitPartialSignature(w.signing, { orgId: 'acme', userId: 'u-three', id: register.id, signature: await sign(w.keys.three, register), digest: register.digest });
  const wallet = buildBusinessMultisig({ members: w.owners });
  const members = { multisigPublicKey: wallet.multisigPublicKey, members: wallet.members.map((m) => ({ userId: m.userId, publicKey: m.suiPublicKey, weight: m.weight })) };
  w.notices.length = 0;
  const deps = (orgId = 'acme', over = {}) => ({
    db: w.db,
    orgId,
    env: { NODE_ENV: 'test' },
    now: () => w.signing.now(),
    ctx: w.ctx,
    walletMembers: async () => (orgId === 'acme' ? { ok: true, address: wallet.address, members } : { ok: false, status: 409, code: 'no_wallet', error: 'register the business wallet first' }),
    splashAddresses: async () => [OPERATOR, w.sponsor.address],
    isBusinessWallet: async (address) => normalizeSuiAddress(address) === NORTH_WALLET,
    businessWallet: async () => null,
    searchBusinesses: async () => [],
    splashFee: async ({ kind, principalMinor }) => ({ feeMinor: splashFee({ kind, principalMinor, discountBps: 0, schedule: LAUNCH_SCHEDULE }), feesOn: true }),
    paymentRecord: async () => ({ ok: true, contentHash: new Uint8Array(32).fill(4), walrusBlobId: new TextEncoder().encode('blob-tx') }),
    requesterAddresses: async () => [],
    notifyAsk: async () => {},
    notifyBatch: async () => {},
    ...over,
  });
  return { w, deps };
}

const input = (recipientId, clientKey) => ({
  clientKey,
  payee: { kind: 'recipient', recipientId },
  amountMinor: USDC(5_000).toString(),
  maxFeeMinor: splashFee({ kind: 1, principalMinor: USDC(5_000), discountBps: 0, schedule: LAUNCH_SCHEDULE }).toString(),
  reference: 'INV-0042',
});

async function savedWallet(t, address = SUPPLIER_WALLET, opts = {}) {
  await t.w.screenClear(address);
  return t.w.saveRecipient(address, opts);
}

async function rename(t, names) {
  for (const [id, name] of Object.entries(names)) await t.w.db.update(schema.users).set({ name }).where(eq(schema.users.id, id));
}

const labels = (entries) => entries.map((e) => e.status.label);
const historyOf = async (t, orgId = 'acme') => buildHistory({ transfers: await T.listTransfers(t.deps(orgId)), batches: await B.listBatches(t.deps(orgId)), withdrawals: [], earlier: [] });

/** A payment the owners declined: the named owners decline it, one after the other, a minute apart. */
async function declinedPayment(t, clientKey, decliners = ['u-two', 'u-three']) {
  const recipientId = await savedWallet(t);
  const made = await T.createTransfer(t.deps(), OWNER, input(recipientId, clientKey));
  assert.equal(made.ok, true, JSON.stringify(made));
  let minute = 0;
  for (const userId of decliners) {
    t.w.setNow(new Date(T0.getTime() + ++minute * 60_000));
    const declined = await declineSigningRequest(t.w.signing, { orgId: 'acme', userId, id: made.signingRequest.id });
    assert.equal(declined.ok, true, JSON.stringify(declined));
  }
  t.w.setNow(T0);
  return made;
}

test('a payment the owners declined says who: one name, two names in the order they declined', async () => {
  const t = await setup();
  await rename(t, { 'u-two': 'Aisha', 'u-three': 'Ben' });
  const made = await declinedPayment(t, 'tx_key_declin01', ['u-two', 'u-three']);
  const [view] = await T.listTransfers(t.deps());
  assert.equal(view.status, 'declined');
  assert.deepEqual(view.declinedBy, { names: ['Aisha', 'Ben'], unnamed: 0 });
  assert.deepEqual(labels(await historyOf(t)), ['Declined by Aisha and Ben']);
  assert.deepEqual((await T.getTransfer(t.deps(), made.transfer.id)).declinedBy, { names: ['Aisha', 'Ben'], unnamed: 0 }, 'one payment reads the same as the list');
  // The other order is the other sentence: it is the order they declined, not the order of their ids.
  const second = await setup();
  await rename(second, { 'u-two': 'Aisha', 'u-three': 'Ben' });
  await declinedPayment(second, 'tx_key_declin02', ['u-three', 'u-two']);
  assert.deepEqual(labels(await historyOf(second)), ['Declined by Ben and Aisha']);
  await t.w.client.close();
  await second.w.client.close();
});

test('a request only one owner declined, then its sender withdrew, is Withdrawn and names nobody', async () => {
  const t = await setup();
  await rename(t, { 'u-two': 'Aisha' });
  const recipientId = await savedWallet(t);
  const made = await T.createTransfer(t.deps(), OWNER, input(recipientId, 'tx_key_withdr01'));
  assert.equal((await declineSigningRequest(t.w.signing, { orgId: 'acme', userId: 'u-two', id: made.signingRequest.id })).ok, true);
  assert.equal((await cancelSigningRequest(t.w.signing, { orgId: 'acme', userId: 'u-founder', id: made.signingRequest.id })).ok, true);
  const [view] = await T.listTransfers(t.deps());
  assert.equal(view.status, 'withdrawn');
  assert.equal(view.declinedBy ?? null, null, 'a withdrawn request carries no decliners');
  assert.deepEqual(labels(await historyOf(t)), ['Withdrawn']);
  await t.w.client.close();
});

test('more than two who declined: two names, then "and 1 more"', async () => {
  const t = await setup();
  await rename(t, { 'u-two': 'Aisha', 'u-three': 'Ben', 'u-founder': 'Chen' });
  const made = await declinedPayment(t, 'tx_key_declin03', ['u-two', 'u-three']);
  // The record of a third who declined (a request with more signers than the three of this world).
  await t.w.client.exec(`UPDATE wallet_signing_signers SET declined_at = '${new Date(T0.getTime() + 3 * 60_000).toISOString()}' WHERE request_id = '${made.signingRequest.id}' AND user_id = 'u-founder'`);
  assert.deepEqual(labels(await historyOf(t)), ['Declined by Aisha, Ben and 1 more']);
  await t.w.client.close();
});

test('a decliner with no usable name is an owner, not a blank, and still counts', async () => {
  const t = await setup();
  await rename(t, { 'u-two': 'https://evil.example/pay', 'u-three': '   ' });
  await declinedPayment(t, 'tx_key_declin04', ['u-two', 'u-three']);
  const [view] = await T.listTransfers(t.deps());
  assert.deepEqual(view.declinedBy, { names: [], unnamed: 2 });
  assert.deepEqual(labels(await historyOf(t)), ['Declined by an owner']);
  await t.w.client.close();
});

test('a hostile name is said as plain words, a very long one is cut, and neither is stored or sent as markup or a link', async () => {
  const t = await setup();
  await rename(t, { 'u-two': '<img src=x onerror=alert(1)> https://evil.example/pay Aisha', 'u-three': `${'B'.repeat(400)} www.evil.example` });
  await declinedPayment(t, 'tx_key_declin05', ['u-two', 'u-three']);
  const [view] = await T.listTransfers(t.deps());
  assert.equal(view.declinedBy.names[0], 'Aisha');
  assert.ok(view.declinedBy.names[1].length <= 31, `${view.declinedBy.names[1].length}`);
  const [entry] = await historyOf(t);
  assert.match(entry.status.label, /^Declined by Aisha and B+…?$/);
  assert.doesNotMatch(JSON.stringify(view), /evil|<|>|https?|www/i, 'the view the page receives has none of it');
  // The user's own record is untouched: the name is cleaned where it is said, never rewritten.
  const [raw] = await t.w.db.select().from(schema.users).where(eq(schema.users.id, 'u-two'));
  assert.match(raw.name, /evil/);
  await t.w.client.close();
});

test('a batch the owners declined says who, and a batch that was withdrawn does not', async () => {
  const t = await setup();
  await rename(t, { 'u-two': 'Aisha', 'u-three': 'Ben' });
  await savedWallet(t, WALLET_A, { name: 'Dela Cruz Trading Corp' });
  await savedWallet(t, WALLET_B, { name: 'Santos Supplies Inc' });
  const rows = (a, b) => [{ line: 1, recipient: 'Dela Cruz Trading Corp', amount: a, reference: '' }, { line: 2, recipient: 'Santos Supplies Inc', amount: b, reference: '' }];
  const fee = (r) => r.reduce((s, x) => s + splashFee({ kind: 1, principalMinor: USDC(Number(x.amount.replace(/,/g, ''))), discountBps: 0, schedule: LAUNCH_SCHEDULE }), 0n).toString();
  const taken = await B.createBatch(t.deps(), OWNER, { clientKey: 'batch_key_taken01', rows: rows('5,000', '250'), maxFeeMinor: fee(rows('5,000', '250')) });
  assert.equal(taken.ok, true, JSON.stringify(taken));
  assert.equal((await declineSigningRequest(t.w.signing, { orgId: 'acme', userId: 'u-two', id: taken.signingRequest.id })).ok, true);
  assert.equal((await cancelSigningRequest(t.w.signing, { orgId: 'acme', userId: 'u-founder', id: taken.signingRequest.id })).ok, true);
  const refused = await B.createBatch(t.deps(), OWNER, { clientKey: 'batch_key_refus01', rows: rows('600', '70'), maxFeeMinor: fee(rows('600', '70')) });
  assert.equal(refused.ok, true, JSON.stringify(refused));
  for (const userId of ['u-three', 'u-two']) assert.equal((await declineSigningRequest(t.w.signing, { orgId: 'acme', userId, id: refused.signingRequest.id })).ok, true);
  const listed = await B.listBatches(t.deps());
  const byId = (id) => listed.find((b) => b.id === id);
  assert.equal(byId(taken.batch.id).status, 'withdrawn');
  assert.equal(byId(taken.batch.id).declinedBy ?? null, null);
  assert.equal(byId(refused.batch.id).status, 'declined');
  assert.equal((await B.getBatch(t.deps(), refused.batch.id)).declinedBy.names.length, 2, 'one batch reads the same as the list');
  assert.deepEqual(labels(await historyOf(t)).sort(), ['Declined by Ben and Aisha', 'Withdrawn']);
  await t.w.client.close();
});

test('a payment a staff member asked the owners to approve names the owner who declined it', async () => {
  const t = await setup();
  await rename(t, { 'u-two': 'Aisha' });
  const db = t.w.db;
  const now = T0;
  const recipientId = await savedWallet(t);
  await db.insert(schema.walletApprovalAsks).values({ id: 'wpa_decl1', orgId: 'acme', intentId: 'intent-1', requestedBy: 'u-three', intent: {}, note: null, contentHash: 'h', walrusBlobId: 'b', status: 'open', expiresAt: new Date(now.getTime() + 86_400_000) });
  await db.insert(schema.walletTransfers).values({ id: 'wtr_ask1', orgId: 'acme', clientKey: 'tx_key_ask00001', requestHash: 'x', paymentRef: 'pay_ask1', route: 'asked_owners', payeeKind: 'self_custody', recipientId, payeeName: 'Dela Cruz Trading Corp', address: SUPPLIER_WALLET, amountMinor: 5_000_000_000n, maxFeeMinor: 1n, feeKind: 1, askId: 'wpa_decl1', requestedBy: 'u-three' });
  assert.deepEqual(labels(await historyOf(t)), ['Waiting for an owner']);
  const declined = await declineApprovalAsk(db, { orgId: 'acme', userId: 'u-two', askId: 'wpa_decl1', now: () => now });
  assert.equal(declined.ok, true, JSON.stringify(declined));
  const [view] = await T.listTransfers(t.deps());
  assert.equal(view.status, 'declined');
  assert.deepEqual(view.declinedBy, { names: ['Aisha'], unnamed: 0 });
  assert.deepEqual(labels(await historyOf(t)), ['Declined by Aisha']);
  // An owner with no usable name: the same sentence as everywhere.
  await rename(t, { 'u-two': '<<>>' });
  assert.deepEqual(labels(await historyOf(t)), ['Declined by an owner']);
  await t.w.client.close();
});

test('another business reads none of it: not in its lists, not by id, not from the store', async () => {
  const t = await setup();
  await rename(t, { 'u-two': 'Aisha', 'u-three': 'Ben', 'u-north': 'Nadia' });
  const made = await declinedPayment(t, 'tx_key_declin06', ['u-two', 'u-three']);
  // Northwind has its own declined request, with its own names.
  await t.w.client.exec(`INSERT INTO wallet_signing_requests (id, org_id, purpose, dedupe_key, sender_address, signer_kind, threshold, gas_mode, tx_bytes, tx_digest, bytes_hash, summary, status, requested_by, expires_at, error) SELECT 'sr_north', 'northwind', purpose, 'north:1', sender_address, signer_kind, threshold, gas_mode, tx_bytes, tx_digest, bytes_hash, summary, 'cancelled', 'u-north', expires_at, 'enough signers declined that it can no longer be signed' FROM wallet_signing_requests WHERE id = '${made.signingRequest.id}'`);
  await t.w.client.exec(`INSERT INTO wallet_signing_signers (request_id, org_id, user_id, address, public_key, weight, declined_at) VALUES ('sr_north', 'northwind', 'u-north', '${SUPPLIER_WALLET}', 'pk', 1, '${T0.toISOString()}')`);

  assert.deepEqual(await T.listTransfers(t.deps('northwind')), [], 'its list holds none of Acme’s payments');
  assert.equal(await T.getTransfer(t.deps('northwind'), made.transfer.id), null, 'Acme’s payment by its id reads as absent');
  const north = await declinersOfRequests(t.w.db, 'northwind', [made.signingRequest.id, 'sr_north']);
  assert.deepEqual([...north.keys()], ['sr_north'], 'asked for Acme’s request, Northwind is told nothing of it');
  assert.deepEqual(north.get('sr_north'), { names: ['Nadia'], unnamed: 0 });
  const acme = await declinersOfRequests(t.w.db, 'acme', [made.signingRequest.id, 'sr_north']);
  assert.deepEqual([...acme.keys()], [made.signingRequest.id], 'and Acme is told nothing of Northwind’s');
  assert.deepEqual(acme.get(made.signingRequest.id), { names: ['Aisha', 'Ben'], unnamed: 0 });
  assert.equal((await askDeclinerOf(t.w.db, 'northwind', 'wpa_anything')) ?? null, null);
  assert.deepEqual(await declinersOfRequests(t.w.db, 'acme', []), new Map(), 'nothing asked, nothing read');
  await t.w.client.close();
});

test('a declined payment is the same on every read: a repeat of the read changes nothing and writes nothing', async () => {
  const t = await setup();
  await rename(t, { 'u-two': 'Aisha', 'u-three': 'Ben' });
  await declinedPayment(t, 'tx_key_declin07', ['u-two', 'u-three']);
  const before = JSON.stringify(await t.w.db.select().from(schema.walletSigningSigners));
  const first = JSON.stringify(await T.listTransfers(t.deps()));
  const second = JSON.stringify(await T.listTransfers(t.deps()));
  assert.equal(first, second);
  assert.equal(JSON.stringify(await t.w.db.select().from(schema.walletSigningSigners)), before, 'reading who declined writes nothing');
  await t.w.client.close();
});
