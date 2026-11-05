/**
 * v2 Phase 3, brief 5.4, the independent review's findings on the payment
 * service, each reproduced here before it was fixed:
 *
 *   - a payment a staff member asked for, once an owner accepts it, must be
 *     found by its signing request: the receipt, the share link and the
 *     invoice it paid all read it that way;
 *   - a second request on the same intent id while the first is still being
 *     made is "in progress", never a payment that "failed"; a claim that never
 *     got its request is reclaimed after a while;
 *   - the fee a staff member was shown is bound into the ask, and the owner
 *     signs at least that fee, or confirms a different one;
 *   - a withdrawn ask is "withdrawn", and a retry with another fee under the
 *     same intent id answers the payment already made.
 *
 * PGlite with every migration, the wallet world's model chain, software
 * passkeys. Nothing reaches a network; nothing is signed for any network.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { eq } from 'drizzle-orm';
import { fromBase64, normalizeSuiAddress } from '@mysten/sui/utils';

import * as schema from '../lib/db/schema.ts';
import { LAUNCH_SCHEDULE, splashFee } from '../lib/fees/schedule.ts';
import { buildBusinessMultisig } from '../lib/wallet/business-multisig.ts';
import { reportTransferSettled } from '../lib/server/bill-payment-flow.ts';
import { acceptApprovalAsk, cancelApprovalAsk } from '../lib/server/payment-approval-asks.ts';
import { paymentReceiptFor } from '../lib/server/payment-receipts.ts';
import { mintReceiptShare, readReceiptShare, revokeReceiptShares } from '../lib/server/receipt-documents.ts';
import * as T from '../lib/server/wallet-transfers.ts';
import { submitPartialSignature, signingInbox } from '../lib/server/wallet-signing.ts';
import { readSigningRequest } from '../lib/server/wallet-signing-store.ts';

import { world, CORE, T0 } from './fixtures/wallet-world.mjs';

const USDC = (n) => BigInt(Math.round(n * 1_000_000));
const SUPPLIER = normalizeSuiAddress(`0x${'77'.repeat(32)}`);
const STAFF = { userId: 'u-two', role: 'MAKER' };
const sign = async (passkey, view) => (await passkey.keypair.signTransaction(fromBase64(view.transactionBytes))).signature;
const FEE = splashFee({ kind: 1, principalMinor: USDC(5_000), discountBps: 0, schedule: LAUNCH_SCHEDULE });

async function setup(over = {}) {
  const w = await world();
  const { startBusinessWallet } = await import('../lib/server/business-wallet.ts');
  const nominate = await startBusinessWallet(w.ctx, { orgId: 'acme', requestedBy: 'u-founder', founder: { userId: 'u-founder', passkeyPublicKey: w.keys.founder.publicKey }, owners: w.owners });
  await submitPartialSignature(w.signing, { orgId: 'acme', userId: 'u-founder', id: nominate.request.id, signature: await sign(w.keys.founder, nominate.request), digest: nominate.request.digest });
  const [register] = await signingInbox(w.signing, { orgId: 'acme', userId: 'u-two' });
  await submitPartialSignature(w.signing, { orgId: 'acme', userId: 'u-two', id: register.id, signature: await sign(w.keys.two, register), digest: register.digest });
  await submitPartialSignature(w.signing, { orgId: 'acme', userId: 'u-three', id: register.id, signature: await sign(w.keys.three, register), digest: register.digest });
  const wallet = buildBusinessMultisig({ members: w.owners });
  const members = { multisigPublicKey: wallet.multisigPublicKey, members: wallet.members.map((m) => ({ userId: m.userId, publicKey: m.suiPublicKey, weight: m.weight })) };
  await w.db.update(schema.users).set({ name: 'Priya Sharma' }).where(eq(schema.users.id, 'u-two'));
  await w.db.update(schema.users).set({ name: 'Nadia Rahman' }).where(eq(schema.users.id, 'u-three'));
  await w.db.update(schema.organizations).set({ legalName: 'Acme Trading Sdn. Bhd.', addressCountry: 'MY' }).where(eq(schema.organizations.id, 'acme'));
  let clock = w.signing.now();
  const deps = (extra = {}) => ({
    db: w.db,
    orgId: 'acme',
    env: { NODE_ENV: 'test' },
    now: () => clock,
    ctx: w.ctx,
    walletMembers: async () => ({ ok: true, address: wallet.address, members }),
    splashAddresses: async () => [w.sponsor.address],
    isBusinessWallet: async () => false,
    businessWallet: async () => null,
    searchBusinesses: async () => [],
    splashFee: async ({ kind, principalMinor }) => ({ feeMinor: splashFee({ kind, principalMinor, discountBps: 0, schedule: LAUNCH_SCHEDULE }), feesOn: true }),
    paymentRecord: async () => ({ ok: true, contentHash: new Uint8Array(32).fill(4), walrusBlobId: new TextEncoder().encode('blob-tx') }),
    requesterAddresses: async (userId) => (userId === 'u-two' ? [w.keys.two.address] : []),
    claimWaitMs: 150,
    ...over,
    ...extra,
  });
  await w.screenClear(SUPPLIER);
  const recipientId = await w.saveRecipient(SUPPLIER, { name: 'Luzon Components Inc.' });
  const rdeps = () => ({
    db: w.db,
    orgId: 'acme',
    now: () => w.signing.now(),
    corePackageOriginalId: CORE,
    readTransaction: async (digest) => ({ digest, success: true, sender: wallet.address, balanceChanges: [], events: [{ packageId: CORE, eventType: `${CORE}::fee_config::FeeCharged`, json: { fee: FEE.toString(), derived_kind: 1 } }] }),
    schedule: LAUNCH_SCHEDULE,
    feesOn: true,
    signedPartners: [],
    network: 'mainnet',
  });
  return { w, wallet, members, deps, recipientId, rdeps, advance: (ms) => { clock = new Date(clock.getTime() + ms); } };
}

const request = (t, over = {}) => ({
  clientKey: 'tx_review_0001',
  payee: { kind: 'recipient', recipientId: t.recipientId },
  amountMinor: USDC(5_000).toString(),
  maxFeeMinor: FEE.toString(),
  reference: 'INV-0042',
  ...over,
});

const accept = (t, ask, over = {}) =>
  acceptApprovalAsk({ db: t.w.db, ctx: t.w.ctx }, { orgId: 'acme', userId: 'u-founder', askId: ask.id, mode: 'wallet_pays', wallet: t.members, maxFeeMinor: FEE, settleByMs: BigInt(T0.getTime() + 300_000), ...over });

async function executeRequest(t, view) {
  await submitPartialSignature(t.w.signing, { orgId: 'acme', userId: 'u-two', id: view.id, signature: await sign(t.w.keys.two, view), digest: view.digest });
  const done = await submitPartialSignature(t.w.signing, { orgId: 'acme', userId: 'u-three', id: view.id, signature: await sign(t.w.keys.three, view), digest: view.digest });
  assert.equal(done.request.status, 'executed', JSON.stringify(done));
}

// ─── Staff: ask, accept, execute, receipt ───────────────────────────────────

test('a payment staff asked for is found by its signing request once an owner accepts: the receipt, the share link and the invoice all read it', async () => {
  const t = await setup();
  const made = await T.createTransfer(t.deps(), STAFF, request(t));
  assert.equal(made.ok, true, JSON.stringify(made));
  const accepted = await accept(t, made.ask);
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  const requestId = accepted.request.id;
  const [row] = await t.w.db.select().from(schema.walletTransfers);
  assert.equal(row.signingRequestId, requestId, 'accepting the ask writes the signing request back to the payment');

  await executeRequest(t, accepted.request);

  const receipt = await paymentReceiptFor(t.rdeps(), requestId, 'u-founder');
  assert.equal(receipt.ok, true, JSON.stringify(receipt));
  assert.equal(receipt.receipt.final, true);
  assert.equal(receipt.receipt.payee.name, 'Luzon Components Inc.', 'the payee name survives the staff route');
  assert.equal(receipt.receipt.reference, 'INV-0042');
  assert.equal(receipt.receipt.fees.splash.kindLabel, 'Sui wallet', 'and so does the fee kind');
  assert.equal(await T.receiptRefFor(t.deps(), made.ask.id), requestId, 'the receipt is found by the ask id too');

  const share = await mintReceiptShare(t.w.db, { orgId: 'acme', paymentRef: receipt.receipt.paymentRef, userId: 'u-founder', now: T0 });
  assert.ok((await readReceiptShare(t.w.db, share.token, T0))?.paymentRef);

  // The invoice that asked for this payment is told it was paid.
  const executed = await readSigningRequest(t.w.db, 'acme', requestId);
  const calls = [];
  await reportTransferSettled(t.w.db, executed, new Date('2026-11-05T00:00:00Z'), async (_db, input) => (calls.push(input), { ok: true }));
  assert.equal(calls.length, 1, 'an invoice a staff member paid through Pay invoices is marked paid');
  assert.equal(calls[0].paymentIntentId, row.id);
});

test('a payment that was asked about, but whose request is not written back yet, is still found through its ask', async () => {
  const t = await setup();
  const made = await T.createTransfer(t.deps(), STAFF, request(t));
  const accepted = await accept(t, made.ask);
  await executeRequest(t, accepted.request);
  // An older row, from before the write-back: the link is only through the ask.
  await t.w.db.update(schema.walletTransfers).set({ signingRequestId: null }).where(eq(schema.walletTransfers.id, made.transfer.id));
  const receipt = await paymentReceiptFor(t.rdeps(), accepted.request.id, 'u-founder');
  assert.equal(receipt.ok, true, JSON.stringify(receipt));
  assert.equal(receipt.receipt.payee.name, 'Luzon Components Inc.');
  const executed = await readSigningRequest(t.w.db, 'acme', accepted.request.id);
  const calls = [];
  await reportTransferSettled(t.w.db, executed, new Date(), async (_db, input) => (calls.push(input), { ok: true }));
  assert.equal(calls.length, 1);
});

// ─── The fee staff were shown ───────────────────────────────────────────────

test('the fee shown to staff is bound into the ask: owners sign at least that fee, and a different one only when they confirm it', async () => {
  const t = await setup();
  const made = await T.createTransfer(t.deps(), STAFF, request(t));
  assert.equal(made.ask.intent.maxFeeMinor, FEE.toString(), 'the ask carries the fee that was shown');

  const low = await accept(t, made.ask, { maxFeeMinor: 1n });
  assert.equal(low.ok, false);
  assert.equal(low.status, 409);
  assert.equal(low.code, 'fee_below_shown');
  const high = await accept(t, made.ask, { maxFeeMinor: FEE * 2n });
  assert.equal(high.ok, false);
  assert.equal(high.code, 'fee_change_needs_confirmation');
  const asks = await t.w.db.select().from(schema.walletApprovalAsks);
  assert.equal(asks[0].status, 'open', 'a refused accept claims nothing');

  const dflt = await accept(t, made.ask, { maxFeeMinor: null });
  assert.equal(dflt.ok, true, JSON.stringify(dflt));
  assert.equal(dflt.request.description.actions.find((a) => a.type === 'pay_intent').maxFeeMinor, FEE.toString(), 'no fee sent: the fee shown is signed');
});

test('an owner who confirms a higher fee signs that fee', async () => {
  const t = await setup();
  const made = await T.createTransfer(t.deps(), STAFF, request(t));
  const ok = await accept(t, made.ask, { maxFeeMinor: FEE + 5n, confirmFeeChange: true });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.request.description.actions.find((a) => a.type === 'pay_intent').maxFeeMinor, (FEE + 5n).toString());
});

// ─── A second request while the first is being made ─────────────────────────

test('a second request on the same intent id while the first is still being made is in progress, never a failed payment', async () => {
  const t = await setup();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const slow = t.deps({ paymentRecord: async () => { await gate; return { ok: true, contentHash: new Uint8Array(32).fill(4), walrusBlobId: new TextEncoder().encode('blob-tx') }; } });
  const owner = { userId: 'u-founder', role: 'OWNER' };
  const first = T.createTransfer(slow, owner, request(t));
  await new Promise((r) => setTimeout(r, 50));
  const second = await T.createTransfer(t.deps(), owner, request(t));
  assert.equal(second.ok, false, JSON.stringify(second));
  assert.equal(second.status, 409);
  assert.equal(second.code, 'in_progress');
  release();
  const done = await first;
  assert.equal(done.ok, true, JSON.stringify(done));
  const third = await T.createTransfer(t.deps(), owner, request(t));
  assert.equal(third.ok, true);
  assert.equal(third.created, false);
  assert.equal(third.signingRequest.id, done.signingRequest.id, 'the retry after it finished gets the request to sign');
});

test('a claim that never got its request, because the process died, is reclaimed after a while and the key works again', async () => {
  const t = await setup();
  const dead = { id: 'wtr_dead', orgId: 'acme', clientKey: 'tx_review_0001', requestHash: 'x', paymentRef: 'aa'.repeat(32), route: 'owners_sign', payeeKind: 'self_custody', recipientId: t.recipientId, businessId: null, payeeName: 'x', payeeMasked: null, payeeCountry: null, address: SUPPLIER, amountMinor: 1n, maxFeeMinor: 0n, feeKind: 1, reference: null, requestedBy: 'u-founder', createdAt: t.deps().now(), updatedAt: t.deps().now() };
  await t.w.db.insert(schema.walletTransfers).values(dead);
  const owner = { userId: 'u-founder', role: 'OWNER' };
  const young = await T.createTransfer(t.deps(), owner, request(t));
  assert.equal(young.code, 'in_progress', 'a young claim is still in progress');
  t.advance(10 * 60_000);
  const reclaimed = await T.createTransfer(t.deps(), owner, request(t));
  assert.equal(reclaimed.ok, true, JSON.stringify(reclaimed));
  assert.equal(reclaimed.created, true);
  assert.ok(reclaimed.signingRequest?.id);
  assert.equal((await t.w.db.select().from(schema.walletTransfers)).length, 1, 'the dead claim is gone');
});

test('a database fault is not read as "another request holds this key": it surfaces, and nothing loops', async () => {
  const t = await setup();
  const owner = { userId: 'u-founder', role: 'OWNER' };
  const broken = new Proxy(t.w.db, { get: (target, prop) => (prop === 'insert' ? () => { throw new Error('connection reset'); } : Reflect.get(target, prop)) });
  await assert.rejects(() => T.createTransfer(t.deps({ db: broken }), owner, request(t)), /connection reset/);
});

// ─── Smaller findings ───────────────────────────────────────────────────────

test('a withdrawn ask reads as withdrawn, not failed', async () => {
  const t = await setup();
  const made = await T.createTransfer(t.deps(), STAFF, request(t));
  // The ask was made at the test clock (T0): withdrawing it at the real clock would find it expired once the real date passes its window.
  const out = await cancelApprovalAsk(t.w.db, { orgId: 'acme', userId: 'u-two', askId: made.ask.id, now: t.deps().now });
  assert.equal(out.ok, true);
  const view = await T.getTransfer(t.deps(), made.transfer.id);
  assert.equal(view.status, 'withdrawn');
});

test('a retry under the same intent id with another fee answers the payment already made', async () => {
  const t = await setup();
  const owner = { userId: 'u-founder', role: 'OWNER' };
  const a = await T.createTransfer(t.deps(), owner, request(t));
  assert.equal(a.ok, true, JSON.stringify(a));
  const b = await T.createTransfer(t.deps(), owner, request(t, { maxFeeMinor: (FEE + 100n).toString() }));
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.equal(b.created, false);
  assert.equal(b.transfer.id, a.transfer.id);
});

test('the quote carries the full address and whether the recipient was saved in the last 24 hours, so the review is not approved on a name alone', async () => {
  const t = await setup();
  const q = await T.quoteTransfer(t.deps(), { payee: { kind: 'recipient', recipientId: t.recipientId }, amountMinor: USDC(5_000).toString() });
  assert.equal(q.ok, true, JSON.stringify(q));
  assert.equal(q.quote.payee.address, SUPPLIER);
  assert.equal(q.quote.payee.country, 'PH');
  assert.equal(q.quote.payee.recentlyAdded, false, 'a recipient saved long before is not new');
  await t.w.db.update(schema.suppliers).set({ createdAt: t.deps().now() }).where(eq(schema.suppliers.id, t.recipientId));
  const fresh = await T.quoteTransfer(t.deps(), { payee: { kind: 'recipient', recipientId: t.recipientId }, amountMinor: USDC(5_000).toString() });
  assert.equal(fresh.quote.payee.recentlyAdded, true);
});

test('revoking a receipt link stops it opening, for this business only', async () => {
  const t = await setup();
  const share = await mintReceiptShare(t.w.db, { orgId: 'acme', paymentRef: 'ref-1', userId: 'u-founder', now: T0 });
  assert.ok(await readReceiptShare(t.w.db, share.token, T0));
  assert.equal(await revokeReceiptShares(t.w.db, { orgId: 'northwind', paymentRef: 'ref-1', now: T0 }), 0);
  assert.equal(await revokeReceiptShares(t.w.db, { orgId: 'acme', paymentRef: 'ref-1', now: T0 }), 1);
  assert.equal(await readReceiptShare(t.w.db, share.token, T0), null);
});
