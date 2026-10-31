/**
 * v2 Phase 3, brief 5.4 step 5, the server half: the receipt of a payment
 * that was signed and executed, the link that shares it, and the self-billed
 * e-invoice.
 *
 * PGlite with every migration and the wallet world's model chain. The fee on
 * the receipt is the one the chain charged (the executed transaction's
 * FeeCharged event), not the bound the owners signed; a transaction that
 * cannot be read leaves the receipt not final; another business reads none of
 * it; a link opens one payment, expires and can be revoked, and is kept only
 * as a hash; the e-invoice is made once, remade only after 72 hours with the
 * replaced file's hash kept, and only for a Malaysian business paying a
 * supplier outside Malaysia.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { eq } from 'drizzle-orm';
import { fromBase64, normalizeSuiAddress } from '@mysten/sui/utils';

import * as schema from '../lib/db/schema.ts';
import { LAUNCH_SCHEDULE, splashFee } from '../lib/fees/schedule.ts';
import { buildBusinessMultisig } from '../lib/wallet/business-multisig.ts';
import { feeChargedFrom, paymentReceiptFor } from '../lib/server/payment-receipts.ts';
import { makeEInvoice, mintReceiptShare, readEInvoice, readReceiptShare, revokeReceiptShares, E_INVOICE_FRESH_MS, RECEIPT_LINK_TTL_MS } from '../lib/server/receipt-documents.ts';
import { receiptRows } from '../lib/transfer/receipt.ts';
import * as T from '../lib/server/wallet-transfers.ts';
import { submitPartialSignature, signingInbox } from '../lib/server/wallet-signing.ts';

import { world, CORE, T0 } from './fixtures/wallet-world.mjs';

const USDC = (n) => BigInt(Math.round(n * 1_000_000));
const SUPPLIER = normalizeSuiAddress(`0x${'77'.repeat(32)}`);
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
  await w.db.update(schema.users).set({ name: 'Priya Sharma' }).where(eq(schema.users.id, 'u-two'));
  await w.db.update(schema.users).set({ name: 'Nadia Rahman' }).where(eq(schema.users.id, 'u-three'));
  await w.db.update(schema.organizations).set({ legalName: 'Acme Trading Sdn. Bhd.', addressCountry: 'MY' }).where(eq(schema.organizations.id, 'acme'));
  const deps = {
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
    requesterAddresses: async () => [],
  };
  await w.screenClear(SUPPLIER);
  const recipientId = await w.saveRecipient(SUPPLIER, { name: 'Luzon Components Inc.' });
  const made = await T.createTransfer(deps, { userId: 'u-founder', role: 'OWNER' }, {
    clientKey: 'tx_receipt_0001',
    payee: { kind: 'recipient', recipientId },
    amountMinor: USDC(5_000).toString(),
    maxFeeMinor: USDC(5).toString(),
    reference: 'INV-0042',
  });
  assert.equal(made.ok, true, JSON.stringify(made));
  const feeCharged = { fee: USDC(1).toString(), derived_kind: 1 };
  let readable = true;
  const rdeps = (orgId = 'acme', over = {}) => ({
    db: w.db,
    orgId,
    now: () => w.signing.now(),
    corePackageOriginalId: CORE,
    readTransaction: async (digest) =>
      readable ? { digest, success: true, sender: wallet.address, balanceChanges: [], events: [{ packageId: CORE, eventType: `${CORE}::fee_config::FeeCharged`, json: feeCharged }] } : null,
    schedule: LAUNCH_SCHEDULE,
    feesOn: true,
    signedPartners: [],
    network: 'mainnet',
    ...over,
  });
  return { w, made, deps, rdeps, setReadable: (v) => { readable = v; }, requestId: made.signingRequest.id };
}

async function execute(t) {
  const [a] = [t.made.signingRequest];
  await submitPartialSignature(t.w.signing, { orgId: 'acme', userId: 'u-two', id: a.id, signature: await sign(t.w.keys.two, a), digest: a.digest });
  const done = await submitPartialSignature(t.w.signing, { orgId: 'acme', userId: 'u-three', id: a.id, signature: await sign(t.w.keys.three, a), digest: a.digest });
  assert.equal(done.request.status, 'executed', JSON.stringify(done));
}

test('the receipt of an executed payment shows the fee the chain charged, the people who signed, and a link that checks it', async () => {
  const t = await setup();
  await execute(t);
  const r = await paymentReceiptFor(t.rdeps(), t.requestId, 'u-founder');
  assert.equal(r.ok, true, JSON.stringify(r));
  const receipt = r.receipt;
  assert.equal(receipt.status, 'settled');
  assert.equal(receipt.final, true);
  assert.equal(receipt.fees.splash.minor, USDC(1).toString(), 'the fee charged, not the 5 USDC bound the owners signed');
  assert.equal(receipt.fees.splash.kindLabel, 'Sui wallet');
  assert.deepEqual(receipt.approvers.map((a) => a.name).sort(), ['Nadia Rahman', 'Priya Sharma']);
  assert.equal(receipt.payee.name, 'Luzon Components Inc.');
  assert.equal(receipt.paidFrom, 'Acme Trading Sdn. Bhd.');
  assert.equal(receipt.reference, 'INV-0042');
  assert.match(receipt.verifyUrl, /^https:\/\/suiscan\.xyz\/mainnet\/tx\//);
  assert.equal(r.payerCountry, 'MY');
  assert.equal(r.supplierCountry, 'PH');
  const rows = Object.fromEntries(receiptRows(receipt).map((x) => [x.label, x.value]));
  assert.equal(rows['You paid'], '5,001.00 USDC');
  // A payment that took no fee on chain (fees off, or a free kind) shows none charged.
  const none = await paymentReceiptFor(t.rdeps('acme', { readTransaction: async (digest) => ({ digest, success: true, balanceChanges: [], events: [] }), feesOn: false }), t.requestId, 'u-founder');
  assert.equal(none.receipt.fees.splash.minor, '0');
  assert.match(receiptRows(none.receipt).find((x) => x.label === 'Splash fee').value, /No Splash fee/);
});

test('a payment still waiting for signatures, or whose transaction cannot be read, is not a final receipt', async () => {
  const t = await setup();
  const waiting = await paymentReceiptFor(t.rdeps(), t.requestId, 'u-founder');
  assert.equal(waiting.ok, true, JSON.stringify(waiting));
  assert.equal(waiting.receipt.final, false);
  assert.equal(waiting.receipt.status, 'on_the_way');
  assert.equal(waiting.receipt.verifyUrl, null);
  await execute(t);
  t.setReadable(false);
  const unread = await paymentReceiptFor(t.rdeps(), t.requestId, 'u-founder');
  assert.equal(unread.receipt.final, false, 'the fee could not be read, so it is not final');
  assert.equal(unread.receipt.fees.splash.minor, USDC(5).toString(), 'the bound stays, and is not presented as the charge');
});

test('another business reads no receipt of this one', async () => {
  const t = await setup();
  await execute(t);
  const other = await paymentReceiptFor(t.rdeps('northwind'), t.requestId, 'u-north');
  assert.equal(other.ok, false);
  assert.equal(other.status, 404);
  assert.equal((await paymentReceiptFor(t.rdeps(), 'wsr_00000000-0000-0000-0000-000000000000', 'u-founder')).status, 404);
});

test('the fee is read only from splash_core’s own FeeCharged event', () => {
  const event = (pkg, type, fee) => ({ packageId: pkg, eventType: `${pkg}::${type}`, json: { fee, derived_kind: 4 } });
  assert.deepEqual(feeChargedFrom({ events: [event(CORE, 'fee_config::FeeCharged', '7')] }, CORE), { feeMinor: 7n, kind: 4 });
  const OTHER = `0x${'ab'.repeat(32)}`;
  assert.equal(feeChargedFrom({ events: [event(OTHER, 'fee_config::FeeCharged', '7')] }, CORE), null, 'another package’s event is not Splash’s fee');
  assert.equal(feeChargedFrom({ events: [event(CORE, 'fee_config::FeeCharged', 'not a number')] }, CORE), null);
  assert.equal(feeChargedFrom({ events: [] }, CORE), null);
  assert.equal(feeChargedFrom({}, CORE), null);
});

// ─── The link ───────────────────────────────────────────────────────────────

test('a receipt link opens one payment, is kept only as a hash, expires, and can be revoked', async () => {
  const t = await setup();
  const now = t.w.signing.now();
  const { token, expiresAt } = await mintReceiptShare(t.w.db, { orgId: 'acme', paymentRef: t.requestId, userId: 'u-founder', now });
  assert.equal(expiresAt.getTime(), now.getTime() + RECEIPT_LINK_TTL_MS);
  const rows = await t.w.db.select().from(schema.paymentReceiptShares);
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].tokenHash, token);
  assert.ok(!JSON.stringify(rows[0]).includes(token), 'the token is not stored');
  assert.deepEqual(await readReceiptShare(t.w.db, token, now), { orgId: 'acme', paymentRef: t.requestId });
  assert.equal(await readReceiptShare(t.w.db, `${token}x`, now), null);
  assert.equal(await readReceiptShare(t.w.db, 'short', now), null);
  assert.equal(await readReceiptShare(t.w.db, token, new Date(now.getTime() + RECEIPT_LINK_TTL_MS)), null, 'expired');
  assert.equal(await revokeReceiptShares(t.w.db, { orgId: 'northwind', paymentRef: t.requestId, now }), 0, 'another business cannot revoke it');
  assert.equal(await revokeReceiptShares(t.w.db, { orgId: 'acme', paymentRef: t.requestId, now }), 1);
  assert.equal(await readReceiptShare(t.w.db, token, now), null, 'revoked');
});

// ─── The self-billed e-invoice ──────────────────────────────────────────────

const DETAILS = {
  buyer: { name: 'Acme Trading Sdn. Bhd.', tin: 'C1234567890', registrationNumber: '202001012345', addressLine: 'Level 8, Menara Acme', city: 'Kuala Lumpur', postcode: '50450', stateCode: '14', phone: '+60312345678' },
  supplier: { name: 'Luzon Components Inc.', country: 'PH' },
  exchangeRateToMyr: '4.2',
  description: 'Electronic components',
  classification: '034',
};

async function einvoiceInput(t, over = {}) {
  await execute(t);
  const r = await paymentReceiptFor(t.rdeps(), t.requestId, 'u-founder');
  return { orgId: 'acme', userId: 'u-founder', receipt: r.receipt, payerCountry: r.payerCountry, supplierCountry: r.supplierCountry, details: DETAILS, now: t.w.signing.now(), ...over };
}

test('the e-invoice is made once, answers the same file again, and is remade only after 72 hours with the old hash kept', async () => {
  const t = await setup();
  const input = await einvoiceInput(t);
  const first = await makeEInvoice(t.w.db, input);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.created, true);
  assert.match(first.eInvoice.fileName, /^self-billed-SPL-\d{4}-[0-9A-F]{6}\.json$/);
  assert.match(first.eInvoice.guideline, /4\.7/);
  const doc = JSON.stringify(first.eInvoice.document);
  assert.match(doc, /EI00000000030/);
  assert.match(doc, /"11"/);
  assert.match(doc, /INV-0042/);
  const again = await makeEInvoice(t.w.db, input);
  assert.equal(again.created, false);
  assert.equal(again.eInvoice.sha256, first.eInvoice.sha256);
  const early = await makeEInvoice(t.w.db, { ...input, refresh: true, now: new Date(input.now.getTime() + E_INVOICE_FRESH_MS - 1) });
  assert.equal(early.created, false, 'a file under 72 hours old is kept');
  const later = await makeEInvoice(t.w.db, { ...input, refresh: true, now: new Date(input.now.getTime() + E_INVOICE_FRESH_MS + 1) });
  assert.equal(later.created, true);
  assert.notEqual(later.eInvoice.sha256, first.eInvoice.sha256, 'a fresh issue date is a different file');
  const [row] = await t.w.db.select().from(schema.paymentEInvoices);
  assert.equal(row.history.length, 1);
  assert.equal(row.history[0].replacedSha256, first.eInvoice.sha256);
  assert.equal((await t.w.db.select().from(schema.paymentEInvoices)).length, 1, 'one file per payment');
});

test('two requests making the e-invoice together leave one file', async () => {
  const t = await setup();
  const input = await einvoiceInput(t);
  const [a, b] = await Promise.all([makeEInvoice(t.w.db, input), makeEInvoice(t.w.db, input)]);
  assert.equal(a.ok && b.ok, true, JSON.stringify([a, b]));
  assert.equal([a, b].filter((x) => x.created).length, 1);
  assert.equal((await t.w.db.select().from(schema.paymentEInvoices)).length, 1);
});

test('the e-invoice is for a Malaysian business paying a supplier outside Malaysia, once the payment settled, with the person’s own details', async () => {
  const t = await setup();
  const input = await einvoiceInput(t);
  const sg = await makeEInvoice(t.w.db, { ...input, payerCountry: 'SG' });
  assert.equal(sg.code, 'not_malaysian');
  const my = await makeEInvoice(t.w.db, { ...input, supplierCountry: 'MY' });
  assert.equal(my.code, 'not_foreign');
  const unknown = await makeEInvoice(t.w.db, { ...input, supplierCountry: null });
  assert.equal(unknown.code, 'supplier_country_unknown');
  const noTin = await makeEInvoice(t.w.db, { ...input, details: { ...DETAILS, buyer: { ...DETAILS.buyer, tin: '' }, exchangeRateToMyr: '' } });
  assert.equal(noTin.status, 422);
  assert.equal(noTin.code, 'incomplete');
  assert.ok(noTin.problems.some((p) => /TIN/.test(p)));
  assert.equal((await t.w.db.select().from(schema.paymentEInvoices)).length, 0, 'a half-made file is never kept');
  const unsettled = await makeEInvoice(t.w.db, { ...input, receipt: { ...input.receipt, final: false, status: 'on_the_way' } });
  assert.equal(unsettled.code, 'status');
});

test('another business reads none of the e-invoice', async () => {
  const t = await setup();
  const input = await einvoiceInput(t);
  await makeEInvoice(t.w.db, input);
  const args = { paymentRef: input.receipt.paymentRef, receiptNo: input.receipt.receiptNo };
  assert.ok(await readEInvoice(t.w.db, { orgId: 'acme', ...args }));
  assert.equal(await readEInvoice(t.w.db, { orgId: 'northwind', ...args }), null);
  void T0;
});
