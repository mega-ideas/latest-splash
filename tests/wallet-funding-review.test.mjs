/**
 * "Add funds" (v2 §4.3), the independent review's findings as regressions.
 *
 * Each test is one finding, reproduced: it failed before the fix.
 *   1. A CCTP mint credits only what Circle minted, to the wallet the burn
 *      names, from exactly one MessageReceived; anything else in the same
 *      transaction is the sender's, screened as the sender's.
 *   2. Holds fail closed: every transaction touching the wallet is read
 *      (the deposit watcher), and USDC the watcher has not accounted for is
 *      withheld like held USDC.
 *   3. Holds follow the business across a wallet rotation, and the owners'
 *      second approval is not built over held funds.
 *   4. No sandbox webhook without a configured, random secret and the
 *      sandbox flag; the sandbox order reference is not the intent id's hash.
 *   5. A top-up is "arrived" only when cleared USDC covers what it promised.
 *   6. A partner delivery comes from the partner's own Sui address.
 *   7. A bank account's fingerprint is keyed (HMAC), and partners report the
 *      account itself, not Splash's hash.
 *   8. Circle's event is recognised by its type's original package, through
 *      an upgrade or a wrapper.
 *   9. The accepted quote is required where rates move; USDT variants get the
 *      peg guard; slippage is part of the idempotent request.
 *  10. Source changes leave an append-only trail; a revoked source can be
 *      added again, pending fresh proof.
 *  11. With Elliptic and Chainalysis both configured, a Chainalysis CLEAR is
 *      not a verdict; its BLOCK still blocks.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

import { eq } from 'drizzle-orm';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { fromBase58, normalizeStructTag, normalizeSuiAddress, toBase58, toBase64, toHex } from '@mysten/sui/utils';

import { migratedDb } from './helpers/store-db.mjs';
import { softPasskey } from './fixtures/soft-passkey.mjs';
import * as schema from '../lib/db/schema.ts';
import { kytProviderFromEnv } from '../lib/compliance/kyt.ts';
import { bankAccountIdentity } from '../lib/funding/wallet-funding.ts';
import { sandboxWebhookSecret, signWebhook } from '../lib/funding/providers.ts';
import { CCTP_SUI_MESSAGE_TRANSMITTER } from '../lib/payments/cctp.ts';
import { parseRate } from '../lib/money.ts';
import { buildBusinessMultisig } from '../lib/wallet/business-multisig.ts';
import { requestWalletPayment } from '../lib/server/business-wallet.ts';
import {
  addFundingSource,
  createFundingIntent,
  getFundingIntent,
  handleProviderWebhook,
  listWalletDeposits,
  recordDeposit,
  revokeFundingSource,
  syncWalletDeposits,
  verifyWalletSource,
  walletFundsWithheld,
  walletSourceChallenge,
} from '../lib/server/wallet-funding.ts';

const USDC = normalizeStructTag('0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN');
const USDT = normalizeStructTag('0x375f70cf2ae4c00bf37117d0c85a2c71545e6ee05c4a5c7d282cd66a4504b068::usdt::USDT');
const ACME_WALLET = normalizeSuiAddress(`0x${'a1'.repeat(32)}`);
const ACME_NEW_WALLET = normalizeSuiAddress(`0x${'a2'.repeat(32)}`);
const OPERATOR = normalizeSuiAddress(`0x${'0e'.repeat(32)}`);
const STRIPE_SENDER = normalizeSuiAddress(`0x${'57'.repeat(30)}c1ea`);
const TRANSMITTER = CCTP_SUI_MESSAGE_TRANSMITTER.testnet;
/** Circle's TokenMessengerMinter on testnet: the package whose module emits MessageReceived (read from a real mint, 25 Oct 2026). */
const TOKEN_MESSENGER = '0x267d3c0cb776eace2840f27e4d33da9c6d952f9749403f1fe6579f4962ed3c64';
const T0 = new Date('2026-10-25T08:00:00Z');
const FP_KEY = 'f'.repeat(16) + toHex(randomBytes(16));
const SANDBOX_SECRET = toHex(randomBytes(32));

const ENV = {
  NODE_ENV: 'test',
  FUNDING_SOURCE_FINGERPRINT_KEY: FP_KEY,
  FUNDING_SANDBOX_WEBHOOKS_ENABLED: 'true',
  FUNDING_SANDBOX_WEBHOOK_SECRET: SANDBOX_SECRET,
  FUNDING_PROVIDER_STRIPE_SUI_SENDERS: STRIPE_SENDER,
};

const digest = () => toBase58(randomBytes(32));
const clearAddr = () => normalizeSuiAddress(`0x${toHex(randomBytes(30))}c1ea`);
const deadAddr = () => normalizeSuiAddress(`0x${toHex(randomBytes(30))}dead`);
const beefAddr = () => normalizeSuiAddress(`0x${toHex(randomBytes(30))}beef`);

async function world({ env = ENV } = {}) {
  const { db } = await migratedDb();
  await db.update(schema.organizations).set({ legalName: 'Acme Trading Sdn. Bhd.' }).where(eq(schema.organizations.id, 'acme'));
  const chain = new Map();
  /** Every digest that touched each address, oldest first: what the indexer lists. */
  const touched = new Map();
  let clock = T0;
  const wallets = { acme: ACME_WALLET, northwind: normalizeSuiAddress(`0x${'b2'.repeat(32)}`) };
  const earlier = { acme: [], northwind: [] };
  let indexerLag = 0;
  const deps = (orgId, overrides = {}) => ({
    db,
    orgId,
    env,
    now: () => clock,
    network: 'testnet',
    readWallet: async () => wallets[orgId],
    readTransaction: async (d) => chain.get(d) ?? null,
    listWalletDigests: async (address, after) => {
      const all = touched.get(normalizeSuiAddress(address)) ?? [];
      const visible = all.slice(0, Math.max(0, all.length - indexerLag));
      const start = after === null ? 0 : visible.indexOf(after) + 1;
      const page = visible.slice(start, start + 2);
      return { digests: page, cursor: page.length ? page[page.length - 1] : after, hasMore: start + 2 < visible.length };
    },
    earlierWallets: async () => earlier[orgId],
    kyt: kytProviderFromEnv({ NODE_ENV: 'test' }, { now: () => clock }),
    companyName: async () => (orgId === 'acme' ? 'Acme Trading Sdn. Bhd.' : 'Northwind Pte Ltd'),
    coinTypes: { USDC, USDT, USDSUI: null },
    splashAddresses: [OPERATOR],
    signedPartners: new Set(),
    bookReader: async () => ({ pair: 'USDT_USDC', bid: parseRate('0.9998'), ask: parseRate('1.0002'), mid: parseRate('1'), deviationBps: 0n, source: 'deepbook', asOf: clock.toISOString() }),
    ...overrides,
  });
  const record = (tx) => {
    chain.set(tx.digest, tx);
    for (const a of new Set(tx.balanceChanges.map((b) => normalizeSuiAddress(b.address)))) {
      touched.set(a, [...(touched.get(a) ?? []), tx.digest]);
    }
    return tx.digest;
  };
  /** A transaction moving `amount` of `coinType` from `sender` to `to`, plus anything in `extra`. */
  const deliver = ({ to = ACME_WALLET, amount = 1_000_000n, coinType = USDC, sender = clearAddr(), events = [], extra = [] } = {}) =>
    record({
      digest: digest(),
      success: true,
      sender,
      timestampMs: clock.getTime(),
      balanceChanges: [{ address: to, coinType, amount: String(amount) }, { address: sender, coinType, amount: String(-amount) }, ...extra],
      events,
    });
  return {
    db,
    chain,
    deps,
    deliver,
    record,
    wallets,
    earlier,
    setIndexerLag: (n) => { indexerLag = n; },
    advance: (ms) => { clock = new Date(clock.getTime() + ms); },
    now: () => clock,
  };
}

async function provenSolanaWallet(w) {
  const kp = new Ed25519Keypair();
  const address = toBase58(kp.getPublicKey().toRawBytes());
  const added = await addFundingSource(w.deps('acme'), 'u-owner', { kind: 'wallet', chain: 'SOLANA', address });
  assert.equal(added.ok, true, JSON.stringify(added));
  const ch = await walletSourceChallenge(w.deps('acme'), added.source.id);
  const sig = await kp.sign(new TextEncoder().encode(ch.challenge.message));
  const v = await verifyWalletSource(w.deps('acme'), { userId: 'u-owner', sourceId: added.source.id, challengeId: ch.challenge.id, signature: toBase58(sig) });
  assert.equal(v.ok, true, JSON.stringify(v));
  return { address, kp, source: v.source };
}

/** Circle's BurnMessageV2 body: version, burnToken, mintRecipient, amount, messageSender, maxFee, feeExecuted, expirationBlock. */
function burnBody({ sender32, recipient, amount, feeExecuted = 0n }) {
  const body = new Uint8Array(228);
  new DataView(body.buffer).setUint32(0, 1, false);
  body.set(Buffer.from(recipient.slice(2), 'hex'), 36);
  body.set(Buffer.from(amount.toString(16).padStart(64, '0'), 'hex'), 68);
  body.set(Buffer.from(sender32.slice(2), 'hex'), 100);
  body.set(Buffer.from(feeExecuted.toString(16).padStart(64, '0'), 'hex'), 164);
  return body;
}

/** A Solana address as CCTP's bytes32 messageSender. */
const solanaSender32 = (address) => `0x${toHex(fromBase58(address))}`;

/** The event as Sui reports it: emitted by Circle's TokenMessengerMinter module, typed by the transmitter's original package. */
function circleEvent(body, { domain = 5, packageId = TOKEN_MESSENGER, typePackage = TRANSMITTER } = {}) {
  return { packageId, eventType: `${typePackage}::receive_message::MessageReceived`, json: { source_domain: domain, message_body: toBase64(body) } };
}

/* 1 ── CCTP ───────────────────────────────────────────────────────────── */

test('a CCTP mint credits only what Circle minted; extra USDC in the same transaction is the sender’s, screened as the sender’s', async () => {
  const w = await world();
  const { address } = await provenSolanaWallet(w);
  const body = burnBody({ sender32: solanaSender32(address), recipient: ACME_WALLET, amount: 1_000_000n });
  // The attacker relays the business's 1 USDC mint and adds 1,000,000 USDC of their own.
  const attacker = deadAddr();
  const d = w.deliver({ sender: attacker, amount: 1_000_001_000_000n, events: [circleEvent(body)] });
  const r = await recordDeposit(w.deps('acme'), { digest: d });
  assert.equal(r.ok, true, JSON.stringify(r));
  const byChannel = Object.fromEntries(r.deposits.map((x) => [x.channel, x]));
  assert.equal(byChannel.cctp.amountMinor, '1000000', 'the CCTP line is the minted amount');
  assert.equal(byChannel.cctp.status, 'cleared');
  assert.equal(byChannel.wallet.amountMinor, '1000000000000', 'the rest is a separate deposit');
  assert.equal(byChannel.wallet.originAddress, attacker);
  assert.equal(byChannel.wallet.status, 'blocked', 'screened against the sender, a sanctions hit');
  // Reported twice: the same two rows.
  const again = await recordDeposit(w.deps('acme'), { digest: d });
  assert.equal(again.deposits.length, 2);
  assert.equal((await listWalletDeposits(w.deps('acme'))).length, 2);
});

test('a burn naming another recipient, or two mints in one transaction, credits no burner', async () => {
  const w = await world();
  const { address } = await provenSolanaWallet(w);
  const elsewhere = normalizeSuiAddress(`0x${'cd'.repeat(32)}`);
  const other = burnBody({ sender32: solanaSender32(address), recipient: elsewhere, amount: 5_000_000n });
  const sender = beefAddr();
  const r1 = await recordDeposit(w.deps('acme'), { digest: w.deliver({ sender, amount: 5_000_000n, events: [circleEvent(other)] }) });
  assert.equal(r1.deposits.length, 1);
  assert.equal(r1.deposits[0].channel, 'wallet', JSON.stringify(r1.deposits[0]));
  assert.equal(r1.deposits[0].originAddress, sender);
  assert.equal(r1.deposits[0].status, 'held');

  const mine = burnBody({ sender32: solanaSender32(address), recipient: ACME_WALLET, amount: 5_000_000n });
  const r2 = await recordDeposit(w.deps('acme'), { digest: w.deliver({ sender, amount: 10_000_000n, events: [circleEvent(mine), circleEvent(mine)] }) });
  assert.ok(r2.deposits.every((x) => x.channel !== 'cctp' || x.status !== 'cleared'), JSON.stringify(r2.deposits));
  assert.ok(r2.deposits.every((x) => x.status !== 'cleared'), 'nothing clears on an ambiguous mint');
});

test('the CCTP fee Circle took is not credited: the mint is amount less feeExecuted', async () => {
  const w = await world();
  const { address } = await provenSolanaWallet(w);
  const body = burnBody({ sender32: solanaSender32(address), recipient: ACME_WALLET, amount: 10_000_000n, feeExecuted: 1_000n });
  const r = await recordDeposit(w.deps('acme'), { digest: w.deliver({ amount: 9_999_000n, events: [circleEvent(body)] }) });
  assert.equal(r.deposits.length, 1);
  assert.equal(r.deposits[0].channel, 'cctp');
  assert.equal(r.deposits[0].amountMinor, '9999000');
  assert.equal(r.deposits[0].status, 'cleared');
});

/* 8 ── Circle's event, through an upgrade or a wrapper ────────────────── */

test("Circle's event is Circle's by its type's package, whoever's module emitted it; another type is not", async () => {
  const w = await world();
  const { address } = await provenSolanaWallet(w);
  const body = burnBody({ sender32: solanaSender32(address), recipient: ACME_WALLET, amount: 2_000_000n });
  const upgraded = await recordDeposit(w.deps('acme'), { digest: w.deliver({ amount: 2_000_000n, events: [circleEvent(body, { packageId: `0x${'77'.repeat(32)}` })] }) });
  assert.equal(upgraded.deposits[0].channel, 'cctp', 'an upgraded or wrapping package still emits the original type');
  assert.equal(upgraded.deposits[0].status, 'cleared');
  const forged = await recordDeposit(w.deps('acme'), { digest: w.deliver({ amount: 2_000_000n, events: [circleEvent(body, { packageId: TRANSMITTER, typePackage: `0x${'99'.repeat(32)}` })] }) });
  assert.equal(forged.deposits[0].channel, 'wallet', 'a look-alike type from another package is not Circle’s');
});

/* 2 ── Holds fail closed ──────────────────────────────────────────────── */

test('a deposit nobody reports is found by the watcher, screened and held, and unaccounted USDC is withheld', async () => {
  const w = await world();
  w.deliver({ sender: beefAddr(), amount: 50_000_000n });
  w.deliver({ sender: clearAddr(), amount: 30_000_000n });
  // Nobody posted either digest. Spending reads what is withheld first.
  const withheld = await walletFundsWithheld(w.deps('acme'), 80_000_000n);
  assert.equal(withheld.ok, true, JSON.stringify(withheld));
  assert.equal(withheld.heldMinor, '80000000', 'both found and held: one for review, one from no known source');
  assert.equal(withheld.unreconciledMinor, '0');
  const deposits = await listWalletDeposits(w.deps('acme'));
  assert.equal(deposits.length, 2);
  assert.ok(deposits.every((d) => d.status === 'held'));

  // The indexer has not caught up with a third arrival the balance already shows: withheld until it does.
  w.setIndexerLag(1);
  w.deliver({ sender: clearAddr(), amount: 5_000_000n });
  const lagging = await walletFundsWithheld(w.deps('acme'), 85_000_000n);
  assert.equal(lagging.unreconciledMinor, '5000000');
  assert.equal(lagging.withheldMinor, '85000000');

  // Money that left is accounted too: after an outflow of 20, nothing is unaccounted.
  w.setIndexerLag(0);
  w.record({ digest: digest(), success: true, sender: ACME_WALLET, timestampMs: 1, balanceChanges: [{ address: ACME_WALLET, coinType: USDC, amount: '-20000000' }, { address: clearAddr(), coinType: USDC, amount: '20000000' }], events: [] });
  const after = await walletFundsWithheld(w.deps('acme'), 65_000_000n);
  assert.equal(after.unreconciledMinor, '0');

  // The watcher cannot read the chain: nothing is assumed spendable.
  const down = await walletFundsWithheld(w.deps('acme', { listWalletDigests: async () => { throw new Error('indexer down'); } }), 65_000_000n);
  assert.equal(down.ok, false);
  assert.equal(down.code, 'deposits_unreadable');
});

test('a sync runs once per transaction, however many times it is called at once', async () => {
  const w = await world();
  for (let i = 0; i < 5; i++) w.deliver({ amount: 1_000_000n });
  const runs = await Promise.all([1, 2, 3].map(() => syncWalletDeposits(w.deps('acme'))));
  assert.ok(runs.every((r) => r.ok), JSON.stringify(runs));
  assert.equal((await listWalletDeposits(w.deps('acme'))).length, 5);
  const [row] = await w.db.select().from(schema.walletDepositSync).where(eq(schema.walletDepositSync.orgId, 'acme'));
  assert.equal(row.netUsdcMinor, 5_000_000n, 'each transaction counted once');
});

test('a wallet payment passes the balance it read to the holds, so an arrival in between is not spendable', async () => {
  const members = [softPasskey(), softPasskey()].map((p, i) => ({ userId: `u-${i}`, publicKey: p.publicKey }));
  const ms = buildBusinessMultisig({ members });
  const wallet = { multisigPublicKey: ms.multisigPublicKey, members: ms.members.map((m) => ({ userId: m.userId, publicKey: m.suiPublicKey, weight: m.weight })) };
  const seen = [];
  const ctx = { heldUsdc: async (address, balance) => { seen.push(balance); return balance; }, readUsdc: async () => ({ coinMinor: 60n, addressBalanceMinor: 40n }), signing: { sponsor: null }, chain: {}, account: {} };
  const r = await requestWalletPayment(ctx, { orgId: 'acme', requestedBy: 'u-0', wallet, payment: { amountMinor: 1n, maxFeeMinor: 0n } });
  assert.equal(r.code, 'funds_on_hold');
  assert.deepEqual(seen, [100n]);
});

/* 3 ── Rotation ───────────────────────────────────────────────────────── */

test('holds follow the business to its new wallet, and the rotation transfer is not a new deposit', async () => {
  const w = await world();
  const held = await recordDeposit(w.deps('acme'), { digest: w.deliver({ sender: clearAddr(), amount: 40_000_000n }) });
  assert.equal(held.deposits[0].status, 'held');
  // Rotated: the account names a new wallet, and the old one moves everything over.
  w.wallets.acme = ACME_NEW_WALLET;
  w.earlier.acme = [ACME_WALLET];
  const move = w.deliver({ to: ACME_NEW_WALLET, sender: ACME_WALLET, amount: 40_000_000n });
  assert.equal((await recordDeposit(w.deps('acme'), { digest: move })).code, 'own_wallet_transfer');
  const withheld = await walletFundsWithheld(w.deps('acme'), 40_000_000n);
  assert.equal(withheld.ok, true, JSON.stringify(withheld));
  assert.equal(withheld.withheldMinor, '40000000', 'the held 40 is still held at the new address');
  assert.equal((await listWalletDeposits(w.deps('acme'))).length, 1, 'the rotation transfer is no deposit');
});

/* 4 ── Sandbox webhooks ───────────────────────────────────────────────── */

test('no sandbox webhook without a configured secret and the sandbox flag; the public string signs nothing', async () => {
  assert.equal(sandboxWebhookSecret({ NODE_ENV: 'test' }), '', 'no fallback secret');
  assert.equal(sandboxWebhookSecret({ NODE_ENV: 'test', FUNDING_SANDBOX_WEBHOOK_SECRET: SANDBOX_SECRET }), '', 'no flag, no sandbox webhooks');
  assert.equal(sandboxWebhookSecret({ NODE_ENV: 'test', FUNDING_SANDBOX_WEBHOOKS_ENABLED: 'true', FUNDING_SANDBOX_WEBHOOK_SECRET: 'short' }), '', 'a guessable secret is no secret');
  assert.equal(sandboxWebhookSecret(ENV), SANDBOX_SECRET);

  const w = await world({ env: { ...ENV, FUNDING_SANDBOX_WEBHOOK_SECRET: undefined } });
  const intent = await createFundingIntent(w.deps('acme'), { channel: 'provider', provider: 'stripe', method: 'bank', amount: '10', userId: 'u', clientKey: 'k-sbx-000001', acceptedArrivesMinMinor: '10000000' });
  assert.equal(intent.ok, true, JSON.stringify(intent));
  const ref = intent.intent.instructions.next.reference;
  const { createHash } = await import('node:crypto');
  assert.notEqual(ref, `sb_stripe_${createHash('sha256').update(intent.intent.id).digest('hex').slice(0, 20)}`, 'the order reference is not derivable from the intent id');
  const raw = JSON.stringify({ eventId: 'evt_sbx_0001', providerRef: ref, intentId: intent.intent.id, status: 'delivered', suiDigest: w.deliver({ sender: STRIPE_SENDER, amount: 1n }), occurredAt: T0.toISOString() });
  const res = await handleProviderWebhook({ provider: 'stripe', rawBody: raw, signature: signWebhook(raw, 'splash-sandbox-funding-webhook', w.now()), env: w.deps('acme').env, now: w.now(), db: w.db }, async (o) => w.deps(o));
  assert.equal(res.status, 401, JSON.stringify(res));
  assert.equal((await getFundingIntent(w.deps('acme'), intent.intent.id)).intent.status, 'provider_pending');
});

/* 5 ── "Arrived" means covered ────────────────────────────────────────── */

test('a dust or held deposit does not make a top-up arrived; cleared USDC that covers it does', async () => {
  const w = await world();
  const intent = await createFundingIntent(w.deps('acme'), { channel: 'wallet', amount: '10000', userId: 'u', clientKey: 'k-dust-00001', purpose: 'transfer_top_up', transferRef: 'tr_dust_01' });
  assert.equal(intent.ok, true, JSON.stringify(intent));
  await recordDeposit(w.deps('acme'), { digest: w.deliver({ sender: beefAddr(), amount: 1n }), intentId: intent.intent.id });
  let now = (await getFundingIntent(w.deps('acme'), intent.intent.id)).intent;
  assert.equal(now.status, 'arriving', JSON.stringify(now));
  assert.equal(now.progress.clearedMinor, '0');
  assert.equal(now.progress.heldMinor, '1');

  const kp = new Ed25519Keypair();
  const sui = kp.getPublicKey().toSuiAddress();
  const added = await addFundingSource(w.deps('acme'), 'u-owner', { kind: 'wallet', chain: 'SUI', address: sui });
  const ch = await walletSourceChallenge(w.deps('acme'), added.source.id);
  const { signature } = await kp.signPersonalMessage(new TextEncoder().encode(ch.challenge.message));
  await verifyWalletSource(w.deps('acme'), { userId: 'u-owner', sourceId: added.source.id, challengeId: ch.challenge.id, signature });
  await recordDeposit(w.deps('acme'), { digest: w.deliver({ sender: sui, amount: 9_999_000_000n }), intentId: intent.intent.id });
  now = (await getFundingIntent(w.deps('acme'), intent.intent.id)).intent;
  assert.equal(now.status, 'arriving', 'cleared 9,999 does not cover 10,000');
  await recordDeposit(w.deps('acme'), { digest: w.deliver({ sender: sui, amount: 1_000_000n }), intentId: intent.intent.id });
  now = (await getFundingIntent(w.deps('acme'), intent.intent.id)).intent;
  assert.equal(now.status, 'arrived');
  assert.equal(now.progress.clearedMinor, '10000000000');
});

/* 6 ── Partner deliveries come from the partner ───────────────────────── */

async function stripeWorld() {
  const w = await world();
  const bank = { holderName: 'Acme Trading Sdn Bhd', country: 'MY', bankCode: 'MBBEMYKL', accountNumber: '514012345678' };
  const src = await addFundingSource(w.deps('acme'), 'u-owner', { kind: 'bank_account', ...bank });
  assert.equal(src.ok, true, JSON.stringify(src));
  const intent = await createFundingIntent(w.deps('acme'), { channel: 'provider', provider: 'stripe', method: 'bank', amount: '250', userId: 'u', clientKey: 'k-pin-000001', sourceId: src.source.id, acceptedArrivesMinMinor: '250000000' });
  assert.equal(intent.ok, true, JSON.stringify(intent));
  const send = async (body) => {
    const raw = JSON.stringify(body);
    return handleProviderWebhook({ provider: 'stripe', rawBody: raw, signature: signWebhook(raw, SANDBOX_SECRET, w.now()), env: ENV, now: w.now(), db: w.db }, async (o) => w.deps(o));
  };
  const payer = { kind: 'bank_account', country: 'MY', bankCode: 'MBBEMYKL', accountNumber: '5140-1234-5678', holderName: 'ACME TRADING SDN. BHD.', last4: '5678' };
  return { ...w, bank, src, intent: intent.intent, ref: intent.intent.instructions.next.reference, send, payer };
}

test("a partner delivery must come from the partner's own Sui address, and cover the order, before it is re-read as the partner's", async () => {
  const w = await stripeWorld();
  // A third party's clear-screened transfer, recorded first as source unknown.
  const d = w.deliver({ sender: clearAddr(), amount: 250_000_000n });
  assert.deepEqual((await recordDeposit(w.deps('acme'), { digest: d })).deposits[0].holdReasons, ['source_unknown']);
  const r = await w.send({ eventId: 'evt_pin_0001', providerRef: w.ref, intentId: w.intent.id, status: 'delivered', suiDigest: d, payer: w.payer, occurredAt: w.now().toISOString() });
  assert.equal(r.status, 200);
  assert.equal(r.body.code, 'not_partner_delivery', JSON.stringify(r));
  const [dep] = await listWalletDeposits(w.deps('acme'));
  assert.equal(dep.status, 'held', 'not re-attributed');
  assert.equal(dep.intentId, null);

  // From the partner, but short of the order: recorded, not cleared into "arrived".
  const short = w.deliver({ sender: STRIPE_SENDER, amount: 1_000_000n });
  assert.deepEqual((await w.send({ eventId: 'evt_pin_0002', providerRef: w.ref, intentId: w.intent.id, status: 'delivered', suiDigest: short, payer: w.payer, occurredAt: w.now().toISOString() })).body, { ok: true });
  assert.ok((await listWalletDeposits(w.deps('acme'))).some((x) => x.digest === short && x.intentId === w.intent.id), 'the short delivery is recorded for the top-up');
  assert.equal((await getFundingIntent(w.deps('acme'), w.intent.id)).intent.status, 'arriving');

  // From the partner, covering it, with the account the business added: cleared and arrived.
  const full = w.deliver({ sender: STRIPE_SENDER, amount: 250_000_000n });
  const ok = await w.send({ eventId: 'evt_pin_0003', providerRef: w.ref, intentId: w.intent.id, status: 'delivered', suiDigest: full, payer: w.payer, occurredAt: w.now().toISOString() });
  assert.equal(ok.status, 200, JSON.stringify(ok));
  const fullDep = (await listWalletDeposits(w.deps('acme'))).find((x) => x.digest === full);
  assert.equal(fullDep.status, 'cleared', JSON.stringify(fullDep));
  assert.equal(fullDep.sourceId, w.src.source.id);
  assert.equal((await getFundingIntent(w.deps('acme'), w.intent.id)).intent.status, 'arrived');
});

test('a user report naming a partner top-up is held to the same rule', async () => {
  const w = await stripeWorld();
  const r = await recordDeposit(w.deps('acme'), { digest: w.deliver({ sender: clearAddr(), amount: 250_000_000n }), intentId: w.intent.id });
  assert.equal(r.code, 'not_partner_delivery');
});

/* 7 ── Keyed bank fingerprints ────────────────────────────────────────── */

test('a bank fingerprint is an HMAC under a server key: no key, no bank account', async () => {
  const { createHash } = await import('node:crypto');
  const input = { country: 'MY', bankCode: 'MBBEMYKL', accountNumber: '514012345678' };
  const keyed = bankAccountIdentity(input, FP_KEY);
  assert.notEqual(keyed.fingerprint, createHash('sha256').update('bank:MY:MBBEMYKL:514012345678').digest('hex'));
  assert.notEqual(keyed.fingerprint, bankAccountIdentity(input, 'another-key-another-key-another-key').fingerprint);
  assert.throws(() => bankAccountIdentity(input, ''), /key/);
  const w = await world({ env: { ...ENV, FUNDING_SOURCE_FINGERPRINT_KEY: undefined } });
  const r = await addFundingSource(w.deps('acme'), 'u-owner', { kind: 'bank_account', holderName: 'Acme Trading Sdn Bhd', ...input });
  assert.equal(r.code, 'fingerprint_key_missing');
});

test('after a key rotation an account added under the previous key still matches', async () => {
  const w = await world();
  const bank = { holderName: 'Acme Trading Sdn Bhd', country: 'MY', bankCode: 'MBBEMYKL', accountNumber: '514012345678' };
  const first = await addFundingSource(w.deps('acme'), 'u-owner', { kind: 'bank_account', ...bank });
  const rotated = { ...ENV, FUNDING_SOURCE_FINGERPRINT_KEY: 'n'.repeat(40), FUNDING_SOURCE_FINGERPRINT_KEY_PREVIOUS: FP_KEY };
  const again = await addFundingSource(w.deps('acme', { env: rotated }), 'u-owner', { kind: 'bank_account', ...bank });
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(again.source.id, first.source.id, 'the same account, found under the previous key');
});

/* 9 ── Quotes ─────────────────────────────────────────────────────────── */

test('where the rate moves, the accepted quote is required; USDT variants get the peg guard; slippage is part of the request', async () => {
  const w = await world();
  assert.equal((await createFundingIntent(w.deps('acme'), { channel: 'provider', provider: 'stripe', method: 'bank', amount: '10', userId: 'u', clientKey: 'k-acc-000001' })).code, 'accepted_quote_required');
  assert.equal((await createFundingIntent(w.deps('acme'), { channel: 'swap', route: 'lifi', sourceChain: 'ETHEREUM', fromToken: 'WETH', fromDecimals: 18, amountIn: '1000000000000000000', userId: 'u', clientKey: 'k-acc-000002' })).code, 'accepted_quote_required');
  assert.equal((await createFundingIntent(w.deps('acme'), { channel: 'wallet', asset: 'USDT', amount: '10', userId: 'u', clientKey: 'k-acc-000003' })).code, 'accepted_quote_required');
  // Plain USDC needs none: what is sent is what arrives.
  assert.equal((await createFundingIntent(w.deps('acme'), { channel: 'wallet', amount: '10', userId: 'u', clientKey: 'k-acc-000004' })).ok, true);

  const off = async () => ({ pair: 'USDT_USDC', bid: parseRate('0.99'), ask: parseRate('1'), mid: parseRate('0.995'), deviationBps: 50n, source: 'deepbook', asOf: '' });
  for (const fromToken of ['USDT0', 'USDT.e', 'USDt0', 'axlUSDT']) {
    const q = await createFundingIntent(w.deps('acme', { bookReader: off }), { channel: 'swap', route: 'debridge', sourceChain: 'ETHEREUM', fromToken, fromDecimals: 6, amountIn: '50000000', userId: 'u', clientKey: `k-peg-${fromToken.replace(/\W/g, '')}-01`, acceptedArrivesMinMinor: '1' });
    assert.equal(q.code, 'off_peg', fromToken);
  }

  const ask = { channel: 'swap', route: 'lifi', sourceChain: 'ETHEREUM', fromToken: 'WETH', fromDecimals: 18, amountIn: '1000000000000000000', userId: 'u', clientKey: 'k-slip-00001', acceptedArrivesMinMinor: '1', slippageBps: 50 };
  assert.equal((await createFundingIntent(w.deps('acme'), ask)).ok, true);
  assert.equal((await createFundingIntent(w.deps('acme'), { ...ask, slippageBps: 300 })).code, 'idempotency_key_reused');
});

/* 10 ── The trail, and adding a source back ───────────────────────────── */

test('adding, proving and revoking a source leaves an append-only trail; a revoked source can be added again, pending', async () => {
  const w = await world();
  const { source } = await provenSolanaWallet(w);
  await revokeFundingSource(w.deps('acme'), source.id, 'u-owner');
  const trail = await w.db.select().from(schema.fundingSourceEvents).where(eq(schema.fundingSourceEvents.orgId, 'acme'));
  assert.deepEqual(trail.map((e) => e.action).sort(), ['added', 'revoked', 'verified']);
  const verified = trail.find((e) => e.action === 'verified');
  assert.match(verified.evidenceSha256 ?? '', /^[0-9a-f]{64}$/);
  assert.equal(verified.actorUserId, 'u-owner');
  await assert.rejects(w.db.update(schema.fundingSourceEvents).set({ action: 'x' }), (e) => /append-only/.test(String(e?.cause?.message ?? e?.message)));

  const back = await addFundingSource(w.deps('acme'), 'u-owner', { kind: 'wallet', chain: 'SOLANA', address: source.address });
  assert.equal(back.ok, true, JSON.stringify(back));
  assert.equal(back.created, true);
  assert.notEqual(back.source.id, source.id);
  assert.equal(back.source.status, 'pending', 'it needs fresh proof');
});

/* 11 ── Screening precedence ──────────────────────────────────────────── */

test('with Elliptic contracted, a Chainalysis CLEAR is not a verdict, and its BLOCK still blocks', async () => {
  const prod = { NODE_ENV: 'production', ELLIPTIC_API_KEY: 'k', ELLIPTIC_API_SECRET: 's', CHAINALYSIS_SANCTIONS_API_KEY: 'c' };
  const clear = async () => new Response(JSON.stringify({ identifications: [] }), { status: 200 });
  const hit = async () => new Response(JSON.stringify({ identifications: [{ name: 'SDN' }] }), { status: 200 });
  const a = await kytProviderFromEnv(prod, { fetcher: clear }).screen({ chain: 'SUI', address: clearAddr(), direction: 'deposit' });
  assert.equal(a.verdict, null, JSON.stringify(a));
  const b = await kytProviderFromEnv(prod, { fetcher: hit }).screen({ chain: 'SUI', address: clearAddr(), direction: 'deposit' });
  assert.equal(b.verdict, 'BLOCK');
});
