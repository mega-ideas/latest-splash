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
 *
 * v2 Phase 3 (p3-decliners), Sky's decisions: the label carries the title in
 * brackets ("Aisha (Owner)"); the signing panel names everyone, History the
 * first two; the name and title are a snapshot written with the decline, so a
 * leaver, a rename or a removed account never changes or blanks an old label; a
 * decline from before the snapshot reads the live name and title, else "an owner".
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
import { cancelSigningRequest, declineSigningRequest, readRequestForSigner, signingInbox, submitPartialSignature } from '../lib/server/wallet-signing.ts';
import { declinedByAllLabel } from '../lib/team/declined-by.ts';
import { askDeclinerOf, declinersOfRequests } from '../lib/server/wallet-signing-store.ts';
import { setMemberTitle } from '../lib/server/team-admin.ts';

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
  assert.deepEqual(view.declinedBy, { names: [{ name: 'Aisha', title: 'Owner' }, { name: 'Ben', title: 'Owner' }], unnamed: 0 });
  assert.deepEqual(labels(await historyOf(t)), ['Declined by Aisha (Owner) and Ben (Owner)']);
  assert.deepEqual((await T.getTransfer(t.deps(), made.transfer.id)).declinedBy, { names: [{ name: 'Aisha', title: 'Owner' }, { name: 'Ben', title: 'Owner' }], unnamed: 0 }, 'one payment reads the same as the list');
  // The other order is the other sentence: it is the order they declined, not the order of their ids.
  const second = await setup();
  await rename(second, { 'u-two': 'Aisha', 'u-three': 'Ben' });
  await declinedPayment(second, 'tx_key_declin02', ['u-three', 'u-two']);
  assert.deepEqual(labels(await historyOf(second)), ['Declined by Ben (Owner) and Aisha (Owner)']);
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
  assert.deepEqual(labels(await historyOf(t)), ['Declined by Aisha (Owner), Ben (Owner) and 1 more']);
  await t.w.client.close();
});

test('a decliner with no usable name is said by their title alone, not a blank', async () => {
  const t = await setup();
  await rename(t, { 'u-two': 'https://evil.example/pay', 'u-three': '   ' });
  await declinedPayment(t, 'tx_key_declin04', ['u-two', 'u-three']);
  const [view] = await T.listTransfers(t.deps());
  assert.deepEqual(view.declinedBy, { names: [{ name: null, title: 'Owner' }, { name: null, title: 'Owner' }], unnamed: 0 });
  assert.deepEqual(labels(await historyOf(t)), ['Declined by Owner and Owner']);
  await t.w.client.close();
});

test('a hostile name is said as plain words, a very long one is cut, and neither is stored or sent as markup or a link', async () => {
  const t = await setup();
  await rename(t, { 'u-two': '<img src=x onerror=alert(1)> https://evil.example/pay Aisha', 'u-three': `${'B'.repeat(400)} www.evil.example` });
  await declinedPayment(t, 'tx_key_declin05', ['u-two', 'u-three']);
  const [view] = await T.listTransfers(t.deps());
  // A name that starts with markup or a link is no name (the words after it are not the person); that person is said by their title.
  assert.equal(view.declinedBy.names.length, 2);
  assert.deepEqual(view.declinedBy.names[0], { name: null, title: 'Owner' });
  assert.match(view.declinedBy.names[1].name, /^B{30}…$/, 'a cut name ends in the one ellipsis character');
  const [entry] = await historyOf(t);
  assert.match(entry.status.label, /^Declined by Owner and B{30}… \(Owner\)$/);
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
  assert.deepEqual(labels(await historyOf(t)).sort(), ['Declined by Ben (Owner) and Aisha (Owner)', 'Withdrawn']);
  await t.w.client.close();
});

test('a payment a staff member asked the owners to approve names the owner who declined it', async () => {
  const t = await setup();
  await rename(t, { 'u-two': 'Aisha' });
  const db = t.w.db;
  const now = T0;
  const recipientId = await savedWallet(t);
  await db.insert(schema.walletApprovalAsks).values({ id: 'wpa_decl1', orgId: 'acme', intentId: 'intent-1', requestedBy: 'u-three', intent: {}, note: null, contentHash: 'h', walrusBlobId: 'b', status: 'open', expiresAt: new Date(now.getTime() + 86_400_000) });
  await db.insert(schema.walletTransfers).values({ id: 'wtr_ask1', orgId: 'acme', clientKey: 'tx_key_ask00001', requestHash: 'x', paymentRef: 'a'.repeat(64), route: 'asked_owners', payeeKind: 'self_custody', recipientId, payeeName: 'Dela Cruz Trading Corp', address: SUPPLIER_WALLET, amountMinor: 5_000_000_000n, maxFeeMinor: 1n, feeKind: 1, askId: 'wpa_decl1', requestedBy: 'u-three' });
  assert.deepEqual(labels(await historyOf(t)), ['Waiting for an owner']);
  const declined = await declineApprovalAsk(db, { orgId: 'acme', userId: 'u-two', askId: 'wpa_decl1', now: () => now });
  assert.equal(declined.ok, true, JSON.stringify(declined));
  const [view] = await T.listTransfers(t.deps());
  assert.equal(view.status, 'declined');
  assert.deepEqual(view.declinedBy, { names: [{ name: 'Aisha', title: 'Owner' }], unnamed: 0 });
  assert.deepEqual(labels(await historyOf(t)), ['Declined by Aisha (Owner)']);
  // The ask keeps what the owner was called when they declined: a rename afterwards does not change it.
  await rename(t, { 'u-two': '<<>>' });
  assert.deepEqual(labels(await historyOf(t)), ['Declined by Aisha (Owner)']);
  await t.w.client.close();
});

test('another business reads none of it: not in its lists, not by id, not from the store', async () => {
  const t = await setup();
  await rename(t, { 'u-two': 'Aisha', 'u-three': 'Ben', 'u-north': 'Nadia' });
  const made = await declinedPayment(t, 'tx_key_declin06', ['u-two', 'u-three']);
  // Northwind has its own declined request, with its own names.
  await t.w.client.exec(`INSERT INTO wallet_signing_requests (id, org_id, purpose, dedupe_key, sender_address, signer_kind, multisig_public_key, threshold, gas_mode, tx_bytes, tx_digest, bytes_hash, summary, status, requested_by, expires_at, error) SELECT 'sr_north', 'northwind', purpose, 'north:1', sender_address, signer_kind, multisig_public_key, threshold, gas_mode, tx_bytes, 'north-digest', 'north-hash', summary, 'cancelled', 'u-north', expires_at, 'enough signers declined that it can no longer be signed' FROM wallet_signing_requests WHERE id = '${made.signingRequest.id}'`);
  await t.w.client.exec(`INSERT INTO wallet_signing_signers (request_id, org_id, user_id, address, public_key, weight, declined_at, declined_name, declined_title) VALUES ('sr_north', 'northwind', 'u-north', '${SUPPLIER_WALLET}', 'pk', 1, '${T0.toISOString()}', 'Nadia', 'Owner')`);

  assert.deepEqual(await T.listTransfers(t.deps('northwind')), [], 'its list holds none of Acme’s payments');
  assert.equal(await T.getTransfer(t.deps('northwind'), made.transfer.id), null, 'Acme’s payment by its id reads as absent');
  const north = await declinersOfRequests(t.w.db, 'northwind', [made.signingRequest.id, 'sr_north']);
  assert.deepEqual([...north.keys()], ['sr_north'], 'asked for Acme’s request, Northwind is told nothing of it');
  assert.deepEqual(north.get('sr_north'), { names: [{ name: 'Nadia', title: 'Owner' }], unnamed: 0 });
  const acme = await declinersOfRequests(t.w.db, 'acme', [made.signingRequest.id, 'sr_north']);
  assert.deepEqual([...acme.keys()], [made.signingRequest.id], 'and Acme is told nothing of Northwind’s');
  assert.deepEqual(acme.get(made.signingRequest.id), { names: [{ name: 'Aisha', title: 'Owner' }, { name: 'Ben', title: 'Owner' }], unnamed: 0 });
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

// ─── v2 Phase 3 (p3-decliners): the panel names all, the snapshot keeps the label ───

const signers = async (t, requestId) => (await t.w.db.select().from(schema.walletSigningSigners).where(eq(schema.walletSigningSigners.requestId, requestId))).sort((a, b) => a.userId.localeCompare(b.userId));
const snapshotOf = async (t, requestId, userId) => {
  const row = (await signers(t, requestId)).find((r) => r.userId === userId);
  return { name: row.declinedName, title: row.declinedTitle };
};
const panelOf = async (t, requestId, userId = 'u-founder', orgId = 'acme') => readRequestForSigner(t.w.signing, { orgId, userId, id: requestId });

test('the signing panel names everyone who declined, History the first two and a count, from the same facts', async () => {
  const t = await setup();
  await rename(t, { 'u-two': 'Aisha', 'u-three': 'Ben', 'u-founder': 'Chen' });
  // Ben is the Finance lead (an approver the owners appointed): the title is the appointment, not the role under it.
  await t.w.client.exec(`UPDATE memberships SET role = 'checker' WHERE user_id = 'u-three'`);
  await t.w.client.exec(`INSERT INTO wallet_finance_leads (id, org_id, user_id, granted_by, granted_at) VALUES ('wfl_decl1', 'acme', 'u-three', 'u-founder', '${T0.toISOString()}')`);
  const made = await declinedPayment(t, 'tx_key_panel001', ['u-two', 'u-three']);
  // The third owner's decline (a request with more signers than the three of this world), written as the app writes it.
  await t.w.client.exec(`UPDATE wallet_signing_signers SET declined_at = '${new Date(T0.getTime() + 3 * 60_000).toISOString()}', declined_name = 'Chen', declined_title = 'Owner' WHERE request_id = '${made.signingRequest.id}' AND user_id = 'u-founder'`);

  const panel = await panelOf(t, made.signingRequest.id);
  assert.equal(panel.ok, true, JSON.stringify(panel));
  assert.equal(declinedByAllLabel(panel.request.declinedBy), 'Declined by Aisha (Owner), Ben (Finance lead) and Chen (Owner)', 'the panel names all three, in the order they declined');
  assert.deepEqual(labels(await historyOf(t)), ['Declined by Aisha (Owner), Ben (Finance lead) and 1 more'], 'History names two and counts the rest');
  const [view] = await T.listTransfers(t.deps());
  assert.deepEqual(view.declinedBy, panel.request.declinedBy, 'the panel and History read the same facts; only the panel says all of them');
  await t.w.client.close();
});

test('while a request is waiting, the owners who have not answered read who has declined it, and a request nobody declined carries none', async () => {
  const t = await setup();
  await rename(t, { 'u-two': 'Aisha' });
  const recipientId = await savedWallet(t);
  const made = await T.createTransfer(t.deps(), OWNER, input(recipientId, 'tx_key_waiting1'));
  const before = await signingInbox(t.w.signing, { orgId: 'acme', userId: 'u-three' });
  assert.equal(before.length, 1);
  assert.equal('declinedBy' in before[0], false, 'nobody has declined: nothing to say');
  assert.equal((await declineSigningRequest(t.w.signing, { orgId: 'acme', userId: 'u-two', id: made.signingRequest.id })).ok, true);
  const [waiting] = await signingInbox(t.w.signing, { orgId: 'acme', userId: 'u-three' });
  assert.equal(waiting.status, 'collecting');
  assert.deepEqual(waiting.declinedBy, { names: [{ name: 'Aisha', title: 'Owner' }], unnamed: 0 });
  assert.equal(declinedByAllLabel(waiting.declinedBy), 'Declined by Aisha (Owner)');
  const byId = await panelOf(t, made.signingRequest.id, 'u-three');
  assert.deepEqual(byId.request.declinedBy, waiting.declinedBy, 'the inbox and the request read the same');
  await t.w.client.close();
});

test('the name and title are written with the decline itself, once: a later rename, role change or second decline does not touch them', async () => {
  const t = await setup();
  await rename(t, { 'u-two': 'Aisha' });
  const made = await declinedPayment(t, 'tx_key_snap0001', ['u-two']);
  assert.deepEqual(await snapshotOf(t, made.signingRequest.id, 'u-two'), { name: 'Aisha', title: 'Owner' });
  assert.deepEqual(await snapshotOf(t, made.signingRequest.id, 'u-three'), { name: null, title: null }, 'a signer who did not decline has no snapshot');
  await rename(t, { 'u-two': 'Zed' });
  await t.w.client.exec(`UPDATE memberships SET role = 'viewer' WHERE user_id = 'u-two'`);
  const again = await declineSigningRequest(t.w.signing, { orgId: 'acme', userId: 'u-two', id: made.signingRequest.id });
  assert.equal(again.ok, false);
  assert.deepEqual(await snapshotOf(t, made.signingRequest.id, 'u-two'), { name: 'Aisha', title: 'Owner' }, 'a repeat of the decline writes nothing');
  await t.w.client.close();
});

test('only the name and the title are kept, cleaned as plain words: nothing else of the person goes into the snapshot', async () => {
  const t = await setup();
  await rename(t, { 'u-two': 'Aisha (CFO), Ben (Staff) https://evil.example', 'u-three': '<img src=x onerror=alert(1)>' });
  const made = await declinedPayment(t, 'tx_key_snap0002', ['u-two', 'u-three']);
  assert.deepEqual(await snapshotOf(t, made.signingRequest.id, 'u-two'), { name: 'Aisha CFO Ben Staff', title: 'Owner' });
  assert.deepEqual(await snapshotOf(t, made.signingRequest.id, 'u-three'), { name: '', title: 'Owner' }, 'a name that is nothing after cleaning is stored empty, not as the markup');
  const row = (await signers(t, made.signingRequest.id)).find((r) => r.userId === 'u-two');
  const [user] = await t.w.db.select().from(schema.users).where(eq(schema.users.id, 'u-two'));
  const kept = `${row.declinedName}|${row.declinedTitle}`;
  assert.ok(!kept.includes(user.email), 'no email');
  assert.doesNotMatch(kept, /evil|<|>|\(|\)|,/);
  assert.deepEqual(labels(await historyOf(t)), ['Declined by Aisha CFO Ben Staff (Owner) and Owner']);
  await t.w.client.close();
});

test('a person who left, was renamed or lost their account keeps their name and title on an old decline', async () => {
  const t = await setup();
  await rename(t, { 'u-two': 'Aisha', 'u-three': 'Ben' });
  const made = await declinedPayment(t, 'tx_key_leaver01', ['u-two', 'u-three']);
  const said = 'Declined by Aisha (Owner) and Ben (Owner)';
  assert.deepEqual(labels(await historyOf(t)), [said]);
  // Renamed: the old label does not change.
  await rename(t, { 'u-two': 'Zed Renamed' });
  assert.deepEqual(labels(await historyOf(t)), [said]);
  // Left the business (membership gone): the name still shows.
  await t.w.client.exec(`DELETE FROM memberships WHERE user_id = 'u-two'`);
  assert.deepEqual(labels(await historyOf(t)), [said]);
  assert.equal(declinedByAllLabel((await panelOf(t, made.signingRequest.id)).request.declinedBy), said);
  // The account removed altogether: the decline record outlives it, with the label as it was.
  await t.w.client.exec(`DELETE FROM users WHERE id = 'u-two'`);
  assert.deepEqual(labels(await historyOf(t)), [said]);
  assert.equal(declinedByAllLabel((await panelOf(t, made.signingRequest.id)).request.declinedBy), said);
  assert.equal((await signers(t, made.signingRequest.id)).filter((r) => r.declinedAt).length, 2, 'the record of who declined is still there');
  await t.w.client.close();
});

test('a decline from before the snapshot reads the live name and title while the person is a member, else "an owner"', async () => {
  const t = await setup();
  await rename(t, { 'u-two': 'Aisha', 'u-three': 'Ben' });
  const made = await declinedPayment(t, 'tx_key_oldrow01', ['u-two', 'u-three']);
  await t.w.client.exec(`UPDATE wallet_signing_signers SET declined_name = NULL, declined_title = NULL WHERE request_id = '${made.signingRequest.id}'`);
  assert.deepEqual(labels(await historyOf(t)), ['Declined by Aisha (Owner) and Ben (Owner)'], 'still members: their live name and title');
  await rename(t, { 'u-two': 'Aisha Renamed' });
  await t.w.client.exec(`UPDATE memberships SET role = 'maker' WHERE user_id = 'u-three'`);
  assert.deepEqual(labels(await historyOf(t)), ['Declined by Aisha Renamed (Owner) and Ben (Staff)'], 'no snapshot: the live card');
  await t.w.client.exec(`DELETE FROM memberships WHERE user_id = 'u-two'`);
  assert.deepEqual(labels(await historyOf(t)), ['Declined by Ben (Staff) and 1 more'], 'a leaver with no snapshot is counted, not named, in History');
  assert.equal(declinedByAllLabel((await panelOf(t, made.signingRequest.id)).request.declinedBy), 'Declined by Ben (Staff) and an owner', 'the panel names everyone: the leaver with no snapshot is "an owner", not a count');
  await t.w.client.exec(`DELETE FROM memberships WHERE user_id = 'u-three'`);
  assert.deepEqual(labels(await historyOf(t)), ['Declined by an owner']);
  assert.equal(declinedByAllLabel((await panelOf(t, made.signingRequest.id)).request.declinedBy), 'Declined by an owner and an owner', 'two leavers with no snapshot: two owners, not "2 more"');
  await t.w.client.close();
});

test('a hostile name or title in the record is said as plain words: one bracket pair at most, no comma, link or second person', async () => {
  const t = await setup();
  const made = await declinedPayment(t, 'tx_key_hostile1', ['u-two', 'u-three']);
  await t.w.client.exec(`UPDATE wallet_signing_signers SET declined_name = 'Aisha (CFO), Ben', declined_title = 'Owner), Ben (Owner' WHERE request_id = '${made.signingRequest.id}' AND user_id = 'u-two'`);
  await t.w.client.exec(`UPDATE wallet_signing_signers SET declined_name = 'https://evil.example Chen', declined_title = '[Finance](https://evil.example)' WHERE request_id = '${made.signingRequest.id}' AND user_id = 'u-three'`);
  const [entry] = await historyOf(t);
  // The link is never shown; the plain word before it is (a bracket is a space, so "[Finance](https://…)" is "Finance").
  assert.equal(entry.status.label, 'Declined by Aisha CFO Ben (Owner Ben Owner) and Finance');
  const full = declinedByAllLabel((await panelOf(t, made.signingRequest.id)).request.declinedBy);
  assert.doesNotMatch(full, /evil|https?|<|>|\[|\]|,/);
  assert.equal(full.split('(').length - 1, 1, 'one title, in one pair of brackets');
  await t.w.client.close();
});

test('another business never reads the names: not in the panel, not by id, not in its inbox, not from the store', async () => {
  const t = await setup();
  await rename(t, { 'u-two': 'Aisha', 'u-north': 'Nadia' });
  const recipientId = await savedWallet(t);
  const made = await T.createTransfer(t.deps(), OWNER, input(recipientId, 'tx_key_tenant01'));
  assert.equal((await declineSigningRequest(t.w.signing, { orgId: 'acme', userId: 'u-two', id: made.signingRequest.id })).ok, true);
  const seen = await panelOf(t, made.signingRequest.id, 'u-north', 'northwind');
  assert.equal(seen.ok, false);
  assert.equal(seen.status, 404, 'Acme’s request reads as absent to Northwind');
  assert.doesNotMatch(JSON.stringify(seen), /Aisha/);
  assert.deepEqual(await signingInbox(t.w.signing, { orgId: 'northwind', userId: 'u-north' }), []);
  // A Northwind person asking as Acme is not a signer there: absent as well.
  const crossed = await panelOf(t, made.signingRequest.id, 'u-north', 'acme');
  assert.equal(crossed.ok, false);
  assert.doesNotMatch(JSON.stringify(crossed), /Aisha/);
  assert.deepEqual([...(await declinersOfRequests(t.w.db, 'northwind', [made.signingRequest.id])).keys()], []);
  await t.w.client.close();
});

test('an ask an owner declined keeps the owner’s name and title as they were, and an ask from before the snapshot reads the live card', async () => {
  const t = await setup();
  await rename(t, { 'u-two': 'Aisha' });
  const db = t.w.db;
  await db.insert(schema.walletApprovalAsks).values({ id: 'wpa_snap1', orgId: 'acme', intentId: 'intent-a', requestedBy: 'u-three', intent: {}, note: null, contentHash: 'h', walrusBlobId: 'b', status: 'open', expiresAt: new Date(T0.getTime() + 86_400_000) });
  const declined = await declineApprovalAsk(db, { orgId: 'acme', userId: 'u-two', askId: 'wpa_snap1', now: () => T0 });
  assert.equal(declined.ok, true, JSON.stringify(declined));
  const [row] = await db.select().from(schema.walletApprovalAsks).where(eq(schema.walletApprovalAsks.id, 'wpa_snap1'));
  assert.deepEqual([row.decidedName, row.decidedTitle], ['Aisha', 'Owner']);
  await rename(t, { 'u-two': 'Zed' });
  await t.w.client.exec(`DELETE FROM memberships WHERE user_id = 'u-two'`);
  await t.w.client.exec(`DELETE FROM users WHERE id = 'u-two'`);
  assert.deepEqual(await askDeclinerOf(db, 'acme', 'wpa_snap1'), { names: [{ name: 'Aisha', title: 'Owner' }], unnamed: 0 }, 'renamed, left and deleted: the label is as it was');
  assert.equal(await askDeclinerOf(db, 'northwind', 'wpa_snap1'), null, 'another business is told nothing');
  // An ask declined before the snapshot: the live card while they are a member.
  await t.w.client.exec(`INSERT INTO users (id, email, name) VALUES ('u-old', 'old@acme.test', 'Olu')`);
  await t.w.client.exec(`INSERT INTO memberships (id, user_id, org_id, role) VALUES ('m-old', 'u-old', 'acme', 'admin')`);
  await t.w.client.exec(`INSERT INTO wallet_approval_asks (id, org_id, intent_id, requested_by, intent, content_hash, walrus_blob_id, status, decided_by, decided_at, expires_at) VALUES ('wpa_old1', 'acme', 'intent-b', 'u-three', '{}', 'h', 'b', 'declined', 'u-old', '${T0.toISOString()}', '${new Date(T0.getTime() + 86_400_000).toISOString()}')`);
  assert.deepEqual(await askDeclinerOf(db, 'acme', 'wpa_old1'), { names: [{ name: 'Olu', title: 'Owner' }], unnamed: 0 });
  await t.w.client.exec(`DELETE FROM memberships WHERE user_id = 'u-old'`);
  assert.deepEqual(await askDeclinerOf(db, 'acme', 'wpa_old1'), { names: [], unnamed: 1 }, 'no snapshot and gone: an owner');
  await t.w.client.close();
});

// ─── v2 Phase 3 (p3-member-title): the member's own title is the title in the label ───

const titleOf = (t, userId, title, actor = 'u-founder') => setMemberTitle(t.w.db, { orgId: 'acme', actorUserId: actor, userId, title, now: () => T0 });

test('a title an owner gave is the title in "Declined by", in History and in the panel; with none, the role word as before', async () => {
  const t = await setup();
  await rename(t, { 'u-two': 'Aisha', 'u-three': 'Ben' });
  assert.equal((await titleOf(t, 'u-two', 'CFO')).ok, true);
  // Ben sets his own, and it is not "Owner" either.
  assert.equal((await titleOf(t, 'u-three', 'Finance lead', 'u-three')).ok, true);
  const made = await declinedPayment(t, 'tx_key_mtitle01', ['u-two', 'u-three']);
  assert.deepEqual(await snapshotOf(t, made.signingRequest.id, 'u-two'), { name: 'Aisha', title: 'CFO' });
  assert.deepEqual(labels(await historyOf(t)), ['Declined by Aisha (CFO) and Ben (Finance lead)']);
  assert.equal(declinedByAllLabel((await panelOf(t, made.signingRequest.id)).request.declinedBy), 'Declined by Aisha (CFO) and Ben (Finance lead)');
  // Someone with no title is still the role word.
  const second = await setup();
  await rename(second, { 'u-two': 'Aisha', 'u-three': 'Ben' });
  assert.equal((await titleOf(second, 'u-two', 'CFO')).ok, true);
  await declinedPayment(second, 'tx_key_mtitle02', ['u-two', 'u-three']);
  assert.deepEqual(labels(await historyOf(second)), ['Declined by Aisha (CFO) and Ben (Owner)']);
  await t.w.client.close();
  await second.w.client.close();
});

test('an old decline keeps the title it was made under: a new title, a cleared title, leaving or removal change nothing', async () => {
  const t = await setup();
  await rename(t, { 'u-two': 'Aisha', 'u-three': 'Ben' });
  await titleOf(t, 'u-two', 'CFO');
  const made = await declinedPayment(t, 'tx_key_mtitle03', ['u-two', 'u-three']);
  const said = 'Declined by Aisha (CFO) and Ben (Owner)';
  assert.deepEqual(labels(await historyOf(t)), [said]);
  await titleOf(t, 'u-two', 'Chair');
  await titleOf(t, 'u-three', 'Treasurer', 'u-three');
  assert.deepEqual(labels(await historyOf(t)), [said], 'a new title does not rewrite an old decline');
  await titleOf(t, 'u-two', '');
  assert.deepEqual(labels(await historyOf(t)), [said], 'clearing does not either');
  await t.w.client.exec(`DELETE FROM memberships WHERE user_id = 'u-two'`);
  assert.equal(declinedByAllLabel((await panelOf(t, made.signingRequest.id)).request.declinedBy), said, 'and a leaver still shows with the title they had');
  // A decline made after the change carries the new title.
  const later = await declinedPayment(t, 'tx_key_mtitle04', ['u-three']);
  assert.deepEqual(await snapshotOf(t, later.signingRequest.id, 'u-three'), { name: 'Ben', title: 'Treasurer' });
  await t.w.client.close();
});

test('a decline from before the snapshot reads the member’s live title while they are a member', async () => {
  const t = await setup();
  await rename(t, { 'u-two': 'Aisha', 'u-three': 'Ben' });
  const made = await declinedPayment(t, 'tx_key_mtitle05', ['u-two', 'u-three']);
  await t.w.client.exec(`UPDATE wallet_signing_signers SET declined_name = NULL, declined_title = NULL WHERE request_id = '${made.signingRequest.id}'`);
  await titleOf(t, 'u-two', 'CFO');
  assert.deepEqual(labels(await historyOf(t)), ['Declined by Aisha (CFO) and Ben (Owner)']);
  await titleOf(t, 'u-two', 'Chair');
  assert.deepEqual(labels(await historyOf(t)), ['Declined by Aisha (Chair) and Ben (Owner)'], 'no snapshot: the live title');
  await t.w.client.close();
});

test('an ask an owner declined keeps that owner’s title as it was', async () => {
  const t = await setup();
  await rename(t, { 'u-two': 'Aisha' });
  await titleOf(t, 'u-two', 'CFO');
  await t.w.db.insert(schema.walletApprovalAsks).values({ id: 'wpa_mtitle1', orgId: 'acme', intentId: 'intent-m', requestedBy: 'u-three', intent: {}, note: null, contentHash: 'h', walrusBlobId: 'b', status: 'open', expiresAt: new Date(T0.getTime() + 86_400_000) });
  assert.equal((await declineApprovalAsk(t.w.db, { orgId: 'acme', userId: 'u-two', askId: 'wpa_mtitle1', now: () => T0 })).ok, true);
  await titleOf(t, 'u-two', 'Chair');
  assert.deepEqual(await askDeclinerOf(t.w.db, 'acme', 'wpa_mtitle1'), { names: [{ name: 'Aisha', title: 'CFO' }], unnamed: 0 });
  await t.w.client.close();
});

test('another business’s title is never read into this business’s label', async () => {
  const t = await setup();
  await rename(t, { 'u-two': 'Aisha', 'u-north': 'Nadia' });
  await t.w.client.exec(`UPDATE memberships SET title = 'Northwind Chair' WHERE user_id = 'u-north'`);
  await titleOf(t, 'u-two', 'CFO');
  const made = await declinedPayment(t, 'tx_key_mtitle06', ['u-two']);
  const all = JSON.stringify([await historyOf(t), (await panelOf(t, made.signingRequest.id)).request.declinedBy]);
  assert.doesNotMatch(all, /Northwind Chair|Nadia/);
  assert.equal((await titleOf(t, 'u-north', 'Spy')).ok, false, 'an acme owner cannot set a northwind person’s title');
  await t.w.client.close();
});

test('migration 0081 adds the snapshot columns to both records and is last in the journal', async () => {
  const { readFileSync } = await import('node:fs');
  const sql = readFileSync(new URL('../drizzle/0081_decliner_snapshot.sql', import.meta.url), 'utf8');
  for (const column of ['declined_name', 'declined_title', 'decided_name', 'decided_title']) assert.match(sql, new RegExp(`"${column}"`), column);
  assert.doesNotMatch(sql, /DROP TABLE|CASCADE/i, 'nothing is dropped but one foreign key, by name');
  const journal = JSON.parse(readFileSync(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8'));
  const tags = journal.entries.map((entry) => entry.tag);
  const at = tags.indexOf('0081_decliner_snapshot');
  assert.notEqual(at, -1, 'it is in the journal');
  // Later migrations (0082, the invitation email) may follow it; none may come in between or take its number.
  assert.equal(tags[at - 1]?.slice(0, 4), '0080', 'it follows 0080');
  for (const later of tags.slice(at + 1)) assert.ok(Number(later.slice(0, 4)) > 81, `${later} comes after it`);
});
