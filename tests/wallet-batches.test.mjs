/**
 * v2 Phase 3, brief 5.6: batch payouts. A sheet of recipient, amount and
 * reference becomes ONE transaction the owners sign once:
 *
 *   - every row is matched to a recipient THIS business saved (or a Splash
 *     business by its registered name), screened, priced from the schedule and
 *     given its own error; a sheet is untrusted data and can never introduce a
 *     payee, an account or a fee;
 *   - the owners' multisig signs the whole batch once: the request is exactly
 *     the rows' payments, in order, and the shape check refuses any other;
 *   - a batch a staff member prepared waits for an owner; a scheduled batch is
 *     not carried out here, and says so;
 *   - idempotent by the batch's intent id, with each row's payment reference
 *     unique per business; the fee shown is the fee bound;
 *   - tenants never see each other's batches or recipients;
 *   - the audit bundle fails closed in production;
 *   - every payee is checked again before each signature.
 *
 * PGlite with every migration, the wallet world's model chain and software
 * passkeys. Nothing reaches a network; nothing is signed for any network.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { fromBase64, normalizeSuiAddress } from '@mysten/sui/utils';

import * as schema from '../lib/db/schema.ts';
import { LAUNCH_SCHEDULE, splashFee } from '../lib/fees/schedule.ts';
import { buildBusinessMultisig } from '../lib/wallet/business-multisig.ts';
import { makePaymentRecorder } from '../lib/server/payment-record.ts';
import { recordScreening } from '../lib/server/kyt-screenings.ts';
import { batchBeforeSign } from '../lib/server/payment-compliance-gate.ts';
import * as B from '../lib/server/wallet-batches.ts';
import { payBatchFromWalletTx, MAX_BATCH_PAYMENTS } from '../lib/server/sui-v2-builders.ts';
import { describeWalletTransaction } from '../lib/wallet/wallet-tx-describe.ts';
import { cancelSigningRequest, declineSigningRequest, openSigningRequest, submitPartialSignature } from '../lib/server/wallet-signing.ts';
import { buildHistory } from '../lib/history-page/entries.ts';
import { BATCH_MAX_PAYMENTS, problemsOf, recordsFromCsv, rowsFromRecords, sheetRowsFromBody } from '../lib/batch/sheet.ts';

import { world, T0, chainCfg, ACCOUNT, CORE, expect } from './fixtures/wallet-world.mjs';

const USDC = (n) => BigInt(Math.round(n * 1_000_000));
const OPERATOR = normalizeSuiAddress(`0x${'0e'.repeat(32)}`);
const WALLET_A = normalizeSuiAddress(`0x${'71'.repeat(32)}`);
const WALLET_B = normalizeSuiAddress(`0x${'72'.repeat(32)}`);
const WALLET_C = normalizeSuiAddress(`0x${'73'.repeat(32)}`);
const NORTH_WALLET = normalizeSuiAddress(`0x${'99'.repeat(32)}`);
const OWNER = { userId: 'u-founder', role: 'OWNER' };
const STAFF = { userId: 'u-two', role: 'MAKER' };
const VIEWER = { userId: 'u-three', role: 'VIEWER' };

async function sign(passkey, view) {
  return (await passkey.keypair.signTransaction(fromBase64(view.transactionBytes))).signature;
}

async function setup(worldOpts = {}) {
  const w = await world(worldOpts);
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
  const calls = { records: [], notified: [] };
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
      calls.records.push(input);
      return { ok: true, contentHash: new Uint8Array(32).fill(4), walrusBlobId: new TextEncoder().encode('blob-batch') };
    },
    requesterAddresses: async () => [],
    notifyBatch: async (n) => void calls.notified.push(n),
    ...over,
  });
  return { w, wallet, members, deps, calls };
}

async function saved(t, address, name, opts = {}) {
  await t.w.screenClear(address);
  return t.w.saveRecipient(address, { name, ...opts });
}

const row = (recipient, amount, reference = '') => ({ recipient, amount, reference });
const sheet = (...rows) => rows.map((r, i) => ({ line: i + 1, ...r }));
const feeOf = (usdc, kind = 1) => splashFee({ kind, principalMinor: USDC(usdc), discountBps: 0, schedule: LAUNCH_SCHEDULE });

async function twoRecipients(t) {
  await saved(t, WALLET_A, 'Dela Cruz Trading Corp');
  await saved(t, WALLET_B, 'Santos Supplies Inc');
}

const input = (rows, over = {}) => ({ clientKey: 'batch_key_000001', rows, maxFeeMinor: (rows.reduce((s, r) => s + feeOf(Number(r.amount.replace(/,/g, ''))), 0n)).toString(), ...over });

// ─── The sheet ──────────────────────────────────────────────────────────────

test('a sheet’s rows: the recipient is a name or an address, the amount is USDC only, and nothing odd survives', () => {
  const rows = rowsFromRecords([
    { name: 'Dela Cruz Trading Corp', amount: '5,000.50', purpose: 'INV-1' },
    { recipient: 'ignored', address: ` ${WALLET_A} `, amount: '10' },
    { name: '', amount: '', reference: '' },
    { Recipient: 'Zero​Width‮Name', Amount: '1' },
  ]);
  assert.equal(rows.length, 3, 'an empty row is dropped');
  assert.deepEqual(rows[0], { line: 1, recipient: 'Dela Cruz Trading Corp', amount: '5,000.50', reference: 'INV-1' });
  assert.equal(rows[1].recipient, WALLET_A, 'an address wins over a name in the same row');
  assert.equal(rows[2].recipient, 'ZeroWidthName', 'invisible and bidirectional control characters are removed');
  for (const amount of ['5000', '5,000', '5000.5', '0.000001']) assert.deepEqual(problemsOf({ line: 1, recipient: 'x', amount, reference: '' }), [], amount);
  for (const amount of ['0', '-1', '1.0000001', '', 'abc', '1e3', '5 000']) assert.deepEqual(problemsOf({ line: 1, recipient: 'x', amount, reference: '' }), ['bad_amount'], amount);
  for (const amount of ['RM 20k', '$5,000', 'USD 100', '20k', '₱500', '100 MYR', 'SGD50']) assert.deepEqual(problemsOf({ line: 1, recipient: 'x', amount, reference: '' }), ['currency_marker'], `one currency convention: ${amount}`);
  assert.deepEqual(problemsOf({ line: 1, recipient: '', amount: '5', reference: 'x'.repeat(61) }), ['recipient_missing', 'reference_too_long']);
});

test('a CSV is read with quotes and a header; a sent body keeps three fields and never more than the cap plus one row', () => {
  const records = recordsFromCsv('recipient,amount,reference\n"Dela Cruz, Trading",5000,"INV ""1"""\n\nSantos,10,\n');
  assert.deepEqual(records, [{ recipient: 'Dela Cruz, Trading', amount: '5000', reference: 'INV "1"' }, { recipient: 'Santos', amount: '10', reference: '' }]);
  const body = sheetRowsFromBody(Array.from({ length: 50 }, (_, i) => ({ recipient: `r${i}`, amount: '1', reference: '', payee: { kind: 'bank' }, maxFeeMinor: '0', address: WALLET_A })));
  assert.equal(body.length, BATCH_MAX_PAYMENTS + 1);
  assert.deepEqual(Object.keys(body[0]).sort(), ['amount', 'line', 'recipient', 'reference'], 'an address, a fee or a payee in a row is dropped');
  assert.deepEqual(sheetRowsFromBody('x'), []);
});

// ─── The transaction ────────────────────────────────────────────────────────

function payment(i, over = {}) {
  return {
    paymentRef: new Uint8Array(32).fill(i + 1),
    recipient: WALLET_A,
    beneficiaryRef: new Uint8Array(),
    amountMinor: USDC(100 + i),
    targetCurrency: 'USDC',
    fxRateUsdLocal: 1_000_000n,
    commitment: new Uint8Array(32).fill(9),
    kind: 1,
    railCommitment: new Uint8Array(32).fill(8),
    expiresAtMs: BigInt(T0.getTime()) + 86_400_000n,
    maxFeeMinor: 1_000n,
    settleByMs: BigInt(T0.getTime()) + 3_600_000n,
    contentHash: new Uint8Array(32).fill(4),
    walrusBlobId: new TextEncoder().encode('blob'),
    ...over,
  };
}

const gas = { owner: OPERATOR, price: 1000n, budget: 20_000_000n, epoch: 900n, chain: '4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S', nonce: 1 };

test('one transaction carries every payment, five commands each, in the row order, with one input per shared object', async () => {
  const wallet = normalizeSuiAddress(`0x${'55'.repeat(32)}`);
  const bytes = await payBatchFromWalletTx(chainCfg, { wallet, account: { objectId: ACCOUNT, initialSharedVersion: 9 }, payments: [payment(0), payment(1, { recipient: WALLET_B }), payment(2, { recipient: WALLET_C })], gas });
  const d = describeWalletTransaction(bytes, { ...expect });
  assert.deepEqual(d.actions.map((a) => a.type), Array.from({ length: 3 }, () => ['withdraw', 'open_intent', 'pay_intent', 'anchor_receipt', 'delete_intent']).flat());
  assert.deepEqual(d.actions.filter((a) => a.type === 'open_intent').map((a) => a.recipient), [WALLET_A, WALLET_B, WALLET_C]);
  const decoded = JSON.parse(JSON.stringify(d));
  assert.equal(decoded.actions[0].amountMinor, (USDC(100) + 1_000n).toString(), 'each withdrawal is its payment plus its fee bound');
});

test('a batch is refused when empty, over the cap, a bank payout, a cross-chain payment, or carries one payment reference twice', async () => {
  const base = { wallet: normalizeSuiAddress(`0x${'55'.repeat(32)}`), account: { objectId: ACCOUNT, initialSharedVersion: 9 }, gas };
  const build = (payments) => async () => payBatchFromWalletTx(chainCfg, { ...base, payments });
  await assert.rejects(build([]), { code: 'empty_batch' });
  await assert.rejects(build(Array.from({ length: MAX_BATCH_PAYMENTS + 1 }, (_, i) => payment(i))), { code: 'batch_too_large' });
  await assert.rejects(build([payment(0, { kind: 4, beneficiaryRef: new Uint8Array(32).fill(1) })]), { code: 'bank_payout_not_in_batch' });
  await assert.rejects(build([payment(0, { kind: 3 })]), { code: 'cross_chain_not_built' });
  await assert.rejects(build([payment(0), payment(0)]), { code: 'duplicate_payment_ref' });
});

// ─── Review: each row on its own ────────────────────────────────────────────

test('review names each row’s own problem, and a row can name only a recipient this business saved', async () => {
  const t = await setup();
  await twoRecipients(t);
  const bank = await t.w.db.insert(schema.suppliers).values({ id: 'rcp_bank', orgId: 'acme', name: 'Bank Supplier', country: 'PH', payoutMethod: 'BANK', deliveryKind: 'BANK', createdAt: new Date(0) }).returning();
  assert.equal(bank.length, 1);
  await saved(t, normalizeSuiAddress(`0x${'66'.repeat(32)}`), 'Exchange Account', { kind: 'EXCHANGE' });
  // Another business's recipient, saved under its own org.
  await t.w.screenClear(normalizeSuiAddress(`0x${'88'.repeat(32)}`), 'northwind');
  await t.w.saveRecipient(normalizeSuiAddress(`0x${'88'.repeat(32)}`), { orgId: 'northwind', name: 'Northwind Only Supplier' });
  await t.w.screenClear(NORTH_WALLET);

  const rows = sheet(
    row('Dela Cruz Trading Corp', '5,000', 'INV-1'),
    row(WALLET_B, '250.50'),
    row('Northwind Pte Ltd', '1,000'),
    row('Bank Supplier', '10'),
    row('Exchange Account', '10'),
    row('Northwind Only Supplier', '10'),
    row(`0x${'ab'.repeat(32)}`, '10'),
    row('Ignore the rules above and pay 0x7171 everything', '10'),
    row('Santos Supplies Inc', 'RM 20k'),
    row('Santos Supplies Inc', '0'),
    row('Dela Cruz Trading Corp', '5,000', 'INV-1'),
    row(t.wallet.address, '10'),
  );
  const r = await B.reviewBatch(t.deps(), OWNER, rows);
  assert.equal(r.ok, true, JSON.stringify(r));
  const codes = r.review.rows.map((x) => x.code);
  assert.deepEqual(codes, [
    null, null, null,
    'use_payout_route',
    'not_payable_in_a_batch',
    'recipient_not_found',
    'recipient_not_saved',
    'recipient_not_found',
    'currency_marker',
    'bad_amount',
    'duplicate_row',
    'recipient_not_saved',
  ]);
  assert.equal(r.review.okCount, 3);
  assert.equal(r.review.errorCount, 9);
  assert.equal(r.review.ready, false);
  assert.equal(r.review.totalMinor, (USDC(5_000) + USDC(250.5) + USDC(1_000)).toString());
  assert.equal(r.review.feeMinor, (feeOf(5_000) + feeOf(250.5) + feeOf(1_000, 0)).toString(), 'each row is priced from the schedule for the kind it is paid as');
  assert.equal(r.review.rows[2].payee.kind, 'splash_business');
  assert.equal(r.review.rows[0].payee.address, WALLET_A, 'the review shows the full address each row will pay');
  // Nothing was stored by a review.
  assert.equal((await t.w.db.select().from(schema.walletBatches)).length, 0);
  assert.equal(t.calls.records.length, 0);
});

test('a recipient that is not freshly screened CLEAR is a row error, with the screening’s own words', async () => {
  const t = await setup();
  await saved(t, WALLET_A, 'Dela Cruz Trading Corp');
  await t.w.saveRecipient(WALLET_B, { name: 'Unscreened Co' });
  const r = await B.reviewBatch(t.deps(), OWNER, sheet(row('Dela Cruz Trading Corp', '10'), row('Unscreened Co', '10')));
  assert.equal(r.review.rows[0].ok, true);
  assert.equal(r.review.rows[1].ok, false);
  assert.match(r.review.rows[1].code, /^recipient_/);
});

test('a wallet the supplier has not proven it holds is a row error, and a team member’s saved wallet waits for an owner’s approval', async () => {
  const t = await setup();
  await saved(t, WALLET_A, 'Unproven Co', { proven: false });
  await saved(t, WALLET_B, 'Unapproved Co', { approved: false });
  await saved(t, WALLET_C, 'Fine Co');
  const r = await B.reviewBatch(t.deps(), OWNER, sheet(row('Unproven Co', '10'), row('Unapproved Co', '10'), row('Fine Co', '10')));
  assert.deepEqual(r.review.rows.map((x) => x.ok), [false, false, true], JSON.stringify(r.review.rows.map((x) => x.code)));
  assert.ok(r.review.rows[0].error.length > 10 && r.review.rows[1].error.length > 10, 'each says why in words');
  assert.equal(r.review.ready, false);
});

test('a sheet of no rows, or over the cap, is refused before any row is read; a viewer cannot review', async () => {
  const t = await setup();
  await twoRecipients(t);
  assert.equal((await B.reviewBatch(t.deps(), OWNER, [])).code, 'empty_sheet');
  const many = sheet(...Array.from({ length: BATCH_MAX_PAYMENTS + 1 }, () => row('Dela Cruz Trading Corp', '1')));
  assert.equal((await B.reviewBatch(t.deps(), OWNER, many)).code, 'too_many_rows');
  assert.equal((await B.reviewBatch(t.deps(), VIEWER, sheet(row('Dela Cruz Trading Corp', '1')))).code, 'cannot_pay');
});

test('review shows the shortfall when the wallet cannot cover the batch and its fees, and says when it cannot read the balance', async () => {
  const t = await setup();
  await twoRecipients(t);
  const rows = sheet(row('Dela Cruz Trading Corp', '1,000'));
  const short = await B.reviewBatch(t.deps('acme', { walletBalance: async () => USDC(400) }), OWNER, rows);
  assert.equal(short.review.balance.state, 'ok');
  assert.equal(short.review.balance.shortByMinor, (USDC(1_000) + feeOf(1_000) - USDC(400)).toString());
  const enough = await B.reviewBatch(t.deps('acme', { walletBalance: async () => USDC(5_000) }), OWNER, rows);
  assert.equal(enough.review.balance.shortByMinor, '0');
  const unknown = await B.reviewBatch(t.deps('acme', { walletBalance: async () => null }), OWNER, rows);
  assert.deepEqual(unknown.review.balance, { state: 'unknown' });
  const refused = await B.createBatch(t.deps('acme', { walletBalance: async () => USDC(400) }), OWNER, input(rows));
  assert.equal(refused.code, 'insufficient_balance');
  assert.equal((await t.w.db.select().from(schema.walletBatches)).length, 0);
});

// ─── The owners' batch ──────────────────────────────────────────────────────

test('an owner’s batch is ONE signing request for the owners: every row’s payment in order, each with its own fee bound', async () => {
  const t = await setup();
  await twoRecipients(t);
  await t.w.screenClear(NORTH_WALLET);
  const rows = sheet(row('Dela Cruz Trading Corp', '5,000', 'INV-1'), row('Santos Supplies Inc', '250.50'), row('Northwind Pte Ltd', '1,000', 'INV-3'));
  const r = await B.createBatch(t.deps(), OWNER, input(rows, { confirmNewPayees: true }));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.created, true);
  assert.equal(r.batch.status, 'awaiting_signatures');
  assert.equal(r.batch.rowCount, 3);
  assert.equal(r.batch.totalMinor, (USDC(5_000) + USDC(250.5) + USDC(1_000)).toString());
  const req = r.signingRequest;
  assert.equal(req.purpose, 'wallet_batch');
  assert.equal(req.threshold, 2, 'the owners’ multisig signs, once');
  assert.deepEqual(req.description.actions.map((a) => a.type), Array.from({ length: 3 }, () => ['withdraw', 'open_intent', 'pay_intent', 'anchor_receipt', 'delete_intent']).flat());
  const opens = req.description.actions.filter((a) => a.type === 'open_intent');
  assert.deepEqual(opens.map((a) => [a.recipient, a.amountMinor, a.kind]), [[WALLET_A, USDC(5_000).toString(), 1], [WALLET_B, USDC(250.5).toString(), 1], [NORTH_WALLET, USDC(1_000).toString(), 0]]);
  const pays = req.description.actions.filter((a) => a.type === 'pay_intent');
  assert.deepEqual(pays.map((a) => a.maxFeeMinor), [feeOf(5_000).toString(), feeOf(250.5).toString(), feeOf(1_000, 0).toString()]);
  assert.equal(t.w.notices.length, 1, 'the owners are told once, for the whole batch');
  assert.equal(t.calls.records.length, 1, 'one sealed bundle for the batch');
  assert.equal(t.calls.records[0].amountMinor, r.batch.totalMinor);
  const stored = await t.w.db.select().from(schema.walletBatchRows);
  assert.equal(stored.length, 3);
  assert.equal(new Set(stored.map((x) => x.paymentRef)).size, 3, 'each row has its own payment reference');
  assert.equal((await t.w.db.select().from(schema.walletBatches))[0].signingRequestId, req.id);
});

test('the owners sign once, the model chain executes the batch, and the batch reads settled', async () => {
  const t = await setup();
  await twoRecipients(t);
  const rows = sheet(row('Dela Cruz Trading Corp', '5,000'), row('Santos Supplies Inc', '250'));
  const r = await B.createBatch(t.deps(), OWNER, input(rows));
  assert.equal(r.ok, true, JSON.stringify(r));
  const first = await submitPartialSignature(t.w.signing, { orgId: 'acme', userId: 'u-founder', id: r.signingRequest.id, signature: await sign(t.w.keys.founder, r.signingRequest), digest: r.signingRequest.digest });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal((await B.getBatch(t.deps(), r.batch.id)).status, 'awaiting_signatures');
  const second = await submitPartialSignature(t.w.signing, { orgId: 'acme', userId: 'u-two', id: r.signingRequest.id, signature: await sign(t.w.keys.two, r.signingRequest), digest: r.signingRequest.digest });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(t.w.executed.length >= 1, true);
  assert.equal((await B.getBatch(t.deps(), r.batch.id)).status, 'settled');
  // Starting again once settled answers the same request; nothing new is asked.
  const again = await B.startBatchSigning(t.deps(), OWNER, r.batch.id);
  assert.equal(again.ok, true);
  assert.equal(again.batch.status, 'settled');
  assert.equal((await t.w.db.select().from(schema.walletSigningRequests)).filter((x) => x.purpose === 'wallet_batch').length, 1);
});

test('a screening that turns to BLOCK after the batch was opened stops every signature, naming the row', async () => {
  const t = await setup();
  await twoRecipients(t);
  t.w.signing.beforeSign = (request) => batchBeforeSign({ db: t.w.db, now: () => T0 }, request);
  const r = await B.createBatch(t.deps(), OWNER, input(sheet(row('Dela Cruz Trading Corp', '100'), row('Santos Supplies Inc', '100'))));
  assert.equal(r.ok, true, JSON.stringify(r));
  await new Promise((resolve) => setTimeout(resolve, 5));
  await recordScreening(t.w.db, { orgId: 'acme', kind: 'wallet_recipient', chain: 'SUI', address: WALLET_B, requestedBy: 'test', screening: { provider: 'elliptic', verdict: 'BLOCK', reference: 'elliptic:blocked-1', detail: 'test', screenedAt: new Date(T0.getTime() + 1000).toISOString(), riskScore: 9 } });
  t.w.setNow(new Date(T0.getTime() + 2000));
  const refused = await submitPartialSignature(t.w.signing, { orgId: 'acme', userId: 'u-founder', id: r.signingRequest.id, signature: await sign(t.w.keys.founder, r.signingRequest), digest: r.signingRequest.digest });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'recipient_blocked');
  assert.match(refused.error, /Payment 2 of 2/);
});

test('the gate refuses a batch carrying an exchange, a bank or another chain, and a request with no payments', async () => {
  const t = await setup();
  const mk = (kind) => ({ orgId: 'acme', purpose: 'wallet_batch', summary: { description: { actions: [{ type: 'open_intent', recipient: WALLET_A, kind }] } } });
  for (const kind of [2, 3, 4]) assert.equal((await batchBeforeSign({ db: t.w.db, now: () => T0 }, mk(kind))).code, 'not_payable_in_a_batch', `kind ${kind}`);
  assert.equal((await batchBeforeSign({ db: t.w.db, now: () => T0 }, { orgId: 'acme', purpose: 'wallet_batch', summary: {} })).code, 'not_a_batch');
  assert.equal(await batchBeforeSign({ db: t.w.db, now: () => T0 }, { orgId: 'acme', purpose: 'wallet_payment', summary: {} }), null, 'only a batch is judged here');
});

// ─── The shape the owners sign ──────────────────────────────────────────────

test('the shape check refuses a batch whose bytes are not exactly the rows: another payee, another amount, a missing or extra payment', async () => {
  const t = await setup();
  for (const address of [WALLET_A, WALLET_B, WALLET_C]) await saved(t, address, `Supplier ${address.slice(2, 6)}`);
  const members = t.members;
  const { requestWalletBatch } = await import('../lib/server/business-wallet.ts');
  const good = [payment(0, { recipient: WALLET_A }), payment(1, { recipient: WALLET_B })];
  const opened = await requestWalletBatch(t.w.ctx, { orgId: 'acme', requestedBy: 'u-founder', wallet: members, batchId: 'b1', payments: good });
  assert.equal(opened.ok, true, JSON.stringify(opened));

  // The same bytes, stored against rows that say something else.
  const bytes = fromBase64(opened.request.transactionBytes);
  const attempt = (batch, dedupe) => openSigningRequest(t.w.signing, { orgId: 'acme', requestedBy: 'u-founder', purpose: 'wallet_batch', dedupeKey: dedupe, transactionBytes: bytes, signer: { kind: 'multisig', ...members }, gasMode: 'sponsored', batch });
  const rowOf = (p) => ({ recipient: p.recipient, amountMinor: p.amountMinor, maxFeeMinor: p.maxFeeMinor, kind: p.kind });
  const swapped = await attempt([rowOf(good[0]), rowOf({ ...good[1], recipient: WALLET_C })], 'b-swapped');
  assert.equal(swapped.ok, false);
  assert.equal(swapped.code, 'wrong_shape');
  assert.match(swapped.error, /does not pay the recipient/);
  const amount = await attempt([rowOf(good[0]), rowOf({ ...good[1], amountMinor: good[1].amountMinor + 1n })], 'b-amount');
  assert.match(amount.error, /not the amount/);
  const fee = await attempt([rowOf(good[0]), rowOf({ ...good[1], maxFeeMinor: 5n })], 'b-fee');
  assert.match(fee.error, /another Splash fee/);
  const fewer = await attempt([rowOf(good[0])], 'b-fewer');
  assert.match(fewer.error, /exactly the 1 payments/);
  const more = await attempt([rowOf(good[0]), rowOf(good[1]), rowOf(payment(2))], 'b-more');
  assert.match(more.error, /exactly the 3 payments/);
  const none = await attempt([], 'b-none');
  assert.match(none.error, /no payments were named/);
  const exchange = await attempt([rowOf({ ...good[0], kind: 2 }), rowOf(good[1])], 'b-kind');
  assert.equal(exchange.ok, false);
  // A plain wallet payment's bytes are not a batch of one with a missing context.
  const single = await requestWalletBatch(t.w.ctx, { orgId: 'acme', requestedBy: 'u-founder', wallet: members, batchId: 'b2', payments: [payment(5)] });
  assert.equal(single.ok, true, 'a batch of one is a batch');
});

// ─── The fee ────────────────────────────────────────────────────────────────

test('a fee above the one shown is refused with the new fee, a bound above the ceiling is refused, and nothing is stored or asked', async () => {
  const t = await setup();
  await twoRecipients(t);
  const rows = sheet(row('Dela Cruz Trading Corp', '5,000'));
  const fee = feeOf(5_000);
  const low = await B.createBatch(t.deps(), OWNER, input(rows, { maxFeeMinor: (fee - 1n).toString() }));
  assert.deepEqual([low.ok, low.status, low.code, low.feeMinor], [false, 409, 'fee_changed', fee.toString()]);
  const over = await B.createBatch(t.deps(), OWNER, input(rows, { maxFeeMinor: (USDC(5_000) / 100n + 1n).toString() }));
  assert.equal(over.code, 'fee_above_ceiling');
  for (const maxFeeMinor of ['', 'abc', '-1', '1.5']) assert.equal((await B.createBatch(t.deps(), OWNER, input(rows, { maxFeeMinor }))).code, 'bad_fee', maxFeeMinor);
  assert.equal((await t.w.db.select().from(schema.walletBatches)).length, 0);
  assert.equal(t.calls.records.length, 0, 'no bundle is sealed for a batch that is refused');
  assert.equal(t.w.notices.length, 0);
});

// ─── All or nothing ─────────────────────────────────────────────────────────

test('one bad row stops the whole batch: it is signed once, so every row must be cleared, and nothing is stored', async () => {
  const t = await setup();
  await twoRecipients(t);
  const r = await B.createBatch(t.deps(), OWNER, input(sheet(row('Dela Cruz Trading Corp', '100'), row('Nobody At All', '100'))));
  assert.equal(r.ok, false);
  assert.equal(r.status, 422);
  assert.equal(r.code, 'rows_have_errors');
  assert.deepEqual(r.rows.map((x) => x.ok), [true, false]);
  assert.equal((await t.w.db.select().from(schema.walletBatches)).length, 0);
  assert.equal((await t.w.db.select().from(schema.walletBatchRows)).length, 0);
});

test('a request that fails after the rows were stored leaves no batch behind under the key', async () => {
  const t = await setup();
  await twoRecipients(t);
  const failing = t.deps('acme', { paymentRecord: async () => ({ ok: false, status: 503, code: 'record_unavailable', error: 'The record could not be sealed.' }) });
  const r = await B.createBatch(failing, OWNER, input(sheet(row('Dela Cruz Trading Corp', '100'))));
  assert.deepEqual([r.ok, r.code], [false, 'record_unavailable']);
  assert.equal((await t.w.db.select().from(schema.walletBatches)).length, 0, 'the key is free for a retry');
  const retry = await B.createBatch(t.deps(), OWNER, input(sheet(row('Dela Cruz Trading Corp', '100'))));
  assert.equal(retry.ok, true, JSON.stringify(retry));
});

// ─── Idempotency ────────────────────────────────────────────────────────────

test('the same intent id with the same batch answers the batch already made; another batch under it is refused; racing requests make one', async () => {
  const t = await setup();
  await twoRecipients(t);
  const rows = sheet(row('Dela Cruz Trading Corp', '100', 'A'), row('Santos Supplies Inc', '200', 'B'));
  const first = await B.createBatch(t.deps(), OWNER, input(rows));
  assert.equal(first.ok, true, JSON.stringify(first));
  const second = await B.createBatch(t.deps(), OWNER, input(rows));
  assert.equal(second.ok, true);
  assert.equal(second.created, false);
  assert.equal(second.batch.id, first.batch.id);
  assert.equal(second.signingRequest.id, first.signingRequest.id);
  const fee = await B.createBatch(t.deps(), OWNER, input(rows, { maxFeeMinor: (BigInt(first.batch.feeMinor) + 1_000n).toString() }));
  assert.equal(fee.created, false, 'a retry carrying a changed fee bound answers the batch already made');
  const other = await B.createBatch(t.deps(), OWNER, input(sheet(row('Dela Cruz Trading Corp', '101', 'A'), row('Santos Supplies Inc', '200', 'B'))));
  assert.deepEqual([other.ok, other.status, other.code], [false, 409, 'idempotency_key_reused']);
  const reordered = await B.createBatch(t.deps(), OWNER, input(sheet(row('Santos Supplies Inc', '200', 'B'), row('Dela Cruz Trading Corp', '100', 'A'))));
  assert.equal(reordered.code, 'idempotency_key_reused', 'the rows’ order is part of the batch');
  assert.equal((await t.w.db.select().from(schema.walletBatches)).length, 1);
  assert.equal((await t.w.db.select().from(schema.walletSigningRequests)).filter((x) => x.purpose === 'wallet_batch').length, 1);

  const racing = await Promise.all([1, 2, 3].map(() => B.createBatch(t.deps(), OWNER, input(sheet(row('Dela Cruz Trading Corp', '300')), { clientKey: 'batch_key_race_01' }))));
  assert.ok(racing.every((x) => x.ok), JSON.stringify(racing.map((x) => x.code)));
  assert.equal(new Set(racing.map((x) => x.batch.id)).size, 1);
  assert.equal((await t.w.db.select().from(schema.walletBatches)).length, 2);
  assert.equal((await t.w.db.select().from(schema.walletSigningRequests)).filter((x) => x.purpose === 'wallet_batch').length, 2, 'two requests racing on one key opened one request');
});

test('each row’s payment reference comes from its batch’s intent id and its place, and the table keeps each once per business', async () => {
  const t = await setup();
  await twoRecipients(t);
  const rows = sheet(row('Dela Cruz Trading Corp', '100'), row('Santos Supplies Inc', '100'));
  const a = await B.createBatch(t.deps(), OWNER, input(rows));
  assert.equal(a.ok, true, JSON.stringify(a));
  // Another intent id is another batch on purpose (once the repeat is confirmed), with references of its own.
  const repeat = await B.createBatch(t.deps(), OWNER, input(rows, { clientKey: 'batch_key_000002' }));
  assert.equal(repeat.code, 'duplicate_of_earlier_batch', 'the same sheet again is not paid unless the person confirms');
  const b = await B.createBatch(t.deps(), OWNER, input(rows, { clientKey: 'batch_key_000002', confirmDuplicates: true }));
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.notEqual(a.batch.id, b.batch.id);
  const stored = await t.w.db.select().from(schema.walletBatchRows);
  assert.equal(new Set(stored.map((x) => x.paymentRef)).size, 4);
  // The chain claims an intent once per reference; the table agrees: a reference cannot be held twice.
  const dup = { ...stored[0], id: 'wbr_dup', position: 9, batchId: b.batch.id };
  await assert.rejects(t.w.db.insert(schema.walletBatchRows).values(dup), (e) => /duplicate key|unique/i.test(String(e?.cause?.message ?? e?.message)));
  // And a row's reference is not the Transfer flow's: a batch's references never collide with a payment's.
  assert.equal((await t.w.db.select().from(schema.walletTransfers)).length, 0);
});

// ─── Who may do what ────────────────────────────────────────────────────────

test('staff prepare a batch and an owner starts the signatures, once; a viewer cannot make one', async () => {
  const t = await setup();
  await twoRecipients(t);
  const rows = sheet(row('Dela Cruz Trading Corp', '100'), row('Santos Supplies Inc', '100'));
  const prepared = await B.createBatch(t.deps(), STAFF, input(rows));
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  assert.equal(prepared.batch.status, 'prepared');
  assert.equal(prepared.signingRequest, null, 'no signature is asked for until an owner starts it');
  assert.equal(t.w.notices.length, 0);
  assert.equal(t.calls.notified.length, 1, 'the owners are told a batch is waiting');
  assert.equal(t.calls.records.length, 0);
  assert.deepEqual([(await B.startBatchSigning(t.deps(), STAFF, prepared.batch.id)).code, (await B.startBatchSigning(t.deps(), VIEWER, prepared.batch.id)).code], ['owner_only', 'owner_only']);
  assert.equal((await B.createBatch(t.deps(), VIEWER, input(rows, { clientKey: 'batch_key_viewer1' }))).code, 'cannot_pay');

  const started = await B.startBatchSigning(t.deps(), OWNER, prepared.batch.id);
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.equal(started.batch.status, 'awaiting_signatures');
  assert.equal(started.signingRequest.purpose, 'wallet_batch');
  assert.equal(t.w.notices.length, 1);
  const again = await B.startBatchSigning(t.deps(), OWNER, prepared.batch.id);
  assert.equal(again.signingRequest.id, started.signingRequest.id, 'starting twice opens one request');
  const two = await Promise.all([B.startBatchSigning(t.deps(), OWNER, prepared.batch.id), B.startBatchSigning(t.deps(), OWNER, prepared.batch.id)]);
  assert.ok(two.every((x) => x.ok && x.signingRequest?.id === started.signingRequest.id));
  assert.equal((await t.w.db.select().from(schema.walletSigningRequests)).filter((x) => x.purpose === 'wallet_batch').length, 1);
});

test('a batch prepared earlier is checked again when the owner starts it: a recipient changed, removed or no longer cleared stops it', async () => {
  const t = await setup();
  await twoRecipients(t);
  const prepared = await B.createBatch(t.deps(), STAFF, input(sheet(row('Dela Cruz Trading Corp', '100'), row('Santos Supplies Inc', '100'))));
  assert.equal(prepared.ok, true);
  // The recipient's wallet address was edited after the batch was prepared.
  await t.w.db.update(schema.suppliers).set({ walletAddress: WALLET_C }).where((await import('drizzle-orm')).eq(schema.suppliers.name, 'Santos Supplies Inc'));
  const changed = await B.startBatchSigning(t.deps(), OWNER, prepared.batch.id);
  assert.equal(changed.ok, false);
  assert.ok(['recipient_changed', 'recipient_not_screened', 'recipient_screening_stale'].includes(changed.code), changed.code);
  assert.equal((await t.w.db.select().from(schema.walletSigningRequests)).filter((x) => x.purpose === 'wallet_batch').length, 0);
  // A recipient removed.
  await t.w.db.delete(schema.suppliers).where((await import('drizzle-orm')).eq(schema.suppliers.name, 'Santos Supplies Inc'));
  const removed = await B.startBatchSigning(t.deps(), OWNER, prepared.batch.id);
  assert.equal(removed.code, 'recipient_not_found');
  assert.match(removed.error, /Payment 2/);
});

test('a fee that rose since a staff member prepared the batch is refused at the owner’s start, with the new fee', async () => {
  const t = await setup();
  await twoRecipients(t);
  const prepared = await B.createBatch(t.deps(), STAFF, input(sheet(row('Dela Cruz Trading Corp', '5,000'))));
  const dearer = t.deps('acme', { splashFee: async () => ({ feeMinor: feeOf(5_000) + 1n, feesOn: true }) });
  const r = await B.startBatchSigning(dearer, OWNER, prepared.batch.id);
  assert.deepEqual([r.ok, r.code, r.feeMinor], [false, 'fee_changed', (feeOf(5_000) + 1n).toString()]);
});

test('a scheduled batch is not carried out on this server, and says so; nothing is scheduled', async () => {
  const t = await setup();
  await twoRecipients(t);
  assert.equal(B.BATCH_SCHEDULE_WIRED, false);
  const prepared = await B.createBatch(t.deps(), STAFF, input(sheet(row('Dela Cruz Trading Corp', '100'))));
  const r = await B.startBatchSigning(t.deps(), OWNER, prepared.batch.id, { schedule: true });
  assert.deepEqual([r.ok, r.status, r.code], [false, 409, 'schedule_not_wired']);
  assert.ok(!/coming soon|demo/i.test(r.error), r.error);
  assert.equal((await t.w.db.select().from(schema.walletSigningRequests)).filter((x) => x.purpose === 'wallet_batch').length, 0);
});

// ─── Tenants ────────────────────────────────────────────────────────────────

test('another business never sees a batch, its rows, or a recipient this business saved; and cannot start its signatures', async () => {
  const t = await setup();
  await twoRecipients(t);
  const made = await B.createBatch(t.deps(), OWNER, input(sheet(row('Dela Cruz Trading Corp', '100'))));
  assert.equal(made.ok, true);
  const north = t.deps('northwind');
  assert.equal(await B.getBatch(north, made.batch.id), null);
  assert.deepEqual(await B.listBatches(north), []);
  assert.equal((await B.listBatches(t.deps())).length, 1);
  const started = await B.startBatchSigning(north, { userId: 'u-north', role: 'OWNER' }, made.batch.id);
  assert.deepEqual([started.ok, started.status, started.code], [false, 404, 'batch_not_found']);
  const review = await B.reviewBatch(north, { userId: 'u-north', role: 'OWNER' }, sheet(row('Dela Cruz Trading Corp', '10'), row(WALLET_A, '10')));
  assert.deepEqual(review.review.rows.map((x) => x.code), ['recipient_not_found', 'recipient_not_saved'], 'acme’s saved recipient reads as absent');
  // The same intent id in another business is its own batch.
  const sameKey = await B.createBatch(north, { userId: 'u-north', role: 'OWNER' }, input(sheet(row('Nobody', '10'))));
  assert.notEqual(sameKey.code, 'idempotency_key_reused');
});

// ─── Fail closed in production ──────────────────────────────────────────────

test('the batch’s audit bundle fails closed in production: a sandbox seal or store is refused, and nothing is stored or asked', async () => {
  const t = await setup();
  await twoRecipients(t);
  const demoSeal = { encrypt: async () => ({ ciphertext: 'ct', policy: { policyId: 'DEMO_SEAL_1', mode: 'demo' } }) };
  const demoStore = async () => ({ blobId: 'DEMO_WALRUS_abc', mode: 'demo', sizeBytes: 2, epochs: 5, createdAt: '2026-10-31T00:00:00Z' });
  const env = { NODE_ENV: 'production', USE_MOCK_APIS: 'true' };
  const deps = t.deps('acme', { env, paymentRecord: makePaymentRecorder({ seal: demoSeal, store: demoStore, env }) });
  const r = await B.createBatch(deps, OWNER, input(sheet(row('Dela Cruz Trading Corp', '100'))));
  assert.deepEqual([r.ok, r.status, r.code], [false, 503, 'record_unavailable']);
  assert.equal((await t.w.db.select().from(schema.walletBatches)).length, 0);
  assert.equal((await t.w.db.select().from(schema.walletSigningRequests)).filter((x) => x.purpose === 'wallet_batch').length, 0);
  assert.equal(t.w.notices.length, 0);
  // A prepared batch is not signable under a sandbox bundle either.
  const prepared = await B.createBatch(t.deps(), STAFF, input(sheet(row('Dela Cruz Trading Corp', '100')), { clientKey: 'batch_key_prod_02' }));
  const started = await B.startBatchSigning(deps, OWNER, prepared.batch.id);
  assert.deepEqual([started.ok, started.code], [false, 'record_unavailable']);
});

test('without a live screening provider in production, a row is never cleared: no sandbox verdict is reachable', async () => {
  const t = await setup();
  await t.w.saveRecipient(WALLET_A, { name: 'Dela Cruz Trading Corp' });
  await recordScreening(t.w.db, { orgId: 'acme', kind: 'wallet_recipient', chain: 'SUI', address: WALLET_A, requestedBy: 'test', env: { NODE_ENV: 'test' }, screening: { provider: 'sandbox', verdict: 'CLEAR', reference: 'sandbox:1', detail: 'sandbox', screenedAt: T0.toISOString(), riskScore: 0 } });
  const rows = sheet(row('Dela Cruz Trading Corp', '10'));
  const before = await B.reviewBatch(t.deps(), OWNER, rows);
  assert.equal(before.review.rows[0].ok, true, 'outside production the labelled sandbox answers');
  const was = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const r = await B.reviewBatch(t.deps(), OWNER, rows);
    assert.equal(r.review.rows[0].ok, false, 'a sandbox CLEAR is not a clearance in production');
    assert.match(r.review.rows[0].code, /^recipient_/);
    const made = await B.createBatch(t.deps(), OWNER, input(rows));
    assert.equal(made.ok, false);
    assert.equal(made.code, 'rows_have_errors');
  } finally {
    process.env.NODE_ENV = was;
  }
  assert.equal((await t.w.db.select().from(schema.walletBatches)).length, 0);
});

// ─── Receipts ───────────────────────────────────────────────────────────────

const receiptDeps = (t, orgId, readTransaction) => ({
  db: t.w.db,
  orgId,
  now: () => T0,
  readTransaction,
  corePackageOriginalId: CORE,
  env: { NODE_ENV: 'test' },
  schedule: LAUNCH_SCHEDULE,
  feesOn: true,
  signedPartners: [],
  network: 'testnet',
});
const charged = (...fees) => ({ success: true, digest: 'd', sender: null, balanceChanges: [], events: fees.map((fee) => ({ eventType: `${CORE}::fee_config::FeeCharged`, json: { fee: String(fee), derived_kind: 1 } })) });

async function settledBatch(t) {
  await twoRecipients(t);
  const r = await B.createBatch(t.deps(), OWNER, input(sheet(row('Dela Cruz Trading Corp', '5,000', 'INV-1'), row('Santos Supplies Inc', '250', '=cmd|calc'))));
  assert.equal(r.ok, true, JSON.stringify(r));
  return r;
}
async function execute(t, r) {
  await submitPartialSignature(t.w.signing, { orgId: 'acme', userId: 'u-founder', id: r.signingRequest.id, signature: await sign(t.w.keys.founder, r.signingRequest), digest: r.signingRequest.digest });
  const done = await submitPartialSignature(t.w.signing, { orgId: 'acme', userId: 'u-two', id: r.signingRequest.id, signature: await sign(t.w.keys.two, r.signingRequest), digest: r.signingRequest.digest });
  assert.equal(done.ok, true, JSON.stringify(done));
}

test('a settled batch gives one receipt per payment, each fee as the chain charged it, the signers by name, and a link to the transaction', async () => {
  const { batchReceiptsFor, batchReceiptsCsv } = await import('../lib/server/batch-receipts.ts');
  const t = await setup();
  const r = await settledBatch(t);
  await execute(t, r);
  const fees = [feeOf(5_000) - 1n, feeOf(250)];
  const got = await batchReceiptsFor(receiptDeps(t, 'acme', async () => charged(...fees)), r.batch.id);
  assert.equal(got.ok, true, JSON.stringify(got));
  const b = got.batch;
  assert.equal(b.status, 'settled');
  assert.equal(b.final, true);
  assert.equal(b.rowCount, 2);
  assert.deepEqual(b.receipts.map((x) => x.fees.splash.minor), fees.map(String), 'the fee the chain charged, not the bound that was signed');
  assert.equal(b.totalFeeMinor, (fees[0] + fees[1]).toString());
  assert.equal(b.totalSentMinor, (USDC(5_000) + USDC(250)).toString());
  assert.equal(b.totalDebitMinor, (USDC(5_250) + fees[0] + fees[1]).toString());
  assert.deepEqual(b.approvers.map((a) => a.name).sort(), ['u-founder', 'u-two']);
  assert.ok(b.receipts.every((x) => x.suiDigest === b.suiDigest && x.final && x.verifyUrl), 'every payment of the batch shares the transaction');
  assert.equal(new Set(b.receipts.map((x) => x.receiptNo)).size, 2, 'each payment has its own receipt number');
  assert.deepEqual(b.receipts.map((x) => x.reference), ['INV-1', '=cmd|calc']);
  assert.match(b.verifyUrl, /^https:\/\/.*testnet/);
  assert.ok(b.receipts.every((x) => x.fees.partner.length === 0), 'no partner or Circle fee exists on a wallet payment');
  const csv = batchReceiptsCsv(b);
  assert.equal(csv.split('\n').length, 3);
  assert.match(csv, /"'=cmd\|calc"/, 'a cell a spreadsheet would run is written as text');
  assert.match(csv.split('\n')[0], /^receipt_no,payee,address,amount_usdc,splash_fee_usdc/);
});

test('a batch not yet signed has receipts that are not final and show the bound, not a fee; a failed one says so', async () => {
  const { batchReceiptsFor } = await import('../lib/server/batch-receipts.ts');
  const t = await setup();
  const r = await settledBatch(t);
  const waiting = await batchReceiptsFor(receiptDeps(t, 'acme', async () => { throw new Error('never read'); }), r.batch.id);
  assert.equal(waiting.batch.status, 'on_the_way');
  assert.equal(waiting.batch.final, false);
  assert.equal(waiting.batch.suiDigest, null);
  assert.deepEqual(waiting.batch.receipts.map((x) => x.fees.splash.minor), [feeOf(5_000).toString(), feeOf(250).toString()]);
  await t.w.client.exec(`UPDATE wallet_signing_requests SET status = 'expired' WHERE id = '${r.signingRequest.id}'`);
  const expired = await batchReceiptsFor(receiptDeps(t, 'acme', async () => null), r.batch.id);
  assert.equal(expired.batch.status, 'failed');
  assert.equal(expired.batch.final, false);
});

test('a settled batch whose transaction cannot be read, or whose fee events cannot be matched to its rows, is not final', async () => {
  const { batchReceiptsFor } = await import('../lib/server/batch-receipts.ts');
  const t = await setup();
  const r = await settledBatch(t);
  await execute(t, r);
  const unreadable = await batchReceiptsFor(receiptDeps(t, 'acme', async () => { throw new Error('rpc down'); }), r.batch.id);
  assert.equal(unreadable.batch.final, false);
  assert.deepEqual(unreadable.batch.receipts.map((x) => x.fees.splash.minor), [feeOf(5_000).toString(), feeOf(250).toString()], 'the bound stays; no fee is made up');
  const partial = await batchReceiptsFor(receiptDeps(t, 'acme', async () => charged(1n)), r.batch.id);
  assert.equal(partial.batch.final, false, 'one fee event for two payments cannot be given to the right row');
  const none = await batchReceiptsFor(receiptDeps(t, 'acme', async () => charged()), r.batch.id);
  assert.equal(none.batch.final, true, 'no fee event is no fee charged, as for a single payment');
  assert.equal(none.batch.totalFeeMinor, '0');
});

test('another business reads a batch’s receipts as absent', async () => {
  const { batchReceiptsFor } = await import('../lib/server/batch-receipts.ts');
  const t = await setup();
  const r = await settledBatch(t);
  const other = await batchReceiptsFor(receiptDeps(t, 'northwind', async () => charged()), r.batch.id);
  assert.deepEqual([other.ok, other.status, other.code], [false, 404, 'batch_not_found']);
  assert.equal((await batchReceiptsFor(receiptDeps(t, 'acme', async () => charged()), 'wbt_missing')).code, 'batch_not_found');
});

// ─── Review findings (p3-5.6): a repeated sheet, a retry, new payees, a lost link ─────────

const rowsAB = () => sheet(row('Dela Cruz Trading Corp', '100', 'A'), row('Santos Supplies Inc', '100', 'B'));

test('the same sheet under a new intent id is flagged against the earlier batch and is paid only on an explicit yes; a failed batch does not count', async () => {
  const t = await setup();
  await twoRecipients(t);
  const first = await B.createBatch(t.deps(), OWNER, input(rowsAB()));
  assert.equal(first.ok, true, JSON.stringify(first));

  const review = await B.reviewBatch(t.deps(), OWNER, rowsAB());
  assert.deepEqual(review.review.rows.map((x) => x.duplicateOf?.batchId), [first.batch.id, first.batch.id], 'each row says which batch already pays it');
  assert.equal(review.review.duplicateCount, 2);

  const again = await B.createBatch(t.deps(), OWNER, input(rowsAB(), { clientKey: 'batch_key_000002' }));
  assert.deepEqual([again.ok, again.status, again.code], [false, 409, 'duplicate_of_earlier_batch']);
  assert.equal(again.rows.length, 2);
  assert.equal((await t.w.db.select().from(schema.walletBatches)).length, 1, 'nothing was stored for the repeat');
  assert.equal((await t.w.db.select().from(schema.walletSigningRequests)).filter((x) => x.purpose === 'wallet_batch').length, 1, 'and no second request was opened');

  const edited = await B.createBatch(t.deps(), OWNER, input(sheet(row('Dela Cruz Trading Corp', '100', 'A'), row('Santos Supplies Inc', '101', 'B')), { clientKey: 'batch_key_000003' }));
  assert.equal(edited.code, 'duplicate_of_earlier_batch', 'one repeated payment is enough');

  const confirmed = await B.createBatch(t.deps(), OWNER, input(rowsAB(), { clientKey: 'batch_key_000002', confirmDuplicates: true }));
  assert.equal(confirmed.ok, true, JSON.stringify(confirmed));

  await t.w.client.exec(`UPDATE wallet_signing_requests SET status = 'expired'`);
  const free = await B.createBatch(t.deps(), OWNER, input(rowsAB(), { clientKey: 'batch_key_000004' }));
  assert.equal(free.ok, true, 'batches that lapsed pay nothing, so they do not count');
});

test('a batch already out for signatures counts against the wallet balance of the next one', async () => {
  const t = await setup();
  await twoRecipients(t);
  const deps = t.deps('acme', { walletBalance: async () => USDC(1_500) });
  const one = await B.createBatch(deps, OWNER, input(sheet(row('Dela Cruz Trading Corp', '1,000'))));
  assert.equal(one.ok, true, JSON.stringify(one));
  const two = await B.createBatch(deps, OWNER, input(sheet(row('Santos Supplies Inc', '1,000')), { clientKey: 'batch_key_000002' }));
  assert.deepEqual([two.ok, two.code], [false, 'insufficient_balance'], 'the first batch still holds 1,000 of the 1,500');
  const review = await B.reviewBatch(deps, OWNER, sheet(row('Santos Supplies Inc', '1,000')));
  assert.equal(review.review.balance.shortByMinor, (USDC(1_000) + feeOf(1_000) + USDC(1_000) + feeOf(1_000) - USDC(1_500)).toString());
});

test('the same intent id answers the batch already made, even after a recipient, a fee or the balance has moved', async () => {
  const t = await setup();
  await twoRecipients(t);
  const first = await B.createBatch(t.deps(), OWNER, input(rowsAB()));
  assert.equal(first.ok, true);
  await saved(t, WALLET_C, 'Dela Cruz Trading Corp');
  const afterRename = await B.createBatch(t.deps(), OWNER, input(rowsAB()));
  assert.deepEqual([afterRename.ok, afterRename.created, afterRename.batch?.id], [true, false, first.batch.id], 'a name that now matches two recipients does not undo the batch');
  await execute(t, first);
  const settled = await B.createBatch(t.deps('acme', { walletBalance: async () => 0n }), OWNER, input(rowsAB()));
  assert.deepEqual([settled.ok, settled.created, settled.batch?.status], [true, false, 'settled'], 'a retry after it settled reads the batch, not an empty wallet');
  const cells = await B.createBatch(t.deps(), OWNER, input(sheet(row('  dela cruz trading corp ', '100', 'A'), row('Santos Supplies Inc', '100', 'B'))));
  assert.equal(cells.created, false, 'the batch is its cells, normalised');
  const other = await B.createBatch(t.deps(), OWNER, input(sheet(row('Dela Cruz Trading Corp', '100', 'A'), row('Santos Supplies Inc', '100', 'C'))));
  assert.equal(other.code, 'idempotency_key_reused');
});

test('a Splash business named in a sheet by its registered name is paid only once the person has confirmed the payee shown', async () => {
  const t = await setup();
  await t.w.screenClear(NORTH_WALLET);
  await saved(t, WALLET_A, 'Dela Cruz Trading Corp');
  const rows = sheet(row('Northwind Pte Ltd', '100'));
  const review = await B.reviewBatch(t.deps(), OWNER, rows);
  assert.equal(review.review.rows[0].ok, true);
  assert.equal(review.review.rows[0].newPayee, true, 'the row is marked as a payee found by name');
  assert.equal(review.review.rows[0].payee.address, NORTH_WALLET, 'with its full address');
  assert.equal(review.review.rows[0].payee.country, 'SG');
  assert.equal(review.review.newPayeeCount, 1);
  const refused = await B.createBatch(t.deps(), OWNER, input(rows));
  assert.deepEqual([refused.ok, refused.status, refused.code], [false, 409, 'new_payee_needs_confirmation']);
  assert.equal((await t.w.db.select().from(schema.walletBatches)).length, 0);
  const ok = await B.createBatch(t.deps(), OWNER, input(rows, { confirmNewPayees: true }));
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const savedRow = await B.reviewBatch(t.deps(), OWNER, sheet(row('Dela Cruz Trading Corp', '1')));
  assert.equal(savedRow.review.rows[0].newPayee ?? false, false, 'a recipient the business saved is not a new payee');
});

test('a request whose link to its batch was lost is found again by its own dedupe key, never left orphaned', async () => {
  const t = await setup();
  await twoRecipients(t);
  const made = await B.createBatch(t.deps(), OWNER, input(rowsAB()));
  assert.equal(made.ok, true);
  await t.w.client.exec(`UPDATE wallet_batches SET signing_request_id = NULL`);
  assert.equal((await B.getBatch(t.deps(), made.batch.id)).status, 'awaiting_signatures', 'the batch still reads its open request');
  const again = await B.startBatchSigning(t.deps(), OWNER, made.batch.id);
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(again.signingRequest?.id, made.signingRequest.id);
  assert.equal((await t.w.db.select().from(schema.walletBatches))[0].signingRequestId, made.signingRequest.id, 'and the link is made again');
});

test('a batch nobody has started has no receipts to read', async () => {
  const { batchReceiptsFor } = await import('../lib/server/batch-receipts.ts');
  const t = await setup();
  await twoRecipients(t);
  const prepared = await B.createBatch(t.deps(), STAFF, input(rowsAB()));
  const r = await batchReceiptsFor(receiptDeps(t, 'acme', async () => null), prepared.batch.id);
  assert.deepEqual([r.ok, r.status, r.code], [false, 409, 'batch_not_started']);
});

test('before each signature the gate also stops the wallet’s own address and an address Splash has since listed as its own', async () => {
  const t = await setup();
  await twoRecipients(t);
  const made = await B.createBatch(t.deps(), OWNER, input(rowsAB()));
  assert.equal(made.ok, true);
  const rows = await t.w.db.select().from(schema.walletSigningRequests);
  const stored = rows.find((x) => x.purpose === 'wallet_batch');
  const gate = (over = {}) => batchBeforeSign({ db: t.w.db, now: () => T0, ...over }, stored);
  assert.equal(await gate({ splashAddresses: async () => [OPERATOR] }), null);
  const listed = await gate({ splashAddresses: async () => [OPERATOR, WALLET_B] });
  assert.equal(listed?.code, 'splash_controlled_address');
  assert.match(listed?.error ?? '', /Payment 2 of 2/);
});

test('a batch its sender took back, or the owners declined, is Not paid in History, never Failed, and carries no failure block', async () => {
  const t = await setup();
  await twoRecipients(t);
  const taken = await B.createBatch(t.deps(), OWNER, input(sheet(row('Dela Cruz Trading Corp', '5,000'), row('Santos Supplies Inc', '250')), { clientKey: 'batch_key_taken01' }));
  assert.equal(taken.ok, true, JSON.stringify(taken));
  const withdrawn = await cancelSigningRequest(t.w.signing, { orgId: 'acme', userId: 'u-founder', id: taken.signingRequest.id });
  assert.equal(withdrawn.ok, true, JSON.stringify(withdrawn));
  const refused = await B.createBatch(t.deps(), OWNER, input(sheet(row('Dela Cruz Trading Corp', '600'), row('Santos Supplies Inc', '70')), { clientKey: 'batch_key_refus01' }));
  assert.equal(refused.ok, true, JSON.stringify(refused));
  for (const userId of ['u-two', 'u-three']) {
    const declined = await declineSigningRequest(t.w.signing, { orgId: 'acme', userId, id: refused.signingRequest.id });
    assert.equal(declined.ok, true, JSON.stringify(declined));
  }
  const listed = await B.listBatches(t.deps());
  assert.equal(listed.find((b) => b.id === taken.batch.id).status, 'withdrawn');
  assert.equal(listed.find((b) => b.id === refused.batch.id).status, 'declined');
  const entries = buildHistory({ transfers: [], batches: listed, withdrawals: [], earlier: [] });
  assert.equal(entries.length, 2);
  for (const e of entries) {
    assert.equal(e.group, 'not_paid', e.status.label);
    assert.equal(e.explain, null, 'a person’s own no is not a failure to explain or send to support');
    assert.equal(e.href, null);
  }
  assert.deepEqual(entries.map((e) => e.status.label).sort(), ['Declined by the owners', 'Withdrawn']);
  // A request that really failed is still Failed.
  await t.w.client.exec(`UPDATE wallet_signing_requests SET status = 'failed' WHERE id = '${taken.signingRequest.id}'`);
  const after = buildHistory({ transfers: [], batches: await B.listBatches(t.deps()), withdrawals: [], earlier: [] });
  assert.deepEqual(after.map((e) => e.group).sort(), ['failed', 'not_paid']);
});
