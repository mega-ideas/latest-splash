/**
 * v2 Phase 3, staff payments inside a rule: the service. A staff member who
 * has a rule pays alone from Transfer when the amount, the recipient and the
 * time window all fit it; the payment goes through splash_spend's allowance
 * path and is signed by that person's own passkey. Anything else is a request
 * to the owners, with the reason in plain words.
 *
 * Sky's rule: anyone can fund the wallet, but they can only spend what the
 * rule allows, and anything outside the rule needs the person in charge.
 *
 * Proven here, on PGlite with every migration, software passkeys and the
 * model chain (tests/fixtures/spend-world.mjs), which applies splash_spend's
 * checks and the allowance's caps to the very bytes the server built:
 *
 *   in a rule        one request, one signer (the staff member), executed
 *                    on the model chain, the allowance charged once
 *   outside a rule   no request, no draw: an ask to the owners with the
 *                    reasons, or a plain refusal when the person insisted on
 *                    paying alone
 *   replay           the same intent id answers the same payment; a signature
 *                    sent again moves nothing
 *   races            two requests by one person cannot both claim the last of
 *                    their cap; two people, each with room, both go through
 *   tenancy          another business's staff, recipients and requests read
 *                    as absent
 *   fail closed      no chain client, no sponsor, an unreadable rule: nothing
 *                    is built, signed or sent, and nothing stands in
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { eq } from 'drizzle-orm';
import { fromBase64, normalizeSuiAddress } from '@mysten/sui/utils';

import * as schema from '../lib/db/schema.ts';
import { LAUNCH_SCHEDULE, splashFee } from '../lib/fees/schedule.ts';
import { buildBusinessMultisig } from '../lib/wallet/business-multisig.ts';
import { softPasskey } from './fixtures/soft-passkey.mjs';
import { spendWorld } from './fixtures/spend-world.mjs';
import { T0 } from './fixtures/wallet-world.mjs';
import { startBusinessWallet } from '../lib/server/business-wallet.ts';
import { changeRecipients, issueSpendingRule, readSpendingRules, revokeSpendingRule, startSpendPolicy } from '../lib/server/spend-rules.ts';
import { deriveNearThresholdAlerts } from '../lib/server/near-threshold.ts';
import { listApprovalAsks } from '../lib/server/payment-approval-asks.ts';
import { readRequestForSigner, signingInbox, submitPartialSignature } from '../lib/server/wallet-signing.ts';
import * as T from '../lib/server/wallet-transfers.ts';
import { staffRulePaymentTx } from '../lib/server/spend-rules-builders.ts';

const U = (n) => BigInt(Math.round(n * 1_000_000));
const DAY = 86_400_000n;
const t0 = BigInt(T0.getTime());
const OPERATOR = normalizeSuiAddress(`0x${'0e'.repeat(32)}`);
const SUPPLIER = normalizeSuiAddress(`0x${'77'.repeat(32)}`);
const STRANGER = normalizeSuiAddress(`0x${'78'.repeat(32)}`);
const EXCHANGE = normalizeSuiAddress(`0x${'79'.repeat(32)}`);
const NORTH_WALLET = normalizeSuiAddress(`0x${'99'.repeat(32)}`);
const staffKey = softPasskey();
const staff2Key = softPasskey();
const STAFF = { userId: 'u-staff', role: 'MAKER' };
const STAFF2 = { userId: 'u-staff2', role: 'MAKER' };
const OWNER = { userId: 'u-founder', role: 'OWNER' };
const feeFor = (principal, kind = 1) => splashFee({ kind, principalMinor: principal, discountBps: 0, schedule: LAUNCH_SCHEDULE });

async function sign(passkey, view) {
  return (await passkey.keypair.signTransaction(fromBase64(view.transactionBytes))).signature;
}

async function signBy(w, view, name) {
  let last;
  for (const who of Array.isArray(name) ? name : [name]) {
    last = await submitPartialSignature(w.signing, { orgId: 'acme', userId: who === 'founder' ? 'u-founder' : `u-${who}`, id: view.id, signature: await sign(w.keys[who], view), digest: view.digest });
    assert.equal(last.ok, true, JSON.stringify(last));
  }
  return last.request;
}

/** A business with a wallet, a spending policy, USDC, a verified recipient and one rule for each of two staff. */
async function setup(opts = {}) {
  const w = await spendWorld({ feeOf: (amount) => feeFor(amount), ...opts });
  const started = await startBusinessWallet(w.ctx, { orgId: 'acme', requestedBy: 'u-founder', founder: { userId: 'u-founder', passkeyPublicKey: w.keys.founder.publicKey }, owners: w.owners });
  assert.equal(started.ok, true, JSON.stringify(started));
  await signBy(w, started.request, 'founder');
  const [register] = await signingInbox(w.signing, { orgId: 'acme', userId: 'u-two' });
  assert.equal((await signBy(w, register, ['two', 'three'])).status, 'executed');
  const wallet = buildBusinessMultisig({ members: w.owners });
  const members = { multisigPublicKey: wallet.multisigPublicKey, members: wallet.members.map((m) => ({ userId: m.userId, publicKey: m.suiPublicKey, weight: m.weight })) };
  const policy = await startSpendPolicy(w.sc, { orgId: 'acme', requestedBy: 'u-founder', wallet: members, perPaymentMaxMinor: U(20_000) });
  assert.equal((await signBy(w, policy.request, ['founder', 'two'])).status, 'executed');
  w.balances.set(wallet.address, { coinMinor: 0n, addressBalanceMinor: U(100_000) });

  const calls = { asks: [], records: 0 };
  const rule = (spender, over = {}) => ({ spender, perPaymentMaxMinor: U(2_000), cap: { period: 'month', limitMinor: U(15_000) }, expiresAtMs: t0 + 90n * DAY, ...over });
  const give = async (r) => {
    const opened = await issueSpendingRule(w.sc, { orgId: 'acme', requestedBy: 'u-founder', wallet: members, rule: r });
    assert.equal(opened.ok, true, JSON.stringify(opened));
    assert.equal((await signBy(w, opened.request, ['two', 'three'])).status, 'executed');
  };
  const verify = async (address, tag = 'wallet') => {
    const opened = await changeRecipients(w.sc, { orgId: 'acme', requestedBy: 'u-founder', wallet: members, change: { add: [{ address, tag }] } });
    assert.equal(opened.ok, true, JSON.stringify(opened));
    assert.equal((await signBy(w, opened.request, ['two', 'three'])).status, 'executed');
  };
  await w.screenClear(SUPPLIER);
  const recipientId = await w.saveRecipient(SUPPLIER);
  await verify(SUPPLIER);

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
    splashFee: async ({ kind, principalMinor }) => ({ feeMinor: feeFor(principalMinor, kind), feesOn: true }),
    paymentRecord: async () => {
      calls.records += 1;
      return { ok: true, contentHash: new Uint8Array(32).fill(4), walrusBlobId: new TextEncoder().encode('blob-tx') };
    },
    requesterAddresses: async (userId) => (userId === 'u-staff' ? [staffKey.address] : userId === 'u-staff2' ? [staff2Key.address] : []),
    staffSigner: async (userId) => {
      const k = userId === 'u-staff' ? staffKey : userId === 'u-staff2' ? staff2Key : null;
      return k ? { publicKey: k.publicKey, address: k.address } : null;
    },
    spend: w.sc,
    notifyAsk: async (n) => calls.asks.push(n),
    ...over,
  });
  return { w, wallet, members, deps, calls, rule, give, verify, recipientId };
}

const input = (recipientId, over = {}) => ({
  clientKey: 'tx_key_000001',
  payee: { kind: 'recipient', recipientId },
  amountMinor: U(1_000).toString(),
  maxFeeMinor: feeFor(U(1_000)).toString(),
  reference: 'INV-0042',
  ...over,
});
const amountInput = (recipientId, usdc, over = {}) => input(recipientId, { amountMinor: U(usdc).toString(), maxFeeMinor: feeFor(U(usdc)).toString(), ...over });

const requests = (w) => w.db.select().from(schema.walletSigningRequests).where(eq(schema.walletSigningRequests.purpose, 'staff_rule_payment'));
const transfers = (w) => w.db.select().from(schema.walletTransfers);
const asks = (w) => w.db.select().from(schema.walletApprovalAsks);

// ─── Inside a rule ──────────────────────────────────────────────────────────

test('a staff member whose rule covers the payment pays alone: one request, one signer, their own passkey, and it executes under their allowance', async () => {
  const t = await setup();
  await t.give(t.rule(staffKey.address));
  const fee = feeFor(U(1_000));
  const r = await T.createTransfer(t.deps(), STAFF, input(t.recipientId));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.created, true);
  assert.equal(r.transfer.route, 'staff_rule');
  assert.equal(r.transfer.status, 'awaiting_signatures');
  assert.equal(r.ask, null, 'the owners are not asked');
  assert.deepEqual([r.plan.route, r.plan.reasons], ['staff_rule', []]);
  const req = r.signingRequest;
  assert.equal(req.purpose, 'staff_rule_payment');
  assert.equal(req.threshold, 1);
  assert.deepEqual(req.signers.map((s) => [s.userId, s.address, s.signed]), [['u-staff', staffKey.address, false]]);
  assert.equal(req.sender, staffKey.address, 'sent by the staff member’s own passkey address');
  assert.equal(req.you.mustSign, true);
  assert.deepEqual(req.description.actions.map((a) => a.type), ['open_intent', 'no_second_approval', 'pay_intent', 'anchor_receipt', 'delete_intent']);
  const [open, , pay] = req.description.actions;
  assert.equal(open.recipient, SUPPLIER);
  assert.equal(open.amountMinor, U(1_000).toString());
  assert.equal(open.kind, 1);
  assert.equal(pay.maxFeeMinor, fee.toString(), 'the fee shown is the fee signed as max_fee');
  assert.equal(pay.underRule.withdrawalMinor, (U(1_000) + fee).toString());
  assert.equal(req.description.gas.sponsored, true, 'Splash sponsors the gas');
  assert.equal(t.w.spends.length, 0, 'nothing is drawn before the person signs');

  // An owner is not a signer of a staff member's own payment, and another staff member cannot see it.
  assert.equal((await submitPartialSignature(t.w.signing, { orgId: 'acme', userId: 'u-two', id: req.id, signature: await sign(t.w.keys.two, req), digest: req.digest })).code, 'not_a_signer');
  assert.equal((await readRequestForSigner(t.w.signing, { orgId: 'acme', userId: 'u-staff2', id: req.id })).status, 404);

  const signed = await submitPartialSignature(t.w.signing, { orgId: 'acme', userId: 'u-staff', id: req.id, signature: await sign(staffKey, req), digest: req.digest });
  assert.equal(signed.ok, true, JSON.stringify(signed));
  assert.equal(signed.request.status, 'executed');
  assert.equal(t.w.spends.length, 1);
  const [allowance] = [...t.w.spend.allowances.values()];
  assert.equal(allowance.currentSpend, U(1_000) + fee, 'the allowance is charged the principal and the fee bound, once');
  assert.equal(t.w.balances.get(SUPPLIER)?.addressBalanceMinor, U(1_000), 'the recipient is paid');
  assert.equal(t.w.balances.get(t.wallet.address).addressBalanceMinor, U(100_000) - U(1_000) - feeFor(U(1_000)), 'from the business wallet, not from anyone’s own funds');
  const [row] = await transfers(t.w);
  assert.equal(row.route, 'staff_rule');
  assert.equal(row.requestedBy, 'u-staff');
  assert.equal(row.signingRequestId, req.id);
  assert.equal((await T.getTransfer(t.deps(), row.id)).status, 'settled');
  assert.equal(t.calls.asks.length, 0);
  await t.w.client.close();
});

test('an invoice paid by a staff member under their rule is told it was paid, with who signed, once the transaction paid what was asked', async () => {
  const t = await setup();
  await t.give(t.rule(staffKey.address));
  const r = await T.createTransfer(t.deps(), STAFF, input(t.recipientId));
  const signed = await submitPartialSignature(t.w.signing, { orgId: 'acme', userId: 'u-staff', id: r.signingRequest.id, signature: await sign(staffKey, r.signingRequest), digest: r.signingRequest.digest });
  assert.equal(signed.request.status, 'executed');
  const { readSigningRequest } = await import('../lib/server/wallet-signing-store.ts');
  const { reportTransferSettled } = await import('../lib/server/bill-payment-flow.ts');
  const stored = await readSigningRequest(t.w.db, 'acme', r.signingRequest.id);
  const told = [];
  await reportTransferSettled(t.w.db, stored, new Date(Number(t0)), async (_db, line) => told.push(line));
  assert.equal(told.length, 1);
  assert.equal(told[0].orgId, 'acme');
  assert.equal(told[0].paymentIntentId, r.transfer.id);
  assert.equal(told[0].suiDigest, stored.executedDigest);
  assert.deepEqual(told[0].approvers, ['u-staff'], 'the person who signed, by name');
  await t.w.client.close();
});

test('the receipt of a payment made under a rule names the person who signed and the fee the chain charged, and is the business’s own', async () => {
  const t = await setup();
  await t.w.db.update(schema.users).set({ name: 'Aisha Rahman' }).where(eq(schema.users.id, 'u-staff'));
  await t.give(t.rule(staffKey.address));
  const r = await T.createTransfer(t.deps(), STAFF, input(t.recipientId));
  const { paymentReceiptFor } = await import('../lib/server/payment-receipts.ts');
  const { CORE } = await import('./fixtures/wallet-world.mjs');
  const rdeps = (orgId = 'acme', readable = true) => ({
    db: t.w.db, orgId, now: () => t.w.signing.now(), corePackageOriginalId: CORE,
    readTransaction: async (digest) => (readable ? { digest, success: true, sender: staffKey.address, balanceChanges: [], events: [{ packageId: CORE, eventType: `${CORE}::fee_config::FeeCharged`, json: { fee: feeFor(U(1_000)).toString(), derived_kind: 1 } }] } : null),
    schedule: LAUNCH_SCHEDULE, feesOn: true, signedPartners: [], network: 'mainnet',
  });
  const waiting = await paymentReceiptFor(rdeps(), r.signingRequest.id, 'u-staff');
  assert.equal(waiting.ok, true, JSON.stringify(waiting));
  assert.equal(waiting.receipt.final, false, 'not final before it is signed and executed');
  await submitPartialSignature(t.w.signing, { orgId: 'acme', userId: 'u-staff', id: r.signingRequest.id, signature: await sign(staffKey, r.signingRequest), digest: r.signingRequest.digest });
  const done = await paymentReceiptFor(rdeps(), r.signingRequest.id, 'u-staff');
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(done.receipt.final, true);
  assert.equal(done.receipt.fees.splash.minor, feeFor(U(1_000)).toString());
  assert.deepEqual(done.receipt.approvers.map((a) => a.name), ['Aisha Rahman'], 'the one person who signed, by name');
  assert.equal(done.receipt.payee.name, 'Dela Cruz Trading Corp');
  assert.equal((await paymentReceiptFor(rdeps('northwind'), r.signingRequest.id, 'u-north-staff')).status, 404, 'another business reads none of it');
  await t.w.client.close();
});

test('the same person, a second payment later, draws on the same allowance and the running total to that recipient grows', async () => {
  const t = await setup();
  await t.give(t.rule(staffKey.address));
  for (const [key, usdc] of [['tx_key_000001', 1_500], ['tx_key_000002', 1_200]]) {
    const r = await T.createTransfer(t.deps(), STAFF, amountInput(t.recipientId, usdc, { clientKey: key }));
    assert.equal(r.transfer.route, 'staff_rule', key);
    const s = await submitPartialSignature(t.w.signing, { orgId: 'acme', userId: 'u-staff', id: r.signingRequest.id, signature: await sign(staffKey, r.signingRequest), digest: r.signingRequest.digest });
    assert.equal(s.request.status, 'executed', JSON.stringify(s));
  }
  const view = (await readSpendingRules(t.w.sc)).view;
  const [mine] = view.rules.filter((x) => x.spender === staffKey.address);
  assert.equal(mine.runningTotals[0].totalMinor, String(U(2_700)));
  assert.equal(mine.recentSpends.length, 2);
  await t.w.client.close();
});

// ─── Outside a rule ─────────────────────────────────────────────────────────

test('no rule and no approval means no draw: the owners are asked, with the reason, and nothing is signed or spent', async () => {
  const t = await setup();
  // u-staff has no rule at all.
  const r = await T.createTransfer(t.deps(), STAFF, input(t.recipientId));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.transfer.route, 'asked_owners');
  assert.equal(r.signingRequest ?? null, null);
  assert.deepEqual(r.plan.reasons, ['no_rule']);
  assert.match(r.plan.lines.join(' '), /no spending rule/i);
  assert.ok(r.ask?.id?.startsWith('wpa_'));
  assert.match(r.ask.note, /no spending rule/i, 'the owners are told why it came to them');
  assert.equal((await requests(t.w)).length, 0, 'no staff payment request exists');
  assert.equal(t.w.spends.length, 0);
  assert.equal(t.calls.asks.length, 1, 'the owners are told');
  // Insisting on paying alone is refused, in words, and leaves nothing behind.
  const insisted = await T.createTransfer(t.deps(), STAFF, input(t.recipientId, { clientKey: 'tx_key_000002', via: 'rule' }));
  assert.equal(insisted.ok, false);
  assert.deepEqual([insisted.status, insisted.code], [409, 'outside_rule']);
  assert.deepEqual(insisted.reasons, ['no_rule']);
  assert.match(insisted.error, /no spending rule/i);
  assert.equal((await transfers(t.w)).length, 1);
  assert.equal((await asks(t.w)).length, 1);
  await t.w.client.close();
});

test('a transaction built by hand for someone with no rule never reaches a signer: the dry run aborts and nobody is asked', async () => {
  const t = await setup();
  await t.give(t.rule(staffKey.address));
  // staff2 has no rule. Their bytes name staff's allowance, which the reader will accept for a request that names it.
  const { readStaffRule, openStaffRulePayment } = await import('../lib/server/spend-rules.ts');
  const read = await readStaffRule(t.w.sc, { addresses: [staffKey.address] });
  assert.equal(read.ok, true, read.error);
  const payment = { paymentRef: new Uint8Array(32).fill(9), recipient: SUPPLIER, amountMinor: U(100), targetCurrency: 'USDC', fxRateUsdLocal: 1_000_000n, commitment: new Uint8Array(32).fill(8), railCommitment: new Uint8Array(32).fill(7), expiresAtMs: t0 + 7n * DAY, maxFeeMinor: feeFor(U(100)), settleByMs: t0 + 3_600_000n, contentHash: new Uint8Array(32).fill(4), walrusBlobId: new TextEncoder().encode('blob') };
  // The server will not even build it: the allowance is not theirs.
  const refused = await openStaffRulePayment(t.w.sc, { orgId: 'acme', userId: 'u-staff2', signer: { publicKey: staff2Key.publicKey, address: staff2Key.address }, read: read.read, payment });
  assert.deepEqual([refused.ok, refused.code], [false, 'no_passkey_for_rule']);
  // Bytes made by hand and put to the signing layer: the dry run aborts, so nobody is asked to sign.
  const bytes = await staffRulePaymentTx(t.w.sc.chain, {
    ...payment,
    spender: staff2Key.address,
    account: t.w.ctx.account,
    policy: { objectId: read.read.policy.objectId, initialSharedVersion: read.read.policy.initialSharedVersion },
    allowance: { objectId: read.read.allowance.objectId, initialSharedVersion: read.read.allowance.initialSharedVersion },
    funder: read.read.allowance.funder,
    gas: await t.w.signing.sponsor.gasFor(),
  });
  const { openSigningRequest } = await import('../lib/server/wallet-signing.ts');
  const staffPay = { policyId: read.read.policy.objectId, allowanceId: read.read.allowance.objectId, funder: read.read.allowance.funder };
  const forged = await openSigningRequest(t.w.signing, {
    orgId: 'acme',
    requestedBy: 'u-staff2',
    purpose: 'staff_rule_payment',
    dedupeKey: 'pay:forged',
    transactionBytes: bytes,
    signer: { kind: 'single', userId: 'u-staff2', publicKey: Buffer.from(new (await import('@mysten/sui/keypairs/passkey')).PasskeyPublicKey(fromBase64(staff2Key.publicKey)).toSuiBytes()).toString('base64') },
    gasMode: 'sponsored',
    staffPay,
    staffPayment: { spender: staff2Key.address, recipient: SUPPLIER, amountMinor: U(100), maxFeeMinor: payment.maxFeeMinor, policyId: staffPay.policyId, allowanceId: staffPay.allowanceId },
  });
  assert.equal(forged.ok, false);
  assert.equal(forged.code, 'simulation_failed');
  assert.match(forged.error, /E_NOT_STAFF|ENotTheSpender/);
  assert.equal((await requests(t.w)).length, 0);
  await t.w.client.close();
});

const OUTSIDE = [
  ['a rule that has ended', async (t) => t.w.setNow(new Date(Number(t0 + 91n * DAY))), 'rule_expired', /ended/i],
  [
    'a rule the owners took back',
    async (t) => {
      const opened = await revokeSpendingRule(t.w.sc, { orgId: 'acme', requestedBy: 'u-founder', wallet: t.members, spender: staffKey.address });
      assert.equal((await signBy(t.w, opened.request, ['founder', 'two'])).status, 'executed');
    },
    'no_rule',
    /no spending rule/i,
  ],
  [
    'an allowance taken back while the person is still on the policy',
    async (t) => {
      const [id] = [...t.w.spend.allowances.keys()];
      t.w.spend.allowances.delete(id);
      for (const [cap, c] of t.w.spend.caps) if (c.allowance === id) t.w.spend.caps.delete(cap);
    },
    'rule_revoked',
    /taken back/i,
  ],
  [
    'a cap already used up for now',
    async (t) => {
      const id = [...t.w.spend.allowances.keys()][0];
      t.w.charge(id, U(15_000), t0);
    },
    'cap_used_up',
    /used up/i,
  ],
  ['a recipient the owners have not verified', async () => {}, 'recipient_not_on_rule', /not on your rule/i, { stranger: true }],
  ['more than the rule allows for one payment', async () => {}, 'over_payment_max', /more than your rule allows for one payment/i, { usdc: 2_500 }],
  ['an exchange account', async () => {}, 'exchange_needs_owners', /Travel Rule/i, { exchange: true }],
];

for (const [name, prepare, reason, words, opts = {}] of OUTSIDE) {
  test(`${name} is not paid alone: the person is told why, the owners are asked, and nothing is drawn`, async () => {
    const t = await setup();
    await t.give(t.rule(staffKey.address));
    let recipientId = t.recipientId;
    if (opts.stranger) {
      await t.w.screenClear(STRANGER);
      recipientId = await t.w.saveRecipient(STRANGER);
    }
    if (opts.exchange) {
      await t.w.screenClear(EXCHANGE);
      recipientId = await t.w.saveRecipient(EXCHANGE, { kind: 'EXCHANGE' });
      await t.verify(EXCHANGE, 'exchange');
    }
    await prepare(t);
    // The fee the page showed: an exchange account is priced as an exchange payment.
    const body = (over = {}) => amountInput(recipientId, opts.usdc ?? 1_000, { ...(opts.exchange ? { maxFeeMinor: feeFor(U(opts.usdc ?? 1_000), 2).toString() } : {}), ...over });
    // The person insists on paying alone: refused, plainly.
    const insisted = await T.createTransfer(t.deps(), STAFF, body({ via: 'rule' }));
    assert.equal(insisted.ok, false, JSON.stringify(insisted));
    assert.deepEqual([insisted.status, insisted.code], [409, 'outside_rule']);
    assert.ok(insisted.reasons.includes(reason), `${reason} in ${insisted.reasons}`);
    assert.match(insisted.error, words);
    assert.equal((await transfers(t.w)).length, 0, 'nothing was stored');
    // The page let the server decide: the owners are asked, with the same reason.
    const asked = await T.createTransfer(t.deps(), STAFF, body({ clientKey: 'tx_key_000002' }));
    assert.equal(asked.ok, true, JSON.stringify(asked));
    assert.equal(asked.transfer.route, 'asked_owners');
    assert.ok(asked.plan.reasons.includes(reason));
    assert.match(asked.plan.lines.join(' '), words);
    assert.equal((await requests(t.w)).length, 0);
    assert.equal(t.w.spends.length, 0);
    assert.equal([...t.w.spend.allowances.values()].reduce((a, x) => a + x.currentSpend, 0n), reason === 'cap_used_up' ? U(15_000) : 0n, 'the allowance is as it was');
    await t.w.client.close();
  });
}

test('once the cap window has renewed, the same rule pays alone again', async () => {
  const t = await setup();
  await t.give(t.rule(staffKey.address, { cap: { period: 'day', limitMinor: U(1_100) } }));
  const first = await T.createTransfer(t.deps(), STAFF, input(t.recipientId));
  assert.equal(first.transfer.route, 'staff_rule');
  await submitPartialSignature(t.w.signing, { orgId: 'acme', userId: 'u-staff', id: first.signingRequest.id, signature: await sign(staffKey, first.signingRequest), digest: first.signingRequest.digest });
  const second = await T.createTransfer(t.deps(), STAFF, input(t.recipientId, { clientKey: 'tx_key_000002' }));
  assert.equal(second.transfer.route, 'asked_owners');
  assert.deepEqual(second.plan.reasons, ['over_cap']);
  t.w.setNow(new Date(T0.getTime() + 25 * 3_600_000));
  await t.w.screenClear(SUPPLIER);
  const third = await T.createTransfer(t.deps(), STAFF, input(t.recipientId, { clientKey: 'tx_key_000003' }));
  assert.equal(third.transfer.route, 'staff_rule', 'a day later the cap is whole again');
  await t.w.client.close();
});

test('above the second-approval threshold, counting what this person already paid the same recipient, the owners decide', async () => {
  const t = await setup();
  await t.give(t.rule(staffKey.address, { perPaymentMaxMinor: U(6_000), cap: { period: 'month', limitMinor: U(50_000) } }));
  const pay = async (key, usdc) => {
    const r = await T.createTransfer(t.deps(), STAFF, amountInput(t.recipientId, usdc, { clientKey: key }));
    if (r.transfer?.route === 'staff_rule') await submitPartialSignature(t.w.signing, { orgId: 'acme', userId: 'u-staff', id: r.signingRequest.id, signature: await sign(staffKey, r.signingRequest), digest: r.signingRequest.digest });
    return r;
  };
  assert.equal((await pay('tx_key_000001', 6_000)).transfer.route, 'staff_rule');
  const over = await pay('tx_key_000002', 4_001);
  assert.equal(over.transfer.route, 'asked_owners');
  assert.deepEqual(over.plan.reasons, ['above_threshold']);
  assert.match(over.plan.lines[0], /10,000\.00 USDC/);
  assert.equal((await pay('tx_key_000003', 4_000)).transfer.route, 'staff_rule', 'exactly the threshold needs no approval; one unit above does');
  await t.w.client.close();
});

test('a payment in anything but USDC is refused for staff and for owners alike, and is not sent to anyone', async () => {
  const t = await setup();
  await t.give(t.rule(staffKey.address));
  for (const actor of [STAFF, OWNER]) {
    const r = await T.createTransfer(t.deps(), actor, input(t.recipientId, { asset: 'USDT', clientKey: `tx_key_${actor.userId.length}0001` }));
    assert.equal(r.ok, false);
    assert.deepEqual([r.status, r.code], [400, 'wrong_asset'], actor.userId);
    assert.match(r.error, /USDC/);
  }
  assert.equal((await transfers(t.w)).length, 0);
  assert.equal((await asks(t.w)).length, 0);
  const ok = await T.createTransfer(t.deps(), STAFF, input(t.recipientId, { asset: 'USDC' }));
  assert.equal(ok.transfer.route, 'staff_rule');
  await t.w.client.close();
});

test('a recipient that is not a fresh CLEAR is not paid under a rule, and neither are funds on hold', async () => {
  const t = await setup();
  await t.give(t.rule(staffKey.address));
  // A recipient the owners verified on the policy but nobody has screened: no fresh CLEAR, so no payment.
  const unscreenedId = await t.w.saveRecipient(STRANGER);
  await t.verify(STRANGER);
  const unscreened = await T.createTransfer(t.deps(), STAFF, input(unscreenedId, { via: 'rule' }));
  assert.equal(unscreened.ok, false);
  assert.ok([403, 409].includes(unscreened.status), String(unscreened.status));
  assert.equal((await requests(t.w)).length, 0);
  assert.equal((await transfers(t.w)).length, 0);
  t.w.ctx.heldUsdc = async () => U(99_999);
  t.w.ctx.readUsdc = async () => ({ coinMinor: 0n, addressBalanceMinor: U(100_000) });
  const held = await T.createTransfer(t.deps(), STAFF, input(t.recipientId, { clientKey: 'tx_key_000002' }));
  assert.equal(held.ok, false);
  assert.deepEqual([held.status, held.code], [409, 'funds_on_hold']);
  assert.equal((await requests(t.w)).length, 0);
  await t.w.client.close();
});

test('a viewer cannot pay at all, and an owner’s payment is the owners’ even when the page says via rule', async () => {
  const t = await setup();
  await t.give(t.rule(staffKey.address));
  const viewer = await T.createTransfer(t.deps(), { userId: 'u-view', role: 'VIEWER' }, input(t.recipientId));
  assert.deepEqual([viewer.ok, viewer.status, viewer.code], [false, 403, 'cannot_pay']);
  const owner = await T.createTransfer(t.deps(), OWNER, input(t.recipientId, { via: 'rule' }));
  assert.equal(owner.ok, true, JSON.stringify(owner));
  assert.equal(owner.transfer.route, 'owners_sign');
  assert.equal(owner.signingRequest.purpose, 'wallet_payment');
  assert.equal(owner.signingRequest.threshold, 2);
  await t.w.client.close();
});

// ─── Between asking and signing ─────────────────────────────────────────────

test('a rule taken back after the request was opened: the dry run fails at submission, nothing is drawn, and the payment reads as not paid', async () => {
  const t = await setup();
  await t.give(t.rule(staffKey.address));
  const r = await T.createTransfer(t.deps(), STAFF, input(t.recipientId));
  assert.equal(r.transfer.route, 'staff_rule');
  const taken = await revokeSpendingRule(t.w.sc, { orgId: 'acme', requestedBy: 'u-founder', wallet: t.members, spender: staffKey.address });
  assert.equal((await signBy(t.w, taken.request, ['founder', 'two'])).status, 'executed');
  const signed = await submitPartialSignature(t.w.signing, { orgId: 'acme', userId: 'u-staff', id: r.signingRequest.id, signature: await sign(staffKey, r.signingRequest), digest: r.signingRequest.digest });
  assert.equal(signed.request.status, 'failed');
  assert.equal(t.w.spends.length, 0);
  assert.equal(t.w.balances.get(SUPPLIER), undefined, 'the recipient was not paid');
  assert.equal((await T.getTransfer(t.deps(), r.transfer.id)).status, 'failed');
  await t.w.client.close();
});

test('a recipient blocked after the request was opened is not paid: the signature is refused', async () => {
  const t = await setup();
  await t.give(t.rule(staffKey.address));
  const { paymentBeforeSign } = await import('../lib/server/payment-compliance-gate.ts');
  const { recordScreening } = await import('../lib/server/kyt-screenings.ts');
  t.w.signing.beforeSign = (request) => paymentBeforeSign({ db: t.w.db, now: () => T0 }, request);
  const r = await T.createTransfer(t.deps(), STAFF, input(t.recipientId));
  assert.equal(r.transfer.route, 'staff_rule');
  await new Promise((resolve) => setTimeout(resolve, 5));
  await recordScreening(t.w.db, {
    orgId: 'acme', kind: 'wallet_recipient', chain: 'SUI', address: SUPPLIER, requestedBy: 'test',
    screening: { provider: 'elliptic', verdict: 'BLOCK', reference: 'elliptic:test-block', detail: 'test', screenedAt: new Date(T0.getTime() + 1).toISOString(), riskScore: 100 },
  });
  const refused = await submitPartialSignature(t.w.signing, { orgId: 'acme', userId: 'u-staff', id: r.signingRequest.id, signature: await sign(staffKey, r.signingRequest), digest: r.signingRequest.digest });
  assert.deepEqual([refused.ok, refused.code], [false, 'recipient_blocked']);
  assert.equal(t.w.spends.length, 0);
  await t.w.client.close();
});

// ─── Replay ─────────────────────────────────────────────────────────────────

test('the same intent id answers the payment already made; another payment under it is refused; a signature sent again moves nothing', async () => {
  const t = await setup();
  await t.give(t.rule(staffKey.address));
  const a = await T.createTransfer(t.deps(), STAFF, input(t.recipientId));
  const b = await T.createTransfer(t.deps(), STAFF, input(t.recipientId));
  assert.equal(b.ok, true);
  assert.equal(b.created, false);
  assert.equal(b.transfer.id, a.transfer.id);
  assert.equal(b.signingRequest.id, a.signingRequest.id);
  assert.equal((await requests(t.w)).length, 1);
  assert.equal((await transfers(t.w)).length, 1);
  const other = await T.createTransfer(t.deps(), STAFF, amountInput(t.recipientId, 1_001));
  assert.deepEqual([other.ok, other.status, other.code], [false, 409, 'idempotency_key_reused']);
  const good = { orgId: 'acme', userId: 'u-staff', id: a.signingRequest.id, signature: await sign(staffKey, a.signingRequest), digest: a.signingRequest.digest };
  assert.equal((await submitPartialSignature(t.w.signing, good)).request.status, 'executed');
  const again = await submitPartialSignature(t.w.signing, good);
  assert.equal(again.ok, false);
  assert.equal(t.w.spends.length, 1, 'one draw');
  // After it executed, the same intent id still answers that payment, settled, and opens nothing.
  const after = await T.createTransfer(t.deps(), STAFF, input(t.recipientId));
  assert.equal(after.created, false);
  assert.equal(after.transfer.status, 'settled');
  assert.equal((await requests(t.w)).length, 1);
  assert.equal([...t.w.spend.allowances.values()][0].currentSpend, U(1_000) + feeFor(U(1_000)));
  await t.w.client.close();
});

test('two sends racing on one intent id make one payment and one request', async () => {
  const t = await setup();
  await t.give(t.rule(staffKey.address));
  const [x, y] = await Promise.all([T.createTransfer(t.deps(), STAFF, input(t.recipientId)), T.createTransfer(t.deps(), STAFF, input(t.recipientId))]);
  assert.equal(x.ok && y.ok, true, JSON.stringify([x, y]));
  assert.equal([x, y].filter((r) => r.created).length, 1);
  assert.equal(x.transfer.id, y.transfer.id);
  assert.equal((await requests(t.w)).length, 1);
  assert.equal((await transfers(t.w)).length, 1);
  await t.w.client.close();
});

// ─── Races at the boundary of the cap ───────────────────────────────────────

test('one person asking twice at once for the last of their cap: one pays alone, the other is asked of the owners; nothing is over-claimed', async () => {
  const t = await setup();
  // Room for exactly one: 1,000 and its fee, not two.
  await t.give(t.rule(staffKey.address, { cap: { period: 'month', limitMinor: U(1_300) } }));
  const [x, y] = await Promise.all([
    T.createTransfer(t.deps(), STAFF, input(t.recipientId, { clientKey: 'tx_key_00000a' })),
    T.createTransfer(t.deps(), STAFF, input(t.recipientId, { clientKey: 'tx_key_00000b' })),
  ]);
  assert.equal(x.ok && y.ok, true, JSON.stringify([x, y]));
  const routes = [x.transfer.route, y.transfer.route].sort();
  assert.deepEqual(routes, ['asked_owners', 'staff_rule']);
  const loser = x.transfer.route === 'asked_owners' ? x : y;
  assert.deepEqual(loser.plan.reasons, ['over_cap']);
  assert.equal((await requests(t.w)).length, 1);
  const winner = x.transfer.route === 'staff_rule' ? x : y;
  assert.equal((await submitPartialSignature(t.w.signing, { orgId: 'acme', userId: 'u-staff', id: winner.signingRequest.id, signature: await sign(staffKey, winner.signingRequest), digest: winner.signingRequest.digest })).request.status, 'executed');
  assert.equal(t.w.spends.length, 1);
  // Once the first has landed, what is left on chain is what is counted: no double count of it.
  const third = await T.createTransfer(t.deps(), STAFF, amountInput(t.recipientId, 300, { clientKey: 'tx_key_00000c' }));
  assert.equal(third.transfer.route, 'asked_owners', 'there is not room for another 300 and its fee: 1,300 less the 1,000 and its fee already drawn is just under 300');
  const fourth = await T.createTransfer(t.deps(), STAFF, amountInput(t.recipientId, 100, { clientKey: 'tx_key_00000d' }));
  assert.equal(fourth.transfer.route, 'staff_rule', 'what is left on chain is counted once, not twice: 100 and its fee fit');
  await t.w.client.close();
});

test('the cap the first request is waiting on is released when it is withdrawn', async () => {
  const t = await setup();
  await t.give(t.rule(staffKey.address, { cap: { period: 'month', limitMinor: U(1_300) } }));
  const first = await T.createTransfer(t.deps(), STAFF, input(t.recipientId, { clientKey: 'tx_key_00000a' }));
  assert.equal(first.transfer.route, 'staff_rule');
  const second = await T.createTransfer(t.deps(), STAFF, input(t.recipientId, { clientKey: 'tx_key_00000b' }));
  assert.equal(second.transfer.route, 'asked_owners');
  const { cancelSigningRequest } = await import('../lib/server/wallet-signing.ts');
  assert.equal((await cancelSigningRequest(t.w.signing, { orgId: 'acme', userId: 'u-staff', id: first.signingRequest.id })).ok, true);
  const third = await T.createTransfer(t.deps(), STAFF, input(t.recipientId, { clientKey: 'tx_key_00000c' }));
  assert.equal(third.transfer.route, 'staff_rule', 'a withdrawn request no longer holds the cap');
  await t.w.client.close();
});

test('a request nobody signed in time holds nothing, even before the sweep has closed it', async () => {
  const t = await setup();
  await t.give(t.rule(staffKey.address, { cap: { period: 'month', limitMinor: U(1_300) } }));
  const first = await T.createTransfer(t.deps(), STAFF, input(t.recipientId, { clientKey: 'tx_key_00000a' }));
  assert.equal(first.transfer.route, 'staff_rule');
  // Over an hour later the request can no longer be signed, though its row still says collecting.
  t.w.setNow(new Date(T0.getTime() + 61 * 60_000));
  await t.w.screenClear(SUPPLIER);
  const [row] = await requests(t.w);
  assert.equal(row.status, 'collecting');
  const second = await T.createTransfer(t.deps(), STAFF, input(t.recipientId, { clientKey: 'tx_key_00000b' }));
  assert.equal(second.transfer.route, 'staff_rule', 'the lapsed request does not hold the cap');
  await t.w.client.close();
});

test('two staff, each with room for one payment, both pay alone at the same time and neither takes the other’s cap', async () => {
  const t = await setup();
  await t.give(t.rule(staffKey.address, { cap: { period: 'month', limitMinor: U(1_300) } }));
  await t.give(t.rule(staff2Key.address, { cap: { period: 'month', limitMinor: U(1_300) } }));
  const [x, y] = await Promise.all([
    T.createTransfer(t.deps(), STAFF, input(t.recipientId, { clientKey: 'tx_key_00000a' })),
    T.createTransfer(t.deps(), STAFF2, input(t.recipientId, { clientKey: 'tx_key_00000b' })),
  ]);
  assert.deepEqual([x.transfer.route, y.transfer.route], ['staff_rule', 'staff_rule']);
  assert.equal((await requests(t.w)).length, 2);
  for (const [who, key, r] of [['u-staff', staffKey, x], ['u-staff2', staff2Key, y]]) {
    const s = await submitPartialSignature(t.w.signing, { orgId: 'acme', userId: who, id: r.signingRequest.id, signature: await sign(key, r.signingRequest), digest: r.signingRequest.digest });
    assert.equal(s.request.status, 'executed', JSON.stringify(s));
  }
  assert.equal(t.w.spends.length, 2);
  for (const a of t.w.spend.allowances.values()) assert.equal(a.currentSpend, U(1_000) + feeFor(U(1_000)));
  await t.w.client.close();
});

test('the same recipient reached through several spenders feeds the near-threshold alerts', async () => {
  const t = await setup();
  await t.give(t.rule(staffKey.address, { perPaymentMaxMinor: U(2_000), cap: { period: 'month', limitMinor: U(20_000) } }));
  await t.give(t.rule(staff2Key.address, { perPaymentMaxMinor: U(2_000), cap: { period: 'month', limitMinor: U(20_000) } }));
  let n = 0;
  for (const [actor, key, who] of [[STAFF, staffKey, 'u-staff'], [STAFF2, staff2Key, 'u-staff2'], [STAFF, staffKey, 'u-staff'], [STAFF2, staff2Key, 'u-staff2']]) {
    n += 1;
    const r = await T.createTransfer(t.deps(), actor, amountInput(t.recipientId, 2_000, { clientKey: `tx_key_0000${n}0` }));
    assert.equal(r.transfer.route, 'staff_rule', `payment ${n}: ${JSON.stringify(r.plan)}`);
    const s = await submitPartialSignature(t.w.signing, { orgId: 'acme', userId: who, id: r.signingRequest.id, signature: await sign(key, r.signingRequest), digest: r.signingRequest.digest });
    assert.equal(s.request.status, 'executed');
  }
  // Each person is at 4,000 of the 10,000 threshold, under it alone; together 8,000, which is 80% of it.
  const view = (await readSpendingRules(t.w.sc)).view;
  const alerts = deriveNearThresholdAlerts(view);
  const many = alerts.find((a) => a.kind === 'same_recipient_many_spenders');
  assert.ok(many, JSON.stringify(alerts.map((a) => a.kind)));
  assert.equal(many.recipient, SUPPLIER);
  assert.deepEqual([...many.spenders].sort(), [staffKey.address, staff2Key.address].sort());
  assert.equal(many.severity, 'near_threshold');
  assert.equal(many.countedMinor, String(U(8_000)));
  await t.w.client.close();
});

// ─── Another business ───────────────────────────────────────────────────────

test('another business’s recipients, requests and staff are absent: nothing crosses', async () => {
  const t = await setup();
  await t.give(t.rule(staffKey.address));
  const mine = await T.createTransfer(t.deps(), STAFF, input(t.recipientId));
  assert.equal(mine.transfer.route, 'staff_rule');
  // From northwind: acme's saved recipient is absent, and northwind has no wallet to pay from.
  const north = t.deps('northwind');
  const probe = await T.createTransfer(north, { userId: 'u-north-staff', role: 'MAKER' }, input(t.recipientId, { clientKey: 'tx_key_north_1' }));
  assert.equal(probe.ok, false);
  assert.ok([404, 409].includes(probe.status), String(probe.status));
  assert.equal(await T.getTransfer(north, mine.transfer.id), null, 'acme’s payment reads as absent from northwind');
  assert.deepEqual((await T.listTransfers(north)), []);
  assert.deepEqual(await listApprovalAsks(t.w.db, { orgId: 'northwind', userId: 'u-north-staff' }), []);
  // acme's staff request cannot be read or signed by northwind's people, by id.
  assert.equal((await readRequestForSigner(t.w.signing, { orgId: 'northwind', userId: 'u-north-staff', id: mine.signingRequest.id })).status, 404);
  assert.equal((await submitPartialSignature(t.w.signing, { orgId: 'northwind', userId: 'u-north-staff', id: mine.signingRequest.id, signature: await sign(staffKey, mine.signingRequest), digest: mine.signingRequest.digest })).status, 404);
  // The staff member's rule is read for acme only: a person of another business has no rule here.
  const { readStaffRule } = await import('../lib/server/spend-rules.ts');
  const read = await readStaffRule(t.w.sc, { addresses: [softPasskey().address] });
  assert.equal(read.ok, true);
  assert.equal(read.read.facts.rule, null);
  await t.w.client.close();
});

// ─── Fail closed ────────────────────────────────────────────────────────────

test('in production, without the chain client for spending rules, nothing is built, signed or sent for a payment under a rule', async () => {
  const t = await setup();
  await t.give(t.rule(staffKey.address));
  const prod = t.deps('acme', { env: { NODE_ENV: 'production' }, spend: undefined });
  const insisted = await T.createTransfer(prod, STAFF, input(t.recipientId, { via: 'rule' }));
  assert.equal(insisted.ok, false);
  assert.deepEqual([insisted.status, insisted.code], [503, 'staff_rule_unavailable']);
  assert.match(insisted.error, /nothing was sent/i);
  assert.equal((await transfers(t.w)).length, 0);
  assert.equal((await requests(t.w)).length, 0);
  // Left to decide, the server does not pretend: the owners are asked, and the reason says paying under a rule is not set up.
  const asked = await T.createTransfer(prod, STAFF, input(t.recipientId, { clientKey: 'tx_key_000002' }));
  assert.equal(asked.ok, true, JSON.stringify(asked));
  assert.equal(asked.transfer.route, 'asked_owners');
  assert.deepEqual(asked.plan.reasons, ['staff_rule_not_wired']);
  assert.equal((await requests(t.w)).length, 0);
  assert.equal(t.w.spends.length, 0);
  // A staff member's passkey that cannot sign here is the same: no stand-in signer.
  const noKey = t.deps('acme', { staffSigner: async () => null });
  const nokey = await T.createTransfer(noKey, STAFF, input(t.recipientId, { clientKey: 'tx_key_000003', via: 'rule' }));
  assert.deepEqual([nokey.ok, nokey.status, nokey.code], [false, 409, 'no_passkey_for_rule']);
  await t.w.client.close();
});

test('an unreadable chain, and a missing gas sponsor, are refused as such, not answered from a guess', async () => {
  const t = await setup();
  await t.give(t.rule(staffKey.address));
  const broken = t.deps('acme', { spend: { ...t.w.sc, read: { ...t.w.sc.read, readPolicy: async () => { throw new Error('rpc down'); } } } });
  const insisted = await T.createTransfer(broken, STAFF, input(t.recipientId, { via: 'rule' }));
  assert.deepEqual([insisted.ok, insisted.status, insisted.code], [false, 502, 'rule_unreadable']);
  const left = await T.createTransfer(broken, STAFF, input(t.recipientId, { clientKey: 'tx_key_000002' }));
  assert.equal(left.transfer.route, 'asked_owners');
  assert.deepEqual(left.plan.reasons, ['policy_unreadable']);
  const sponsor = t.w.signing.sponsor;
  t.w.signing.sponsor = null;
  const nosponsor = await T.createTransfer(t.deps(), STAFF, input(t.recipientId, { clientKey: 'tx_key_000003', via: 'rule' }));
  assert.deepEqual([nosponsor.ok, nosponsor.status, nosponsor.code], [false, 503, 'no_sponsor']);
  t.w.signing.sponsor = sponsor;
  assert.equal((await requests(t.w)).length, 0);
  assert.equal(t.w.spends.length, 0);
  await t.w.client.close();
});

test('a rule held by a passkey this person can no longer sign with is not paid under; the owners are asked', async () => {
  const t = await setup();
  await t.give(t.rule(staffKey.address));
  const other = softPasskey();
  const swapped = t.deps('acme', { staffSigner: async () => ({ publicKey: other.publicKey, address: other.address }) });
  const asked = await T.createTransfer(swapped, STAFF, input(t.recipientId));
  assert.equal(asked.transfer.route, 'asked_owners');
  assert.deepEqual(asked.plan.reasons, ['rule_needs_passkey']);
  assert.match(asked.plan.lines.join(' '), /passkey you cannot sign with/);
  assert.equal((await requests(t.w)).length, 0);
  await t.w.client.close();
});

// ─── The ask names who can see it ──────────────────────────────────────────

test('the Finance lead sees the ask where the role allows, and cannot approve it; only an owner can', async () => {
  const t = await setup();
  const lead = 'u-lead';
  await t.w.db.insert(schema.users).values({ id: lead, email: 'lead@acme.test', name: lead });
  await t.w.db.insert(schema.memberships).values({ id: `m-${lead}`, userId: lead, orgId: 'acme', role: 'checker' });
  await t.w.db.insert(schema.walletFinanceLeads).values({ id: 'fl_1', orgId: 'acme', userId: lead, grantedBy: 'u-founder', grantedAt: T0 });
  const r = await T.createTransfer(t.deps(), STAFF, input(t.recipientId));
  assert.equal(r.transfer.route, 'asked_owners');
  assert.deepEqual(t.calls.asks[0].financeLeadUserId, lead, 'the lead is told');
  assert.ok(!t.calls.asks[0].ownerUserIds.includes(lead));
  const seen = await listApprovalAsks(t.w.db, { orgId: 'acme', userId: lead });
  assert.equal(seen.length, 1);
  const { acceptApprovalAsk } = await import('../lib/server/payment-approval-asks.ts');
  const tried = await acceptApprovalAsk({ db: t.w.db, ctx: t.w.ctx }, { orgId: 'acme', userId: lead, askId: r.ask.id, mode: 'wallet_pays', wallet: t.members, maxFeeMinor: null, settleByMs: t0 + 3_600_000n });
  assert.deepEqual([tried.ok, tried.status, tried.code], [false, 403, 'not_an_owner']);
  await t.w.client.close();
});

test('the audit bundle is made for a payment under a rule the same way, and a refused bundle leaves nothing behind', async () => {
  const t = await setup();
  await t.give(t.rule(staffKey.address));
  const refused = await T.createTransfer(t.deps('acme', { paymentRecord: async () => ({ ok: false, status: 503, code: 'seal_unavailable', error: 'Seal is not available' }) }), STAFF, input(t.recipientId));
  assert.deepEqual([refused.ok, refused.status, refused.code], [false, 503, 'seal_unavailable']);
  assert.equal((await transfers(t.w)).length, 0, 'the claim is freed');
  assert.equal((await requests(t.w)).length, 0);
  assert.equal(t.calls.records, 0);
  const ok = await T.createTransfer(t.deps(), STAFF, input(t.recipientId));
  assert.equal(ok.transfer.route, 'staff_rule');
  assert.equal(t.calls.records, 1, 'one bundle, made by the server');
  await t.w.client.close();
});
