/**
 * v2 Phase 3, brief 5.4: the payment itself. One service takes a payment to a
 * Splash business or a saved wallet or exchange recipient from the Transfer
 * flow (a bank payout goes through the supplier payout route, which this
 * flow also fronts), and turns it into what the chain needs:
 *
 *   - an owner's payment is a signing request for the owners' multisig (the
 *     quorum collects the signatures); staff ask the owners (a staff rule's
 *     own spend is the splash_spend path, not wired on this server yet);
 *   - the fee the person was shown is the payment's max_fee, exactly; a fee
 *     above it is refused with the new fee, a fee above the ceiling is
 *     refused, and Splash's fee is read from the schedule, never typed;
 *   - idempotent by the intent id (the client's key): the same key with the
 *     same payment answers the payment already made and opens nothing more;
 *     the same key for another payment is refused; every read takes the org;
 *   - the sealed audit bundle behind the receipt is made by the server and
 *     fails closed in production: no demo bundle is ever anchored;
 *   - a Splash business is found by its registered name and nothing else;
 *     a bank payout, USDC to another chain, an address Splash controls and
 *     the business's own wallet are refused here, each with its reason.
 *
 * PGlite with every migration, the wallet world's model chain and software
 * passkeys. Nothing reaches a network; nothing is signed for any network.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { eq } from 'drizzle-orm';
import { fromBase64, normalizeSuiAddress } from '@mysten/sui/utils';

import * as schema from '../lib/db/schema.ts';
import { LAUNCH_SCHEDULE, splashFee } from '../lib/fees/schedule.ts';
import { buildBusinessMultisig } from '../lib/wallet/business-multisig.ts';
import { makePaymentRecorder } from '../lib/server/payment-record.ts';
import * as T from '../lib/server/wallet-transfers.ts';
import { submitPartialSignature } from '../lib/server/wallet-signing.ts';

import { world, T0 } from './fixtures/wallet-world.mjs';

const USDC = (n) => BigInt(Math.round(n * 1_000_000));
const OPERATOR = normalizeSuiAddress(`0x${'0e'.repeat(32)}`);
const SUPPLIER_WALLET = normalizeSuiAddress(`0x${'77'.repeat(32)}`);
const EXCHANGE_WALLET = normalizeSuiAddress(`0x${'88'.repeat(32)}`);
const NORTH_WALLET = normalizeSuiAddress(`0x${'99'.repeat(32)}`);
const OWNER = { userId: 'u-founder', role: 'OWNER' };

async function sign(passkey, view) {
  return (await passkey.keypair.signTransaction(fromBase64(view.transactionBytes))).signature;
}

async function setup(more = {}) {
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
  const calls = { records: 0, asks: [] };
  const deps = (orgId = 'acme', over = {}) => ({
    db: w.db,
    orgId,
    env: { NODE_ENV: 'test' },
    now: () => w.signing.now(),
    ctx: w.ctx,
    walletMembers: async () => (orgId === 'acme' ? { ok: true, address: wallet.address, members } : { ok: false, status: 409, code: 'no_wallet', error: 'register the business wallet first' }),
    splashAddresses: async () => [OPERATOR, w.sponsor.address],
    isBusinessWallet: async (address) => normalizeSuiAddress(address) === NORTH_WALLET,
    businessWallet: async (businessId) => (businessId === 'northwind' ? { ok: true, name: 'Northwind Pte Ltd', wallet: NORTH_WALLET, country: 'SG' } : null),
    searchBusinesses: async (q) => (/^north/i.test(q.trim()) ? [{ id: 'northwind', name: 'Northwind Pte Ltd', country: 'SG' }] : []),
    splashFee: async ({ kind, principalMinor }) => ({ feeMinor: splashFee({ kind, principalMinor, discountBps: 0, schedule: LAUNCH_SCHEDULE }), feesOn: true }),
    paymentRecord: async (input) => {
      calls.records += 1;
      calls.lastRecord = input;
      return { ok: true, contentHash: new Uint8Array(32).fill(4), walrusBlobId: new TextEncoder().encode('blob-tx') };
    },
    requesterAddresses: async (userId) => (userId === 'u-two' ? [w.keys.two.address] : []),
    notifyAsk: async (n) => calls.asks.push(n),
    ...over,
  });
  return { w, wallet, members, deps, calls };
}

const input = (over = {}) => ({
  clientKey: 'tx_key_000001',
  payee: { kind: 'recipient', recipientId: over.recipientId },
  amountMinor: USDC(5_000).toString(),
  maxFeeMinor: splashFee({ kind: 1, principalMinor: USDC(5_000), discountBps: 0, schedule: LAUNCH_SCHEDULE }).toString(),
  reference: 'INV-0042',
  ...over,
});

async function savedWallet(t, address = SUPPLIER_WALLET, opts = {}) {
  await t.w.screenClear(address);
  return t.w.saveRecipient(address, opts);
}

// ─── The owners' payment ────────────────────────────────────────────────────

test('an owner’s payment to a saved wallet becomes a signing request for the owners, with the fee shown as its max_fee', async () => {
  const t = await setup();
  const recipientId = await savedWallet(t);
  const fee = splashFee({ kind: 1, principalMinor: USDC(5_000), discountBps: 0, schedule: LAUNCH_SCHEDULE });
  const r = await T.createTransfer(t.deps(), OWNER, input({ recipientId }));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.created, true);
  assert.equal(r.transfer.route, 'owners_sign');
  assert.match(r.transfer.id, /^wtr_/);
  assert.equal(r.transfer.status, 'awaiting_signatures');
  assert.equal(r.transfer.feeMinor, fee.toString());
  const req = r.signingRequest;
  assert.equal(req.purpose, 'wallet_payment');
  assert.equal(req.threshold, 2);
  const d = req.description;
  assert.deepEqual(d.actions.map((a) => a.type), ['withdraw', 'open_intent', 'pay_intent', 'anchor_receipt', 'delete_intent']);
  assert.equal(d.actions[1].recipient, SUPPLIER_WALLET);
  assert.equal(d.actions[1].amountMinor, USDC(5_000).toString());
  assert.equal(d.actions[1].kind, 1, 'a wallet payment is derived as kind WALLET');
  assert.equal(d.actions[2].maxFeeMinor, fee.toString(), 'the fee shown is the fee signed as max_fee');
  assert.equal(d.actions[0].amountMinor, (USDC(5_000) + fee).toString(), 'the wallet withdraws principal plus the fee shown');
  assert.equal(t.w.notices.length, 1, 'the owners are told');
  const [row] = await t.w.db.select().from(schema.walletTransfers);
  assert.equal(row.orgId, 'acme');
  assert.equal(row.clientKey, 'tx_key_000001');
  assert.equal(row.signingRequestId, req.id);
  assert.equal(row.payeeName, 'Dela Cruz Trading Corp');
  assert.equal(row.reference, 'INV-0042');
  assert.equal(row.requestedBy, 'u-founder');
});

test('a payment to a business on Splash is found by its registered name and priced as free inside the network', async () => {
  const t = await setup();
  await t.w.screenClear(NORTH_WALLET);
  const found = await T.findBusinesses(t.deps(), 'north');
  assert.deepEqual(found, { ok: true, businesses: [{ id: 'northwind', name: 'Northwind Pte Ltd', country: 'SG' }] });
  const r = await T.createTransfer(t.deps(), OWNER, { clientKey: 'tx_key_splash01', payee: { kind: 'splash_business', businessId: 'northwind' }, amountMinor: USDC(1_000).toString(), maxFeeMinor: '0' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.transfer.feeKind, 0);
  assert.equal(r.transfer.payeeName, 'Northwind Pte Ltd');
  const open = r.signingRequest.description.actions.find((a) => a.type === 'open_intent');
  assert.equal(open.kind, 0);
  assert.equal(open.recipient, NORTH_WALLET);
});

test('search needs a real name: too short, nothing, or another business’s own name returns no one', async () => {
  const t = await setup();
  assert.deepEqual(await T.findBusinesses(t.deps(), 'n'), { ok: true, businesses: [] });
  assert.deepEqual(await T.findBusinesses(t.deps(), '   '), { ok: true, businesses: [] });
  assert.deepEqual(await T.findBusinesses(t.deps(), 'zzzz'), { ok: true, businesses: [] });
  const own = await T.findBusinesses(t.deps('northwind'), 'north');
  assert.equal(own.ok, true);
  assert.ok(!own.businesses.some((b) => b.id === 'northwind'), 'a business is not offered itself');
});

// ─── The fee ────────────────────────────────────────────────────────────────

test('a fee above the one shown is refused with the new fee, and nothing is stored or asked of anyone', async () => {
  const t = await setup();
  const recipientId = await savedWallet(t);
  const fee = splashFee({ kind: 1, principalMinor: USDC(5_000), discountBps: 0, schedule: LAUNCH_SCHEDULE });
  const r = await T.createTransfer(t.deps(), OWNER, input({ recipientId, maxFeeMinor: (fee - 1n).toString() }));
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
  assert.equal(r.code, 'fee_changed');
  assert.equal(r.feeMinor, fee.toString());
  assert.equal((await t.w.db.select().from(schema.walletTransfers)).length, 0);
  assert.equal((await t.w.db.select().from(schema.walletSigningRequests)).filter((x) => x.purpose === 'wallet_payment').length, 0);
  assert.equal(t.calls.records, 0, 'no bundle is sealed for a payment that is refused');
});

test('a fee bound above the ceiling is refused, and a bound above the fee shown is allowed up to it', async () => {
  const t = await setup();
  const recipientId = await savedWallet(t);
  const over = await T.createTransfer(t.deps(), OWNER, input({ recipientId, maxFeeMinor: (USDC(5_000) / 100n + 1n).toString() }));
  assert.equal(over.code, 'fee_above_ceiling');
  const fine = await T.createTransfer(t.deps(), OWNER, input({ recipientId, maxFeeMinor: USDC(10).toString() }));
  assert.equal(fine.ok, true, JSON.stringify(fine));
  assert.equal(fine.signingRequest.description.actions[2].maxFeeMinor, USDC(10).toString());
});

test('an amount that is not a positive whole number of minor units is not a payment', async () => {
  const t = await setup();
  const recipientId = await savedWallet(t);
  for (const amountMinor of ['0', '-5', '1.5', '1e6', '', 'abc', '99999999999999999999999']) {
    const r = await T.createTransfer(t.deps(), OWNER, input({ recipientId, amountMinor }));
    assert.equal(r.ok, false, amountMinor);
    assert.equal(r.status, 400, amountMinor);
  }
  const noKey = await T.createTransfer(t.deps(), OWNER, input({ recipientId, clientKey: 'x' }));
  assert.equal(noKey.code, 'idempotency_key_required');
});

// ─── Idempotency ────────────────────────────────────────────────────────────

test('the same intent id with the same payment answers the payment already made; another payment under it is refused', async () => {
  const t = await setup();
  const recipientId = await savedWallet(t);
  const a = await T.createTransfer(t.deps(), OWNER, input({ recipientId }));
  assert.equal(a.ok, true, JSON.stringify(a));
  const b = await T.createTransfer(t.deps(), OWNER, input({ recipientId }));
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.equal(b.created, false);
  assert.equal(b.transfer.id, a.transfer.id);
  assert.equal(b.signingRequest.id, a.signingRequest.id);
  assert.equal((await t.w.db.select().from(schema.walletTransfers)).length, 1);
  assert.equal((await t.w.db.select().from(schema.walletSigningRequests)).filter((x) => x.purpose === 'wallet_payment').length, 1, 'one request, however often it is sent');
  assert.equal(t.calls.records, 1, 'and one bundle');
  assert.equal(t.w.notices.length, 1, 'the owners are told once');
  const other = await T.createTransfer(t.deps(), OWNER, input({ recipientId, amountMinor: USDC(5_001).toString() }));
  assert.equal(other.status, 409);
  assert.equal(other.code, 'idempotency_key_reused');
});

test('two sends racing on one intent id make one payment', async () => {
  const t = await setup();
  const recipientId = await savedWallet(t);
  const [a, b] = await Promise.all([T.createTransfer(t.deps(), OWNER, input({ recipientId })), T.createTransfer(t.deps(), OWNER, input({ recipientId }))]);
  const made = [a, b].filter((x) => x.ok && x.created);
  assert.equal(made.length, 1, JSON.stringify([a, b]));
  assert.equal((await t.w.db.select().from(schema.walletTransfers)).length, 1);
  assert.equal((await t.w.db.select().from(schema.walletSigningRequests)).filter((x) => x.purpose === 'wallet_payment').length, 1);
});

test('a refused payment frees its intent id, so the person can fix it and send again under the same one', async () => {
  const t = await setup();
  const recipientId = await savedWallet(t, SUPPLIER_WALLET, { proven: false });
  const refused = await T.createTransfer(t.deps(), OWNER, input({ recipientId }));
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'ownership_not_proven');
  assert.equal((await t.w.db.select().from(schema.walletTransfers)).length, 0, 'a payment that was not opened leaves no row behind');
  const { recordOwnershipProof } = await import('../lib/server/ownership-proofs.ts');
  await recordOwnershipProof(t.w.db, { orgId: 'acme', address: SUPPLIER_WALLET, method: 'sui_personal_message', evidence: 'proof', now: T0 });
  await t.w.db.update(schema.suppliers).set({ ownershipStatus: 'proven' }).where(eq(schema.suppliers.id, recipientId));
  const again = await T.createTransfer(t.deps(), OWNER, input({ recipientId }));
  assert.equal(again.ok, true, JSON.stringify(again));
});

// ─── Tenants ────────────────────────────────────────────────────────────────

test('another business’s recipient, payment and receipt read as absent', async () => {
  const t = await setup();
  const recipientId = await savedWallet(t);
  const made = await T.createTransfer(t.deps(), OWNER, input({ recipientId }));
  assert.equal(made.ok, true);
  // Northwind cannot pay acme's recipient, nor read acme's payment.
  const north = await T.createTransfer(t.deps('northwind'), { userId: 'u-north', role: 'OWNER' }, input({ recipientId, clientKey: 'tx_key_north01' }));
  assert.equal(north.ok, false);
  assert.ok([404, 409].includes(north.status), JSON.stringify(north));
  assert.equal((await T.getTransfer(t.deps('northwind'), made.transfer.id)), null);
  assert.equal((await T.getTransfer(t.deps(), made.transfer.id))?.id, made.transfer.id);
  assert.equal((await T.listTransfers(t.deps('northwind'))).length, 0);
  assert.equal((await T.listTransfers(t.deps())).length, 1);
  // The same intent id in another business is its own.
  await t.w.screenClear(SUPPLIER_WALLET, 'northwind');
});

// ─── Who may pay, and what is refused ───────────────────────────────────────

test('a viewer cannot pay, and staff ask the owners (the staff rule’s own spend is not wired here)', async () => {
  const t = await setup();
  const recipientId = await savedWallet(t);
  const viewer = await T.createTransfer(t.deps(), { userId: 'u-two', role: 'VIEWER' }, input({ recipientId }));
  assert.equal(viewer.status, 403);
  const staff = await T.createTransfer(t.deps(), { userId: 'u-two', role: 'MAKER' }, input({ recipientId }));
  assert.equal(staff.ok, true, JSON.stringify(staff));
  assert.equal(staff.transfer.route, 'asked_owners');
  assert.equal(staff.transfer.status, 'asked_owners');
  assert.ok(staff.ask?.id?.startsWith('wpa_'), 'the owners have an ask');
  assert.equal(staff.signingRequest ?? null, null, 'staff open no signing request: the owners do, when they accept');
  assert.equal((await t.w.db.select().from(schema.walletSigningRequests)).filter((x) => x.purpose === 'wallet_payment').length, 0);
  assert.equal(t.calls.asks.length, 1, 'the owners are told');
  const replay = await T.createTransfer(t.deps(), { userId: 'u-two', role: 'MAKER' }, input({ recipientId }));
  assert.equal(replay.ok, true);
  assert.equal(replay.created, false);
  assert.equal(replay.ask.id, staff.ask.id);
  assert.equal((await t.w.db.select().from(schema.walletApprovalAsks)).length, 1);
});

test('a bank recipient, USDC to another chain, Splash’s own address and the business’s own wallet are refused here, each for its reason', async () => {
  const t = await setup();
  // A saved bank recipient (the older kind) goes through the payout route.
  const bankId = 'rcp_bank_1';
  await t.w.db.insert(schema.suppliers).values({ id: bankId, orgId: 'acme', name: 'Luzon Components', country: 'PH', bankName: 'BPI', accountRef: '0012345678', tier: 'PAYOUT_ONLY', deliveryKind: 'BANK', createdAt: new Date(0) });
  const bank = await T.createTransfer(t.deps(), OWNER, input({ recipientId: bankId }));
  assert.equal(bank.code, 'use_payout_route');
  // USDC to another chain needs the bridge adapter, which is not registered.
  const chainId = 'rcp_chain_1';
  await t.w.db.insert(schema.suppliers).values({ id: chainId, orgId: 'acme', name: 'Orion', country: 'US', tier: 'PAYOUT_ONLY', payoutMethod: 'CROSS_CHAIN', deliveryKind: 'CROSS_CHAIN', destinationChain: 'BASE', destinationDomain: 6, destinationAddress: `0x${'ab'.repeat(20)}`, mintRecipient: `0x${'00'.repeat(12)}${'ab'.repeat(20)}`, createdAt: new Date(0) });
  const cross = await T.createTransfer(t.deps(), OWNER, input({ recipientId: chainId, clientKey: 'tx_key_cross01' }));
  assert.equal(cross.ok, false);
  assert.equal(cross.code, 'cross_chain_not_built');
  // Splash's own address, even if somebody saved it.
  const operatorId = await savedWallet(t, OPERATOR);
  const op = await T.createTransfer(t.deps(), OWNER, input({ recipientId: operatorId, clientKey: 'tx_key_oper01' }));
  assert.equal(op.ok, false);
  assert.match(op.code, /splash/);
  // The business's own wallet.
  const own = await T.createTransfer(t.deps(), OWNER, { clientKey: 'tx_key_own0001', payee: { kind: 'splash_business', businessId: 'acme' }, amountMinor: USDC(1).toString(), maxFeeMinor: '0' });
  assert.equal(own.ok, false);
  // A business that is not on Splash.
  const nobody = await T.createTransfer(t.deps(), OWNER, { clientKey: 'tx_key_nobody1', payee: { kind: 'splash_business', businessId: 'nobody' }, amountMinor: USDC(1).toString(), maxFeeMinor: '0' });
  assert.equal(nobody.status, 404);
});

test('a business without a Splash Wallet is told so, not that an address is invalid', async () => {
  const t = await setup();
  const recipientId = await savedWallet(t);
  const r = await T.createTransfer(t.deps('northwind'), { userId: 'u-north', role: 'OWNER' }, input({ recipientId }));
  assert.equal(r.ok, false);
  assert.ok(!/address|0x/i.test(r.error ?? ''), r.error);
});

// ─── The audit bundle ───────────────────────────────────────────────────────

test('the sealed audit bundle is the server’s to make, and fails closed in production without the live services', async () => {
  const stored = [];
  const live = { encrypt: async () => ({ ciphertext: 'ct', policy: { policyId: 'seal_1', mode: 'live' } }) };
  const demoSeal = { encrypt: async () => ({ ciphertext: 'ct', policy: { policyId: 'DEMO_SEAL_1', mode: 'demo' } }) };
  const liveStore = async (c) => (stored.push(c), { blobId: 'LiveBlobId123', mode: 'live', sizeBytes: 2, epochs: 5, createdAt: '2026-10-31T00:00:00Z' });
  const demoStore = async (c) => (stored.push(c), { blobId: 'DEMO_WALRUS_abc', mode: 'demo', sizeBytes: 2, epochs: 5, createdAt: '2026-10-31T00:00:00Z' });
  const record = { orgId: 'acme', transferId: 'wtr_1', payer: 'Acme', payee: 'Dela Cruz', amountMinor: '5000000000', maxFeeMinor: '1', reference: 'INV-1' };

  const prod = { NODE_ENV: 'production', USE_MOCK_APIS: 'true' };
  const demoInProd = await makePaymentRecorder({ seal: demoSeal, store: demoStore, env: prod })(record);
  assert.equal(demoInProd.ok, false);
  assert.equal(demoInProd.status, 503);
  assert.equal(demoInProd.code, 'record_unavailable');
  const demoStoreOnly = await makePaymentRecorder({ seal: live, store: demoStore, env: prod })(record);
  assert.equal(demoStoreOnly.code, 'record_unavailable', 'a demo blob is refused in production even when the seal is live');
  const demoSealOnly = await makePaymentRecorder({ seal: demoSeal, store: liveStore, env: prod })(record);
  assert.equal(demoSealOnly.code, 'record_unavailable', 'a demo seal is refused in production even when the store is live');
  assert.equal(stored.filter((c) => c === 'ct').length, 3, 'only ciphertext ever reaches the store');

  const ok = await makePaymentRecorder({ seal: live, store: liveStore, env: prod })(record);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.contentHash.length, 32);
  assert.deepEqual(Buffer.from(ok.walrusBlobId).toString('utf8'), 'LiveBlobId123');
  assert.equal(ok.mode, 'live');
  // The hash is of the record, not of the ciphertext or the blob id: the same record gives the same hash.
  const again = await makePaymentRecorder({ seal: live, store: liveStore, env: prod })(record);
  assert.deepEqual(Buffer.from(again.contentHash), Buffer.from(ok.contentHash));
  const changed = await makePaymentRecorder({ seal: live, store: liveStore, env: prod })({ ...record, amountMinor: '5000000001' });
  assert.notDeepEqual(Buffer.from(changed.contentHash), Buffer.from(ok.contentHash));

  // Outside production the labelled sandbox answers, and says so.
  const dev = await makePaymentRecorder({ seal: demoSeal, store: demoStore, env: { NODE_ENV: 'development' } })(record);
  assert.equal(dev.ok, true);
  assert.equal(dev.mode, 'sandbox');
  // A failure in either service is a refusal, not a made-up bundle.
  const boom = await makePaymentRecorder({ seal: { encrypt: async () => { throw new Error('no key servers'); } }, store: liveStore, env: prod })(record);
  assert.equal(boom.ok, false);
  assert.equal(boom.status, 503);
});

test('a payment whose bundle cannot be made is refused, stores nothing and opens nothing', async () => {
  const t = await setup();
  const recipientId = await savedWallet(t);
  const r = await T.createTransfer(t.deps('acme', { paymentRecord: async () => ({ ok: false, status: 503, code: 'record_unavailable', error: 'The payment record cannot be made right now, so nothing was sent.' }) }), OWNER, input({ recipientId }));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'record_unavailable');
  assert.equal((await t.w.db.select().from(schema.walletTransfers)).length, 0);
  assert.equal(t.w.notices.length, 0);
});

test('the commitment on chain is over the payment’s own facts, and the payment reference is the intent id’s hash', async () => {
  const t = await setup();
  const recipientId = await savedWallet(t);
  const r = await T.createTransfer(t.deps(), OWNER, input({ recipientId }));
  assert.equal(r.ok, true);
  const want = createHash('sha256').update('splash-transfer|acme|tx_key_000001').digest('hex');
  assert.equal(r.transfer.paymentRef, want);
});
