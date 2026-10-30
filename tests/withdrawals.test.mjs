/**
 * Withdrawals to the business's OWN bank (v2 §4.4), over the payout-partner
 * interface (§4.5): MYR, business wallet → Hata → Fiuu → the business's bank.
 *
 * PGlite with every migration, the wallet world's model chain and software
 * passkeys (tests/fixtures/wallet-world.mjs), the sandbox partner wrapped so
 * every call it gets is recorded, and a model of what each Sui transaction
 * moved. Nothing reaches a network and nothing is signed for any network.
 *
 * What must hold:
 *   - a destination is the business's own account: the name given AND the
 *     bank's own holder name match the registered name, or nothing is kept;
 *     the account number is sealed at rest, bound to the org and row;
 *   - the deposit address is the partner's, fixed per business, never a
 *     Splash address or another business's, and verified only by a test
 *     deposit the partner confirms and the chain shows;
 *   - the quote comes only once the wallet holds the money; a worse rate or
 *     a higher fee than shown is refused, never taken;
 *   - the instruction goes to the partner BEFORE money moves, keyed by the
 *     intent id, built only from the account the intent commits to;
 *   - the owners' multisig signs bytes that pay exactly that deposit
 *     address, for that account and amount, as a bank payout;
 *   - after settlement the digest is posted; webhooks are signed, in a
 *     replay window, counted once, never backwards; a return is believed
 *     only from the chain, back in the business wallet;
 *   - idempotent by the client's key; another business's ids read as absent;
 *   - production without credentials refuses, and no sandbox answer reaches
 *     it, whatever USE_MOCK_APIS says.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

import { eq } from 'drizzle-orm';
import { fromBase64, normalizeSuiAddress, toBase58, toHex } from '@mysten/sui/utils';

import * as schema from '../lib/db/schema.ts';
import { signWebhook, WEBHOOK_TOLERANCE_SECONDS } from '../lib/funding/providers.ts';
import { LAUNCH_SCHEDULE, splashFee } from '../lib/fees/schedule.ts';
import { canAdvancePayout, PAYOUT_SIGNATURE_HEADER, PayoutPartnerUnavailable, WebhookRejected } from '../lib/payouts/partner.ts';
import { payoutPartner } from '../lib/payouts/registry.ts';
import {
  accountKey,
  beneficiaryRefOf,
  canAdvanceWithdrawal,
  destinationAad,
  open,
  TEST_DEPOSIT_MINOR,
  withdrawalIntentId,
} from '../lib/payouts/withdrawal-rules.ts';
import { buildBusinessMultisig } from '../lib/wallet/business-multisig.ts';
import { requestWalletPayment } from '../lib/server/business-wallet.ts';
import { assertPurposeShape, cancelSigningRequest, submitPartialSignature } from '../lib/server/wallet-signing.ts';
import { readSigningRequest } from '../lib/server/wallet-signing-store.ts';
import { walletRequestHeadline, walletSignatureMessage } from '../lib/server/approval-requests.ts';
import * as W from '../lib/server/withdrawals.ts';
import * as R from '../lib/payouts/withdrawal-rules.ts';
import * as O from '../lib/server/onboarding.ts';
import {
  addWithdrawalDestination,
  createWithdrawal,
  getWithdrawal,
  handlePayoutWebhook,
  listWithdrawalDestinations,
  listWithdrawals,
  quoteWithdrawal,
  requestPartnerDepositAddress,
  requestTestDeposit,
  revokeWithdrawalDestination,
  withdrawalDepositAddress,
  withdrawalSigningExecuted,
} from '../lib/server/withdrawals.ts';

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
const ACCOUNT_NUMBER = '5140-1234-5678';
const ACME_BANK = { holderName: 'ACME TRADING SENDIRIAN BERHAD', country: 'MY', bankCode: 'MBBEMYKL', accountNumber: ACCOUNT_NUMBER };
const digest = () => toBase58(randomBytes(32));
const hex32 = () => toHex(randomBytes(32));

async function sign(passkey, view) {
  return (await passkey.keypair.signTransaction(fromBase64(view.transactionBytes))).signature;
}

/** A sandbox partner that records every call, with optional overrides. */
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

async function setup({ env = ENV, overrides = {}, fee, intentEvents } = {}) {
  const w = await world();
  await w.db.update(schema.organizations).set({ legalName: 'Acme Trading Sdn. Bhd.' }).where(eq(schema.organizations.id, 'acme'));
  await w.db.update(schema.organizations).set({ legalName: 'Northwind Pte Ltd' }).where(eq(schema.organizations.id, 'northwind'));
  // The founder nominates, two members register: the model chain names the wallet.
  const { startBusinessWallet } = await import('../lib/server/business-wallet.ts');
  const { signingInbox } = await import('../lib/server/wallet-signing.ts');
  const nominate = await startBusinessWallet(w.ctx, { orgId: 'acme', requestedBy: 'u-founder', founder: { userId: 'u-founder', passkeyPublicKey: w.keys.founder.publicKey }, owners: w.owners });
  assert.equal(nominate.ok, true, JSON.stringify(nominate));
  await submitPartialSignature(w.signing, { orgId: 'acme', userId: 'u-founder', id: nominate.request.id, signature: await sign(w.keys.founder, nominate.request), digest: nominate.request.digest });
  const [register] = await signingInbox(w.signing, { orgId: 'acme', userId: 'u-two' });
  await submitPartialSignature(w.signing, { orgId: 'acme', userId: 'u-two', id: register.id, signature: await sign(w.keys.two, register), digest: register.digest });
  await submitPartialSignature(w.signing, { orgId: 'acme', userId: 'u-three', id: register.id, signature: await sign(w.keys.three, register), digest: register.digest });
  const wallet = buildBusinessMultisig({ members: w.owners });
  assert.equal((await w.ctx.readAccount()).wallet, wallet.address);
  const members = { multisigPublicKey: wallet.multisigPublicKey, members: wallet.members.map((m) => ({ userId: m.userId, publicKey: m.suiPublicKey, weight: m.weight })) };
  w.balances.set(normalizeSuiAddress(wallet.address), { coinMinor: 0n, addressBalanceMinor: 10_000_000_000n });

  const partner = recorded(payoutPartner('hata_fiuu', env), overrides);
  const chainTxs = new Map();
  // The chain as it reads an executed withdrawal: the intent it created is the
  // one the server derived, unless a test says otherwise (`intentEvents`).
  const chainRead = async (d) => {
    if (chainTxs.has(d)) return chainTxs.get(d);
    const [row] = await w.db.select().from(schema.withdrawals).where(eq(schema.withdrawals.suiDigest, d));
    if (!row) return null;
    const ids = intentEvents ? intentEvents(row) : [row.intentId];
    return { digest: d, success: true, sender: row.walletAddress, balanceChanges: [], events: ids.map((id) => ({ packageId: CORE, eventType: `${CORE}::payment_intent::IntentCreated`, json: { intent_id: id } })) };
  };
  let scope = 'full';
  const feeFn = fee ?? (async (p) => ({ feeMinor: splashFee({ kind: 4, principalMinor: p, discountBps: 0, schedule: LAUNCH_SCHEDULE }), feesOn: true }));
  const deps = (orgId = 'acme', more = {}) => ({
    db: w.db,
    orgId,
    env,
    now: () => w.signing.now(),
    ctx: w.ctx,
    walletMembers: async () => (orgId === 'acme' ? { ok: true, address: wallet.address, members } : { ok: false, status: 409, code: 'no_wallet', error: 'register the business wallet first' }),
    partner: () => partner,
    companyName: async () => (orgId === 'acme' ? 'Acme Trading Sdn. Bhd.' : 'Northwind Pte Ltd'),
    splashAddresses: async () => [OPERATOR, w.sponsor.address],
    isBusinessWallet: async () => false,
    bankPayoutFee: feeFn,
    readTransaction: chainRead,
    corePackageOriginalId: CORE,
    fiatOutOpen: () => scope === 'full',
    signedPartners: new Set(),
    ...more,
  });
  const executedHook = { db: w.db, now: () => w.signing.now(), partner: () => partner, readTransaction: chainRead, corePackageOriginalId: CORE };
  w.signing.onExecuted = async (request) => {
    await withdrawalSigningExecuted(executedHook, request);
  };
  if (W.withdrawalBeforeSign) w.signing.beforeSign = (request) => W.withdrawalBeforeSign({ db: w.db }, request);
  const reconcile = () => W.reconcileWithdrawals({ db: w.db, now: () => w.signing.now(), partner: () => partner, readTransaction: chainRead, corePackageOriginalId: CORE });
  const { sandboxWebhookSecretFor } = await import('../lib/payouts/partner.ts');
  const webhook = (body, { at = w.signing.now(), secret = sandboxWebhookSecretFor ? sandboxWebhookSecretFor(env, 'hata_fiuu') : SECRET, adapter = partner, envOverride = env } = {}) => {
    const rawBody = JSON.stringify(body);
    return handlePayoutWebhook({
      partner: 'hata_fiuu',
      rawBody,
      signature: signWebhook(rawBody, secret, at),
      env: envOverride,
      now: w.signing.now(),
      db: w.db,
      // The chain as a webhook reads it: a withdrawal's own deposit sits at
      // checkpoint 100, and anything a test puts on the chain lands later
      // (checkpoint 200) unless the test names its own checkpoint.
      readTransaction: async (d) => {
        const tx = await chainRead(d);
        if (!tx) return null;
        return 'checkpoint' in tx ? tx : { ...tx, checkpoint: chainTxs.has(d) ? '200' : '100' };
      },
      usdcType: USDC,
      adapter,
    });
  };
  return { w, wallet, members, partner, deps, chainTxs, webhook, reconcile, setScope: (s) => (scope = s) };
}

async function signBoth(t, request) {
  await submitPartialSignature(t.w.signing, { orgId: 'acme', userId: 'u-two', id: request.id, signature: await sign(t.w.keys.two, request), digest: request.digest });
  const done = await submitPartialSignature(t.w.signing, { orgId: 'acme', userId: 'u-three', id: request.id, signature: await sign(t.w.keys.three, request), digest: request.digest });
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(done.request.status, 'executed');
  return done.request.executedDigest;
}

/** A verified destination and a verified deposit address. */
async function readyToWithdraw(t) {
  const added = await addWithdrawalDestination(t.deps(), 'u-founder', ACME_BANK);
  assert.equal(added.ok, true, JSON.stringify(added));
  const got = await requestPartnerDepositAddress(t.deps(), 'u-founder');
  assert.equal(got.ok, true, JSON.stringify(got));
  const testDep = await requestTestDeposit(t.deps(), 'u-founder');
  assert.equal(testDep.ok, true, JSON.stringify(testDep));
  const testDigest = await signBoth(t, testDep.request);
  t.chainTxs.set(testDigest, {
    digest: testDigest,
    success: true,
    sender: t.wallet.address,
    balanceChanges: [
      { address: got.depositAddress.address, coinType: USDC, amount: String(TEST_DEPOSIT_MINOR) },
      { address: t.wallet.address, coinType: USDC, amount: String(-TEST_DEPOSIT_MINOR) },
    ],
  });
  const accountRef = (await t.w.db.select().from(schema.partnerDepositAddresses))[0].accountRef;
  const confirmed = await t.webhook({ type: 'test_deposit.received', eventId: `evt_${hex32().slice(0, 12)}`, accountRef, suiDigest: testDigest, occurredAt: T0.toISOString() });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed));
  const address = await withdrawalDepositAddress(t.deps());
  assert.equal(address.status, 'verified');
  return { destination: added.destination, depositAddress: address, accountRef };
}

const bundle = () => ({ contentHash: hex32(), walrusBlobId: toHex(new TextEncoder().encode('blob-wd')) });

async function quoted(t, destinationId, amountMinor = '1000000000') {
  const q = await quoteWithdrawal(t.deps(), { destinationId, amountMinor });
  assert.equal(q.ok, true, JSON.stringify(q));
  return q.quote;
}

async function created(t, destinationId, { amountMinor = '1000000000', clientKey = `ck_${hex32().slice(0, 16)}` } = {}) {
  const q = await quoted(t, destinationId, amountMinor);
  const r = await createWithdrawal(t.deps(), 'u-founder', { clientKey, destinationId, amountMinor, acceptedReceiveMinor: q.receiveMinor, maxFeeMinor: q.maxFeeMinor, ...bundle() });
  assert.equal(r.ok, true, JSON.stringify(r));
  return { q, r, clientKey };
}

/* ── Rules ────────────────────────────────────────────────────────────── */

test('withdrawal and partner statuses never go backwards, and the final ones are final', () => {
  assert.equal(canAdvanceWithdrawal('preparing', 'awaiting_signatures'), true);
  assert.equal(canAdvanceWithdrawal('awaiting_signatures', 'sent'), true);
  assert.equal(canAdvanceWithdrawal('sent', 'partner_received'), true);
  assert.equal(canAdvanceWithdrawal('partner_received', 'paid_out'), true);
  assert.equal(canAdvanceWithdrawal('sent', 'failed'), true);
  assert.equal(canAdvanceWithdrawal('failed', 'returned'), true);
  // A partner that does not pay out may send the USDC straight back: a return the chain shows closes it, failure reported or not.
  assert.equal(canAdvanceWithdrawal('sent', 'returned'), true);
  assert.equal(canAdvanceWithdrawal('partner_received', 'returned'), true);
  for (const [a, b] of [['paid_out', 'failed'], ['paid_out', 'partner_received'], ['partner_received', 'sent'], ['returned', 'failed'], ['cancelled', 'sent'], ['awaiting_signatures', 'paid_out'], ['awaiting_signatures', 'returned'], ['paid_out', 'returned']]) {
    assert.equal(canAdvanceWithdrawal(a, b), false, `${a} → ${b}`);
  }
  assert.equal(canAdvancePayout('instructed', 'funds_received'), true);
  assert.equal(canAdvancePayout('funds_received', 'paid_out'), true);
  assert.equal(canAdvancePayout('failed', 'returned'), true);
  assert.equal(canAdvancePayout('funds_received', 'returned'), true);
  for (const [a, b] of [['paid_out', 'failed'], ['paid_out', 'funds_received'], ['funds_received', 'instructed'], ['failed', 'paid_out'], ['instructed', 'returned'], ['returned', 'failed']]) {
    assert.equal(canAdvancePayout(a, b), false, `${a} → ${b}`);
  }
});

test('the intent id the instruction is keyed by is the one create_for_wallet derives for the payment reference', () => {
  const ref = new Uint8Array(32).fill(9);
  const a = withdrawalIntentId({ accountId: ACCOUNT, corePackageId: CORE, paymentRef: ref });
  assert.match(a, /^0x[0-9a-f]{64}$/);
  assert.equal(withdrawalIntentId({ accountId: ACCOUNT, corePackageId: CORE, paymentRef: ref }), a, 'deterministic');
  assert.notEqual(withdrawalIntentId({ accountId: ACCOUNT, corePackageId: CORE, paymentRef: new Uint8Array(32).fill(8) }), a);
  assert.notEqual(withdrawalIntentId({ accountId: `0x${'ad'.repeat(32)}`, corePackageId: CORE, paymentRef: ref }), a, 'another account, another id');
  assert.throws(() => withdrawalIntentId({ accountId: ACCOUNT, corePackageId: CORE, paymentRef: new Uint8Array(31) }), /32 bytes/);
});

/* ── Destinations: the business's own bank account ───────────────────── */

test("a destination is kept only in the business's own name, as given and as the bank has it, and its number is sealed", async () => {
  const t = await setup();
  const someoneElse = await addWithdrawalDestination(t.deps(), 'u-founder', { ...ACME_BANK, holderName: 'Someone Else Sdn Bhd' });
  assert.equal(someoneElse.code, 'not_company_name');
  // The bank (the partner's name enquiry) says another company holds it.
  const bankSays = await addWithdrawalDestination(t.deps(), 'u-founder', { ...ACME_BANK, accountNumber: '5140-9999-0000' });
  assert.equal(bankSays.code, 'bank_name_mismatch');
  assert.equal((await t.w.db.select().from(schema.withdrawalDestinations)).length, 0, 'nothing is kept for either');
  const trail = await t.w.db.select().from(schema.withdrawalEvents);
  assert.deepEqual(trail.map((e) => e.action), ['name_mismatch', 'name_mismatch']);
  assert.ok(trail.every((e) => !JSON.stringify(e.detail).includes('5140')), 'the trail keeps the last four digits only');

  const added = await addWithdrawalDestination(t.deps(), 'u-founder', ACME_BANK);
  assert.equal(added.ok, true, JSON.stringify(added));
  assert.equal(added.created, true);
  assert.equal(added.destination.last4, '5678');
  assert.equal(added.destination.currency, 'MYR');
  assert.match(added.destination.beneficiaryRef, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(added).includes('51401234'), 'the view never carries the account number');
  assert.equal(added.destination.route, 'our Malaysia exchange partner, then our Malaysia bank-transfer partner', 'unsigned partners are named by role');

  const [row] = await t.w.db.select().from(schema.withdrawalDestinations);
  assert.ok(!row.accountSealed.includes('51401234') && row.fingerprint.startsWith('h1:'));
  const key = accountKey(ENV);
  assert.equal(open(row.accountSealed, key, destinationAad('acme', row.id, 'account')).toString(), '514012345678');
  assert.throws(() => open(row.accountSealed, key, destinationAad('northwind', row.id, 'account')), /does not open/, 'a sealed number moved to another business does not open');
  const salt = open(row.beneficiarySaltSealed, key, destinationAad('acme', row.id, 'salt'));
  assert.equal(beneficiaryRefOf('hata_fiuu', ACME_BANK, salt), row.beneficiaryRef);

  const again = await addWithdrawalDestination(t.deps(), 'u-founder', { ...ACME_BANK, accountNumber: '514012345678' });
  assert.equal(again.created, false, 'the same account is one destination');
  assert.equal(t.partner.called('checkAccount').length, 2, 'and is not checked again');
  await t.w.client.close();
});

test('no destination without the sealing key, the fingerprint key or a registered name, and none outside the route', async () => {
  const noKey = await setup({ env: { ...ENV, WITHDRAWAL_ACCOUNT_KEY: 'short' } });
  assert.equal((await addWithdrawalDestination(noKey.deps(), 'u-founder', ACME_BANK)).code, 'account_key_missing');
  await noKey.w.client.close();
  const t = await setup({ env: { ...ENV, FUNDING_SOURCE_FINGERPRINT_KEY: '' } });
  assert.equal((await addWithdrawalDestination(t.deps(), 'u-founder', ACME_BANK)).code, 'fingerprint_key_missing');
  assert.equal((await addWithdrawalDestination(t.deps('acme', { companyName: async () => null }), 'u-founder', ACME_BANK)).code, 'no_company_name');
  assert.equal((await addWithdrawalDestination(t.deps(), 'u-founder', { ...ACME_BANK, country: 'SG' })).code, 'country_not_offered');
  assert.equal((await addWithdrawalDestination(t.deps(), 'u-founder', { ...ACME_BANK, partner: 'pdax' })).code, 'bad_partner');
  assert.equal((await addWithdrawalDestination(t.deps(), 'u-founder', { ...ACME_BANK, accountNumber: '12' })).code, 'bad_destination');
  await t.w.client.close();
});

/* ── The partner deposit address and its test deposit ────────────────── */

test('the deposit address is fixed per business, never a Splash address or another business’s, and verified only by its test deposit', async () => {
  const t = await setup();
  const got = await requestPartnerDepositAddress(t.deps(), 'u-founder');
  assert.equal(got.ok, true);
  assert.equal(got.depositAddress.status, 'pending_test');
  assert.equal(got.depositAddress.testAmountMinor, '1000000');
  const again = await requestPartnerDepositAddress(t.deps(), 'u-founder');
  assert.equal(again.created, false);
  assert.equal(again.depositAddress.address, got.depositAddress.address);
  assert.equal(t.partner.called('depositAddress').length, 1);
  assert.equal(t.partner.called('depositAddress')[0].input.businessId, normalizeSuiAddress(ACCOUNT), "the partner is asked for this business's address");

  // A partner that hands out an address Splash controls, or the wallet itself, or another business's.
  const splash = await setup({ overrides: { depositAddress: async () => ({ address: OPERATOR, network: 'sui', accountRef: 'acct_operator', sandbox: true }) } });
  assert.equal((await requestPartnerDepositAddress(splash.deps(), 'u-founder')).code, 'splash_address');
  const own = await setup({ overrides: { depositAddress: async () => ({ address: own.wallet.address, network: 'sui', accountRef: 'acct_own_wallet', sandbox: true }) } });
  assert.equal((await requestPartnerDepositAddress(own.deps(), 'u-founder')).code, 'own_wallet');
  const shared = got.depositAddress.address;
  const conflict = await setup({ overrides: { depositAddress: async () => ({ address: shared, network: 'sui', accountRef: 'acct_shared_one', sandbox: true }) } });
  assert.equal((await requestPartnerDepositAddress(conflict.deps('acme'), 'u-founder')).ok, true);
  assert.equal((await requestPartnerDepositAddress(conflict.deps('northwind'), 'u-north')).code, 'address_conflict', 'one address, one business');
  for (const x of [splash, own, conflict]) await x.w.client.close();

  // Not verified yet: no withdrawal.
  const added = await addWithdrawalDestination(t.deps(), 'u-founder', ACME_BANK);
  assert.equal((await quoteWithdrawal(t.deps(), { destinationId: added.destination.id, amountMinor: '1000000000' })).code, 'deposit_address_unverified');

  const testDep = await requestTestDeposit(t.deps(), 'u-founder');
  assert.equal(testDep.ok, true, JSON.stringify(testDep));
  assert.equal(testDep.request.purpose, 'partner_test_deposit');
  assert.deepEqual(testDep.request.description.actions.map((a) => a.type), ['withdraw', 'send_funds']);
  assert.equal(testDep.request.description.actions[1].recipient, got.depositAddress.address);
  assert.equal(testDep.request.description.actions[1].amountMinor, '1000000');
  assert.equal(testDep.request.sender, t.wallet.address, 'the business wallet sends it, signed by its owners');
  assert.equal((await requestTestDeposit(t.deps(), 'u-founder')).code, 'test_in_progress');

  const accountRef = (await t.w.db.select().from(schema.partnerDepositAddresses))[0].accountRef;
  const early = await t.webhook({ type: 'test_deposit.received', eventId: 'evt_early_1', accountRef, suiDigest: digest(), occurredAt: T0.toISOString() });
  assert.equal(early.status, 503, 'before the transaction is recorded the partner retries');

  const testDigest = await signBoth(t, testDep.request);
  assert.equal((await withdrawalDepositAddress(t.deps())).status, 'test_sent');
  const wrong = await t.webhook({ type: 'test_deposit.received', eventId: 'evt_wrong_1', accountRef, suiDigest: digest(), occurredAt: T0.toISOString() });
  assert.equal(wrong.body.ignored, 'not the test deposit sent');
  const unseen = await t.webhook({ type: 'test_deposit.received', eventId: 'evt_unseen1', accountRef, suiDigest: testDigest, occurredAt: T0.toISOString() });
  assert.equal(unseen.status, 503, 'the chain has not shown it yet');
  // The chain shows a different amount: refused.
  t.chainTxs.set(testDigest, { digest: testDigest, success: true, sender: t.wallet.address, balanceChanges: [{ address: got.depositAddress.address, coinType: USDC, amount: '1' }] });
  const short = await t.webhook({ type: 'test_deposit.received', eventId: 'evt_short_1', accountRef, suiDigest: testDigest, occurredAt: T0.toISOString() });
  assert.equal(short.body.ignored, 'the chain does not show this test deposit');
  assert.equal((await withdrawalDepositAddress(t.deps())).status, 'test_sent');

  t.chainTxs.set(testDigest, { digest: testDigest, success: true, sender: t.wallet.address, balanceChanges: [{ address: got.depositAddress.address, coinType: USDC, amount: '1000000' }] });
  // A forged or stale confirmation is refused before anything is read.
  const forged = await t.webhook({ type: 'test_deposit.received', eventId: 'evt_forged1', accountRef, suiDigest: testDigest, occurredAt: T0.toISOString() }, { secret: toHex(randomBytes(32)) });
  assert.equal(forged.status, 401);
  const stale = await t.webhook({ type: 'test_deposit.received', eventId: 'evt_stale_1', accountRef, suiDigest: testDigest, occurredAt: T0.toISOString() }, { at: new Date(T0.getTime() - (WEBHOOK_TOLERANCE_SECONDS + 1) * 1000) });
  assert.equal(stale.status, 401);
  assert.equal(stale.body.code, 'stale');
  const ok = await t.webhook({ type: 'test_deposit.received', eventId: 'evt_good_01', accountRef, suiDigest: testDigest, occurredAt: T0.toISOString() });
  assert.equal(ok.status, 200, JSON.stringify(ok));
  assert.equal((await withdrawalDepositAddress(t.deps())).status, 'verified');
  const replay = await t.webhook({ type: 'test_deposit.received', eventId: 'evt_good_01', accountRef, suiDigest: testDigest, occurredAt: T0.toISOString() });
  assert.equal(replay.body.duplicate, true);
  assert.equal((await requestTestDeposit(t.deps(), 'u-founder')).code, 'already_verified');
  await t.w.client.close();
});

test('a partner that gives two businesses one account reference is refused for the second, and a webhook can never name two businesses', async () => {
  const addrs = ['0x' + '5a'.repeat(32), '0x' + '5b'.repeat(32), '0x' + '5c'.repeat(32)];
  let n = 0;
  const t = await setup({ overrides: { depositAddress: async () => ({ address: addrs[n++], network: 'sui', accountRef: 'acct_reused', sandbox: true }) } });
  assert.equal((await requestPartnerDepositAddress(t.deps('acme'), 'u-founder')).ok, true);
  const second = await requestPartnerDepositAddress(t.deps('northwind'), 'u-north');
  assert.equal(second.ok, undefined, 'the second business is not given the first one’s account reference');
  assert.equal(second.code, 'account_ref_conflict');
  assert.equal(second.status, 409);
  const rows = await t.w.db.select().from(schema.partnerDepositAddresses).where(eq(schema.partnerDepositAddresses.accountRef, 'acct_reused'));
  assert.deepEqual(rows.map((r) => r.orgId), ['acme'], 'nothing was recorded for the second business');
  // The database holds the line too: a second live row with the reference cannot be written.
  await assert.rejects(
    t.w.db.insert(schema.partnerDepositAddresses).values({ id: 'pda_direct', orgId: 'northwind', partner: rows[0].partner, address: addrs[2], accountRef: 'acct_reused', status: 'pending_test', testAmountMinor: 1_000_000n, createdBy: 'u-north' }),
  );
  await t.w.client.close();
});

test('a test deposit whose signing request lapses can be asked for again', async () => {
  const t = await setup();
  await requestPartnerDepositAddress(t.deps(), 'u-founder');
  const first = await requestTestDeposit(t.deps(), 'u-founder');
  assert.equal(first.ok, true);
  const cancelled = await cancelSigningRequest(t.w.signing, { orgId: 'acme', userId: 'u-founder', id: first.request.id });
  assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
  assert.equal((await withdrawalDepositAddress(t.deps())).status, 'pending_test');
  assert.equal((await requestTestDeposit(t.deps(), 'u-founder')).ok, true);
  await t.w.client.close();
});

/* ── Quote, create, sign, settle ─────────────────────────────────────── */

test('the quote comes once the wallet holds the money, with each partner fee and Splash’s fee as their own lines', async () => {
  const t = await setup();
  const { destination } = await readyToWithdraw(t);
  t.w.balances.set(t.wallet.address, { coinMinor: 0n, addressBalanceMinor: 500_000_000n });
  const poor = await quoteWithdrawal(t.deps(), { destinationId: destination.id, amountMinor: '1000000000' });
  assert.equal(poor.code, 'insufficient_funds');
  assert.equal(t.partner.called('quote').length, 0, 'no rate is asked for before the funds are there');
  t.w.balances.set(t.wallet.address, { coinMinor: 0n, addressBalanceMinor: 10_000_000_000n });
  const q = await quoted(t, destination.id);
  assert.equal(q.currency, 'MYR');
  assert.equal(q.sendMinor, '1000000000');
  assert.equal(q.splashFee.kind, 4, 'a bank payout');
  assert.equal(q.splashFee.minor, String(splashFee({ kind: 4, principalMinor: 1_000_000_000n, discountBps: 0, schedule: LAUNCH_SCHEDULE })));
  assert.equal(q.maxFeeMinor, q.splashFee.minor);
  assert.equal(BigInt(q.totalDebitMinor), 1_000_000_000n + BigInt(q.maxFeeMinor));
  assert.equal(q.partnerFees.length, 2, "the exchange's and the bank transfer's fees, separately");
  assert.ok(q.partnerFees.every((l) => l.currency === 'MYR' && /sandbox/.test(l.label)));
  assert.equal(q.sandbox, true);
  assert.equal(new Date(q.expiresAt).getTime(), T0.getTime() + 5 * 60_000);
  assert.equal((await quoteWithdrawal(t.deps(), { destinationId: destination.id, amountMinor: '0' })).code, 'bad_amount');
  t.setScope('stablecoin');
  assert.equal((await quoteWithdrawal(t.deps(), { destinationId: destination.id, amountMinor: '1000000000' })).code, 'not_in_launch_scope');
  await t.w.client.close();
});

test('a withdrawal instructs the partner first, keyed by its intent id, and the owners sign a bank payout to that address, account and amount', async () => {
  const t = await setup();
  const { destination, depositAddress } = await readyToWithdraw(t);
  const { q, r } = await created(t, destination.id);
  assert.equal(r.created, true);
  const wd = r.withdrawal;
  assert.equal(wd.status, 'awaiting_signatures');
  assert.equal(wd.depositAddress, depositAddress.address);

  const [instruction] = t.partner.called('createPayout').map((c) => c.input);
  assert.equal(instruction.intentId, wd.intentId, 'keyed by the intent id');
  assert.equal(instruction.expectedUsdcMinor, 1_000_000_000n, 'and the expected amount');
  assert.equal(instruction.beneficiary.accountNumber, '514012345678');
  assert.equal(instruction.beneficiaryRef, destination.beneficiaryRef);
  assert.equal(instruction.returnAddress, t.wallet.address, 'a return goes to the business wallet');
  assert.equal(instruction.sourceWallet, t.wallet.address);
  assert.ok(![OPERATOR, t.w.sponsor.address].includes(instruction.depositAddress), 'no Splash address on the path');
  const [row] = await t.w.db.select().from(schema.withdrawals);
  assert.equal(withdrawalIntentId({ accountId: ACCOUNT, corePackageId: CORE, paymentRef: Buffer.from(row.paymentRef, 'hex') }), wd.intentId);

  const request = r.request;
  assert.equal(request.purpose, 'withdrawal');
  assert.equal(request.sender, t.wallet.address, "the owners' multisig signs");
  const d = request.description;
  assert.deepEqual(d.actions.map((a) => a.type), ['withdraw', 'open_intent', 'pay_intent', 'anchor_receipt', 'delete_intent']);
  const openIntent = d.actions[1];
  assert.equal(openIntent.kind, 4);
  assert.equal(openIntent.recipient, depositAddress.address);
  assert.equal(openIntent.beneficiaryRef, destination.beneficiaryRef);
  assert.equal(openIntent.amountMinor, '1000000000');
  assert.equal(openIntent.targetCurrency, 'MYR');
  assert.equal(d.actions[2].maxFeeMinor, q.maxFeeMinor, 'the fee shown is the max_fee');
  assert.equal(d.actions[0].amountMinor, String(1_000_000_000n + BigInt(q.maxFeeMinor)));
  assert.equal(BigInt(d.actions[2].settleByMs), BigInt(T0.getTime() + R.WITHDRAWAL_SIGNING_WINDOW_MS), 'settle_by is the signing deadline, not the five-minute quote');

  // Signed and executed: sent, and the digest goes to the partner.
  const executed = await signBoth(t, request);
  const after = await getWithdrawal(t.deps(), wd.id);
  assert.equal(after.withdrawal.status, 'sent');
  assert.equal(after.withdrawal.suiDigest, executed);
  assert.equal(after.withdrawal.settlementPosted, true);
  const [posted] = t.partner.called('postSettlement').map((c) => c.input);
  assert.deepEqual([posted.intentId, posted.partnerRef, posted.suiDigest], [wd.intentId, wd.partnerRef, executed]);
  await t.w.client.close();
});

test('a withdrawal row keeps the masked ISO 20022 message it was instructed with, for the evidence export, as a supplier payout does', async () => {
  const t = await setup();
  const { destination } = await readyToWithdraw(t);
  const { r } = await created(t, destination.id);
  const [instruction] = t.partner.called('createPayout').map((c) => c.input);
  const [row] = await t.w.db.select().from(schema.withdrawals).where(eq(schema.withdrawals.id, r.withdrawal.id));
  assert.equal(row.purposeCode, 'INTC', 'a business moving its own money');
  assert.ok(row.iso20022, 'the message the partner was sent is on the row');
  const { pacs008Evidence } = await import('../lib/payments/iso20022.ts');
  assert.deepEqual(row.iso20022, JSON.parse(JSON.stringify(pacs008Evidence(instruction.iso20022))), 'exactly what was sent, masked');
  assert.equal(row.iso20022.relationship, 'self');
  assert.equal(row.iso20022.creditorAccountLast4, '5678');
  assert.ok(!JSON.stringify(row.iso20022).includes('514012345678'), 'the account number is masked');
  await t.w.client.close();
});

test('a withdrawal is idempotent by its key: a retry is the same withdrawal and instructs nobody twice; another request on the key is refused', async () => {
  const t = await setup();
  const { destination } = await readyToWithdraw(t);
  const { q, r, clientKey } = await created(t, destination.id);
  const again = await createWithdrawal(t.deps(), 'u-founder', { clientKey, destinationId: destination.id, amountMinor: '1000000000', acceptedReceiveMinor: q.receiveMinor, maxFeeMinor: q.maxFeeMinor, ...bundle() });
  assert.equal(again.ok, true);
  assert.equal(again.created, false);
  assert.equal(again.withdrawal.id, r.withdrawal.id);
  assert.equal(t.partner.called('createPayout').length, 1);
  const other = await createWithdrawal(t.deps(), 'u-founder', { clientKey, destinationId: destination.id, amountMinor: '2000000000', acceptedReceiveMinor: '1', maxFeeMinor: q.maxFeeMinor, ...bundle() });
  assert.equal(other.code, 'idempotency_key_reused');
  assert.equal((await createWithdrawal(t.deps(), 'u-founder', { clientKey: 'x', destinationId: destination.id, amountMinor: '1', acceptedReceiveMinor: '0', maxFeeMinor: '0', ...bundle() })).code, 'idempotency_key_required');
  assert.equal((await t.w.db.select().from(schema.withdrawals)).length, 1);
  await t.w.client.close();
});

test('a worse rate, a higher fee than shown, a fee over the ceiling or no audit bundle is refused, and nothing is instructed', async () => {
  const t = await setup();
  const { destination } = await readyToWithdraw(t);
  const q = await quoted(t, destination.id);
  const base = { destinationId: destination.id, amountMinor: '1000000000', maxFeeMinor: q.maxFeeMinor, ...bundle() };
  const worse = await createWithdrawal(t.deps(), 'u-founder', { ...base, clientKey: 'ck_worse_rate', acceptedReceiveMinor: String(BigInt(q.receiveMinor) + 1n) });
  assert.equal(worse.code, 'quote_changed');
  assert.equal(worse.quote.receiveMinor, q.receiveMinor, 'the new quote comes back to be shown');
  const lowFee = await createWithdrawal(t.deps(), 'u-founder', { ...base, clientKey: 'ck_fee_lower', acceptedReceiveMinor: q.receiveMinor, maxFeeMinor: String(BigInt(q.maxFeeMinor) - 1n) });
  assert.equal(lowFee.code, 'fee_above_shown');
  const ceiling = await createWithdrawal(t.deps(), 'u-founder', { ...base, clientKey: 'ck_ceiling_1', acceptedReceiveMinor: q.receiveMinor, maxFeeMinor: '10000001' });
  assert.equal(ceiling.code, 'bad_fee');
  const noBundle = await createWithdrawal(t.deps(), 'u-founder', { ...base, clientKey: 'ck_nobundle', acceptedReceiveMinor: q.receiveMinor, contentHash: '' });
  assert.equal(noBundle.code, 'no_audit_bundle');
  const noFee = await createWithdrawal(t.deps('acme', { bankPayoutFee: async () => { throw new Error('FeeConfig unreadable'); } }), 'u-founder', { ...base, clientKey: 'ck_no_fee_1', acceptedReceiveMinor: q.receiveMinor });
  assert.equal(noFee.code, 'fee_unavailable');
  assert.equal(t.partner.called('createPayout').length, 0);
  assert.equal((await t.w.db.select().from(schema.withdrawals)).length, 0);
  await t.w.client.close();
});

test('the partner is never sent an account the intent does not commit to', async () => {
  const t = await setup();
  const { destination } = await readyToWithdraw(t);
  // The stored commitment no longer matches the sealed account (a tampered row).
  await t.w.db.update(schema.withdrawalDestinations).set({ beneficiaryRef: hex32() }).where(eq(schema.withdrawalDestinations.id, destination.id));
  const q = await quoted(t, destination.id);
  const r = await createWithdrawal(t.deps(), 'u-founder', { clientKey: 'ck_tampered1', destinationId: destination.id, amountMinor: '1000000000', acceptedReceiveMinor: q.receiveMinor, maxFeeMinor: q.maxFeeMinor, ...bundle() });
  assert.equal(r.code, 'beneficiary_mismatch');
  assert.equal(t.partner.called('createPayout').length, 0);
  await t.w.client.close();
});

test('the owners are asked only for bytes that pay the verified deposit address, for that account and amount, as a bank payout', async () => {
  const t = await setup();
  const { destination, depositAddress } = await readyToWithdraw(t);
  const { r } = await created(t, destination.id);
  const d = r.request.description;
  const ctx = { recipient: depositAddress.address, beneficiaryRef: destination.beneficiaryRef, amountMinor: 1_000_000_000n };
  assert.doesNotThrow(() => assertPurposeShape('withdrawal', d, ctx));
  assert.throws(() => assertPurposeShape('withdrawal', d, { ...ctx, recipient: `0x${'77'.repeat(32)}` }), /partner deposit address/);
  assert.throws(() => assertPurposeShape('withdrawal', d, { ...ctx, beneficiaryRef: hex32() }), /own bank account/);
  assert.throws(() => assertPurposeShape('withdrawal', d, { ...ctx, amountMinor: 1n }), /amount/);
  const asWallet = { ...d, actions: d.actions.map((a) => (a.type === 'open_intent' ? { ...a, kind: 1 } : a)) };
  assert.throws(() => assertPurposeShape('withdrawal', asWallet, ctx), /bank payout/);

  // The payment builder refuses a "withdrawal" that is not a bank payout to the deposit address.
  const payment = {
    paymentRef: new Uint8Array(32).fill(5), recipient: depositAddress.address, beneficiaryRef: Buffer.from(destination.beneficiaryRef, 'hex'), amountMinor: 1n,
    targetCurrency: 'MYR', fxRateUsdLocal: 1n, commitment: new Uint8Array(32).fill(1), kind: 1, railCommitment: new Uint8Array(32).fill(2),
    expiresAtMs: BigInt(T0.getTime() + 3600_000), maxFeeMinor: 0n, settleByMs: BigInt(T0.getTime() + 60_000), contentHash: new Uint8Array(32).fill(3), walrusBlobId: new Uint8Array([1]),
  };
  const withdrawal = { depositAddress: depositAddress.address, beneficiaryRef: destination.beneficiaryRef };
  assert.equal((await requestWalletPayment(t.w.ctx, { orgId: 'acme', requestedBy: 'u-founder', wallet: t.members, payment, withdrawal })).code, 'not_a_bank_payout');
  assert.equal((await requestWalletPayment(t.w.ctx, { orgId: 'acme', requestedBy: 'u-founder', wallet: t.members, payment: { ...payment, kind: 4, recipient: `0x${'77'.repeat(32)}` }, withdrawal })).code, 'wrong_recipient');
  await t.w.client.close();
});

/* ── After settlement: partner webhooks ──────────────────────────────── */

test('partner webhooks move a withdrawal forward only, once each, and only for its own intent and reference', async () => {
  const t = await setup();
  const { destination } = await readyToWithdraw(t);
  const { r } = await created(t, destination.id);
  const wd = r.withdrawal;
  const ev = (status, extra = {}) => ({ type: 'payout.status', eventId: `evt_${status}_${hex32().slice(0, 8)}`, partnerRef: wd.partnerRef, intentId: wd.intentId, status, occurredAt: T0.toISOString(), ...extra });

  const tooEarly = await t.webhook(ev('funds_received'));
  assert.equal(tooEarly.status, 503, 'before the deposit is recorded the partner retries');
  await signBoth(t, r.request);

  assert.equal((await t.webhook({ ...ev('paid_out'), partnerRef: 'sb_hf_someoneelses' })).body.ignored, 'no such payout', 'the intent and the partner’s own reference must both match');
  assert.equal((await t.webhook({ ...ev('paid_out'), intentId: `0x${'12'.repeat(32)}` })).body.ignored, 'no such payout');
  assert.equal((await t.webhook(ev('paid_out'), { secret: toHex(randomBytes(32)) })).status, 401);

  const received = ev('funds_received');
  assert.equal((await t.webhook(received)).status, 200);
  assert.equal((await t.webhook(received)).body.ignored, 'a withdrawal partner received does not move to partner received', 'a replay changes nothing');
  const paid = ev('paid_out', { bankRef: 'FIUU-TRX-000123' });
  assert.equal((await t.webhook(paid)).status, 200);
  const view = (await getWithdrawal(t.deps(), wd.id)).withdrawal;
  assert.equal(view.status, 'paid_out');
  assert.equal(view.bankRef, 'FIUU-TRX-000123');
  assert.match((await t.webhook(ev('failed'))).body.ignored, /does not move/, 'paid out is final');
  assert.match((await t.webhook(ev('funds_received'))).body.ignored, /does not move/, 'never backwards');
  const events = (await t.w.db.select().from(schema.payoutPartnerEvents)).filter((e) => e.subjectId === wd.id);
  assert.deepEqual(events.map((e) => e.status).sort(), ['funds_received', 'paid_out'], 'each counted event moved it once');
  await t.w.client.close();
});

test('a failed payout asks the partner to return the USDC to the business wallet, and a return is believed only from the chain', async () => {
  const t = await setup();
  const { destination } = await readyToWithdraw(t);
  const { r } = await created(t, destination.id);
  const wd = r.withdrawal;
  await signBoth(t, r.request);
  const failed = await t.webhook({ type: 'payout.status', eventId: 'evt_failed_01', partnerRef: wd.partnerRef, intentId: wd.intentId, status: 'failed', failureReason: 'account closed', occurredAt: T0.toISOString() });
  assert.equal(failed.status, 200);
  const [ret] = t.partner.called('returnOrReverse').map((c) => c.input);
  assert.equal(ret.returnAddress, t.wallet.address, 'back to the business wallet, never to Splash');
  assert.equal(ret.intentId, wd.intentId);

  const returnDigest = digest();
  const body = { type: 'payout.status', eventId: 'evt_return_01', partnerRef: wd.partnerRef, intentId: wd.intentId, status: 'returned', returnDigest, occurredAt: T0.toISOString() };
  assert.equal((await t.webhook(body)).status, 503, 'not on chain yet: retry');
  t.chainTxs.set(returnDigest, { digest: returnDigest, success: true, sender: wd.depositAddress, balanceChanges: [{ address: OPERATOR, coinType: USDC, amount: '1000000000' }] });
  assert.equal((await t.webhook(body)).body.ignored, 'the chain does not show the return', 'USDC that went anywhere but the business wallet is no return');
  t.chainTxs.set(returnDigest, { digest: returnDigest, success: true, sender: wd.depositAddress, balanceChanges: [{ address: t.wallet.address, coinType: USDC, amount: '1000000000' }] });
  assert.equal((await t.webhook({ ...body, eventId: 'evt_return_02' })).status, 200);
  const view = (await getWithdrawal(t.deps(), wd.id)).withdrawal;
  assert.equal(view.status, 'returned');
  assert.equal(view.returnDigest, returnDigest);
  assert.equal(view.returnedMinor, '1000000000');
  await t.w.client.close();
});

test('a withdrawal whose signing request is cancelled is cancelled, and its instruction reversed', async () => {
  const t = await setup();
  const { destination } = await readyToWithdraw(t);
  const { r } = await created(t, destination.id);
  const c = await cancelSigningRequest(t.w.signing, { orgId: 'acme', userId: 'u-founder', id: r.request.id });
  assert.equal(c.ok, true, JSON.stringify(c));
  await t.reconcile();
  const [view] = await listWithdrawals(t.deps());
  assert.equal(view.status, 'cancelled');
  const [rev] = t.partner.called('returnOrReverse').map((x) => x.input);
  assert.equal(rev.reason, 'not_sent');
  assert.equal(rev.intentId, r.withdrawal.intentId);
  await t.w.client.close();
});

test('when the owners cannot be asked (the dry run fails), the instruction is reversed and nothing waits', async () => {
  const t = await setup();
  const { destination } = await readyToWithdraw(t);
  const q = await quoted(t, destination.id);
  const realSimulate = t.w.chain.simulate;
  t.w.signing.chain.simulate = async () => ({ success: false, error: 'MoveAbort(1400)' });
  const r = await createWithdrawal(t.deps(), 'u-founder', { clientKey: 'ck_simfail1', destinationId: destination.id, amountMinor: '1000000000', acceptedReceiveMinor: q.receiveMinor, maxFeeMinor: q.maxFeeMinor, ...bundle() });
  t.w.signing.chain.simulate = realSimulate;
  assert.equal(r.code, 'simulation_failed');
  assert.equal(t.partner.called('createPayout').length, 1);
  assert.equal(t.partner.called('returnOrReverse')[0].input.reason, 'not_sent');
  const [row] = await t.w.db.select().from(schema.withdrawals);
  assert.equal(row.status, 'cancelled');
  await t.w.client.close();
});

/* ── Tenancy, trail, production ──────────────────────────────────────── */

test("another business's destinations, addresses and withdrawals read as absent", async () => {
  const t = await setup();
  const { destination } = await readyToWithdraw(t);
  const { r } = await created(t, destination.id);
  const north = t.deps('northwind');
  assert.deepEqual(await listWithdrawalDestinations(north), []);
  assert.deepEqual(await listWithdrawals(north), []);
  assert.equal(await withdrawalDepositAddress(north), null);
  assert.equal((await getWithdrawal(north, r.withdrawal.id)).code, 'not_found');
  assert.equal((await quoteWithdrawal(north, { destinationId: destination.id, amountMinor: '1000000' })).code, 'not_found');
  assert.equal((await createWithdrawal(north, 'u-north', { clientKey: 'ck_cross_tenant', destinationId: destination.id, amountMinor: '1000000', acceptedReceiveMinor: '1', maxFeeMinor: '0', ...bundle() })).code, 'not_found');
  assert.equal((await revokeWithdrawalDestination(north, 'u-north', destination.id)).code, 'not_found');
  assert.equal((await listWithdrawalDestinations(t.deps())).length, 1, "acme's is untouched");
  await t.w.client.close();
});

test('the withdrawal trail is append-only', async () => {
  const t = await setup();
  await readyToWithdraw(t);
  const events = await t.w.db.select().from(schema.withdrawalEvents);
  assert.ok(events.some((e) => e.action === 'verified' && e.actor === 'partner:hata_fiuu'));
  const appendOnly = (e) => /append-only/.test(String(e?.cause?.message ?? e?.message));
  await assert.rejects(t.w.db.update(schema.withdrawalEvents).set({ action: 'rewritten' }), appendOnly);
  await assert.rejects(t.w.db.delete(schema.withdrawalEvents), appendOnly);
  await t.w.client.close();
});

test('production fails closed: without credentials, with them, and with USE_MOCK_APIS on, no sandbox answer is given', async () => {
  const now = new Date();
  for (const env of [{ NODE_ENV: 'production' }, { NODE_ENV: 'production', USE_MOCK_APIS: 'true', NEXT_PUBLIC_DEMO_MODE: 'true' }]) {
    const p = payoutPartner('hata_fiuu', env);
    assert.equal(p.mode, 'live');
    for (const call of [
      () => p.depositAddress({ businessId: ACCOUNT, now }),
      () => p.checkAccount({ beneficiary: ACME_BANK, now }),
      () => p.quote({ currency: 'MYR', sendMinor: 1n, now }),
      () => p.createPayout({ intentId: ACCOUNT, expectedUsdcMinor: 1n, now }),
      () => p.postSettlement({ intentId: ACCOUNT, partnerRef: 'x', suiDigest: 'y', now }),
      () => p.status({ intentId: ACCOUNT, partnerRef: 'x', now }),
      () => p.returnOrReverse({ intentId: ACCOUNT, partnerRef: 'x', returnAddress: ACCOUNT, reason: 'r', now }),
    ]) {
      await assert.rejects(call(), (e) => e instanceof PayoutPartnerUnavailable && e.code === 'partner_not_configured');
    }
    assert.throws(() => p.handleWebhook({ rawBody: '{}', signature: null, now }), (e) => e instanceof WebhookRejected && e.code === 'partner_not_configured');
  }
  const creds = { NODE_ENV: 'production', HATA_API_KEY: 'k', HATA_WEBHOOK_SECRET: 's', FIUU_MERCHANT_ID: 'm', FIUU_VERIFY_KEY: 'v' };
  await assert.rejects(payoutPartner('hata_fiuu', creds).quote({ currency: 'MYR', sendMinor: 1n, now }), (e) => e.code === 'partner_not_connected');
  assert.throws(() => payoutPartner('hata_fiuu', { NODE_ENV: 'test', PAYOUT_PARTNER_HATA_FIUU_ENABLED: 'false' }), (e) => e.code === 'partner_disabled');
  // §4.5: every route the brief names is on the interface (tests/payout-partners.test.mjs).
  assert.equal(payoutPartner('pdax', { NODE_ENV: 'test' }).mode, 'sandbox');

  // Through the service: nothing is stored, and a production webhook is refused.
  const t = await setup();
  const live = payoutPartner('hata_fiuu', { NODE_ENV: 'production' });
  const prod = t.deps('acme', { partner: () => live });
  assert.equal((await addWithdrawalDestination(prod, 'u-founder', ACME_BANK)).code, 'partner_not_configured');
  assert.equal((await requestPartnerDepositAddress(prod, 'u-founder')).code, 'partner_not_configured');
  assert.equal((await t.w.db.select().from(schema.withdrawalDestinations)).length, 0);
  const rawBody = JSON.stringify({ type: 'payout.status', eventId: 'evt_prod_01', partnerRef: 'sb_hf_x', intentId: ACCOUNT, status: 'paid_out' });
  const answer = await handlePayoutWebhook({ partner: 'hata_fiuu', rawBody, signature: signWebhook(rawBody, SECRET, new Date()), env: { NODE_ENV: 'production', USE_MOCK_APIS: 'true', PAYOUT_SANDBOX_WEBHOOKS_ENABLED: 'true', PAYOUT_SANDBOX_WEBHOOK_SECRET: SECRET }, now: new Date(), db: t.w.db, readTransaction: async () => null, usdcType: USDC });
  assert.equal(answer.status, 503, 'the sandbox secret signs nothing in production');
  assert.equal(PAYOUT_SIGNATURE_HEADER, 'x-splash-payout-signature');
  // Outside production the sandbox accepts nothing without its own random secret.
  const noSecret = await handlePayoutWebhook({ partner: 'hata_fiuu', rawBody, signature: signWebhook(rawBody, SECRET, new Date()), env: { NODE_ENV: 'test' }, now: new Date(), db: t.w.db, readTransaction: async () => null, usdcType: USDC });
  assert.equal(noSecret.status, 401);
  assert.equal((await handlePayoutWebhook({ partner: 'nobody', rawBody, signature: null, env: ENV, now: new Date(), db: t.w.db, readTransaction: async () => null, usdcType: USDC })).status, 404);
  await t.w.client.close();
});

/* ── Routes ───────────────────────────────────────────────────────────── */

test('every withdrawal route takes the org from the session, owners alone change anything, and the webhook checks its signature first', async () => {
  const { readFile } = await import('node:fs/promises');
  const routes = ['route.ts', 'quotes/route.ts', '[id]/route.ts', 'destinations/route.ts', 'destinations/[id]/route.ts', 'deposit-address/route.ts'];
  for (const r of routes) {
    const source = await readFile(new URL(`../app/api/wallet/withdrawals/${r}`, import.meta.url), 'utf8');
    assert.match(source, /withdrawalRoute\(request\)/, `${r}: the wallet route, the org from the session`);
    assert.doesNotMatch(source, /body\.(orgId|accountId|userId|walletAddress|depositAddress)|searchParams\.get\('orgId'\)/, `${r}: no org, account, wallet or address from the request`);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const at = source.indexOf(`export async function ${method}(`);
      if (at < 0) continue;
      const body = source.slice(at, source.indexOf('\n}\n', at));
      // Staff may ask the owners to approve a withdrawal (Sky's decision); only owners change the bank accounts or the deposit address.
      if ((r === 'route.ts' || r === 'quotes/route.ts') && method === 'POST') assert.match(body, /requireWithdrawalRequester\(gate\.route\)/, `${r} ${method}: a member who may ask`);
      else assert.match(body, /requireOwner\(gate\.route,/, `${r} ${method}: owners only`);
      assert.match(body, /limitWalletRequests\(gate\.route\)/, `${r} ${method}: rate-limited`);
    }
  }
  const front = await readFile(new URL('../lib/server/withdrawals-deps.ts', import.meta.url), 'utf8');
  assert.match(front, /walletRoute\(request\)/);
  const hook = await readFile(new URL('../app/api/webhooks/payouts/[partner]/route.ts', import.meta.url), 'utf8');
  assert.match(hook, /PAYOUT_SIGNATURE_HEADER/);
  assert.match(hook, /readCapped\(request, MAX_BODY_BYTES\)/, 'the raw body, read with a byte cap, is what is verified');
  assert.match(hook, /content-length/, 'a declared body over the cap is refused before any read');
  const deps = await readFile(new URL('../lib/server/wallet-deps.ts', import.meta.url), 'utf8');
  assert.match(deps, /withdrawalSigningExecuted/, 'an executed owners’ request moves its withdrawal on');
  assert.match(deps, /withdrawalBeforeSign/, 'a withdrawal signature is checked against its bank account when it is given');
  const cron = await readFile(new URL('../app/api/cron/withdrawals/route.ts', import.meta.url), 'utf8');
  assert.match(cron, /CRON_SECRET/, 'the withdrawal sweep is the cron’s alone');
  assert.match(cron, /reconcileWithdrawals\(/, 'it posts unposted settlements and closes lapsed requests');
  const profile = await readFile(new URL('../app/api/onboarding/profile/route.ts', import.meta.url), 'utf8');
  assert.match(profile, /role: auth\.authority\.role|resolveAuthorityForSession|saveBusinessProfile\(auth\.session/, 'the profile route passes the session, whose role the service checks');
  assert.match(profile, /result\.ok/, 'a refused profile change is answered as refused');
});

/* ── Review fixes (p2-4.4) ───────────────────────────────────────────── */

const PROFILE = { legalName: 'Acme Trading Sdn. Bhd.', registrationNumber: '202601000001', addressCountry: 'MY' };

test('a bank account is checked against the KYB-verified registered name, which only an owner sets and which is fixed once KYB is under way', async () => {
  assert.equal(W.verifiedLegalName({ legalName: 'Acme Trading Sdn. Bhd.', kybStatus: 'none' }), null, 'a name nobody verified is no registered name');
  assert.equal(W.verifiedLegalName({ legalName: 'Acme Trading Sdn. Bhd.', kybStatus: 'pending' }), null);
  assert.equal(W.verifiedLegalName({ legalName: 'Acme Trading Sdn. Bhd.', kybStatus: 'basic' }), 'Acme Trading Sdn. Bhd.');
  assert.equal(W.verifiedLegalName({ legalName: ' Acme Trading Sdn. Bhd. ', kybStatus: 'full' }), 'Acme Trading Sdn. Bhd.');
  assert.equal(W.verifiedLegalName({ legalName: '', kybStatus: 'full' }), null);

  const t = await setup();
  const readName = async () => (await t.w.db.select().from(schema.organizations).where(eq(schema.organizations.id, 'acme')))[0].legalName;
  const staff = await O.saveBusinessProfileFor(t.w.db, { orgId: 'acme', userId: 'u-two', role: 'APPROVER' }, { ...PROFILE, legalName: 'Mule Holdings Sdn Bhd' });
  assert.equal(staff.ok, false);
  assert.equal(staff.code, 'owner_only');
  assert.equal(await readName(), 'Acme Trading Sdn. Bhd.', 'a staff member cannot rewrite the registered name');

  await t.w.db.update(schema.organizations).set({ kybLifecycle: 'ACTIVE', kybStatus: 'full' }).where(eq(schema.organizations.id, 'acme'));
  const locked = await O.saveBusinessProfileFor(t.w.db, { orgId: 'acme', userId: 'u-founder', role: 'OWNER' }, { ...PROFILE, legalName: 'Mule Holdings Sdn Bhd' });
  assert.equal(locked.code, 'legal_name_locked', 'not even an owner, once KYB is under way');
  assert.equal(await readName(), 'Acme Trading Sdn. Bhd.');
  const same = await O.saveBusinessProfileFor(t.w.db, { orgId: 'acme', userId: 'u-founder', role: 'OWNER' }, { ...PROFILE, addressCountry: 'my' });
  assert.equal(same.ok, true, 'the same name may be saved again');
  await t.w.client.close();
});

test('a change of the registered name revokes every bank account and cancels a withdrawal in flight', async () => {
  const t = await setup();
  const { destination } = await readyToWithdraw(t);
  const { r } = await created(t, destination.id);
  const changed = await O.saveBusinessProfileFor(t.w.db, { orgId: 'acme', userId: 'u-founder', role: 'OWNER' }, { ...PROFILE, legalName: 'Mule Holdings Sdn Bhd' }, { partner: () => t.partner });
  assert.equal(changed.ok, true, JSON.stringify(changed));
  assert.equal(changed.destinationsRevoked, 1);
  assert.deepEqual(await listWithdrawalDestinations(t.deps()), []);
  assert.equal((await getWithdrawal(t.deps(), r.withdrawal.id)).withdrawal.status, 'cancelled');
  assert.equal((await readSigningRequest(t.w.db, 'acme', r.request.id)).status, 'cancelled', 'nobody can sign it any more');
  assert.equal(t.partner.called('returnOrReverse').at(-1).input.reason, 'destination_revoked');
  // A bank account checked against an earlier name is not paid, whatever path changed the name.
  const t2 = await setup();
  const ready2 = await readyToWithdraw(t2);
  const mule = t2.deps('acme', { companyName: async () => 'Mule Holdings Sdn Bhd' });
  assert.equal((await quoteWithdrawal(mule, { destinationId: ready2.destination.id, amountMinor: '1000000000' })).code, 'destination_name_changed');
  assert.deepEqual(await listWithdrawalDestinations(t2.deps()), [], 'and it is revoked');
  await t.w.client.close();
  await t2.w.client.close();
});

test('a return counts only from the deposit address, once, and closes a withdrawal only for its whole amount', async () => {
  const t = await setup();
  const { destination, depositAddress } = await readyToWithdraw(t);
  const one = await created(t, destination.id);
  await signBoth(t, one.r.request);
  const two = await created(t, destination.id);
  await signBoth(t, two.r.request);
  const fail = (wd, id) => t.webhook({ type: 'payout.status', eventId: id, partnerRef: wd.partnerRef, intentId: wd.intentId, status: 'failed', occurredAt: T0.toISOString() });
  assert.equal((await fail(one.r.withdrawal, 'evt_fail_one')).status, 200);
  assert.equal((await fail(two.r.withdrawal, 'evt_fail_two')).status, 200);
  const ret = (wd, id, returnDigest) => t.webhook({ type: 'payout.status', eventId: id, partnerRef: wd.partnerRef, intentId: wd.intentId, status: 'returned', returnDigest, occurredAt: T0.toISOString() });

  // A stranger's 1 micro-USDC payment into the wallet is no return.
  const stranger = digest();
  t.chainTxs.set(stranger, { digest: stranger, success: true, sender: `0x${'5e'.repeat(32)}`, balanceChanges: [{ address: t.wallet.address, coinType: USDC, amount: '1' }] });
  assert.equal((await ret(one.r.withdrawal, 'evt_strange1', stranger)).body.ignored, 'the chain does not show the return');
  assert.equal((await ret(two.r.withdrawal, 'evt_strange2', stranger)).body.ignored, 'the chain does not show the return');
  assert.equal((await getWithdrawal(t.deps(), one.r.withdrawal.id)).withdrawal.status, 'failed');

  // The whole amount back from the deposit address closes it.
  const back = digest();
  t.chainTxs.set(back, { digest: back, success: true, sender: depositAddress.address, balanceChanges: [{ address: t.wallet.address, coinType: USDC, amount: '1000000000' }] });
  assert.equal((await ret(one.r.withdrawal, 'evt_back_one', back)).status, 200);
  const closed = (await getWithdrawal(t.deps(), one.r.withdrawal.id)).withdrawal;
  assert.equal(closed.status, 'returned');
  assert.equal(closed.returnedMinor, '1000000000');
  // The same return cannot close a second withdrawal.
  assert.equal((await ret(two.r.withdrawal, 'evt_back_two', back)).body.ignored, 'that return was already counted');
  assert.equal((await getWithdrawal(t.deps(), two.r.withdrawal.id)).withdrawal.status, 'failed');

  // A short return is recorded for review, and the withdrawal stays open.
  const short = digest();
  t.chainTxs.set(short, { digest: short, success: true, sender: depositAddress.address, balanceChanges: [{ address: t.wallet.address, coinType: USDC, amount: '999000000' }] });
  const shortAnswer = await ret(two.r.withdrawal, 'evt_short_two', short);
  assert.equal(shortAnswer.status, 200);
  assert.equal(shortAnswer.body.short, true);
  const open2 = (await getWithdrawal(t.deps(), two.r.withdrawal.id)).withdrawal;
  assert.equal(open2.status, 'failed', 'not final: ops must look at a short return');
  assert.equal(open2.returnedMinor, '999000000');
  const trail = await t.w.db.select().from(schema.withdrawalEvents);
  assert.ok(trail.some((e) => e.action === 'return_short' && e.subjectId === two.r.withdrawal.id));
  await t.w.client.close();
});

test('the owners see which bank account they pay, what it receives and by when, and a revoked account cancels its withdrawal', async () => {
  const t = await setup();
  const { destination } = await readyToWithdraw(t);
  const { q, r } = await created(t, destination.id);
  const details = r.request.withdrawal;
  assert.ok(details, 'the request carries the bank account it pays');
  assert.deepEqual([details.bankCode, details.last4, details.holderName, details.currency], ['MBBEMYKL', '5678', 'ACME TRADING SENDIRIAN BERHAD', 'MYR']);
  assert.equal(details.receiveMinor, q.receiveMinor);
  assert.equal(details.minReceiveMinor, q.receiveMinor);
  assert.equal(details.rateMicro, q.rateMicro);
  assert.equal(details.settleByMs, String(T0.getTime() + R.WITHDRAWAL_SIGNING_WINDOW_MS));
  const headline = walletRequestHeadline('withdrawal', r.request.description, details);
  for (const part of ['ending 5678', 'MBBEMYKL', 'ACME TRADING SENDIRIAN BERHAD', 'MYR', 'sign by']) assert.ok(headline.includes(part), `${part} in: ${headline}`);
  const message = walletSignatureMessage({ orgName: 'Acme', purpose: 'withdrawal', description: r.request.description, withdrawal: details, threshold: 2, signerCount: 3, expiresAt: new Date(T0.getTime() + 3600_000), now: T0 });
  assert.ok(message.includes('ending 5678'), message);
  const notice = t.w.notices.at(-1);
  assert.equal(notice.request.summary.withdrawal.last4, '5678', 'the signers are told which account');

  const revoked = await revokeWithdrawalDestination(t.deps(), 'u-founder', destination.id);
  assert.equal(revoked.ok, true);
  assert.equal(revoked.cancelled, 1);
  assert.equal((await getWithdrawal(t.deps(), r.withdrawal.id)).withdrawal.status, 'cancelled');
  assert.equal((await readSigningRequest(t.w.db, 'acme', r.request.id)).status, 'cancelled');
  assert.equal(t.partner.called('returnOrReverse').at(-1).input.reason, 'destination_revoked');
  await t.w.client.close();
});

test('a signature is refused once the bank account behind the withdrawal is no longer the one the bytes commit to', async () => {
  const t = await setup();
  const { destination } = await readyToWithdraw(t);
  const { r } = await created(t, destination.id);
  await t.w.db.update(schema.withdrawalDestinations).set({ beneficiaryRef: hex32() }).where(eq(schema.withdrawalDestinations.id, destination.id));
  const refused = await submitPartialSignature(t.w.signing, { orgId: 'acme', userId: 'u-two', id: r.request.id, signature: await sign(t.w.keys.two, r.request), digest: r.request.digest });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'withdrawal_changed');
  await t.w.client.close();
});

test('a quorum that signs after the quote’s five minutes still settles, and the partner is told the least the account must receive', async () => {
  const t = await setup();
  const { destination } = await readyToWithdraw(t);
  const q = await quoted(t, destination.id);
  const accepted = String(BigInt(q.receiveMinor) - 500n);
  const r = await createWithdrawal(t.deps(), 'u-founder', { clientKey: 'ck_late_sign', destinationId: destination.id, amountMinor: '1000000000', acceptedReceiveMinor: accepted, maxFeeMinor: q.maxFeeMinor, ...bundle() });
  assert.equal(r.ok, true, JSON.stringify(r));
  const [instruction] = t.partner.called('createPayout').map((c) => c.input);
  assert.equal(instruction.minReceiveMinor, BigInt(accepted), 'the partner pays at least what the owners accepted, or returns the USDC');
  assert.equal(instruction.settleByMs, BigInt(T0.getTime() + R.WITHDRAWAL_SIGNING_WINDOW_MS));
  assert.ok(new Date(r.request.expiresAt).getTime() > T0.getTime() + 5 * 60_000, 'the signing window is not the quote’s');
  t.w.setNow(new Date(T0.getTime() + 6 * 60_000));
  await signBoth(t, r.request);
  assert.equal((await getWithdrawal(t.deps(), r.withdrawal.id)).withdrawal.status, 'sent');
  await t.w.client.close();
});

test('the intent id: production names the original package, the derivation is pinned, and a settlement is posted only once the chain shows that intent', async () => {
  const pkg = `0x${'c1'.repeat(32)}`;
  const orig = `0x${'c0'.repeat(32)}`;
  assert.equal(R.corePackageOriginalIdFor({ NODE_ENV: 'production', SPLASH_CORE_PACKAGE_ID: pkg }), null, 'no silent fallback in production');
  assert.equal(R.corePackageOriginalIdFor({ NODE_ENV: 'production', SPLASH_CORE_PACKAGE_ID: pkg, SPLASH_CORE_ORIGINAL_PACKAGE_ID: orig }), orig);
  assert.equal(R.corePackageOriginalIdFor({ NODE_ENV: 'development', SPLASH_CORE_PACKAGE_ID: pkg }), pkg);
  assert.equal(R.corePackageOriginalIdFor({ NODE_ENV: 'development' }), null);
  // The same inputs are pinned in move/splash_core/tests/intent_v2_tests.move
  // against derived_object, with splash_core at the address `sui move test` gives it.
  const MOVE_TEST_CORE = '0xae1fb78a654fde843bcf88836a43aae4d76b6758bd44acb8ee12cc69d60067b7';
  assert.equal(withdrawalIntentId({ accountId: `0x${'ac'.repeat(32)}`, corePackageId: MOVE_TEST_CORE, paymentRef: new Uint8Array(32).fill(9) }), '0xa6c14246e84b60948bd881cfc42f7f361cc5dfffe0bba410e8fe889b755d40a0');

  const t = await setup({ intentEvents: () => [`0x${'99'.repeat(32)}`] });
  const { destination } = await readyToWithdraw(t);
  const { r } = await created(t, destination.id);
  await signBoth(t, r.request);
  const view = (await getWithdrawal(t.deps(), r.withdrawal.id)).withdrawal;
  assert.equal(view.status, 'sent');
  assert.equal(view.settlementPosted, false, 'the partner is not told a digest whose intent is not the one it was instructed for');
  assert.equal(view.settlementHold, 'intent_id_mismatch');
  assert.equal(t.partner.called('postSettlement').length, 0);
  await t.reconcile();
  assert.equal(t.partner.called('postSettlement').length, 0, 'nor by the sweep');
  const trail = await t.w.db.select().from(schema.withdrawalEvents);
  assert.ok(trail.some((e) => e.action === 'intent_id_mismatch'));
  await t.w.client.close();
});

test('reads never call the partner; the sweep posts settlements, reverses lapsed instructions and frees a lapsed test deposit', async () => {
  let down = true;
  const t = await setup({ overrides: { postSettlement: async () => { if (down) throw new Error('partner down'); } } });
  const { destination } = await readyToWithdraw(t);
  const { r } = await created(t, destination.id);
  await signBoth(t, r.request);
  assert.equal((await getWithdrawal(t.deps(), r.withdrawal.id)).withdrawal.settlementPosted, false);
  const calls = t.partner.calls.length;
  await getWithdrawal(t.deps(), r.withdrawal.id);
  await listWithdrawals(t.deps());
  await listWithdrawals(t.deps());
  assert.equal(t.partner.calls.length, calls, 'a GET by any member calls the partner for nothing');
  down = false;
  await t.reconcile();
  assert.deepEqual(t.partner.calls.slice(calls).map((c) => c.name), ['postSettlement', 'status'], 'the sweep retries the post, then asks the partner where the payout is');
  assert.equal((await getWithdrawal(t.deps(), r.withdrawal.id)).withdrawal.settlementPosted, true);
  await t.w.client.close();

  // A test deposit whose request lapsed is freed by the sweep, without a read.
  const t2 = await setup();
  await requestPartnerDepositAddress(t2.deps(), 'u-founder');
  const first = await requestTestDeposit(t2.deps(), 'u-founder');
  await cancelSigningRequest(t2.w.signing, { orgId: 'acme', userId: 'u-founder', id: first.request.id });
  await t2.reconcile();
  const [row] = await t2.w.db.select().from(schema.partnerDepositAddresses);
  assert.equal(row.status, 'pending_test');
  await t2.w.client.close();
});

test('a deposit address is never Splash’s fee recipient, a pending one, the operator or another business’s wallet', async () => {
  const feeRecipient = `0x${'fe'.repeat(32)}`;
  const pending = `0x${'fd'.repeat(32)}`;
  const listed = R.splashControlledAddresses({
    env: { OPERATOR_SUI_ADDRESS: `0x${'0e'.repeat(32)}`, TREASURY_ADDRESS: 'not an address', SPLASH_FINANCE_ADDRESS: `0x${'f1'.repeat(32)}` },
    extra: [`0x${'c7'.repeat(32)}`],
    sponsor: `0x${'5a'.repeat(32)}`,
    feeConfig: { feeRecipient, pendingRecipient: { recipient: pending, etaMs: 1n } },
  });
  for (const a of [feeRecipient, pending, `0x${'0e'.repeat(32)}`, `0x${'5a'.repeat(32)}`, `0x${'f1'.repeat(32)}`, `0x${'c7'.repeat(32)}`]) assert.ok(listed.includes(a), a);
  assert.equal(listed.length, 6);

  const toFee = await setup({ overrides: { depositAddress: async () => ({ address: feeRecipient, network: 'sui', accountRef: 'acct_fee', sandbox: true }) } });
  assert.equal((await requestPartnerDepositAddress(toFee.deps('acme', { splashAddresses: async () => [feeRecipient] }), 'u-founder')).code, 'splash_address');
  assert.equal((await requestPartnerDepositAddress(toFee.deps('acme', { splashAddresses: async () => { throw new Error('FeeConfig unreadable'); } }), 'u-founder')).code, 'splash_addresses_unreadable', 'fails closed');
  assert.equal((await requestPartnerDepositAddress(toFee.deps('acme', { isBusinessWallet: async () => true }), 'u-founder')).code, 'business_wallet');
  await toFee.w.client.close();
});

test('the sandbox partner runs only off mainnet, and an unconfirmed instruction is reversed', async () => {
  for (const env of [{ NODE_ENV: 'development', SUI_NETWORK: 'mainnet' }, { NODE_ENV: 'development', NEXT_PUBLIC_SUI_NETWORK: 'mainnet' }, { NODE_ENV: 'development', SUI_RPC_URL: 'https://fullnode.mainnet.sui.io:443' }]) {
    assert.throws(() => payoutPartner('hata_fiuu', env), (e) => e instanceof PayoutPartnerUnavailable && e.code === 'partner_not_configured', JSON.stringify(env));
  }
  assert.equal(payoutPartner('hata_fiuu', { NODE_ENV: 'development', SUI_NETWORK: 'testnet' }).mode, 'sandbox');

  const t = await setup({ overrides: { createPayout: async () => { throw new Error('timed out'); } } });
  const { destination } = await readyToWithdraw(t);
  const q = await quoted(t, destination.id);
  const r = await createWithdrawal(t.deps(), 'u-founder', { clientKey: 'ck_timeout_1', destinationId: destination.id, amountMinor: '1000000000', acceptedReceiveMinor: q.receiveMinor, maxFeeMinor: q.maxFeeMinor, ...bundle() });
  assert.equal(r.code, 'partner_error');
  const [rev] = t.partner.called('returnOrReverse').map((c) => c.input);
  assert.ok(rev, 'an instruction the partner may have taken is reversed');
  assert.equal(rev.reason, 'instruction_unconfirmed');
  await t.w.client.close();
});

test('the partner can check the on-chain beneficiary commitment against the account it pays', async () => {
  const t = await setup();
  const { destination } = await readyToWithdraw(t);
  await created(t, destination.id);
  const [instruction] = t.partner.called('createPayout').map((c) => c.input);
  assert.match(String(instruction.beneficiarySalt), /^[0-9a-f]{64}$/);
  assert.equal(beneficiaryRefOf('hata_fiuu', instruction.beneficiary, Buffer.from(instruction.beneficiarySalt, 'hex')), instruction.beneficiaryRef);
  await t.w.client.close();
});

test('staff may ask the owners to approve a withdrawal; the owners alone sign it', async () => {
  assert.equal(R.canAskForWithdrawal?.('OWNER'), true);
  assert.equal(R.canAskForWithdrawal('APPROVER'), true);
  assert.equal(R.canAskForWithdrawal('MAKER'), true);
  assert.equal(R.canAskForWithdrawal('VIEWER'), false);
  const t = await setup();
  await t.w.db.insert(schema.users).values({ id: 'u-staff', email: 'staff@acme.test', name: 'u-staff' });
  await t.w.db.insert(schema.memberships).values({ id: 'm-u-staff', userId: 'u-staff', orgId: 'acme', role: 'maker' });
  const { destination } = await readyToWithdraw(t);
  const q = await quoted(t, destination.id);
  const r = await createWithdrawal(t.deps(), 'u-staff', { clientKey: 'ck_staff_ask', destinationId: destination.id, amountMinor: '1000000000', acceptedReceiveMinor: q.receiveMinor, maxFeeMinor: q.maxFeeMinor, ...bundle() });
  assert.equal(r.ok, true, JSON.stringify(r));
  const stored = await readSigningRequest(t.w.db, 'acme', r.request.id);
  assert.equal(stored.requestedBy, 'u-staff');
  assert.deepEqual(stored.signers.map((s) => s.userId).sort(), ['u-founder', 'u-three', 'u-two'], 'the owners sign it');
  await t.w.client.close();
});

test('the account key can be rotated: an account sealed under the previous key still pays, and is sealed again under the new one', async () => {
  const oldKey = toHex(randomBytes(24));
  const newKey = toHex(randomBytes(24));
  const t = await setup({ env: { ...ENV, WITHDRAWAL_ACCOUNT_KEY: oldKey } });
  const { destination } = await readyToWithdraw(t);
  const rotated = { ...ENV, WITHDRAWAL_ACCOUNT_KEY: newKey, WITHDRAWAL_ACCOUNT_KEY_PREVIOUS: oldKey };
  assert.equal(R.accountKeys?.(rotated).all.length, 2);
  const q = await quoted(t, destination.id);
  const r = await createWithdrawal(t.deps('acme', { env: rotated }), 'u-founder', { clientKey: 'ck_rotated_1', destinationId: destination.id, amountMinor: '1000000000', acceptedReceiveMinor: q.receiveMinor, maxFeeMinor: q.maxFeeMinor, ...bundle() });
  assert.equal(r.ok, true, JSON.stringify(r));
  const [row] = await t.w.db.select().from(schema.withdrawalDestinations);
  assert.equal(open(row.accountSealed, accountKey(rotated), destinationAad('acme', row.id, 'account')).toString(), '514012345678', 'sealed again under the new key');
  assert.equal((await addWithdrawalDestination(t.deps('acme', { env: { ...ENV, WITHDRAWAL_ACCOUNT_KEY: newKey } }), 'u-founder', ACME_BANK)).created, false);
  await t.w.client.close();
});

/* ── Review fixes (p2-4.5) ───────────────────────────────────────────── */

test("a business whose registered name has '&' or an accented letter can still withdraw: the message keeps or transliterates it, and says so", async () => {
  for (const [name, holder] of [
    ['Maju & Jaya Sdn Bhd', 'MAJU & JAYA SDN BHD'],
    ['Café Nusantara Sdn Bhd', 'CAFÉ NUSANTARA SDN BHD'],
  ]) {
    const t = await setup();
    await t.w.db.update(schema.organizations).set({ legalName: name }).where(eq(schema.organizations.id, 'acme'));
    const deps = (more = {}) => t.deps('acme', { companyName: async () => name, ...more });
    const added = await addWithdrawalDestination(deps(), 'u-founder', { ...ACME_BANK, holderName: holder });
    assert.equal(added.ok, true, JSON.stringify(added));
    const got = await requestPartnerDepositAddress(deps(), 'u-founder');
    const testDep = await requestTestDeposit(deps(), 'u-founder');
    const testDigest = await signBoth(t, testDep.request);
    t.chainTxs.set(testDigest, { digest: testDigest, success: true, sender: t.wallet.address, balanceChanges: [{ address: got.depositAddress.address, coinType: USDC, amount: String(TEST_DEPOSIT_MINOR) }] });
    const accountRef = (await t.w.db.select().from(schema.partnerDepositAddresses))[0].accountRef;
    assert.equal((await t.webhook({ type: 'test_deposit.received', eventId: `evt_${hex32().slice(0, 12)}`, accountRef, suiDigest: testDigest, occurredAt: T0.toISOString() })).status, 200);
    const q = await quoteWithdrawal(deps(), { destinationId: added.destination.id, amountMinor: '1000000000' });
    assert.equal(q.ok, true, JSON.stringify(q));
    const r = await createWithdrawal(deps(), 'u-founder', { clientKey: `ck_${hex32().slice(0, 16)}`, destinationId: added.destination.id, amountMinor: '1000000000', acceptedReceiveMinor: q.quote.receiveMinor, maxFeeMinor: q.quote.maxFeeMinor, ...bundle() });
    assert.equal(r.ok, true, `${name}: ${JSON.stringify(r)}`);
    const [instruction] = t.partner.called('createPayout').map((c) => c.input);
    const msg = instruction.iso20022.CdtTrfTxInf;
    if (name.includes('&')) {
      assert.equal(msg.Dbtr.Nm, 'Maju & Jaya Sdn Bhd', "'&' is in the CBPR+ extended set and kept");
    } else {
      assert.equal(msg.Dbtr.Nm, 'Cafe Nusantara Sdn Bhd', 'an accented letter is transliterated for the message');
      assert.ok(msg.SplmtryData.transliterated.includes('debtor.name'), 'and the message says which fields were');
      const events = await t.w.db.select().from(schema.withdrawalEvents);
      assert.ok(events.some((e) => e.action === 'iso20022_transliterated'), 'the trail records it');
    }
    await t.w.client.close();
  }
});

test("an owner saves the business's structured registered address with its profile, so a payout's originator is complete", async () => {
  const t = await setup();
  await t.w.db.update(schema.organizations).set({ kybStatus: 'full' }).where(eq(schema.organizations.id, 'acme'));
  const bad = await O.saveBusinessProfileFor(t.w.db, { orgId: 'acme', userId: 'u-founder', role: 'OWNER' }, { ...PROFILE, address: { streetName: 'Jalan Ampang' } });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'bad_address', 'a town is required');
  const saved = await O.saveBusinessProfileFor(t.w.db, { orgId: 'acme', userId: 'u-founder', role: 'OWNER' }, {
    ...PROFILE,
    address: { streetName: '#12-03, Jalan Ampang', buildingName: 'Menara Acme', postCode: '50450', townName: 'Kuala Lumpur', countrySubDivision: 'Wilayah Persekutuan' },
  });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  const [org] = await t.w.db.select().from(schema.organizations).where(eq(schema.organizations.id, 'acme'));
  assert.deepEqual([org.addressLine1, org.addressLine2, org.addressCity, org.addressState, org.addressPostalCode, org.addressCountry], ['#12-03, Jalan Ampang', 'Menara Acme', 'Kuala Lumpur', 'Wilayah Persekutuan', '50450', 'MY']);
  const { debtorFromProfile } = await import('../lib/payments/iso20022.ts');
  const debtor = debtorFromProfile({ ...org, legalName: W.verifiedLegalName(org) });
  assert.deepEqual(debtor.missing, [], JSON.stringify(debtor));
  assert.equal(debtor.party.address.streetName, '#12-03, Jalan Ampang', "'#' is in the CBPR+ extended set");
  assert.equal(debtor.party.address.buildingName, 'Menara Acme');
  const { readFile } = await import('node:fs/promises');
  const route = await readFile(new URL('../app/api/onboarding/profile/route.ts', import.meta.url), 'utf8');
  assert.match(route, /address: z\s*\.object/, 'the profile route takes the structured address');
  await t.w.client.close();
});

/* ── Review of §4.4, 25 Oct 2026 ─────────────────────────────────────── */

test('a partner that sends the USDC straight back, with no failure first, closes the withdrawal as returned, and a short one is left failed for ops', async () => {
  const t = await setup();
  const { destination, depositAddress } = await readyToWithdraw(t);
  const ret = (wd, id, returnDigest) => t.webhook({ type: 'payout.status', eventId: id, partnerRef: wd.partnerRef, intentId: wd.intentId, status: 'returned', returnDigest, occurredAt: T0.toISOString() });

  // Sent, and the partner never said it received it: the return alone, proven on chain, closes it.
  const one = await created(t, destination.id);
  await signBoth(t, one.r.request);
  const back = digest();
  t.chainTxs.set(back, { digest: back, success: true, sender: depositAddress.address, balanceChanges: [{ address: t.wallet.address, coinType: USDC, amount: '1000000000' }] });
  const answer = await ret(one.r.withdrawal, 'evt_direct_back1', back);
  assert.equal(answer.status, 200, JSON.stringify(answer));
  assert.equal(answer.body.ok, true, JSON.stringify(answer.body));
  const closed = (await getWithdrawal(t.deps(), one.r.withdrawal.id)).withdrawal;
  assert.equal(closed.status, 'returned');
  assert.equal(closed.returnDigest, back);
  assert.equal(closed.returnedMinor, '1000000000');
  assert.equal(t.partner.called('returnOrReverse').length, 0, 'the USDC is already back: nothing more is asked of the partner');

  // Received by the partner, then sent back short: failed, with what came back, never returned.
  const two = await created(t, destination.id);
  await signBoth(t, two.r.request);
  assert.equal((await t.webhook({ type: 'payout.status', eventId: 'evt_recv_two', partnerRef: two.r.withdrawal.partnerRef, intentId: two.r.withdrawal.intentId, status: 'funds_received', occurredAt: T0.toISOString() })).status, 200);
  const short = digest();
  t.chainTxs.set(short, { digest: short, success: true, sender: depositAddress.address, balanceChanges: [{ address: t.wallet.address, coinType: USDC, amount: '400000000' }] });
  const shortAnswer = await ret(two.r.withdrawal, 'evt_direct_short', short);
  assert.equal(shortAnswer.body.short, true, JSON.stringify(shortAnswer.body));
  const open2 = (await getWithdrawal(t.deps(), two.r.withdrawal.id)).withdrawal;
  assert.equal(open2.status, 'failed', 'a short return is no payout and no full return: ops look at it');
  assert.equal(open2.returnedMinor, '400000000');
  const trail = await t.w.db.select().from(schema.withdrawalEvents);
  assert.ok(trail.some((e) => e.action === 'return_short' && e.subjectId === two.r.withdrawal.id));
  // A replay of the short return changes nothing.
  await ret(two.r.withdrawal, 'evt_direct_short', short);
  assert.equal((await getWithdrawal(t.deps(), two.r.withdrawal.id)).withdrawal.status, 'failed');

  // A return before the deposit is recorded is retried, never taken; and a
  // return digest that closed one withdrawal closes no other.
  const three = await created(t, destination.id);
  assert.equal((await ret(three.r.withdrawal, 'evt_early_ret', back)).status, 503);
  await signBoth(t, three.r.request);
  assert.equal((await ret(three.r.withdrawal, 'evt_reuse_back', back)).body.ignored, 'that return was already counted');
  assert.equal((await getWithdrawal(t.deps(), three.r.withdrawal.id)).withdrawal.status, 'sent');
  await t.w.client.close();
});

test("a payout the partner's fees would swallow is never quoted or instructed, and the owners never accept a receive amount of nothing", async () => {
  const base = payoutPartner('hata_fiuu', ENV);
  let zero = false;
  const t = await setup({ overrides: { quote: async (input) => ({ ...(await base.quote(input)), ...(zero ? { receiveMinor: 0n } : {}) }) } });
  const { destination } = await readyToWithdraw(t);
  const q = await quoted(t, destination.id);

  // "At least nothing" would let the partner keep the USDC and pay the bank nothing.
  const nothing = await createWithdrawal(t.deps(), 'u-founder', { clientKey: 'ck_nothing01', destinationId: destination.id, amountMinor: '1000000000', acceptedReceiveMinor: '0', maxFeeMinor: q.maxFeeMinor, ...bundle() });
  assert.equal(nothing.ok, false);
  assert.equal(nothing.code, 'nothing_received');
  assert.equal(t.partner.called('createPayout').length, 0, 'nobody was instructed');

  // The partner's fee lines eat the whole amount: no quote, and no withdrawal on an earlier quote.
  zero = true;
  const none = await quoteWithdrawal(t.deps(), { destinationId: destination.id, amountMinor: '1000000000' });
  assert.equal(none.ok, false);
  assert.equal(none.code, 'below_partner_fees');
  const late = await createWithdrawal(t.deps(), 'u-founder', { clientKey: 'ck_swallow01', destinationId: destination.id, amountMinor: '1000000000', acceptedReceiveMinor: '1', maxFeeMinor: q.maxFeeMinor, ...bundle() });
  assert.equal(late.ok, false);
  assert.equal(late.code, 'below_partner_fees');
  assert.equal(t.partner.called('createPayout').length, 0);
  assert.equal((await t.w.db.select().from(schema.withdrawals)).length, 0, 'nothing was stored');

  // The sandbox itself: 0.10 USDC is 44 sen, less than its RM1.00 bank transfer fee.
  const tiny = await quoteWithdrawal({ ...t.deps(), partner: () => base }, { destinationId: destination.id, amountMinor: '100000' });
  assert.equal(tiny.code, 'below_partner_fees', JSON.stringify(tiny));
  await t.w.client.close();
});

test("a bank account is the business's only when the names match letter for letter, whatever the script: letters outside the Latin alphabet are compared, not dropped", async () => {
  const { sameCompany: same, normalizeCompanyName: fold } = await import('../lib/funding/wallet-funding.ts');
  assert.equal(same('ACME 日本 SDN BHD', 'Acme 中文 Sdn. Bhd.'), false, 'two names that differ only in Chinese characters are two names');
  assert.equal(same('Syarikat ابن', 'Syarikat ابو'), false);
  assert.equal(same('株式会社アクメ', '株式会社アクメ'), true, 'a name wholly in another script still matches itself');
  assert.equal(same('ACME TRADING SDN BHD', 'Acme Trading Sdn. Bhd.'), true);
  assert.equal(same('Café Ölüm Sdn Bhd', 'CAFE OLUM SDN BHD'), true, 'accents still fold');
  assert.equal(fold('  PT  Maju & Co. '), 'pt maju and co');

  const t = await setup();
  const deps = { ...t.deps(), companyName: async () => 'Acme 中文 Sdn. Bhd.' };
  const wrong = await addWithdrawalDestination(deps, 'u-founder', { ...ACME_BANK, holderName: 'ACME 日本 SDN BHD' });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.code, 'not_company_name');
  assert.equal((await t.w.db.select().from(schema.withdrawalDestinations)).length, 0, 'nothing about the account was kept');
  const right = await addWithdrawalDestination(deps, 'u-founder', { ...ACME_BANK, holderName: 'ACME 中文 SDN BHD' });
  assert.equal(right.ok, true, JSON.stringify(right));
  await t.w.client.close();
});

/* ── Review of the §4.4 returns, 25 Oct 2026 ─────────────────────────── */

const returnedEvent = (t) => (wd, id, returnDigest) => t.webhook({ type: 'payout.status', eventId: id, partnerRef: wd.partnerRef, intentId: wd.intentId, status: 'returned', returnDigest, occurredAt: T0.toISOString() });
const backTx = (t, d, from, amount, more = {}) => t.chainTxs.set(d, { digest: d, success: true, sender: from, balanceChanges: [{ address: t.wallet.address, coinType: USDC, amount }], ...more });

test('a short return is counted for one withdrawal only, and a return older than the deposit counts for none', async () => {
  const t = await setup();
  const { destination, depositAddress } = await readyToWithdraw(t);
  const ret = returnedEvent(t);
  const a = await created(t, destination.id);
  await signBoth(t, a.r.request);
  const s = digest();
  backTx(t, s, depositAddress.address, '400000000');
  assert.equal((await ret(a.r.withdrawal, 'evt_short_a', s)).body.short, true);

  // Another withdrawal, of exactly what came back, cannot claim the same digest.
  const b = await created(t, destination.id, { amountMinor: '400000000' });
  await signBoth(t, b.r.request);
  const reuse = await ret(b.r.withdrawal, 'evt_reuse_s', s);
  assert.equal(reuse.body.ignored, 'that return was already counted', JSON.stringify(reuse.body));
  assert.equal((await getWithdrawal(t.deps(), b.r.withdrawal.id)).withdrawal.status, 'sent');
  assert.equal((await getWithdrawal(t.deps(), a.r.withdrawal.id)).withdrawal.returnedMinor, '400000000');

  // A transfer from the deposit address that came before this withdrawal's own deposit is no return of it.
  const old = digest();
  backTx(t, old, depositAddress.address, '400000000', { checkpoint: '50' });
  const stale = await ret(b.r.withdrawal, 'evt_stale_old', old);
  assert.match(String(stale.body.ignored), /before/, JSON.stringify(stale.body));
  assert.equal((await getWithdrawal(t.deps(), b.r.withdrawal.id)).withdrawal.status, 'sent');
  await t.w.client.close();
});

test('a return of more than a withdrawal sent closes none of it, and the withdrawal it belongs to still closes', async () => {
  const t = await setup();
  const { destination, depositAddress } = await readyToWithdraw(t);
  const ret = returnedEvent(t);
  const c = await created(t, destination.id);
  await signBoth(t, c.r.request);
  const d = await created(t, destination.id, { amountMinor: '200000000' });
  await signBoth(t, d.r.request);
  const x = digest();
  backTx(t, x, depositAddress.address, '1000000000');
  const wrong = await ret(d.r.withdrawal, 'evt_over_d', x);
  assert.equal(wrong.status, 200);
  assert.match(String(wrong.body.ignored), /more/, JSON.stringify(wrong.body));
  assert.equal((await getWithdrawal(t.deps(), d.r.withdrawal.id)).withdrawal.status, 'sent');
  const trail = await t.w.db.select().from(schema.withdrawalEvents);
  assert.ok(trail.some((e) => e.action === 'return_over' && e.subjectId === d.r.withdrawal.id), 'ops see the over-return');
  const right = await ret(c.r.withdrawal, 'evt_over_c', x);
  assert.equal(right.body.ok, true, JSON.stringify(right.body));
  assert.equal((await getWithdrawal(t.deps(), c.r.withdrawal.id)).withdrawal.status, 'returned');
  await t.w.client.close();
});

test('a short return straight from sent asks the partner for the rest, and short returns add up to close the withdrawal', async () => {
  const t = await setup();
  const { destination, depositAddress } = await readyToWithdraw(t);
  const ret = returnedEvent(t);
  const one = await created(t, destination.id);
  await signBoth(t, one.r.request);
  const s1 = digest();
  backTx(t, s1, depositAddress.address, '400000000');
  assert.equal((await ret(one.r.withdrawal, 'evt_sum_s1', s1)).body.short, true);
  assert.equal(t.partner.called('returnOrReverse').length, 1, 'the rest is asked back');
  const trail = await t.w.db.select().from(schema.withdrawalEvents);
  assert.ok(trail.some((e) => e.action === 'return_requested' && e.subjectId === one.r.withdrawal.id));

  // A replay of the first short return is counted once.
  const again = await ret(one.r.withdrawal, 'evt_sum_s1', s1);
  assert.equal(again.body.duplicate, true, JSON.stringify(again.body));
  const shorts = (await t.w.db.select().from(schema.withdrawalEvents)).filter((e) => e.action === 'return_short' && e.subjectId === one.r.withdrawal.id);
  assert.equal(shorts.length, 1);
  assert.equal(t.partner.called('returnOrReverse').length, 1);

  // The rest comes back: the two add up to the whole, and it closes.
  const s2 = digest();
  backTx(t, s2, depositAddress.address, '600000000');
  const done = await ret(one.r.withdrawal, 'evt_sum_s2', s2);
  assert.equal(done.body.ok, true, JSON.stringify(done.body));
  const closed = (await getWithdrawal(t.deps(), one.r.withdrawal.id)).withdrawal;
  assert.equal(closed.status, 'returned');
  assert.equal(closed.returnedMinor, '1000000000');
  await t.w.client.close();
});

/* ── Review of the §4.4 webhooks, 26 Oct 2026: two events at once ────── */

/**
 * A partner webhook that, while it reads the return from the chain, lets
 * another event land first: the losing delivery of a race. Signed as the
 * sandbox signs; the chain as `setup` models it.
 */
async function racingWebhook(t, body, during) {
  const { sandboxWebhookSecretFor } = await import('../lib/payouts/partner.ts');
  const rawBody = JSON.stringify(body);
  let ran = false;
  return handlePayoutWebhook({
    partner: 'hata_fiuu',
    rawBody,
    signature: signWebhook(rawBody, sandboxWebhookSecretFor(ENV, 'hata_fiuu'), t.w.signing.now()),
    env: ENV,
    now: t.w.signing.now(),
    db: t.w.db,
    readTransaction: async (d) => {
      if (!ran && t.chainTxs.has(d)) {
        ran = true;
        await during();
      }
      let tx = t.chainTxs.get(d) ?? null;
      if (!tx) {
        const [row] = await t.w.db.select().from(schema.withdrawals).where(eq(schema.withdrawals.suiDigest, d));
        tx = row ? { digest: d, success: true, sender: row.walletAddress, balanceChanges: [] } : null;
      }
      if (!tx) return null;
      return 'checkpoint' in tx ? tx : { ...tx, checkpoint: t.chainTxs.has(d) ? '200' : '100' };
    },
    usdcType: USDC,
    adapter: t.partner,
  });
}

test("a return that lands while a failure is being recorded is counted against the payout as it then stands, never lost: it closes the withdrawal", async () => {
  const t = await setup();
  const { destination, depositAddress } = await readyToWithdraw(t);
  const one = await created(t, destination.id);
  await signBoth(t, one.r.request);
  const wd = one.r.withdrawal;
  const back = digest();
  backTx(t, back, depositAddress.address, '1000000000');
  const returned = { type: 'payout.status', eventId: 'evt_race_ret', partnerRef: wd.partnerRef, intentId: wd.intentId, status: 'returned', returnDigest: back, occurredAt: T0.toISOString() };

  // The failure lands while the return is read from the chain.
  const first = await racingWebhook(t, returned, async () => {
    const failed = await t.webhook({ type: 'payout.status', eventId: 'evt_race_fail', partnerRef: wd.partnerRef, intentId: wd.intentId, status: 'failed', failureReason: 'account closed', occurredAt: T0.toISOString() });
    assert.equal(failed.status, 200, JSON.stringify(failed));
  });
  // The return is counted against the payout as it stands once locked (failed now), so it closes it at once.
  assert.equal(first.status, 200, JSON.stringify(first));
  assert.equal(first.body.ok, true, JSON.stringify(first.body));
  // A retry of the same event moves nothing (the withdrawal is already returned).
  const retry = await t.webhook(returned);
  assert.equal(retry.status, 200, JSON.stringify(retry));
  assert.ok(retry.body.duplicate === true || /does not move/.test(String(retry.body.ignored)), JSON.stringify(retry.body));
  const closed = (await getWithdrawal(t.deps(), wd.id)).withdrawal;
  assert.equal(closed.status, 'returned');
  assert.equal(closed.returnedMinor, '1000000000');
  // The sweep no longer asks for USDC that is already back.
  const asksBefore = t.partner.called('returnOrReverse').length;
  const swept = await t.reconcile();
  assert.equal(swept.returnsAsked, 0, JSON.stringify(swept));
  assert.equal(t.partner.called('returnOrReverse').length, asksBefore);
  await t.w.client.close();
});

test("a short return that lands while the payout moves is counted against the payout as it then stands, and what came back is kept on the withdrawal", async () => {
  const t = await setup();
  const { destination, depositAddress } = await readyToWithdraw(t);
  const one = await created(t, destination.id);
  await signBoth(t, one.r.request);
  const wd = one.r.withdrawal;
  const s = digest();
  backTx(t, s, depositAddress.address, '400000000');
  const shortEvent = { type: 'payout.status', eventId: 'evt_race_short', partnerRef: wd.partnerRef, intentId: wd.intentId, status: 'returned', returnDigest: s, occurredAt: T0.toISOString() };

  // The partner's "received" lands while the short return is read from the chain.
  const first = await racingWebhook(t, shortEvent, async () => {
    const recv = await t.webhook({ type: 'payout.status', eventId: 'evt_race_recv', partnerRef: wd.partnerRef, intentId: wd.intentId, status: 'funds_received', occurredAt: T0.toISOString() });
    assert.equal(recv.status, 200, JSON.stringify(recv));
  });
  // Read against the payout as it stands once locked (partner_received now): short, so failed, with what came back.
  assert.equal(first.status, 200, JSON.stringify(first));
  assert.equal(first.body.short, true, JSON.stringify(first.body));
  const retry = await t.webhook(shortEvent);
  assert.equal(retry.body.duplicate, true, JSON.stringify(retry.body));
  const after = (await getWithdrawal(t.deps(), wd.id)).withdrawal;
  assert.equal(after.status, 'failed');
  assert.equal(after.returnedMinor, '400000000');
  const shorts = (await t.w.db.select().from(schema.withdrawalEvents)).filter((e) => e.action === 'return_short' && e.subjectId === wd.id);
  assert.equal(shorts.length, 1, 'the losing delivery recorded no short return');
  await t.w.client.close();
});

test('a bank account removed while its withdrawal is being instructed leaves no live instruction and no request to sign', async () => {
  const base = payoutPartner('hata_fiuu', ENV);
  let revokeDuring = null;
  const t = await setup({
    overrides: {
      createPayout: async (input) => {
        // An owner removes the bank account while the partner is being instructed.
        if (revokeDuring) await revokeDuring();
        return base.createPayout(input);
      },
    },
  });
  const { destination } = await readyToWithdraw(t);
  const q = await quoted(t, destination.id);
  revokeDuring = async () => {
    revokeDuring = null;
    const revoked = await revokeWithdrawalDestination(t.deps(), 'u-two', destination.id);
    assert.equal(revoked.ok, true, JSON.stringify(revoked));
  };
  const r = await createWithdrawal(t.deps(), 'u-founder', { clientKey: 'ck_revoke_mid', destinationId: destination.id, amountMinor: '1000000000', acceptedReceiveMinor: q.receiveMinor, maxFeeMinor: q.maxFeeMinor, ...bundle() });
  assert.equal(r.ok, false, `the withdrawal was cancelled under it: ${JSON.stringify(r)}`);
  assert.equal(r.code, 'withdrawal_cancelled');
  const [row] = await t.w.db.select().from(schema.withdrawals);
  assert.equal(row.status, 'cancelled');
  assert.ok(row.partnerRef, 'the partner took the instruction');
  // The instruction the partner took after the cancel is reversed.
  const reversals = t.partner.called('returnOrReverse').filter((c) => c.input.partnerRef === row.partnerRef);
  assert.equal(reversals.length, 1, 'the instruction taken after the cancel is reversed');
  // And no owners' request is left open to sign.
  const open = (await t.w.db.select().from(schema.walletSigningRequests)).filter((s) => s.purpose === 'withdrawal' && s.status === 'collecting');
  assert.equal(open.length, 0, 'no request is left for the owners to sign');
  await t.w.client.close();
});

/* ── Review of the §4.4 webhooks, 26 Oct 2026 (second pass): returns at once ── */

const failedEvent = (t, wd, id) => t.webhook({ type: 'payout.status', eventId: id, partnerRef: wd.partnerRef, intentId: wd.intentId, status: 'failed', failureReason: 'account closed', occurredAt: T0.toISOString() });

test('two returns that add up and land at once close the withdrawal once, and neither digest can close another payout', async () => {
  const t = await setup();
  const { destination, depositAddress } = await readyToWithdraw(t);
  const ret = returnedEvent(t);
  const one = await created(t, destination.id);
  await signBoth(t, one.r.request);
  assert.equal((await failedEvent(t, one.r.withdrawal, 'evt_conc_fail')).status, 200);
  const a = digest();
  const b = digest();
  backTx(t, a, depositAddress.address, '400000000');
  backTx(t, b, depositAddress.address, '600000000');
  const answers = await Promise.all([ret(one.r.withdrawal, 'evt_conc_a', a), ret(one.r.withdrawal, 'evt_conc_b', b)]);
  // Whatever the order, a delivery that did not count is retried by the partner.
  for (const [i, ans] of answers.entries()) {
    if (ans.status !== 200) {
      const again = await ret(one.r.withdrawal, i === 0 ? 'evt_conc_a' : 'evt_conc_b', i === 0 ? a : b);
      assert.equal(again.status, 200, JSON.stringify(again));
    }
  }
  const closed = (await getWithdrawal(t.deps(), one.r.withdrawal.id)).withdrawal;
  assert.equal(closed.status, 'returned');
  assert.equal(closed.returnedMinor, '1000000000');
  const claims = (await t.w.db.select().from(schema.withdrawalReturns)).filter((c) => c.withdrawalId === one.r.withdrawal.id);
  assert.deepEqual(claims.map((c) => c.creditedMinor).sort(), [400000000n, 600000000n], 'both returns are held by the payout they closed');

  // A second payout to the same deposit address fails; neither digest closes it.
  const two = await created(t, destination.id, { amountMinor: '600000000' });
  await signBoth(t, two.r.request);
  assert.equal((await failedEvent(t, two.r.withdrawal, 'evt_conc_fail2')).status, 200);
  for (const [id, d] of [['evt_conc_reuse_b', b], ['evt_conc_reuse_a', a]]) {
    const reuse = await ret(two.r.withdrawal, id, d);
    assert.equal(reuse.body.ignored, 'that return was already counted', JSON.stringify(reuse.body));
  }
  assert.equal((await getWithdrawal(t.deps(), two.r.withdrawal.id)).withdrawal.status, 'failed');
  await t.w.client.close();
});

test('short returns that land at once on a failed withdrawal keep what came back in full, and the rest still closes it', async () => {
  const t = await setup();
  const { destination, depositAddress } = await readyToWithdraw(t);
  const ret = returnedEvent(t);
  const one = await created(t, destination.id);
  await signBoth(t, one.r.request);
  assert.equal((await failedEvent(t, one.r.withdrawal, 'evt_cs_fail')).status, 200);
  const parts = [digest(), digest(), digest()];
  parts.forEach((d, i) => backTx(t, d, depositAddress.address, ['200000000', '300000000', '100000000'][i]));
  const answers = await Promise.all(parts.map((d, i) => ret(one.r.withdrawal, `evt_cs_${i}`, d)));
  assert.ok(answers.every((x) => x.status === 200 && x.body.short === true), JSON.stringify(answers.map((x) => x.body)));
  let row = (await getWithdrawal(t.deps(), one.r.withdrawal.id)).withdrawal;
  assert.equal(row.status, 'failed');
  assert.equal(row.returnedMinor, '600000000', 'the three short returns add up on the row');

  const rest = digest();
  backTx(t, rest, depositAddress.address, '400000000');
  const done = await ret(one.r.withdrawal, 'evt_cs_rest', rest);
  assert.equal(done.body.ok, true, JSON.stringify(done.body));
  row = (await getWithdrawal(t.deps(), one.r.withdrawal.id)).withdrawal;
  assert.equal(row.status, 'returned');
  assert.equal(row.returnedMinor, '1000000000');
  await t.w.client.close();
});

test('a short return and the return that completes it land at once: the close is never overwritten by the short one', async () => {
  const t = await setup();
  const { destination, depositAddress } = await readyToWithdraw(t);
  const ret = returnedEvent(t);
  const one = await created(t, destination.id);
  await signBoth(t, one.r.request);
  assert.equal((await failedEvent(t, one.r.withdrawal, 'evt_ov_fail')).status, 200);
  const first = digest();
  backTx(t, first, depositAddress.address, '300000000');
  assert.equal((await ret(one.r.withdrawal, 'evt_ov_first', first)).body.short, true);
  const x = digest();
  const y = digest();
  backTx(t, x, depositAddress.address, '300000000');
  backTx(t, y, depositAddress.address, '400000000');
  await Promise.all([ret(one.r.withdrawal, 'evt_ov_x', x), ret(one.r.withdrawal, 'evt_ov_y', y)]);
  const row = (await getWithdrawal(t.deps(), one.r.withdrawal.id)).withdrawal;
  assert.equal(row.status, 'returned');
  assert.equal(row.returnedMinor, '1000000000', 'the short patch did not land over the close');
  await t.w.client.close();
});

/**
 * The database as one delivery sees it: its first write to a withdrawal row
 * waits until `before` has run (another delivery landing in between).
 */
function writeWaits(db, before) {
  let fired = false;
  const delayed = (obj) =>
    new Proxy(obj, {
      get(o, p) {
        if (p === 'then') {
          return (res, rej) => (fired ? Promise.resolve() : ((fired = true), before())).then(() => o.then(res, rej), rej);
        }
        const v = o[p];
        return typeof v === 'function' ? (...args) => { const r = v.apply(o, args); return r && typeof r === 'object' ? delayed(r) : r; } : v;
      },
    });
  return new Proxy(db, {
    get(o, p) {
      if (p === 'update') return (table) => (table === schema.withdrawals && !fired ? delayed(o.update(table)) : o.update(table));
      const v = o[p];
      return typeof v === 'function' ? v.bind(o) : v;
    },
  });
}

test('a short return on a failed withdrawal whose write lands after the return that closed it does not undo the close', async () => {
  const t = await setup();
  const { destination, depositAddress } = await readyToWithdraw(t);
  const ret = returnedEvent(t);
  const one = await created(t, destination.id);
  await signBoth(t, one.r.request);
  assert.equal((await failedEvent(t, one.r.withdrawal, 'evt_late_fail')).status, 200);
  const a = digest();
  const b = digest();
  backTx(t, a, depositAddress.address, '400000000');
  backTx(t, b, depositAddress.address, '600000000');
  const real = t.w.db;
  let bAnswer = null;
  const runB = async () => {
    bAnswer = await ret(one.r.withdrawal, 'evt_late_b', b);
  };
  t.w.db = writeWaits(real, runB);
  const aPromise = ret(one.r.withdrawal, 'evt_late_a', a);
  t.w.db = real;
  const aAnswer = await aPromise;
  if (!bAnswer) await runB();
  for (const [ans, id, d] of [[aAnswer, 'evt_late_a', a], [bAnswer, 'evt_late_b', b]]) {
    if (ans.status !== 200) assert.equal((await ret(one.r.withdrawal, id, d)).status, 200);
  }
  const row = (await getWithdrawal(t.deps(), one.r.withdrawal.id)).withdrawal;
  assert.equal(row.status, 'returned');
  assert.equal(row.returnedMinor, '1000000000', 'the short write did not land over the close');
  await t.w.client.close();
});

/* ── Reversals still owed for a cancelled payout ─────────────────────── */

test('a reversal the partner did not take when a withdrawal was cancelled under it is asked again by the sweep until taken, and ops are told when it sticks', async () => {
  const base = payoutPartner('hata_fiuu', ENV);
  let revokeDuring = null;
  let refuseReversals = 0;
  const t = await setup({
    overrides: {
      createPayout: async (input) => {
        if (revokeDuring) await revokeDuring();
        return base.createPayout(input);
      },
      returnOrReverse: async (input) => {
        if (refuseReversals > 0) {
          refuseReversals -= 1;
          throw new Error('partner timed out');
        }
        return base.returnOrReverse(input);
      },
    },
  });
  const { destination } = await readyToWithdraw(t);
  const q = await quoted(t, destination.id);
  revokeDuring = async () => {
    revokeDuring = null;
    assert.equal((await revokeWithdrawalDestination(t.deps(), 'u-two', destination.id)).ok, true);
  };
  refuseReversals = R_ASKS();
  const r = await createWithdrawal(t.deps(), 'u-founder', { clientKey: 'ck_rev_owed', destinationId: destination.id, amountMinor: '1000000000', acceptedReceiveMinor: q.receiveMinor, maxFeeMinor: q.maxFeeMinor, ...bundle() });
  assert.equal(r.code, 'withdrawal_cancelled', JSON.stringify(r));
  const [row] = await t.w.db.select().from(schema.withdrawals);
  const reversalsOf = () => t.partner.called('returnOrReverse').filter((c) => c.input.partnerRef === row.partnerRef).length;
  assert.equal(reversalsOf(), 1);

  // The sweep asks again while the partner keeps timing out, and ops are alerted once it sticks.
  const errors = [];
  const origError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    for (let i = 1; i < R_ASKS(); i += 1) {
      const swept = await t.reconcile();
      assert.equal(swept.reversalsAsked, 1, JSON.stringify(swept));
      assert.equal(swept.reversalsPending, 1, JSON.stringify(swept));
    }
  } finally {
    console.error = origError;
  }
  assert.equal(reversalsOf(), R_ASKS());
  const trail = await t.w.db.select().from(schema.withdrawalEvents);
  assert.equal(trail.filter((e) => e.action === 'reversal_request_stuck' && e.subjectId === row.id).length, 1, 'ops see the stuck reversal');
  assert.ok(errors.some((e) => e.includes('ALERT') && e.includes(row.id) && !e.includes('5140')), 'an ops alert names the payout and nothing about the account');

  // Once ops are alerted the sweep backs off: the next run does not ask, the reversal is still owed.
  const held = await t.reconcile();
  assert.equal(held.reversalsAsked, 0, JSON.stringify(held));
  assert.equal(held.reversalsPending, 1, JSON.stringify(held));
  assert.equal(reversalsOf(), R_ASKS());
  const delay = W.reversalReaskDelayMs(R_ASKS());
  assert.ok(delay > 0 && delay <= W.REVERSAL_REASK_MAX_MS, String(delay));
  assert.ok(W.reversalReaskDelayMs(R_ASKS() + 1) > delay, 'each ask after the alert waits longer');
  assert.equal(W.reversalReaskDelayMs(R_ASKS() + 40), W.REVERSAL_REASK_MAX_MS, 'up to a cap: never given up');
  assert.equal(W.reversalReaskDelayMs(1), 0, 'before the alert, every run asks');
  t.w.setNow(new Date(t.w.signing.now().getTime() + delay));

  // The partner takes it: recorded, and never asked again.
  const swept = await t.reconcile();
  assert.equal(swept.reversalsAsked, 1);
  assert.equal(swept.reversalsPending, 0);
  const [after] = await t.w.db.select().from(schema.withdrawals);
  assert.ok(after.returnAcceptedAt, 'the accepted reversal is kept on the row');
  assert.equal(after.status, 'cancelled');
  const n = reversalsOf();
  assert.equal((await t.reconcile()).reversalsAsked, 0);
  assert.equal(reversalsOf(), n);
  await t.w.client.close();
});

test('a bank account removed while the owners\' request is being opened closes that request and reverses the instruction once', async () => {
  const t = await setup();
  const { destination } = await readyToWithdraw(t);
  const q = await quoted(t, destination.id);
  // An owner removes the bank account while the owners' request is being built (its gas is fetched).
  const sponsor = t.w.ctx.signing.sponsor;
  const gasFor = sponsor.gasFor;
  sponsor.gasFor = async (...args) => {
    sponsor.gasFor = gasFor;
    assert.equal((await revokeWithdrawalDestination(t.deps(), 'u-two', destination.id)).ok, true);
    return gasFor.apply(sponsor, args);
  };
  const r = await createWithdrawal(t.deps(), 'u-founder', { clientKey: 'ck_revoke_open', destinationId: destination.id, amountMinor: '1000000000', acceptedReceiveMinor: q.receiveMinor, maxFeeMinor: q.maxFeeMinor, ...bundle() });
  sponsor.gasFor = gasFor;
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.code, 'withdrawal_cancelled', JSON.stringify(r));
  const [row] = await t.w.db.select().from(schema.withdrawals);
  assert.equal(row.status, 'cancelled');
  const requests = (await t.w.db.select().from(schema.walletSigningRequests)).filter((s) => s.purpose === 'withdrawal');
  assert.equal(requests.length, 1, 'the request was opened');
  assert.equal(requests[0].status, 'cancelled', 'and closed before anyone signed it');
  const reversals = t.partner.called('returnOrReverse').filter((c) => c.input.partnerRef === row.partnerRef);
  assert.equal(reversals.length, 1, 'the instruction is reversed once, not once per path that saw it');
  assert.ok(row.returnAcceptedAt, 'and the partner taking it is kept');
  const trail = (await t.w.db.select().from(schema.withdrawalEvents)).filter((e) => e.subjectId === row.id);
  assert.ok(trail.some((e) => e.action === 'cancelled'), JSON.stringify(trail.map((e) => e.action)));
  assert.equal((await t.reconcile()).reversalsAsked, 0, 'nothing is owed');
  await t.w.client.close();
});

function R_ASKS() {
  return W.RETURN_ASKS_BEFORE_ALERT;
}

test('an instruction whose answer was lost, and whose reversal the partner did not take, is reversed by its intent id by the sweep until taken', async () => {
  const base = payoutPartner('hata_fiuu', ENV);
  let refuseReversals = 0;
  const t = await setup({
    overrides: {
      // The partner takes the instruction, and its answer is lost.
      createPayout: async (input) => {
        await base.createPayout(input);
        throw new Error('timed out');
      },
      returnOrReverse: async (input) => {
        if (refuseReversals > 0) {
          refuseReversals -= 1;
          throw new Error('partner timed out');
        }
        return base.returnOrReverse(input);
      },
    },
  });
  const { destination } = await readyToWithdraw(t);
  const q = await quoted(t, destination.id);
  refuseReversals = 2;
  const r = await createWithdrawal(t.deps(), 'u-founder', { clientKey: 'ck_lost_answer', destinationId: destination.id, amountMinor: '1000000000', acceptedReceiveMinor: q.receiveMinor, maxFeeMinor: q.maxFeeMinor, ...bundle() });
  assert.equal(r.code, 'partner_error', JSON.stringify(r));
  const [row] = await t.w.db.select().from(schema.withdrawals);
  assert.equal(row.status, 'cancelled');
  assert.equal(row.partnerRef, null, 'no reference came back');
  assert.equal(row.returnAcceptedAt, null, 'the reversal was not taken');
  const reversalsOf = () => t.partner.called('returnOrReverse').filter((c) => c.input.intentId === row.intentId);
  assert.equal(reversalsOf().length, 1);
  assert.equal(reversalsOf()[0].input.partnerRef, '', 'asked by the intent id alone');
  assert.equal(reversalsOf()[0].input.returnAddress, row.walletAddress);

  // The sweep asks again, by the intent id, while the partner still does not take it.
  let swept = await t.reconcile();
  assert.equal(swept.reversalsAsked, 1, JSON.stringify(swept));
  assert.equal(swept.reversalsPending, 1, JSON.stringify(swept));
  assert.equal(reversalsOf().length, 2);
  assert.ok(reversalsOf().every((c) => c.input.partnerRef === '' && c.input.reason === 'instruction_unconfirmed'), JSON.stringify(reversalsOf().map((c) => c.input.reason)));

  // Taken: kept on the row, and never asked again.
  swept = await t.reconcile();
  assert.equal(swept.reversalsAsked, 1);
  assert.equal(swept.reversalsPending, 0);
  const [after] = await t.w.db.select().from(schema.withdrawals);
  assert.ok(after.returnAcceptedAt, 'the accepted reversal is kept on the row');
  assert.equal(after.status, 'cancelled');
  assert.equal((await t.reconcile()).reversalsAsked, 0);
  assert.equal(reversalsOf().length, 3);
  await t.w.client.close();

  // A payout refused before any instruction was sent owes no reversal.
  const t2 = await setup({ overrides: { createPayout: async () => { throw new PayoutPartnerUnavailable('switched off', 'partner_disabled'); } } });
  const d2 = (await readyToWithdraw(t2)).destination;
  const q2 = await quoted(t2, d2.id);
  const r2 = await createWithdrawal(t2.deps(), 'u-founder', { clientKey: 'ck_refused_first', destinationId: d2.id, amountMinor: '1000000000', acceptedReceiveMinor: q2.receiveMinor, maxFeeMinor: q2.maxFeeMinor, ...bundle() });
  assert.equal(r2.code, 'partner_disabled', JSON.stringify(r2));
  assert.equal(t2.partner.called('returnOrReverse').length, 0);
  assert.equal((await t2.reconcile()).reversalsAsked, 0);
  await t2.w.client.close();
});

test('an instruction still in flight when its reversal by intent id lands is refused when it arrives, and a partner that says it holds nothing is recorded as saying so', async () => {
  const base = payoutPartner('hata_fiuu', ENV);
  let inFlight = null;
  let notFound = 0;
  const t = await setup({
    overrides: {
      // The instruction has not reached the partner yet: the answer is lost on the way out.
      createPayout: async (input) => {
        inFlight = input;
        throw new Error('timed out');
      },
      returnOrReverse: async (input) => {
        if (notFound > 0) {
          notFound -= 1;
          throw new PayoutPartnerUnavailable('no such payout', 'payout_not_found');
        }
        return base.returnOrReverse(input);
      },
    },
  });
  const { destination } = await readyToWithdraw(t);
  const q = await quoted(t, destination.id);
  notFound = 1;
  const r = await createWithdrawal(t.deps(), 'u-founder', { clientKey: 'ck_in_flight', destinationId: destination.id, amountMinor: '1000000000', acceptedReceiveMinor: q.receiveMinor, maxFeeMinor: q.maxFeeMinor, ...bundle() });
  assert.equal(r.code, 'partner_error', JSON.stringify(r));
  const [row] = await t.w.db.select().from(schema.withdrawals);
  const trail = async () => (await t.w.db.select().from(schema.withdrawalEvents)).filter((e) => e.subjectId === row.id && e.action === 'instruction_reversed');
  assert.equal((await trail())[0].detail.accepted, false);
  assert.equal((await trail())[0].detail.answer, 'payout_not_found', 'what the partner said is kept for ops');

  // The sweep asks again; the sandbox keeps the reversal against the intent id.
  const swept = await t.reconcile();
  assert.equal(swept.reversalsAsked, 1, JSON.stringify(swept));
  assert.equal(swept.reversalsPending, 0, JSON.stringify(swept));
  const calls = t.partner.called('returnOrReverse');
  assert.ok(calls.every((c) => c.input.returnAddress === row.walletAddress && c.input.intentId === row.intentId), 'every reversal goes back to the business wallet on the row');

  // The delayed instruction arrives at the partner after the reversal: refused, never live.
  assert.ok(inFlight);
  await assert.rejects(base.createPayout(inFlight), (e) => e instanceof PayoutPartnerUnavailable && e.code === 'instruction_conflict');
  await t.w.client.close();
});

test('a lost answer whose one reversal failed before the sweep counted it is picked up by the backfill migration, and one that was taken is left alone', async () => {
  const { readFileSync } = await import('node:fs');
  const base = payoutPartner('hata_fiuu', ENV);
  let refuse = true;
  const t = await setup({
    overrides: {
      createPayout: async () => { throw new Error('timed out'); },
      // The first payout's one reversal fails; the second's is taken.
      returnOrReverse: async (input) => {
        if (refuse) {
          refuse = false;
          throw new Error('partner timed out');
        }
        return base.returnOrReverse(input);
      },
    },
  });
  const { destination } = await readyToWithdraw(t);
  const ids = [];
  for (const ck of ['ck_legacy_failed', 'ck_legacy_taken']) {
    const q = await quoted(t, destination.id);
    const r = await createWithdrawal(t.deps(), 'u-founder', { clientKey: ck, destinationId: destination.id, amountMinor: '1000000000', acceptedReceiveMinor: q.receiveMinor, maxFeeMinor: q.maxFeeMinor, ...bundle() });
    assert.equal(r.code, 'partner_error', JSON.stringify(r));
    const [row] = (await t.w.db.select().from(schema.withdrawals)).filter((w) => w.clientKey === ck);
    ids.push(row.id);
  }
  // As the rows were left before the reversal was counted: failure partner_error and nothing counted (the event trail is append-only, so its one instruction_reversed event each stays).
  await t.w.db.update(schema.withdrawals).set({ failure: 'partner_error', returnAsks: 0, returnAskedAt: null, returnAcceptedAt: null });
  const reversedEvents = (await t.w.db.select().from(schema.withdrawalEvents)).filter((e) => e.action === 'instruction_reversed');
  assert.deepEqual(ids.map((id) => reversedEvents.filter((e) => e.subjectId === id).map((e) => e.detail.accepted)), [[false], [true]]);
  assert.equal((await t.reconcile()).reversalsAsked, 0, 'before the backfill neither is asked again');
  const sql = readFileSync(new URL('../drizzle/0055_lost_answer_reversal_backfill.sql', import.meta.url), 'utf8');
  for (const part of sql.split('--> statement-breakpoint')) if (part.trim()) await t.w.client.exec(part);
  const rows = await t.w.db.select().from(schema.withdrawals);
  assert.equal(rows.find((w) => w.id === ids[0]).returnAsks, 1, 'the failed reversal is counted');
  assert.equal(rows.find((w) => w.id === ids[1]).returnAsks, 0, 'the taken one owes nothing');
  const swept = await t.reconcile();
  assert.equal(swept.reversalsAsked, 1, JSON.stringify(swept));
  const asked = t.partner.called('returnOrReverse').at(-1).input;
  assert.equal(asked.intentId, rows.find((w) => w.id === ids[0]).intentId);
  assert.equal(asked.partnerRef, '');
  // Running it again changes nothing.
  for (const part of sql.split('--> statement-breakpoint')) if (part.trim()) await t.w.client.exec(part);
  assert.equal((await t.reconcile()).reversalsAsked, 0);
  await t.w.client.close();
});
