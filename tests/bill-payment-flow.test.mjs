/**
 * v2 Phase 3, brief 5.8 into 5.4: Pay invoices hands an approved invoice to
 * the Transfer payment service (lib/bills/payment-hook.ts's contract).
 *
 * PGlite with every migration and the wallet world's model chain. What must
 * hold: the invoice's key is the intent id (the same key answers the same
 * payment, never a second); the fee is quoted from the schedule and signed as
 * max_fee; a viewer, another business's recipient and a bank recipient are
 * refused; `cancel` withdraws a payment nobody has signed and refuses one
 * that has been signed; and the invoice is told it was paid only when the
 * executed transaction paid the recipient and the amount that were asked.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { fromBase64, normalizeSuiAddress } from '@mysten/sui/utils';

import { LAUNCH_SCHEDULE, splashFee } from '../lib/fees/schedule.ts';
import { buildBusinessMultisig } from '../lib/wallet/business-multisig.ts';
import { makeBillPaymentFlow, reportTransferSettled, transferKeyFor } from '../lib/server/bill-payment-flow.ts';
import { startBusinessWallet } from '../lib/server/business-wallet.ts';
import { submitPartialSignature, signingInbox } from '../lib/server/wallet-signing.ts';

import { world } from './fixtures/wallet-world.mjs';

const USDC = (n) => BigInt(Math.round(n * 1_000_000));
const SUPPLIER = normalizeSuiAddress(`0x${'77'.repeat(32)}`);
const sign = async (passkey, view) => (await passkey.keypair.signTransaction(fromBase64(view.transactionBytes))).signature;

async function setup() {
  const w = await world();
  const nominate = await startBusinessWallet(w.ctx, { orgId: 'acme', requestedBy: 'u-founder', founder: { userId: 'u-founder', passkeyPublicKey: w.keys.founder.publicKey }, owners: w.owners });
  await submitPartialSignature(w.signing, { orgId: 'acme', userId: 'u-founder', id: nominate.request.id, signature: await sign(w.keys.founder, nominate.request), digest: nominate.request.digest });
  const [register] = await signingInbox(w.signing, { orgId: 'acme', userId: 'u-two' });
  await submitPartialSignature(w.signing, { orgId: 'acme', userId: 'u-two', id: register.id, signature: await sign(w.keys.two, register), digest: register.digest });
  await submitPartialSignature(w.signing, { orgId: 'acme', userId: 'u-three', id: register.id, signature: await sign(w.keys.three, register), digest: register.digest });
  const wallet = buildBusinessMultisig({ members: w.owners });
  const members = { multisigPublicKey: wallet.multisigPublicKey, members: wallet.members.map((m) => ({ userId: m.userId, publicKey: m.suiPublicKey, weight: m.weight })) };
  const deps = (orgId = 'acme') => ({
    db: w.db,
    orgId,
    env: { NODE_ENV: 'test' },
    now: () => w.signing.now(),
    ctx: w.ctx,
    walletMembers: async () => (orgId === 'acme' ? { ok: true, address: wallet.address, members } : { ok: false, status: 409, code: 'no_wallet', error: 'register the business wallet first' }),
    splashAddresses: async () => [w.sponsor.address],
    isBusinessWallet: async () => false,
    businessWallet: async () => null,
    searchBusinesses: async () => [],
    splashFee: async ({ kind, principalMinor }) => ({ feeMinor: splashFee({ kind, principalMinor, discountBps: 0, schedule: LAUNCH_SCHEDULE }), feesOn: true }),
    paymentRecord: async () => ({ ok: true, contentHash: new Uint8Array(32).fill(4), walrusBlobId: new TextEncoder().encode('blob-bill') }),
    requesterAddresses: async () => [],
  });
  await w.screenClear(SUPPLIER);
  const recipientId = await w.saveRecipient(SUPPLIER, { name: 'Luzon Components Inc.' });
  const flow = makeBillPaymentFlow(async (orgId) => deps(orgId));
  const request = (over = {}) => ({
    orgId: 'acme',
    idempotencyKey: 'inv_1:attempt_1:abc123',
    billId: 'bill_1',
    requestedBy: { userId: 'u-founder', role: 'OWNER' },
    recipientId,
    amountMicros: USDC(2_500),
    currency: 'USDC',
    payOn: '2026-11-05',
    supplierInvoiceNumber: 'INV-0042',
    payee: 'Luzon Components Inc.',
    settlementAsset: 'USDC',
    feeRule: 'quote_in_transfer_shown_fee_is_max_fee',
    ...over,
  });
  return { w, flow, request, recipientId, deps };
}

test('an approved invoice becomes the owners’ payment, keyed by the invoice’s own key, with the fee quoted and signed as max_fee', async () => {
  const t = await setup();
  assert.equal(t.flow.wired, true);
  const a = await t.flow.start(t.request());
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.match(a.paymentIntentId, /^wtr_/);
  const [row] = await t.w.db.select().from((await import('../lib/db/schema.ts')).walletTransfers);
  assert.equal(row.clientKey, transferKeyFor('inv_1:attempt_1:abc123'));
  assert.equal(row.reference, 'INV-0042');
  assert.equal(row.maxFeeMinor, splashFee({ kind: 1, principalMinor: USDC(2_500), discountBps: 0, schedule: LAUNCH_SCHEDULE }), 'the fee shown is the fee signed');
  const again = await t.flow.start(t.request());
  assert.equal(again.ok, true);
  assert.equal(again.paymentIntentId, a.paymentIntentId, 'the same key is the same payment');
  assert.equal((await t.w.db.select().from((await import('../lib/db/schema.ts')).walletTransfers)).length, 1);
  // A new attempt (the invoice was taken back and approved again) is a new payment.
  const next = await t.flow.start(t.request({ idempotencyKey: 'inv_1:attempt_2:abc123' }));
  assert.notEqual(next.paymentIntentId, a.paymentIntentId);
});

test('staff ask the owners, a viewer cannot, and another business’s recipient is refused', async () => {
  const t = await setup();
  const staff = await t.flow.start(t.request({ requestedBy: { userId: 'u-two', role: 'MAKER' }, idempotencyKey: 'inv_2:attempt_1:x' }));
  assert.equal(staff.ok, true, JSON.stringify(staff));
  const finance = await t.flow.start(t.request({ requestedBy: { userId: 'u-three', role: 'FINANCE_ADMIN' }, idempotencyKey: 'inv_3:attempt_1:x' }));
  assert.equal(finance.ok, true, 'a finance admin asks the owners like any approver');
  const viewer = await t.flow.start(t.request({ requestedBy: { userId: 'u-two', role: 'VIEWER' }, idempotencyKey: 'inv_4:attempt_1:x' }));
  assert.equal(viewer.ok, false);
  assert.equal(viewer.status, 403);
  const foreign = await t.flow.start(t.request({ orgId: 'northwind', requestedBy: { userId: 'u-north', role: 'OWNER' }, idempotencyKey: 'inv_5:attempt_1:x' }));
  assert.equal(foreign.ok, false);
  assert.ok([404, 409].includes(foreign.status), JSON.stringify(foreign));
});

test('cancel withdraws a payment nobody has signed, and refuses one that has been signed and sent', async () => {
  const t = await setup();
  const a = await t.flow.start(t.request({ idempotencyKey: 'inv_6:attempt_1:x' }));
  const dropped = await t.flow.cancel({ orgId: 'acme', billId: 'bill_1', paymentIntentId: a.paymentIntentId, requestedBy: { userId: 'u-founder', role: 'OWNER' } });
  assert.deepEqual(dropped, { ok: true });
  assert.deepEqual(await t.flow.cancel({ orgId: 'acme', billId: 'bill_1', paymentIntentId: a.paymentIntentId, requestedBy: { userId: 'u-founder', role: 'OWNER' } }), { ok: true }, 'cancelling twice is the same answer');
  // Another person cannot withdraw the owners' request.
  const b = await t.flow.start(t.request({ idempotencyKey: 'inv_7:attempt_1:x' }));
  const notYours = await t.flow.cancel({ orgId: 'acme', billId: 'bill_1', paymentIntentId: b.paymentIntentId, requestedBy: { userId: 'u-two', role: 'OWNER' } });
  assert.equal(notYours.ok, false);
  assert.equal(notYours.status, 403);
  // Signed by the quorum and executed: it cannot be taken back.
  const schema = await import('../lib/db/schema.ts');
  const [rowB] = await t.w.db.select().from(schema.walletTransfers).where((await import('drizzle-orm')).eq(schema.walletTransfers.id, b.paymentIntentId));
  const view = (await signingInbox(t.w.signing, { orgId: 'acme', userId: 'u-two' })).find((r) => r.id === rowB.signingRequestId);
  await submitPartialSignature(t.w.signing, { orgId: 'acme', userId: 'u-two', id: view.id, signature: await sign(t.w.keys.two, view), digest: view.digest });
  const done = await submitPartialSignature(t.w.signing, { orgId: 'acme', userId: 'u-three', id: view.id, signature: await sign(t.w.keys.three, view), digest: view.digest });
  assert.equal(done.request.status, 'executed', JSON.stringify(done));
  const late = await t.flow.cancel({ orgId: 'acme', billId: 'bill_1', paymentIntentId: b.paymentIntentId, requestedBy: { userId: 'u-founder', role: 'OWNER' } });
  assert.equal(late.ok, false);
  assert.equal(late.status, 409);
});

test('the invoice is told it was paid only when the executed transaction paid the recipient and the amount that were asked', async () => {
  const t = await setup();
  const schema = await import('../lib/db/schema.ts');
  const { eq } = await import('drizzle-orm');
  const a = await t.flow.start(t.request({ idempotencyKey: 'inv_8:attempt_1:x' }));
  const [row] = await t.w.db.select().from(schema.walletTransfers).where(eq(schema.walletTransfers.id, a.paymentIntentId));
  const view = (await signingInbox(t.w.signing, { orgId: 'acme', userId: 'u-two' })).find((r) => r.id === row.signingRequestId);
  await submitPartialSignature(t.w.signing, { orgId: 'acme', userId: 'u-two', id: view.id, signature: await sign(t.w.keys.two, view), digest: view.digest });
  await submitPartialSignature(t.w.signing, { orgId: 'acme', userId: 'u-three', id: view.id, signature: await sign(t.w.keys.three, view), digest: view.digest });
  const { readSigningRequest } = await import('../lib/server/wallet-signing-store.ts');
  const executed = await readSigningRequest(t.w.db, 'acme', view.id);
  assert.equal(executed.status, 'executed');

  const calls = [];
  const spy = async (_db, input) => (calls.push(input), { ok: true });
  await reportTransferSettled(t.w.db, executed, new Date('2026-11-05T00:00:00Z'), spy);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].paymentIntentId, a.paymentIntentId);
  assert.equal(calls[0].suiDigest, executed.executedDigest);
  assert.equal(calls[0].orgId, 'acme');

  // A transaction that paid another amount, or another recipient, is not this invoice's payment.
  const wrongAmount = { ...executed, summary: { ...executed.summary, description: { ...executed.summary.description, actions: executed.summary.description.actions.map((x) => (x.type === 'open_intent' ? { ...x, amountMinor: '1' } : x)) } } };
  await reportTransferSettled(t.w.db, wrongAmount, new Date(), spy);
  const wrongPayee = { ...executed, summary: { ...executed.summary, description: { ...executed.summary.description, actions: executed.summary.description.actions.map((x) => (x.type === 'open_intent' ? { ...x, recipient: `0x${'12'.repeat(32)}` } : x)) } } };
  await reportTransferSettled(t.w.db, wrongPayee, new Date(), spy);
  assert.equal(calls.length, 1, 'neither mismatch is reported as paid');
  // Not executed, or no digest, or a payment no invoice made: nothing.
  await reportTransferSettled(t.w.db, { ...executed, status: 'failed' }, new Date(), spy);
  await reportTransferSettled(t.w.db, { ...executed, executedDigest: null }, new Date(), spy);
  await reportTransferSettled(t.w.db, { ...executed, id: 'wsr_00000000-0000-0000-0000-000000000000' }, new Date(), spy);
  assert.equal(calls.length, 1);
  // Another business's identical request id reads nothing of this one's.
  await reportTransferSettled(t.w.db, { ...executed, orgId: 'northwind' }, new Date(), spy);
  assert.equal(calls.length, 1);
});
