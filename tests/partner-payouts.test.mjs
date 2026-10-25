/**
 * Payouts to a SUPPLIER's bank through the payout partners (v2 §4.5): PH
 * through the Philippines payout partner (pdax), ID through the Indonesia
 * payout partner and its exchange partner (durianpay), on the withdrawal
 * rails (§4.4).
 *
 * PGlite with every migration, the wallet world's model chain and software
 * passkeys (tests/fixtures/wallet-world.mjs), sandbox partners wrapped so
 * every call is recorded. Nothing reaches a network; nothing is signed for
 * any network. What must hold:
 *   - a supplier's account is kept only when the bank's own holder name is
 *     the name given, with a structured address; the business's own name is
 *     a withdrawal, never a supplier; the account and the address are sealed;
 *   - each partner has its own fixed deposit address for the business,
 *     verified once by a test deposit, and only a verified one is paid;
 *   - the instruction (with the ISO 20022 message: purpose, relationship,
 *     source of funds, registration, structured address, holder) goes to the
 *     partner BEFORE any money moves, keyed by the intent id and amount;
 *   - the owners sign a `partner_payout`: a kind 4 payout to that deposit
 *     address for that supplier's commitment and amount, and are shown the
 *     supplier; the digest is posted after settlement;
 *   - webhooks are signed, counted once, never backwards, for their own
 *     partner; idempotent by the client's key; another business's ids read
 *     as absent; production without credentials stores nothing.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

import { eq } from 'drizzle-orm';
import { fromBase64, normalizeSuiAddress, toHex } from '@mysten/sui/utils';

import * as schema from '../lib/db/schema.ts';
import { signWebhook } from '../lib/funding/providers.ts';
import { LAUNCH_SCHEDULE, splashFee } from '../lib/fees/schedule.ts';
import { endToEndIdFor, uetrFor } from '../lib/payments/iso20022.ts';
import { payoutPartner } from '../lib/payouts/registry.ts';
import { accountKey, destinationAad, open, TEST_DEPOSIT_MINOR, withdrawalIntentId } from '../lib/payouts/withdrawal-rules.ts';
import { buildBusinessMultisig } from '../lib/wallet/business-multisig.ts';
import { walletRequestHeadline } from '../lib/server/approval-requests.ts';
import { assertPurposeShape, submitPartialSignature } from '../lib/server/wallet-signing.ts';
import * as P from '../lib/server/partner-payouts.ts';
import * as W from '../lib/server/withdrawals.ts';

import { ACCOUNT, CORE, T0, USDC, world } from './fixtures/wallet-world.mjs';

const SECRET = toHex(randomBytes(32));
const ENV = {
  NODE_ENV: 'test',
  WITHDRAWAL_ACCOUNT_KEY: toHex(randomBytes(24)),
  FUNDING_SOURCE_FINGERPRINT_KEY: toHex(randomBytes(24)),
  PAYOUT_SANDBOX_WEBHOOKS_ENABLED: 'true',
  PAYOUT_SANDBOX_WEBHOOK_SECRET: SECRET,
};
const OPERATOR = normalizeSuiAddress(`0x${'0e'.repeat(32)}`);
const DEBTOR = { name: 'Acme Trading Sdn Bhd', registrationNumber: '202001012345', registrationScheme: 'CINC', registrationIssuer: 'MY', address: { streetName: 'Jalan Ampang', postCode: '50450', townName: 'Kuala Lumpur', country: 'MY' } };
const PH_SUPPLIER = {
  holderName: 'Dela Cruz Trading Corp',
  country: 'PH',
  bankCode: 'BNORPHMM',
  accountNumber: '0012-3456-7890',
  address: { streetName: 'Ayala Avenue', buildingNumber: '6750', postCode: '1226', townName: 'Makati', country: 'PH' },
  registrationNumber: 'CS201912345',
  relationship: 'supplier',
};
const ID_SUPPLIER = {
  holderName: 'PT Sumber Makmur',
  country: 'ID',
  bankCode: '014',
  accountNumber: '8830123456',
  address: { streetName: 'Jalan Sudirman', buildingNumber: '52', postCode: '12190', townName: 'Jakarta', country: 'ID' },
  relationship: 'supplier',
};
const b58 = () => {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  return Array.from(randomBytes(44), (x) => A[x % A.length]).join('');
};
const hex32 = () => toHex(randomBytes(32));

async function sign(passkey, view) {
  return (await passkey.keypair.signTransaction(fromBase64(view.transactionBytes))).signature;
}

function recorded(base, overrides = {}) {
  const calls = [];
  const wrap = (name) => async (input) => {
    calls.push({ name, input });
    if (overrides[name]) return overrides[name](input);
    return base[name](input);
  };
  return {
    ...base,
    calls,
    depositAddress: wrap('depositAddress'),
    checkAccount: wrap('checkAccount'),
    quote: wrap('quote'),
    createPayout: wrap('createPayout'),
    postSettlement: wrap('postSettlement'),
    status: wrap('status'),
    returnOrReverse: wrap('returnOrReverse'),
    handleWebhook: (input) => base.handleWebhook(input),
    called: (name) => calls.filter((c) => c.name === name),
  };
}

async function setup({ env = ENV, overrides = {}, debtor = { party: DEBTOR, missing: [] } } = {}) {
  const w = await world();
  await w.db.update(schema.organizations).set({ legalName: 'Acme Trading Sdn. Bhd.' }).where(eq(schema.organizations.id, 'acme'));
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
  w.balances.set(normalizeSuiAddress(wallet.address), { coinMinor: 0n, addressBalanceMinor: 10_000_000_000n });

  const partners = Object.fromEntries(['hata_fiuu', 'pdax', 'durianpay'].map((id) => [id, recorded(payoutPartner(id, env), overrides[id] ?? {})]));
  const chainTxs = new Map();
  const chainRead = async (d) => {
    if (chainTxs.has(d)) return chainTxs.get(d);
    const [row] = await w.db.select().from(schema.withdrawals).where(eq(schema.withdrawals.suiDigest, d));
    if (!row) return null;
    return { digest: d, success: true, sender: row.walletAddress, balanceChanges: [], events: [{ packageId: CORE, eventType: `${CORE}::payment_intent::IntentCreated`, json: { intent_id: row.intentId } }] };
  };
  const deps = (orgId = 'acme', more = {}) => ({
    db: w.db,
    orgId,
    env,
    now: () => w.signing.now(),
    ctx: w.ctx,
    walletMembers: async () => (orgId === 'acme' ? { ok: true, address: wallet.address, members } : { ok: false, status: 409, code: 'no_wallet', error: 'register the business wallet first' }),
    partner: (id) => partners[id] ?? payoutPartner(id, env),
    companyName: async () => (orgId === 'acme' ? 'Acme Trading Sdn. Bhd.' : 'Northwind Pte Ltd'),
    splashAddresses: async () => [OPERATOR, w.sponsor.address],
    isBusinessWallet: async () => false,
    bankPayoutFee: async (p) => ({ feeMinor: splashFee({ kind: 4, principalMinor: p, discountBps: 0, schedule: LAUNCH_SCHEDULE }), feesOn: true }),
    readTransaction: chainRead,
    corePackageOriginalId: CORE,
    fiatOutOpen: () => true,
    signedPartners: new Set(),
    debtorParty: async () => debtor,
    ...more,
  });
  const settlement = { db: w.db, now: () => w.signing.now(), partner: (id) => partners[id], readTransaction: chainRead, corePackageOriginalId: CORE };
  w.signing.onExecuted = async (request) => W.withdrawalSigningExecuted(settlement, request);
  w.signing.beforeSign = (request) => W.withdrawalBeforeSign({ db: w.db }, request);
  const { sandboxWebhookSecretFor } = await import('../lib/payouts/partner.ts');
  const webhook = (partner, body, { at = w.signing.now(), secret = sandboxWebhookSecretFor ? sandboxWebhookSecretFor(env, partner) : SECRET } = {}) => {
    const rawBody = JSON.stringify(body);
    return W.handlePayoutWebhook({ partner, rawBody, signature: signWebhook(rawBody, secret, at), env, now: w.signing.now(), db: w.db, readTransaction: async (d) => chainTxs.get(d) ?? null, usdcType: USDC, adapter: partners[partner] });
  };
  const reconcile = () => W.reconcileWithdrawals(settlement);
  return { w, wallet, members, partners, deps, chainTxs, webhook, reconcile };
}

async function signBoth(t, request) {
  await submitPartialSignature(t.w.signing, { orgId: 'acme', userId: 'u-two', id: request.id, signature: await sign(t.w.keys.two, request), digest: request.digest });
  const done = await submitPartialSignature(t.w.signing, { orgId: 'acme', userId: 'u-three', id: request.id, signature: await sign(t.w.keys.three, request), digest: request.digest });
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(done.request.status, 'executed');
  return done.request.executedDigest;
}

/** The partner's deposit address for the business, verified by its test deposit. */
async function verifiedDeposit(t, partner) {
  const got = await W.requestPartnerDepositAddress(t.deps(), 'u-founder', { partner });
  assert.equal(got.ok, true, JSON.stringify(got));
  const dep = await W.requestTestDeposit(t.deps(), 'u-founder', { partner });
  assert.equal(dep.ok, true, JSON.stringify(dep));
  const testDigest = await signBoth(t, dep.request);
  t.chainTxs.set(testDigest, { digest: testDigest, success: true, sender: t.wallet.address, balanceChanges: [{ address: got.depositAddress.address, coinType: USDC, amount: String(TEST_DEPOSIT_MINOR) }] });
  const [row] = await t.w.db.select().from(schema.partnerDepositAddresses).where(eq(schema.partnerDepositAddresses.partner, partner));
  const ok = await t.webhook(partner, { type: 'test_deposit.received', eventId: `evt_${hex32().slice(0, 12)}`, accountRef: row.accountRef, suiDigest: testDigest, occurredAt: T0.toISOString() });
  assert.equal(ok.status, 200, JSON.stringify(ok));
  const address = await W.withdrawalDepositAddress(t.deps(), partner);
  assert.equal(address.status, 'verified');
  return address;
}

const bundle = () => ({ contentHash: hex32(), walrusBlobId: toHex(new TextEncoder().encode('blob-pp')) });

async function readyToPay(t, supplier = PH_SUPPLIER) {
  const added = await P.addPayoutBeneficiary(t.deps(), 'u-founder', supplier);
  assert.equal(added.ok, true, JSON.stringify(added));
  const depositAddress = await verifiedDeposit(t, added.beneficiary.partner);
  return { beneficiary: added.beneficiary, depositAddress };
}

async function paid(t, beneficiaryId, { amountMinor = '1000000000', clientKey = `ck_${hex32().slice(0, 16)}`, purposeCode = 'SUPP' } = {}) {
  const q = await P.quotePartnerPayout(t.deps(), { beneficiaryId, amountMinor });
  assert.equal(q.ok, true, JSON.stringify(q));
  const r = await P.createPartnerPayout(t.deps(), 'u-founder', {
    clientKey,
    beneficiaryId,
    amountMinor,
    acceptedReceiveMinor: q.quote.receiveMinor,
    maxFeeMinor: q.quote.maxFeeMinor,
    purposeCode,
    sourceOfFunds: 'business_revenue',
    remittanceInfo: 'INV-2026-0042',
    ...bundle(),
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  return { q: q.quote, r, clientKey };
}

/* ── Suppliers' accounts ─────────────────────────────────────────────── */

test("a supplier's account is kept only as the bank holds it, with a structured address, sealed; the business's own name is a withdrawal", async () => {
  const t = await setup();
  const bankSays = await P.addPayoutBeneficiary(t.deps(), 'u-founder', { ...PH_SUPPLIER, accountNumber: '0012-3456-0000' });
  assert.equal(bankSays.code, 'bank_name_mismatch', "the partner's name enquiry says another holder");
  assert.equal((await P.addPayoutBeneficiary(t.deps(), 'u-founder', { ...PH_SUPPLIER, address: { country: 'PH' } })).code, 'iso20022_missing', 'a town is required');
  assert.equal((await P.addPayoutBeneficiary(t.deps(), 'u-founder', { ...PH_SUPPLIER, address: undefined })).code, 'iso20022_missing', 'a structured address is required');
  assert.equal((await P.addPayoutBeneficiary(t.deps(), 'u-founder', { ...PH_SUPPLIER, relationship: undefined })).code, 'iso20022_missing');
  assert.equal((await P.addPayoutBeneficiary(t.deps(), 'u-founder', { ...PH_SUPPLIER, relationship: 'self' })).code, 'own_account');
  assert.equal((await P.addPayoutBeneficiary(t.deps(), 'u-founder', { ...PH_SUPPLIER, holderName: 'ACME TRADING SENDIRIAN BERHAD' })).code, 'own_account', "the business's own name is a withdrawal");
  assert.equal((await P.addPayoutBeneficiary(t.deps(), 'u-founder', { ...PH_SUPPLIER, country: 'SG' })).code, 'country_not_offered', 'no route pays Singapore');
  assert.equal((await P.addPayoutBeneficiary(t.deps(), 'u-founder', { ...PH_SUPPLIER, partner: 'hata_fiuu' })).code, 'bad_partner', 'the withdrawal route pays no supplier');
  assert.equal((await t.w.db.select().from(schema.withdrawalDestinations)).length, 0, 'nothing is kept for any of them');

  const added = await P.addPayoutBeneficiary(t.deps(), 'u-founder', PH_SUPPLIER);
  assert.equal(added.ok, true, JSON.stringify(added));
  assert.equal(added.beneficiary.partner, 'pdax', 'a Philippine bank goes through the Philippines route');
  assert.equal(added.beneficiary.currency, 'PHP');
  assert.equal(added.beneficiary.last4, '7890');
  assert.equal(added.beneficiary.relationship, 'supplier');
  assert.equal(added.beneficiary.route, 'our Philippines payout partner', 'unsigned partners are named by role');
  assert.ok(!JSON.stringify(added).includes('001234567890') && !JSON.stringify(added).includes('Ayala'), 'the view carries neither the number nor the street');
  const [row] = await t.w.db.select().from(schema.withdrawalDestinations);
  assert.equal(row.kind, 'supplier');
  assert.ok(!row.partySealed.includes('Ayala'));
  const party = JSON.parse(open(row.partySealed, accountKey(ENV), destinationAad('acme', row.id, 'party')).toString());
  assert.equal(party.address.townName, 'Makati');
  assert.equal(party.registrationNumber, 'CS201912345');
  assert.throws(() => open(row.partySealed, accountKey(ENV), destinationAad('northwind', row.id, 'party')), /does not open/);
  assert.equal((await P.addPayoutBeneficiary(t.deps(), 'u-founder', { ...PH_SUPPLIER, accountNumber: '001234567890' })).created, false, 'the same account is one supplier');

  // Kept apart from the business's own accounts, both ways.
  assert.deepEqual(await W.listWithdrawalDestinations(t.deps()), []);
  assert.equal((await W.quoteWithdrawal(t.deps(), { destinationId: row.id, amountMinor: '1000000' })).code, 'not_found', 'a supplier is never withdrawn to');
  assert.equal((await W.revokeWithdrawalDestination(t.deps(), 'u-founder', row.id)).code, 'not_found');
  const id = await P.addPayoutBeneficiary(t.deps(), 'u-founder', ID_SUPPLIER);
  assert.equal(id.beneficiary.partner, 'durianpay');
  assert.equal(id.beneficiary.currency, 'IDR');
  assert.equal((await P.listPayoutBeneficiaries(t.deps())).length, 2);
  await t.w.client.close();
});

test("another business's supplier, payout or deposit address reads as absent, and an own account is never paid as a supplier", async () => {
  const t = await setup();
  const { beneficiary } = await readyToPay(t);
  const { r } = await paid(t, beneficiary.id);
  const north = t.deps('northwind');
  assert.deepEqual(await P.listPayoutBeneficiaries(north), []);
  assert.deepEqual(await P.listPartnerPayouts(north), []);
  assert.equal((await P.getPartnerPayout(north, r.payout.id)).code, 'not_found');
  assert.equal((await P.quotePartnerPayout(north, { beneficiaryId: beneficiary.id, amountMinor: '1000000' })).code, 'not_found');
  assert.equal((await P.revokePayoutBeneficiary(north, 'u-north', beneficiary.id)).code, 'not_found');
  assert.equal((await P.createPartnerPayout(north, 'u-north', { clientKey: 'ck_north_0001', beneficiaryId: beneficiary.id, amountMinor: '1000000', acceptedReceiveMinor: '0', maxFeeMinor: '0', purposeCode: 'SUPP', sourceOfFunds: 'business_revenue', ...bundle() })).code, 'not_found');
  assert.equal(await W.withdrawalDepositAddress(north, 'pdax'), null);
  assert.equal((await W.getWithdrawal(t.deps(), r.payout.id)).code, 'not_found', 'a supplier payout is not a withdrawal');
  assert.deepEqual(await W.listWithdrawals(t.deps()), []);

  // The business's own account, through the supplier path: absent.
  const own = await W.addWithdrawalDestination(t.deps(), 'u-founder', { holderName: 'ACME TRADING SENDIRIAN BERHAD', country: 'MY', bankCode: 'MBBEMYKL', accountNumber: '514012345678' });
  assert.equal(own.ok, true, JSON.stringify(own));
  assert.equal((await P.quotePartnerPayout(t.deps(), { beneficiaryId: own.destination.id, amountMinor: '1000000' })).code, 'not_found');
  assert.equal((await P.revokePayoutBeneficiary(t.deps(), 'u-founder', own.destination.id)).code, 'not_found');
  await t.w.client.close();
});

/* ── Deposit addresses, one per partner ──────────────────────────────── */

test('each route has its own fixed deposit address, verified by its own test deposit, and an unverified one pays nothing', async () => {
  const t = await setup();
  const added = await P.addPayoutBeneficiary(t.deps(), 'u-founder', PH_SUPPLIER);
  assert.equal((await P.quotePartnerPayout(t.deps(), { beneficiaryId: added.beneficiary.id, amountMinor: '1000000000' })).code, 'deposit_address_unverified');
  const pdax = await verifiedDeposit(t, 'pdax');
  const dp = await W.requestPartnerDepositAddress(t.deps(), 'u-founder', { partner: 'durianpay' });
  assert.notEqual(dp.depositAddress.address, pdax.address, 'one address per business per partner');
  assert.equal(dp.depositAddress.status, 'pending_test', 'verifying one route verifies no other');
  assert.equal((await W.requestPartnerDepositAddress(t.deps(), 'u-founder', { partner: 'cctp_wallet' })).code, 'bad_partner', 'a cross-chain payout has no deposit address');
  assert.equal(t.partners.pdax.called('depositAddress').length, 1);
  // A confirmation signed for one partner does not verify another's address.
  const [dpRow] = await t.w.db.select().from(schema.partnerDepositAddresses).where(eq(schema.partnerDepositAddresses.partner, 'durianpay'));
  const cross = await t.webhook('pdax', { type: 'test_deposit.received', eventId: 'evt_cross_01', accountRef: dpRow.accountRef, suiDigest: b58(), occurredAt: T0.toISOString() });
  assert.equal(cross.body.ignored, 'no such account');
  await t.w.client.close();
});

/* ── Quote, instruct, sign, settle ───────────────────────────────────── */

test('a supplier payout instructs the partner first, with its ISO 20022 message, keyed by the intent id, and the owners sign a partner payout', async () => {
  const t = await setup();
  const { beneficiary, depositAddress } = await readyToPay(t);
  t.w.balances.set(t.wallet.address, { coinMinor: 0n, addressBalanceMinor: 100_000_000n });
  assert.equal((await P.quotePartnerPayout(t.deps(), { beneficiaryId: beneficiary.id, amountMinor: '1000000000' })).code, 'insufficient_funds');
  assert.equal(t.partners.pdax.called('quote').length, 0, 'no rate before the funds are there');
  t.w.balances.set(t.wallet.address, { coinMinor: 0n, addressBalanceMinor: 10_000_000_000n });

  const { q, r } = await paid(t, beneficiary.id);
  assert.equal(q.currency, 'PHP');
  assert.equal(q.splashFee.kind, 4);
  assert.equal(q.partnerFees.length, 2, "the partner's own lines");
  assert.ok(q.partnerFees.every((l) => l.partner === 'our Philippines payout partner'));
  const payout = r.payout;
  assert.equal(payout.kind, 'supplier_payout');
  assert.equal(payout.status, 'awaiting_signatures');
  assert.equal(payout.purposeCode, 'SUPP');

  const [instruction] = t.partners.pdax.called('createPayout').map((c) => c.input);
  assert.equal(instruction.route, 'bank');
  assert.equal(instruction.intentId, payout.intentId, 'keyed by the intent id');
  assert.equal(instruction.expectedUsdcMinor, 1_000_000_000n, 'and the expected amount');
  assert.equal(instruction.depositAddress, depositAddress.address);
  assert.equal(instruction.returnAddress, t.wallet.address, 'a return goes to the business wallet');
  assert.ok(![OPERATOR, t.w.sponsor.address].includes(instruction.depositAddress), 'no Splash address on the path');
  assert.equal(instruction.beneficiary.accountNumber, '001234567890');
  assert.equal(instruction.purposeCode, 'SUPP');
  const msg = instruction.iso20022.CdtTrfTxInf;
  assert.equal(msg.PmtId.EndToEndId, endToEndIdFor(payout.intentId));
  assert.equal(msg.PmtId.UETR, uetrFor(payout.intentId));
  assert.equal(msg.Cdtr.Nm, 'Dela Cruz Trading Corp');
  assert.equal(msg.CdtrAcct.Nm, 'Dela Cruz Trading Corp');
  assert.equal(msg.Cdtr.PstlAdr.TwnNm, 'Makati');
  assert.equal(msg.Cdtr.Id.OrgId.Othr[0].Id, 'CS201912345');
  assert.equal(msg.Dbtr.Nm, 'Acme Trading Sdn Bhd');
  assert.equal(msg.Dbtr.Id.OrgId.Othr[0].Id, '202001012345');
  assert.equal(msg.DbtrAcct.Id.Othr.Id, t.wallet.address);
  assert.deepEqual(msg.RgltryRptg[0].Dtls.map((d) => d.Cd), ['supplier', 'business_revenue']);
  assert.deepEqual(msg.RmtInf.Ustrd, ['INV-2026-0042']);
  assert.equal(msg.ChrgsInf.length, 2, "the partner's fee lines ride in the message");
  const [row] = await t.w.db.select().from(schema.withdrawals);
  assert.equal(withdrawalIntentId({ accountId: ACCOUNT, corePackageId: CORE, paymentRef: Buffer.from(row.paymentRef, 'hex') }), payout.intentId);
  // The evidence kept is the same message, masked.
  assert.equal(payout.iso20022.creditorAccountLast4, '7890');
  assert.equal(payout.iso20022.endToEndId, endToEndIdFor(payout.intentId));
  assert.ok(!JSON.stringify(row.iso20022).includes('001234567890'));

  const request = r.request;
  assert.equal(request.purpose, 'partner_payout');
  assert.equal(request.sender, t.wallet.address, "the owners' multisig signs");
  const d = request.description;
  assert.deepEqual(d.actions.map((a) => a.type), ['withdraw', 'open_intent', 'pay_intent', 'anchor_receipt', 'delete_intent'], 'the canonical composed PTB');
  const openIntent = d.actions[1];
  assert.equal(openIntent.kind, 4, 'a bank payout');
  assert.equal(openIntent.recipient, depositAddress.address, "straight to the partner's deposit address");
  assert.equal(openIntent.beneficiaryRef, beneficiary.beneficiaryRef);
  assert.equal(openIntent.amountMinor, '1000000000');
  assert.equal(d.actions[2].maxFeeMinor, q.maxFeeMinor, 'the fee shown is the max_fee');
  assert.equal(request.withdrawal.holderName, 'Dela Cruz Trading Corp', 'the signers are shown the supplier');
  assert.match(walletRequestHeadline('partner_payout', d, request.withdrawal), /Dela Cruz Trading Corp.*ending 7890.*purpose SUPP/);
  const ctx = { recipient: depositAddress.address, beneficiaryRef: beneficiary.beneficiaryRef, amountMinor: 1_000_000_000n };
  assert.doesNotThrow(() => assertPurposeShape('partner_payout', d, ctx));
  assert.throws(() => assertPurposeShape('partner_payout', d, { ...ctx, recipient: `0x${'77'.repeat(32)}` }), /deposit address/);
  assert.throws(() => assertPurposeShape('partner_payout', d, { ...ctx, beneficiaryRef: hex32() }));
  assert.throws(() => assertPurposeShape('partner_payout', d, { ...ctx, amountMinor: 1n }), /amount/);

  // Signed: sent, and only then is the digest posted to the partner.
  assert.equal(t.partners.pdax.called('postSettlement').length, 0);
  const executed = await signBoth(t, request);
  const after = (await P.getPartnerPayout(t.deps(), payout.id)).payout;
  assert.equal(after.status, 'sent');
  assert.equal(after.suiDigest, executed);
  assert.equal(after.settlementPosted, true);
  const [posted] = t.partners.pdax.called('postSettlement').map((c) => c.input);
  assert.deepEqual([posted.intentId, posted.partnerRef, posted.suiDigest], [payout.intentId, payout.partnerRef, executed]);
  await t.w.client.close();
});

test('the Indonesia route pays whole rupiah through its own deposit address', async () => {
  const t = await setup();
  const { beneficiary, depositAddress } = await readyToPay(t, ID_SUPPLIER);
  const { q, r } = await paid(t, beneficiary.id, { amountMinor: '100000000', purposeCode: 'GDDS' });
  assert.equal(q.currency, 'IDR');
  assert.equal(q.partnerFees.length, 2, "the exchange partner's and the disbursement fees");
  const [instruction] = t.partners.durianpay.called('createPayout').map((c) => c.input);
  assert.equal(instruction.iso20022.CdtTrfTxInf.IntrBkSttlmAmt.Ccy, 'IDR');
  assert.doesNotMatch(instruction.iso20022.CdtTrfTxInf.IntrBkSttlmAmt.Amt, /\./, 'no decimals in rupiah');
  assert.equal(instruction.depositAddress, depositAddress.address);
  assert.equal(t.partners.pdax.called('createPayout').length, 0, 'the other route hears nothing');
  assert.match(walletRequestHeadline('partner_payout', r.request.description, r.request.withdrawal), /IDR [\d,]+[^.\d]/);
  await t.w.client.close();
});

test('a supplier payout is idempotent by its key, and a refused one instructs nobody', async () => {
  const t = await setup();
  const { beneficiary } = await readyToPay(t);
  const { q, r, clientKey } = await paid(t, beneficiary.id);
  const base = { beneficiaryId: beneficiary.id, amountMinor: '1000000000', acceptedReceiveMinor: q.receiveMinor, maxFeeMinor: q.maxFeeMinor, purposeCode: 'SUPP', sourceOfFunds: 'business_revenue', remittanceInfo: 'INV-2026-0042', ...bundle() };
  const again = await P.createPartnerPayout(t.deps(), 'u-founder', { ...base, clientKey });
  assert.equal(again.ok, true);
  assert.equal(again.created, false);
  assert.equal(again.payout.id, r.payout.id);
  assert.equal(t.partners.pdax.called('createPayout').length, 1, 'the partner is instructed once');
  assert.equal((await P.createPartnerPayout(t.deps(), 'u-founder', { ...base, clientKey, purposeCode: 'GDDS' })).code, 'idempotency_key_reused', 'the same key for another purpose');
  assert.equal((await P.createPartnerPayout(t.deps(), 'u-founder', { ...base, clientKey, amountMinor: '2000000000' })).code, 'idempotency_key_reused');

  // Refusals: a worse rate, a fee above the one shown, a missing declaration, an incomplete profile.
  const worse = await P.createPartnerPayout(t.deps(), 'u-founder', { ...base, clientKey: 'ck_worse_rate1', acceptedReceiveMinor: String(BigInt(q.receiveMinor) + 1n) });
  assert.equal(worse.code, 'quote_changed');
  assert.equal((await P.createPartnerPayout(t.deps(), 'u-founder', { ...base, clientKey: 'ck_fee_lower1', maxFeeMinor: String(BigInt(q.maxFeeMinor) - 1n) })).code, 'fee_above_shown');
  assert.equal((await P.createPartnerPayout(t.deps(), 'u-founder', { ...base, clientKey: 'ck_no_purpose', purposeCode: undefined })).code, 'iso20022_missing');
  assert.equal((await P.createPartnerPayout(t.deps(), 'u-founder', { ...base, clientKey: 'ck_no_source1', sourceOfFunds: '' })).code, 'iso20022_missing');
  const noProfile = await P.createPartnerPayout(t.deps('acme', { debtorParty: async () => ({ party: null, missing: ['registrationNumber'] }) }), 'u-founder', { ...base, clientKey: 'ck_no_profile' });
  assert.equal(noProfile.code, 'originator_incomplete');
  assert.deepEqual(noProfile.missing, ['registrationNumber']);
  assert.equal(t.partners.pdax.called('createPayout').length, 1, 'none of them reached the partner');
  assert.equal((await t.w.db.select().from(schema.withdrawals)).length, 1);
  await t.w.client.close();
});

test('removing a supplier cancels its payout not yet sent: the request closes, the instruction is reversed, and no signature is taken', async () => {
  const t = await setup();
  const { beneficiary } = await readyToPay(t);
  const { r } = await paid(t, beneficiary.id);
  const removed = await P.revokePayoutBeneficiary(t.deps(), 'u-founder', beneficiary.id);
  assert.equal(removed.ok, true, JSON.stringify(removed));
  assert.equal(removed.cancelled, 1);
  assert.equal((await P.getPartnerPayout(t.deps(), r.payout.id)).payout.status, 'cancelled');
  const [rev] = t.partners.pdax.called('returnOrReverse').map((c) => c.input);
  assert.equal(rev.intentId, r.payout.intentId);
  const signing = await submitPartialSignature(t.w.signing, { orgId: 'acme', userId: 'u-two', id: r.request.id, signature: await sign(t.w.keys.two, r.request), digest: r.request.digest });
  assert.equal(signing.ok, false, 'nobody can sign it any more');
  await t.w.client.close();
});

/* ── Partner webhooks ────────────────────────────────────────────────── */

test("partner webhooks move a supplier payout forward only, once each, for its own partner, intent and reference", async () => {
  const t = await setup();
  const { beneficiary } = await readyToPay(t);
  const { r } = await paid(t, beneficiary.id);
  const p = r.payout;
  const ev = (status, extra = {}) => ({ type: 'payout.status', eventId: `evt_${status}_${hex32().slice(0, 8)}`, partnerRef: p.partnerRef, intentId: p.intentId, status, occurredAt: T0.toISOString(), ...extra });
  assert.equal((await t.webhook('pdax', ev('funds_received'))).status, 503, 'before the deposit is recorded the partner retries');
  await signBoth(t, r.request);
  assert.equal((await t.webhook('durianpay', ev('paid_out'))).body.ignored, 'no such payout', "another partner cannot move this partner's payout");
  assert.equal((await t.webhook('pdax', ev('paid_out'), { secret: toHex(randomBytes(32)) })).status, 401, 'a forged signature');
  assert.equal((await t.webhook('pdax', ev('paid_out'), { at: new Date(T0.getTime() - 10 * 60_000) })).status, 401, 'a replay outside the window');
  assert.equal((await t.webhook('pdax', { ...ev('paid_out'), partnerRef: 'sb_pdax_someoneelse' })).body.ignored, 'no such payout');
  const received = ev('funds_received');
  assert.equal((await t.webhook('pdax', received)).status, 200);
  assert.equal((await t.webhook('pdax', received)).status, 200);
  const paidOut = ev('paid_out', { bankRef: 'INSTAPAY-000123' });
  assert.equal((await t.webhook('pdax', paidOut)).status, 200);
  const view = (await P.getPartnerPayout(t.deps(), p.id)).payout;
  assert.equal(view.status, 'paid_out');
  assert.equal(view.bankRef, 'INSTAPAY-000123');
  assert.match((await t.webhook('pdax', ev('failed'))).body.ignored, /does not move/, 'paid out is final');
  assert.match((await t.webhook('pdax', ev('funds_received'))).body.ignored, /does not move/, 'never backwards');
  const events = (await t.w.db.select().from(schema.payoutPartnerEvents)).filter((e) => e.subjectId === p.id);
  assert.deepEqual(events.map((e) => e.status).sort(), ['funds_received', 'paid_out']);
  await t.w.client.close();
});

test('a failed supplier payout comes back to the business wallet only as the chain shows it', async () => {
  const t = await setup();
  const { beneficiary } = await readyToPay(t);
  const { r } = await paid(t, beneficiary.id);
  const p = r.payout;
  await signBoth(t, r.request);
  assert.equal((await t.webhook('pdax', { type: 'payout.status', eventId: 'evt_pp_failed1', partnerRef: p.partnerRef, intentId: p.intentId, status: 'failed', failureReason: 'account closed', occurredAt: T0.toISOString() })).status, 200);
  const [ret] = t.partners.pdax.called('returnOrReverse').map((c) => c.input);
  assert.equal(ret.returnAddress, t.wallet.address, 'back to the business wallet, never to Splash');
  const returnDigest = b58();
  const body = { type: 'payout.status', eventId: 'evt_pp_return1', partnerRef: p.partnerRef, intentId: p.intentId, status: 'returned', returnDigest, occurredAt: T0.toISOString() };
  t.chainTxs.set(returnDigest, { digest: returnDigest, success: true, sender: p.depositAddress, balanceChanges: [{ address: OPERATOR, coinType: USDC, amount: '1000000000' }] });
  assert.equal((await t.webhook('pdax', body)).body.ignored, 'the chain does not show the return');
  t.chainTxs.set(returnDigest, { digest: returnDigest, success: true, sender: p.depositAddress, balanceChanges: [{ address: t.wallet.address, coinType: USDC, amount: '1000000000' }] });
  assert.equal((await t.webhook('pdax', { ...body, eventId: 'evt_pp_return2' })).status, 200);
  assert.equal((await P.getPartnerPayout(t.deps(), p.id)).payout.status, 'returned');
  await t.w.client.close();
});

test('the sweep posts a digest the partner missed', async () => {
  const t = await setup({ overrides: { pdax: { postSettlement: async () => { throw new Error('partner down'); } } } });
  const { beneficiary } = await readyToPay(t);
  const { r } = await paid(t, beneficiary.id);
  await signBoth(t, r.request);
  assert.equal((await P.getPartnerPayout(t.deps(), r.payout.id)).payout.settlementPosted, false, 'the partner was down');
  t.partners.pdax.postSettlement = async () => undefined;
  const swept = await t.reconcile();
  assert.equal(swept.posted, 1);
  assert.equal((await P.getPartnerPayout(t.deps(), r.payout.id)).payout.settlementPosted, true);
  await t.w.client.close();
});

/* ── Production ──────────────────────────────────────────────────────── */

test('production without credentials refuses at every step and stores nothing, whatever USE_MOCK_APIS says', async () => {
  const t = await setup();
  const live = payoutPartner('pdax', { NODE_ENV: 'production', USE_MOCK_APIS: 'true' });
  const prod = t.deps('acme', { partner: () => live });
  assert.equal((await P.addPayoutBeneficiary(prod, 'u-founder', PH_SUPPLIER)).code, 'partner_not_configured');
  assert.equal((await W.requestPartnerDepositAddress(prod, 'u-founder', { partner: 'pdax' })).code, 'partner_not_configured');
  assert.equal((await t.w.db.select().from(schema.withdrawalDestinations)).length, 0);
  assert.equal((await t.w.db.select().from(schema.partnerDepositAddresses)).length, 0);
  const rawBody = JSON.stringify({ type: 'payout.status', eventId: 'evt_pp_prod1', partnerRef: 'sb_pdax_x00000', intentId: ACCOUNT, status: 'paid_out' });
  const answer = await W.handlePayoutWebhook({ partner: 'pdax', rawBody, signature: signWebhook(rawBody, SECRET, new Date()), env: { NODE_ENV: 'production', PAYOUT_SANDBOX_WEBHOOKS_ENABLED: 'true', PAYOUT_SANDBOX_WEBHOOK_SECRET: SECRET }, now: new Date(), db: t.w.db, readTransaction: async () => null, usdcType: USDC });
  assert.equal(answer.status, 503, 'the sandbox secret signs nothing in production');
  await t.w.client.close();
});

/* ── Routes ──────────────────────────────────────────────────────────── */

test('every payout route takes the org from the session; owners alone change suppliers; staff may ask; all are rate-limited', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const r of ['route.ts', 'quotes/route.ts', '[id]/route.ts', 'beneficiaries/route.ts', 'beneficiaries/[id]/route.ts']) {
    const source = await readFile(new URL(`../app/api/wallet/payouts/${r}`, import.meta.url), 'utf8');
    assert.match(source, /withdrawalRoute\(request\)/, `${r}: the wallet route, the org from the session`);
    assert.doesNotMatch(source, /body\.(orgId|accountId|userId|walletAddress|depositAddress|iso20022|beneficiaryRef)|searchParams\.get\('orgId'\)/, `${r}: nothing about who or where from the request`);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const at = source.indexOf(`export async function ${method}(`);
      if (at < 0) continue;
      const body = source.slice(at, source.indexOf('\n}\n', at));
      if ((r === 'route.ts' || r === 'quotes/route.ts') && method === 'POST') assert.match(body, /requireWithdrawalRequester\(gate\.route\)/, `${r} ${method}`);
      else assert.match(body, /requireOwner\(gate\.route,/, `${r} ${method}: owners only`);
      assert.match(body, /limitWalletRequests\(gate\.route\)/, `${r} ${method}: rate-limited`);
    }
  }
  const deps = await readFile(new URL('../lib/server/wallet-deps.ts', import.meta.url), 'utf8');
  assert.match(deps, /'partner_payout'/, 'the signing hooks settle and check supplier payouts too');
});

/* ── Review fixes (p2-4.5) ───────────────────────────────────────────── */

test('a payment to a partner deposit address goes only through the payout route: no draft, open intent or plain wallet payment pays one', async () => {
  const t = await setup();
  const { beneficiary, depositAddress } = await readyToPay(t);
  const { askOwnersToApprove, acceptApprovalAsk } = await import('../lib/server/payment-approval-asks.ts');
  const { requestWalletPayment, requestOpenIntentPayment } = await import('../lib/server/business-wallet.ts');
  const now = BigInt(t.w.signing.now().getTime());
  const draft = (over = {}) => ({
    paymentRef: hex32(),
    recipient: depositAddress.address,
    beneficiaryRef: beneficiary.beneficiaryRef,
    amountMinor: 1_000_000_000n,
    kind: 4,
    targetCurrency: 'PHP',
    fxRateUsdLocal: 56_000_000n,
    commitment: hex32(),
    railCommitment: hex32(),
    expiresAtMs: now + 86_400_000n,
    ...over,
  });
  const ask = (d) => askOwnersToApprove({ db: t.w.db, ctx: t.w.ctx }, { orgId: 'acme', userId: 'u-founder', draft: d, ...bundle(), requesterAddresses: [] });
  assert.equal((await ask(draft())).code, 'use_payout_route', 'a bank payout draft is refused: it is opened through the payout route only');
  assert.equal((await ask(draft({ kind: 4, recipient: normalizeSuiAddress('0x' + '77'.repeat(32)) }))).code, 'use_payout_route', 'to any address');
  assert.equal((await ask(draft({ kind: 1, beneficiaryRef: '' }))).code, 'use_payout_route', 'nor any other kind to a deposit address');
  assert.equal((await ask(draft({ kind: 2, beneficiaryRef: '' }))).code, 'use_payout_route');
  // A deposit address still waiting for its test deposit is the partner's too.
  const dp = await W.requestPartnerDepositAddress(t.deps(), 'u-founder', { partner: 'durianpay' });
  assert.equal((await ask(draft({ kind: 1, beneficiaryRef: '', recipient: dp.depositAddress.address }))).code, 'use_payout_route');
  assert.equal((await t.w.db.select().from(schema.walletApprovalAsks)).length, 0, 'nothing was stored');

  // An ask stored before this check: an owner accepting it opens nothing.
  const d = draft();
  const shown = { source: 'draft', intentId: `draft:${d.paymentRef}`, maker: null, recipient: d.recipient, amountMinor: String(d.amountMinor), kind: 4, targetCurrency: 'PHP', fxRateUsdLocal: String(d.fxRateUsdLocal), expiresAtMs: String(d.expiresAtMs), paymentRef: d.paymentRef, beneficiaryRef: d.beneficiaryRef, commitment: d.commitment, railCommitment: d.railCommitment };
  await t.w.db.insert(schema.walletApprovalAsks).values({ id: 'wpa_legacy', orgId: 'acme', intentId: shown.intentId, requestedBy: 'u-two', intent: shown, contentHash: hex32(), walrusBlobId: 'aa', status: 'open', expiresAt: new Date(Number(d.expiresAtMs)), createdAt: t.w.signing.now(), updatedAt: t.w.signing.now() });
  const accepted = await acceptApprovalAsk({ db: t.w.db, ctx: t.w.ctx }, { orgId: 'acme', userId: 'u-three', askId: 'wpa_legacy', mode: 'wallet_pays', wallet: t.members, maxFeeMinor: 3_000_000n, settleByMs: now + 300_000n });
  assert.equal(accepted.code, 'use_payout_route', JSON.stringify(accepted));

  // The plain wallet payment refuses it too, whoever calls it.
  const pay = (over) =>
    requestWalletPayment(t.w.ctx, {
      orgId: 'acme',
      requestedBy: 'u-founder',
      wallet: t.members,
      payment: { ...draft(over), paymentRef: randomBytes(32), beneficiaryRef: over.kind === 4 ? Buffer.from(beneficiary.beneficiaryRef, 'hex') : new Uint8Array(), commitment: randomBytes(32), railCommitment: randomBytes(32), maxFeeMinor: 3_000_000n, settleByMs: now + 300_000n, contentHash: randomBytes(32), walrusBlobId: new Uint8Array([1]) },
    });
  assert.equal((await pay({ kind: 4 })).code, 'use_payout_route');
  assert.equal((await pay({ kind: 1, recipient: depositAddress.address })).code, 'use_payout_route');

  // An open intent (a staff member's, under a rule) to a deposit address, or of kind 4: the owners do not pay it here.
  const intentId = normalizeSuiAddress('0x' + '5e'.repeat(32));
  t.w.model.addIntent({ id: intentId, initialSharedVersion: 9, account: ACCOUNT, maker: normalizeSuiAddress('0x' + '5f'.repeat(32)), recipient: depositAddress.address, beneficiaryRef: beneficiary.beneficiaryRef, amountMinor: 1_000_000_000n, kind: 4, targetCurrency: 'PHP', fxRateUsdLocal: 56_000_000n, expiresAtMs: now + 86_400_000n, status: 0, asset: USDC });
  const intentPay = await requestOpenIntentPayment(t.w.ctx, { orgId: 'acme', requestedBy: 'u-founder', wallet: t.members, intentId, maxFeeMinor: 3_000_000n, settleByMs: now + 300_000n, contentHash: randomBytes(32), walrusBlobId: new Uint8Array([1]) });
  assert.equal(intentPay.code, 'use_payout_route');
  assert.equal((await askOwnersToApprove({ db: t.w.db, ctx: t.w.ctx }, { orgId: 'acme', userId: 'u-founder', intentId, ...bundle(), requesterAddresses: [] })).code, 'use_payout_route');
  assert.equal((await t.w.db.select().from(schema.walletSigningRequests)).filter((r) => r.purpose === 'wallet_payment').length, 0, 'no wallet payment was opened');

  // And the shape check refuses a kind 4 intent as a plain wallet payment.
  const { r } = await paid(t, beneficiary.id);
  assert.throws(() => assertPurposeShape('wallet_payment', r.request.description), /bank payout/);
  await t.w.client.close();
});

test('the adapter check binds the receive amount, the rate, the minimum, the originator and the charges', async () => {
  const t = await setup();
  const { beneficiary } = await readyToPay(t);
  await paid(t, beneficiary.id);
  const [instruction] = t.partners.pdax.called('createPayout').map((c) => c.input);
  const { assertPacs008Matches } = await import('../lib/payments/iso20022.ts');
  assert.doesNotThrow(() => assertPacs008Matches(instruction.iso20022, instruction));
  const edit = (f) => {
    const m = structuredClone(instruction.iso20022);
    f(m.CdtTrfTxInf);
    return m;
  };
  for (const [why, f] of [
    ['settlement amount', (x) => (x.IntrBkSttlmAmt.Amt = '999999.00')],
    ['rate', (x) => (x.XchgRate = '1.000000')],
    ['debtor', (x) => (x.Dbtr.Nm = 'Someone Else Ltd')],
    ['debtor registration', (x) => (x.Dbtr.Id.OrgId.Othr[0].Id = '999999999999')],
    ['charges', (x) => (x.ChrgsInf = [])],
  ]) {
    assert.throws(() => assertPacs008Matches(edit(f), instruction), /does not match/, why);
  }
  assert.throws(() => assertPacs008Matches(instruction.iso20022, { ...instruction, minReceiveMinor: instruction.receiveMinor + 1n }), /does not match/, 'a quote below the accepted minimum');
  await t.w.client.close();
});

test("a supplier payout row keeps the registration numbers masked, and viewers do not read payouts or suppliers", async () => {
  const t = await setup();
  const { beneficiary } = await readyToPay(t);
  const { r } = await paid(t, beneficiary.id);
  const [row] = await t.w.db.select().from(schema.withdrawals).where(eq(schema.withdrawals.id, r.payout.id));
  const stored = JSON.stringify(row.iso20022);
  assert.ok(!stored.includes('CS201912345') && !stored.includes('202001012345'), stored);
  assert.match(row.iso20022.creditor.registration, /2345$/, 'the last four only');
  const { readFile } = await import('node:fs/promises');
  for (const f of ['route.ts', '[id]/route.ts', 'beneficiaries/route.ts']) {
    const source = await readFile(new URL(`../app/api/wallet/payouts/${f}`, import.meta.url), 'utf8');
    const at = source.indexOf('export async function GET(');
    const body = source.slice(at, source.indexOf('\n}\n', at));
    assert.match(body, /requirePayoutReader\(gate\.route\)/, `${f} GET: owners and staff only`);
  }
  await t.w.client.close();
});

test("a webhook signed for one partner's route does not verify at another's", async () => {
  const { sandboxWebhookSecretFor } = await import('../lib/payouts/partner.ts');
  assert.notEqual(sandboxWebhookSecretFor(ENV, 'pdax'), sandboxWebhookSecretFor(ENV, 'durianpay'));
  const rawBody = JSON.stringify({ type: 'payout.status', eventId: 'evt_x_partner', partnerRef: 'sb_pdax_x', intentId: ACCOUNT, status: 'paid_out' });
  const now = new Date();
  const sig = signWebhook(rawBody, sandboxWebhookSecretFor(ENV, 'pdax'), now);
  assert.doesNotThrow(() => payoutPartner('pdax', ENV).handleWebhook({ rawBody, signature: sig, now }));
  for (const other of ['durianpay', 'hata_fiuu', 'cctp_wallet']) {
    assert.throws(() => payoutPartner(other, ENV).handleWebhook({ rawBody, signature: sig, now }), /signature/i, `${other} refuses pdax's signature`);
  }
});
