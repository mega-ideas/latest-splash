/**
 * "Add funds" into the Business Splash Wallet (v2 §4.3).
 *
 * PGlite with every migration, a model chain (digest → what the transaction
 * delivered), the sandbox screening provider and real Ed25519 signatures for
 * wallet proofs. Nothing reaches a network.
 *
 * What must hold:
 *   - funds go to the business wallet the chain names, never to an address
 *     Splash controls, and never to anything the request says;
 *   - the quote comes first; a fresh quote worse than the accepted one is
 *     refused, not taken; USDT / USDsui convert only on their peg;
 *   - a top-up is idempotent by the client's key and by the partner's order;
 *   - what arrived is read from the chain, once per transaction and coin;
 *   - every deposit is screened; one from an unverified or unknown source,
 *     unscreened, or failing its source's first-use check is held, a
 *     sanctions hit blocked, and Splash builds no payment spending held funds;
 *   - a source is checked once on first use; a wallet is proven by a
 *     single-use signed message;
 *   - partner webhooks are signed, inside a replay window, counted once, and
 *     never move a status backwards;
 *   - another business's ids read as absent everywhere;
 *   - production without credentials refuses; no sandbox answer reaches it.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

import { eq } from 'drizzle-orm';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { normalizeStructTag, normalizeSuiAddress, toBase58, toBase64, toHex } from '@mysten/sui/utils';

import { migratedDb } from './helpers/store-db.mjs';
import { softPasskey } from './fixtures/soft-passkey.mjs';
import * as schema from '../lib/db/schema.ts';
import { kytProviderFromEnv } from '../lib/compliance/kyt.ts';
import { decideDeposit, canAdvanceIntent, canMoveDeposit, sameCompany, normalizeCompanyName, spendableAfterHolds, walletProofMessage } from '../lib/funding/wallet-funding.ts';
import { fundingProvider, sandboxWebhookSecret, signWebhook, verifySignedWebhook, FundingProviderUnavailable, WEBHOOK_TOLERANCE_SECONDS } from '../lib/funding/providers.ts';
import { swapRoute, SwapRouteUnavailable } from '../lib/funding/swap-routes.ts';
import { CCTP_SUI_MESSAGE_TRANSMITTER, decodeBurnMessageV2, burnerAddress } from '../lib/payments/cctp.ts';
import { quoteConversion, executeConversion, CONVERSION_PEG_TOLERANCE_BPS } from '../lib/server/funding-conversion.ts';
import { parseRate } from '../lib/money.ts';
import { buildBusinessMultisig } from '../lib/wallet/business-multisig.ts';
import { requestWalletPayment } from '../lib/server/business-wallet.ts';
import { heldUsdcMinor } from '../lib/server/wallet-funding-store.ts';
import {
  addFundingSource,
  cancelFundingIntent,
  createFundingIntent,
  fundingDestination,
  fundingOptions,
  getFundingIntent,
  handleProviderWebhook,
  listFundingIntents,
  listWalletDeposits,
  quoteFunding,
  recheckDeposit,
  recordDeposit,
  revokeFundingSource,
  verifyWalletSource,
  walletSourceChallenge,
} from '../lib/server/wallet-funding.ts';

const USDC = normalizeStructTag('0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN');
const USDT = normalizeStructTag('0x375f70cf2ae4c00bf37117d0c85a2c71545e6ee05c4a5c7d282cd66a4504b068::usdt::USDT');
const USDSUI = normalizeStructTag('0x44f838219cf67b058f3b37907b655f226153c18e33dfcd0da559a844fea9b1c1::usdsui::USDSUI');
const ACME_WALLET = normalizeSuiAddress(`0x${'a1'.repeat(32)}`);
const NORTH_WALLET = normalizeSuiAddress(`0x${'b2'.repeat(32)}`);
const OPERATOR = normalizeSuiAddress(`0x${'0e'.repeat(32)}`);
/** The partner's own Sui delivery address (screens clear in the sandbox). */
const STRIPE_SENDER = normalizeSuiAddress(`0x${'57'.repeat(30)}c1ea`);
const T0 = new Date('2026-10-25T08:00:00Z');
const FP_KEY = toHex(randomBytes(24));
const SANDBOX_SECRET = toHex(randomBytes(32));
/** The test server: a fingerprint key, sandbox webhooks on with a random secret, the partner's sending address. */
const ENV = { NODE_ENV: 'test', FUNDING_SOURCE_FINGERPRINT_KEY: FP_KEY, FUNDING_SANDBOX_WEBHOOKS_ENABLED: 'true', FUNDING_SANDBOX_WEBHOOK_SECRET: SANDBOX_SECRET, FUNDING_PROVIDER_STRIPE_SUI_SENDERS: STRIPE_SENDER };

const digest = () => toBase58(randomBytes(32));
/** An address the sandbox screens as clear / a sanctions hit / needing review. */
const clearAddr = () => normalizeSuiAddress(`0x${toHex(randomBytes(30))}c1ea`);
const deadAddr = () => normalizeSuiAddress(`0x${toHex(randomBytes(30))}dead`);
const beefAddr = () => normalizeSuiAddress(`0x${toHex(randomBytes(30))}beef`);

async function world() {
  const { db } = await migratedDb();
  await db.update(schema.organizations).set({ legalName: 'Acme Trading Sdn. Bhd.' }).where(eq(schema.organizations.id, 'acme'));
  await db.update(schema.organizations).set({ legalName: 'Northwind Pte Ltd' }).where(eq(schema.organizations.id, 'northwind'));
  const chain = new Map();
  let clock = T0;
  const wallets = { acme: ACME_WALLET, northwind: NORTH_WALLET };
  const deps = (orgId, overrides = {}) => ({
    db,
    orgId,
    env: ENV,
    now: () => clock,
    network: 'testnet',
    readWallet: async () => wallets[orgId],
    readTransaction: async (d) => chain.get(d) ?? null,
    kyt: kytProviderFromEnv({ NODE_ENV: 'test' }, { now: () => clock }),
    companyName: async () => (orgId === 'acme' ? 'Acme Trading Sdn. Bhd.' : 'Northwind Pte Ltd'),
    coinTypes: { USDC, USDT, USDSUI },
    splashAddresses: [OPERATOR],
    signedPartners: new Set(),
    bookReader: async () => ({ pair: 'USDT_USDC', bid: parseRate('0.9998'), ask: parseRate('1.0002'), mid: parseRate('1'), deviationBps: 0n, source: 'deepbook', asOf: clock.toISOString() }),
    ...overrides,
  });
  /** A Sui transaction that delivered `amount` of `coinType` to `to`, sent by `sender`. */
  const deliver = ({ to = ACME_WALLET, amount = 1_000_000n, coinType = USDC, sender = clearAddr(), events = [], success = true } = {}) => {
    const d = digest();
    chain.set(d, { digest: d, success, sender, timestampMs: clock.getTime(), balanceChanges: [{ address: to, coinType, amount: String(amount) }, { address: sender, coinType, amount: String(-amount) }], events });
    return d;
  };
  return { db, chain, deps, deliver, wallets, advance: (ms) => { clock = new Date(clock.getTime() + ms); }, now: () => clock };
}

/** A wallet source for `orgId`, proven by a real signature over Splash's message. */
async function provenSuiWallet(w, orgId = 'acme') {
  const kp = new Ed25519Keypair();
  const address = kp.getPublicKey().toSuiAddress();
  const added = await addFundingSource(w.deps(orgId), 'u-owner', { kind: 'wallet', chain: 'SUI', address });
  assert.equal(added.ok, true, JSON.stringify(added));
  const ch = await walletSourceChallenge(w.deps(orgId), added.source.id);
  assert.equal(ch.ok, true, JSON.stringify(ch));
  const { signature } = await kp.signPersonalMessage(new TextEncoder().encode(ch.challenge.message));
  const v = await verifyWalletSource(w.deps(orgId), { userId: 'u-owner', sourceId: added.source.id, challengeId: ch.challenge.id, signature });
  assert.equal(v.ok, true, JSON.stringify(v));
  return { kp, address, source: v.source };
}

/* ── The destination ───────────────────────────────────────────────────── */

test('funds go to the wallet the chain names: never a Splash address, and none at all without a wallet', async () => {
  const w = await world();
  const dest = await fundingDestination(w.deps('acme'));
  assert.deepEqual(dest, { ok: true, wallet: ACME_WALLET });
  assert.equal((await fundingDestination(w.deps('acme', { readWallet: async () => null }))).code, 'no_business_wallet');
  assert.equal((await fundingDestination(w.deps('acme', { readWallet: async () => OPERATOR }))).code, 'destination_refused');
  assert.equal((await fundingDestination(w.deps('acme', { readWallet: async () => { throw new Error('rpc'); } }))).code, 'wallet_unreadable');

  for (const channel of ['wallet', 'provider']) {
    const q = await quoteFunding(w.deps('acme'), { channel, amount: '25', provider: 'halliday', method: 'bank' });
    assert.equal(q.ok, true, JSON.stringify(q));
    assert.equal(q.quote.destination, ACME_WALLET);
  }
  const cctp = await quoteFunding(w.deps('acme'), { channel: 'cctp', amount: '25', sourceChain: 'BASE' });
  assert.equal(cctp.ok, true, JSON.stringify(cctp));
  assert.equal(normalizeSuiAddress(cctp.quote.detail.cctp.mintRecipient), ACME_WALLET, 'mint recipient = the business wallet');
  const swap = await quoteFunding(w.deps('acme'), { channel: 'swap', route: 'lifi', sourceChain: 'ETHEREUM', fromToken: 'WETH', fromDecimals: 18, amountIn: '10000000000000000000' });
  assert.equal(swap.ok, true, JSON.stringify(swap));
  assert.equal(swap.quote.destination, ACME_WALLET);
  const intent = await createFundingIntent(w.deps('acme'), { channel: 'wallet', amount: '25', userId: 'u', clientKey: 'k-dest-0001', destination: OPERATOR, wallet: OPERATOR });
  assert.equal(intent.intent.destination, ACME_WALLET, 'a destination in the request is ignored');
});

test('options name partners only when signed, and list what is on hold', async () => {
  const w = await world();
  const unsigned = await fundingOptions(w.deps('acme'));
  assert.equal(unsigned.ok, true);
  const labels = unsigned.channels.provider.map((p) => p.label);
  assert.ok(!labels.some((l) => /Halliday|Stripe|TransFi|Bridge/.test(l)), labels.join(', '));
  assert.ok(!unsigned.channels.provider.some((p) => p.id === 'bridge'), 'Bridge is off by default');
  const signed = await fundingOptions(w.deps('acme', { signedPartners: new Set(['halliday']) }));
  assert.ok(signed.channels.provider.some((p) => p.label === 'Halliday'));
  assert.equal(signed.channels.wallet.address, ACME_WALLET);
  assert.equal(signed.heldMinor, '0');
});

/* ── Quotes first ──────────────────────────────────────────────────────── */

test("a partner's fee is its own line, never Splash's, and the quote expires", async () => {
  const w = await world();
  const q = await quoteFunding(w.deps('acme'), { channel: 'provider', provider: 'transfi', method: 'card', amount: '100' });
  assert.equal(q.ok, true);
  assert.ok(q.quote.lines.length >= 1);
  assert.ok(q.quote.lines.every((l) => l.payee !== 'splash' && l.payee === 'provider'));
  assert.equal(q.quote.arrivesMinMinor, '100000000');
  assert.ok(new Date(q.quote.expiresAt) > w.now());
  assert.equal(q.quote.sandbox, true);
  assert.equal((await quoteFunding(w.deps('acme'), { channel: 'provider', provider: 'bridge', method: 'bank', amount: '1' })).code, 'provider_disabled');
  assert.equal((await quoteFunding(w.deps('acme'), { channel: 'provider', provider: 'nobody', method: 'bank', amount: '1' })).code, 'bad_provider');
  assert.equal((await quoteFunding(w.deps('acme'), { channel: 'wallet', amount: '0' })).code, 'bad_amount');
  assert.equal((await quoteFunding(w.deps('acme'), { channel: 'wallet', amount: '1.0000001' })).code, 'bad_amount');
});

test('USDT and USDsui convert only on their peg, with the rate shown first', async () => {
  const w = await world();
  const ok = await quoteFunding(w.deps('acme'), { channel: 'wallet', asset: 'USDT', amount: '1000' });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(Number(ok.quote.detail.conversion.rate), 0.9998, 'the bid the swap sells into');
  assert.ok(BigInt(ok.quote.arrivesMinMinor) < 1_000_000_000n && BigInt(ok.quote.arrivesMinMinor) > 990_000_000n);

  const off = (bps) => async () => ({ pair: 'USDT_USDC', bid: parseRate(String(1 - bps / 10_000)), ask: parseRate('1'), mid: parseRate(String(1 - bps / 20_000)), deviationBps: BigInt(Math.round(bps / 2)), source: 'deepbook', asOf: '' });
  assert.equal((await quoteFunding(w.deps('acme', { bookReader: off(80) }), { channel: 'wallet', asset: 'USDT', amount: '1000' })).code, 'off_peg');
  assert.equal((await quoteFunding(w.deps('acme', { bookReader: async () => null }), { channel: 'wallet', asset: 'USDSUI', amount: '1000' })).code, 'peg_unverified');
  // The same guard for USDT arriving by CCTP or a swap route.
  assert.equal((await quoteFunding(w.deps('acme', { bookReader: off(80) }), { channel: 'cctp', asset: 'USDT', sourceChain: 'ETHEREUM', amount: '50' })).code, 'off_peg');
  assert.equal((await quoteFunding(w.deps('acme', { bookReader: off(80) }), { channel: 'swap', route: 'debridge', sourceChain: 'ETHEREUM', fromToken: 'USDT', fromDecimals: 6, amountIn: '50000000' })).code, 'off_peg');

  // The tolerance is peg_monitor's own 30 bps, on the mid and on the bid the swap takes.
  assert.equal(CONVERSION_PEG_TOLERANCE_BPS, 30n);
  const peg = await readFile(new URL('../move/splash_core/sources/peg_monitor.move', import.meta.url), 'utf8');
  assert.match(peg, /MAX_DEVIATION_PPM: u64 = 3_000;/);
  const edge = await quoteConversion({ asset: 'USDT', amountInMinor: 1_000_000n }, async () => ({ pair: 'USDT_USDC', bid: parseRate('0.9969'), ask: parseRate('1.0029'), mid: parseRate('0.9999'), deviationBps: 1n, source: 'deepbook', asOf: '' }));
  assert.equal(edge.code, 'off_peg', 'a bid 31 bps under refuses even with a centred mid');

  // A stale quote is refused, never refreshed; and today nothing signs a swap.
  const q = await quoteConversion({ asset: 'USDSUI', amountInMinor: 5_000_000n, now: T0 }, w.deps('acme').bookReader);
  assert.equal((await executeConversion(q.quote, new Date(T0.getTime() + 6 * 60_000))).code, 'quote_expired');
  assert.equal((await executeConversion(q.quote, T0)).code, 'conversion_not_built');
});

test("the peg guard reads exactly the coin's own DeepBook pool, and no reading is no peg", async () => {
  const { getDeepbookPairBook } = await import('../lib/server/deepbook.ts');
  const realFetch = globalThis.fetch;
  const books = [
    { trading_pairs: 'USDSUI_USDC', base_currency: 'USDSUI', quote_currency: 'USDC', last_price: 1, highest_bid: 0.9999, lowest_ask: 1.0001, base_volume: 500000 },
    { trading_pairs: 'USDT_USDC', base_currency: 'USDT', quote_currency: 'USDC', last_price: 0.995, highest_bid: 0.994, lowest_ask: 0.996, base_volume: 900 },
    { trading_pairs: 'WIDE_USDC', base_currency: 'WIDE', quote_currency: 'USDC', last_price: 1, highest_bid: 0.9, lowest_ask: 1.1, base_volume: 1 },
  ];
  globalThis.fetch = async () => new Response(JSON.stringify(books), { status: 200 });
  try {
    const usdt = await getDeepbookPairBook('USDT_USDC', {});
    assert.equal(usdt.deviationBps, 50n, 'USDT’s own book, not the busier USDsui one');
    assert.equal((await quoteConversion({ asset: 'USDT', amountInMinor: 1_000_000n }, (p) => getDeepbookPairBook(p, {}))).code, 'off_peg');
    assert.equal((await quoteConversion({ asset: 'USDSUI', amountInMinor: 1_000_000n }, (p) => getDeepbookPairBook(p, {}))).ok, true);
    assert.equal(await getDeepbookPairBook('WIDE_USDC', {}), null, 'a book wider than 1% is no reading');
    assert.equal(await getDeepbookPairBook('NONE_USDC', {}), null);
    globalThis.fetch = async () => new Response('', { status: 500 });
    assert.equal(await getDeepbookPairBook('USDT_USDC', {}), null);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a fresh quote worse than the accepted one is refused and nothing is made', async () => {
  const w = await world();
  const r = await createFundingIntent(w.deps('acme'), { channel: 'swap', route: 'lifi', sourceChain: 'ETHEREUM', fromToken: 'WETH', fromDecimals: 18, amountIn: '1000000000000000000', userId: 'u', clientKey: 'k-quote-0001', acceptedArrivesMinMinor: '999999999999' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'quote_changed');
  assert.ok(r.quote, 'the new quote comes back to look at');
  assert.equal((await listFundingIntents(w.deps('acme'))).length, 0);
});

/* ── Idempotency ───────────────────────────────────────────────────────── */

test('a top-up is idempotent by its client key, and the partner order by the intent id', async () => {
  const w = await world();
  const ask = { channel: 'provider', provider: 'halliday', method: 'bank', amount: '500', userId: 'u-maker', clientKey: 'k-idem-0001', acceptedArrivesMinMinor: '500000000' };
  assert.equal((await createFundingIntent(w.deps('acme'), { ...ask, clientKey: undefined })).code, 'idempotency_key_required');
  const [a, b] = await Promise.all([createFundingIntent(w.deps('acme'), ask), createFundingIntent(w.deps('acme'), ask)]);
  assert.equal(a.ok && b.ok, true, JSON.stringify([a, b]));
  assert.equal(a.intent.id, b.intent.id, 'two clicks, one top-up');
  const again = await createFundingIntent(w.deps('acme'), ask);
  assert.equal(again.created, false);
  assert.equal(again.intent.status, 'provider_pending');
  assert.match(again.intent.instructions.next.reference ?? '', /^sb_halliday_/);
  assert.equal((await createFundingIntent(w.deps('acme'), { ...ask, amount: '501' })).code, 'idempotency_key_reused');
  // The same key in another business is another business's key.
  const north = await createFundingIntent(w.deps('northwind'), ask);
  assert.notEqual(north.intent.id, a.intent.id);
  // The partner reference is keyed by the intent id (under a per-process key): a retried order is the same order.
  const order1 = await fundingProvider('halliday', { NODE_ENV: 'test' }).createOrder({ intentId: a.intent.id, method: 'bank', deliverMinor: 1n, walletAddress: ACME_WALLET, quoteRef: 'x', now: T0 });
  const order2 = await fundingProvider('halliday', { NODE_ENV: 'test' }).createOrder({ intentId: a.intent.id, method: 'bank', deliverMinor: 1n, walletAddress: ACME_WALLET, quoteRef: 'y', now: T0 });
  assert.equal(order1.providerRef, order2.providerRef);
  assert.equal(order1.providerRef, again.intent.instructions.next.reference);
});

test('transfer step 3 tops up with the same call, naming the transfer', async () => {
  const w = await world();
  assert.equal((await createFundingIntent(w.deps('acme'), { channel: 'wallet', amount: '12', userId: 'u', clientKey: 'k-step3-0001', purpose: 'transfer_top_up' })).code, 'transfer_ref_required');
  const r = await createFundingIntent(w.deps('acme'), { channel: 'wallet', amount: '12', userId: 'u', clientKey: 'k-step3-0002', purpose: 'transfer_top_up', transferRef: 'tr_123456' });
  assert.equal(r.ok, true);
  assert.equal(r.intent.purpose, 'transfer_top_up');
  assert.equal(r.intent.transferRef, 'tr_123456');
  assert.match(r.intent.instructions.uri, new RegExp(`^sui:${ACME_WALLET}\\?asset=USDC&amount=12\\.000000$`));
});

/* ── Deposits: read from the chain, screened, held or cleared ──────────── */

test('a deposit from a proven wallet clears; its first use is checked once', async () => {
  const w = await world();
  const { address, source } = await provenSuiWallet(w);
  const d1 = w.deliver({ sender: address, amount: 7_000_000n });
  const r1 = await recordDeposit(w.deps('acme'), { digest: d1 });
  assert.equal(r1.ok, true, JSON.stringify(r1));
  assert.equal(r1.deposits[0].status, 'cleared');
  assert.equal(r1.deposits[0].firstUse, true);
  assert.equal(r1.deposits[0].amountMinor, '7000000', 'the amount is the chain’s');
  assert.equal(r1.deposits[0].screening.provider, 'sandbox');
  const [row] = await w.db.select().from(schema.fundingSources).where(eq(schema.fundingSources.id, source.id));
  assert.equal(row.firstUseResult, 'passed');
  const firstAt = row.firstUseAt.getTime();
  w.advance(60_000);
  const r2 = await recordDeposit(w.deps('acme'), { digest: w.deliver({ sender: address }) });
  assert.equal(r2.deposits[0].firstUse, false);
  const [after] = await w.db.select().from(schema.fundingSources).where(eq(schema.fundingSources.id, source.id));
  assert.equal(after.firstUseAt.getTime(), firstAt, 'checked once');
});

test('an unknown or unverified source is held, its USDC is not spendable, and proving it releases it', async () => {
  const w = await world();
  const kp = new Ed25519Keypair();
  const sender = kp.getPublicKey().toSuiAddress();
  const r = await recordDeposit(w.deps('acme'), { digest: w.deliver({ sender, amount: 40_000_000n }) });
  assert.equal(r.deposits[0].status, 'held');
  assert.deepEqual(r.deposits[0].holdReasons, ['source_unknown']);
  assert.equal(await heldUsdcMinor(w.db, { orgId: 'acme', walletAddress: ACME_WALLET, usdcType: USDC }), 40_000_000n);
  assert.equal((await fundingOptions(w.deps('acme'))).heldMinor, '40000000');

  // Added but not yet proven: still held, now as unverified.
  const added = await addFundingSource(w.deps('acme'), 'u-owner', { kind: 'wallet', chain: 'SUI', address: sender });
  const re = await recheckDeposit(w.deps('acme'), r.deposits[0].id);
  assert.deepEqual(re.deposit.holdReasons, ['source_unverified']);
  assert.equal(re.deposit.status, 'held');

  // Proving it looks at its held deposits again.
  const ch = await walletSourceChallenge(w.deps('acme'), added.source.id);
  const { signature } = await kp.signPersonalMessage(new TextEncoder().encode(ch.challenge.message));
  assert.equal((await verifyWalletSource(w.deps('acme'), { userId: 'u-owner', sourceId: added.source.id, challengeId: ch.challenge.id, signature })).ok, true);
  const [dep] = await listWalletDeposits(w.deps('acme'));
  assert.equal(dep.status, 'cleared');
  assert.equal(await heldUsdcMinor(w.db, { orgId: 'acme', walletAddress: ACME_WALLET, usdcType: USDC }), 0n);
});

test('a sanctions hit is blocked for good; a review is held; no answer is held, never cleared', async () => {
  const w = await world();
  const blocked = await recordDeposit(w.deps('acme'), { digest: w.deliver({ sender: deadAddr(), amount: 9_000_000n }) });
  assert.equal(blocked.deposits[0].status, 'blocked');
  assert.equal((await recheckDeposit(w.deps('acme'), blocked.deposits[0].id)).code, 'blocked');
  assert.equal(await heldUsdcMinor(w.db, { orgId: 'acme', walletAddress: ACME_WALLET, usdcType: USDC }), 9_000_000n, 'blocked USDC is not spendable either');

  const review = await recordDeposit(w.deps('acme'), { digest: w.deliver({ sender: beefAddr() }) });
  assert.ok(review.deposits[0].holdReasons.includes('screening_review'));

  // Production with no screening provider: no verdict, so held; a proven source does not change that.
  const { address } = await provenSuiWallet(w);
  const unscreened = await recordDeposit(w.deps('acme', { kyt: kytProviderFromEnv({ NODE_ENV: 'production' }) }), { digest: w.deliver({ sender: address }) });
  assert.equal(unscreened.deposits[0].status, 'held');
  assert.ok(unscreened.deposits[0].holdReasons.includes('not_screened'));
  assert.equal(unscreened.deposits[0].screening.verdict, null);
  assert.equal(unscreened.deposits[0].screening.provider, 'none');
});

test('a digest is recorded once, whoever reports it and however often', async () => {
  const w = await world();
  const intent = await createFundingIntent(w.deps('acme'), { channel: 'wallet', amount: '3', userId: 'u', clientKey: 'k-replay-001' });
  const d = w.deliver({ amount: 3_000_000n });
  const results = await Promise.all([1, 2, 3].map(() => recordDeposit(w.deps('acme'), { digest: d, intentId: intent.intent.id })));
  assert.equal(results.filter((r) => r.deposits[0].created).length, 1);
  assert.equal(new Set(results.map((r) => r.deposits[0].id)).size, 1);
  assert.equal((await listWalletDeposits(w.deps('acme'))).length, 1);
  assert.equal((await getFundingIntent(w.deps('acme'), intent.intent.id)).intent.status, 'arriving', 'it came, from no known source, so it is held: arriving, not arrived');
});

test('nothing arrives unless the chain says so: failed, unknown, other coins, other wallets', async () => {
  const w = await world();
  assert.equal((await recordDeposit(w.deps('acme'), { digest: 'not a digest' })).code, 'bad_digest');
  assert.equal((await recordDeposit(w.deps('acme'), { digest: digest() })).code, 'not_on_chain');
  assert.equal((await recordDeposit(w.deps('acme'), { digest: w.deliver({ success: false }) })).code, 'failed_transaction');
  assert.equal((await recordDeposit(w.deps('acme'), { digest: w.deliver({ coinType: normalizeStructTag('0x2::sui::SUI') }) })).code, 'nothing_arrived');
  assert.equal((await recordDeposit(w.deps('acme'), { digest: w.deliver({ to: NORTH_WALLET }) })).code, 'nothing_arrived', "northwind's deposit is not acme's");
  // USDT that arrives is recorded as USDT (to be converted), not as USDC.
  const usdt = await recordDeposit(w.deps('acme'), { digest: w.deliver({ coinType: USDT, amount: 2_000_000n }) });
  assert.equal(usdt.deposits[0].asset, 'USDT');
  assert.equal(await heldUsdcMinor(w.db, { orgId: 'acme', walletAddress: ACME_WALLET, usdcType: USDC }), 0n);
});

/* ── Another business's ids read as absent ─────────────────────────────── */

test("another business's top-ups, deposits and sources read as absent", async () => {
  const w = await world();
  const intent = await createFundingIntent(w.deps('acme'), { channel: 'wallet', amount: '1', userId: 'u', clientKey: 'k-tenant-001' });
  const dep = await recordDeposit(w.deps('acme'), { digest: w.deliver({ sender: clearAddr() }) });
  const src = await addFundingSource(w.deps('acme'), 'u-owner', { kind: 'wallet', chain: 'SUI', address: clearAddr() });
  const north = w.deps('northwind');
  assert.equal((await getFundingIntent(north, intent.intent.id)).status, 404);
  assert.equal((await cancelFundingIntent(north, intent.intent.id)).status, 404);
  assert.equal((await recheckDeposit(north, dep.deposits[0].id)).status, 404);
  assert.equal((await walletSourceChallenge(north, src.source.id)).status, 404);
  assert.equal((await verifyWalletSource(north, { userId: 'x', sourceId: src.source.id, challengeId: 'fch_x', signature: 'x' })).status, 404);
  assert.equal((await revokeFundingSource(north, src.source.id, 'u-x')).status, 404);
  assert.equal((await recordDeposit(north, { digest: w.deliver({ to: NORTH_WALLET }), intentId: intent.intent.id })).status, 404);
  assert.equal((await createFundingIntent(north, { channel: 'wallet', amount: '1', userId: 'u', clientKey: 'k-tenant-002', sourceId: src.source.id })).status, 404);
  assert.deepEqual(await listWalletDeposits(north), []);
  assert.deepEqual(await listFundingIntents(north), []);
});

/* ── Funding sources ───────────────────────────────────────────────────── */

test('a bank account or card must be in the company’s name; no full number is stored', async () => {
  const w = await world();
  assert.equal(sameCompany('ACME TRADING SDN BHD', 'Acme Trading Sdn. Bhd.'), true);
  assert.equal(sameCompany('Acme Trading Sendirian Berhad', 'Acme Trading Sdn. Bhd.'), true);
  assert.equal(sameCompany('Acme', 'Acme Trading Sdn. Bhd.'), false);
  assert.equal(sameCompany('', ''), false);
  assert.equal(normalizeCompanyName('  PT  Maju & Co. '), 'pt maju and co');

  const personal = await addFundingSource(w.deps('acme'), 'u-owner', { kind: 'bank_account', holderName: 'Ahmad bin Ali', country: 'MY', bankCode: 'MBBEMYKL', accountNumber: '5140 1234 5678' });
  assert.equal(personal.code, 'not_company_name');
  const ok = await addFundingSource(w.deps('acme'), 'u-owner', { kind: 'bank_account', holderName: 'ACME TRADING SDN BHD', country: 'MY', bankCode: 'MBBEMYKL', accountNumber: '5140 1234 5678' });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.source.status, 'pending', 'verified on its first deposit');
  assert.equal(ok.source.last4, '5678');
  const [row] = await w.db.select().from(schema.fundingSources).where(eq(schema.fundingSources.id, ok.source.id));
  assert.ok(!JSON.stringify(row).includes('514012345678') && !JSON.stringify(row).includes('5140 1234'), 'the account number is never stored');
  const dup = await addFundingSource(w.deps('acme'), 'u-owner', { kind: 'bank_account', holderName: 'Acme Trading Sdn Bhd', country: 'my', bankCode: 'mbbemykl', accountNumber: '514012345678' });
  assert.equal(dup.created, false, 'the same account is one source');
  assert.equal((await addFundingSource(w.deps('acme'), 'u-owner', { kind: 'card', provider: 'stripe', providerFingerprint: 'fp_card_123456', last4: '4242', holderName: 'Someone Else' })).code, 'not_company_name');
  assert.equal((await addFundingSource(w.deps('acme'), 'u-owner', { kind: 'wallet', chain: 'SUI', address: ACME_WALLET })).code, 'own_wallet');
  assert.equal((await addFundingSource(w.deps('acme'), 'u-owner', { kind: 'wallet', chain: 'SUI', address: OPERATOR })).code, 'splash_address');
  // A removed source can be added back, as a new source waiting for its first use again.
  await revokeFundingSource(w.deps('acme'), ok.source.id, 'u-owner');
  const back = await addFundingSource(w.deps('acme'), 'u-owner', { kind: 'bank_account', holderName: 'Acme Trading Sdn Bhd', country: 'MY', bankCode: 'MBBEMYKL', accountNumber: '514012345678' });
  assert.equal(back.created, true);
  assert.notEqual(back.source.id, ok.source.id);
  assert.equal(back.source.status, 'pending');
});

test('a wallet proof names the business, chain, address, nonce and expiry, and is single-use', async () => {
  const w = await world();
  const kp = new Ed25519Keypair();
  const address = kp.getPublicKey().toSuiAddress();
  const added = await addFundingSource(w.deps('acme'), 'u-owner', { kind: 'wallet', chain: 'SUI', address });
  const ch = await walletSourceChallenge(w.deps('acme'), added.source.id);
  for (const part of ['Acme Trading Sdn. Bhd.', 'Chain: SUI', `Address: ${address}`, 'Nonce: ', 'Expires: ']) assert.ok(ch.challenge.message.includes(part), part);

  // Signed by another key: refused, and the challenge is spent.
  const other = await new Ed25519Keypair().signPersonalMessage(new TextEncoder().encode(ch.challenge.message));
  assert.equal((await verifyWalletSource(w.deps('acme'), { userId: 'u', sourceId: added.source.id, challengeId: ch.challenge.id, signature: other.signature })).code, 'bad_signature');
  const good = await kp.signPersonalMessage(new TextEncoder().encode(ch.challenge.message));
  assert.equal((await verifyWalletSource(w.deps('acme'), { userId: 'u', sourceId: added.source.id, challengeId: ch.challenge.id, signature: good.signature })).code, 'challenge_spent');

  // A signature over another message (another nonce) does not verify this one.
  const ch2 = await walletSourceChallenge(w.deps('acme'), added.source.id);
  const ch3 = await walletSourceChallenge(w.deps('acme'), added.source.id);
  const wrongMsg = await kp.signPersonalMessage(new TextEncoder().encode(ch3.challenge.message));
  assert.equal((await verifyWalletSource(w.deps('acme'), { userId: 'u', sourceId: added.source.id, challengeId: ch2.challenge.id, signature: wrongMsg.signature })).code, 'bad_signature');

  // Expired.
  const ch4 = await walletSourceChallenge(w.deps('acme'), added.source.id);
  w.advance(16 * 60_000);
  const late = await kp.signPersonalMessage(new TextEncoder().encode(ch4.challenge.message));
  assert.equal((await verifyWalletSource(w.deps('acme'), { userId: 'u', sourceId: added.source.id, challengeId: ch4.challenge.id, signature: late.signature })).code, 'challenge_spent');

  // In time, by the key: verified.
  const ch5 = await walletSourceChallenge(w.deps('acme'), added.source.id);
  const fine = await kp.signPersonalMessage(new TextEncoder().encode(ch5.challenge.message));
  const v = await verifyWalletSource(w.deps('acme'), { userId: 'u-owner', sourceId: added.source.id, challengeId: ch5.challenge.id, signature: fine.signature });
  assert.equal(v.ok, true);
  assert.equal(v.source.status, 'verified');
  assert.equal(walletProofMessage({ business: 'B', chain: 'SUI', address: 'A', nonce: 'N', expiresAt: T0 }).split('\n').length, 6);
});

test('a Solana wallet is proven with an ed25519 signature; an EVM wallet cannot be proven yet', async () => {
  const w = await world();
  const kp = new Ed25519Keypair();
  const address = toBase58(kp.getPublicKey().toRawBytes());
  const added = await addFundingSource(w.deps('acme'), 'u-owner', { kind: 'wallet', chain: 'SOLANA', address });
  assert.equal(added.ok, true, JSON.stringify(added));
  const ch = await walletSourceChallenge(w.deps('acme'), added.source.id);
  const sig = await kp.sign(new TextEncoder().encode(ch.challenge.message));
  const v = await verifyWalletSource(w.deps('acme'), { userId: 'u', sourceId: added.source.id, challengeId: ch.challenge.id, signature: toBase58(sig) });
  assert.equal(v.ok, true, JSON.stringify(v));
  const evm = await addFundingSource(w.deps('acme'), 'u-owner', { kind: 'wallet', chain: 'EVM', address: '0x00000000000000000000000000000000000000Ab' });
  assert.equal(evm.ok, true);
  assert.equal((await walletSourceChallenge(w.deps('acme'), evm.source.id)).code, 'proof_not_supported');
});

/* ── CCTP V2 deposits ──────────────────────────────────────────────────── */

function burnMessage({ sender20, recipient, amount }) {
  const body = new Uint8Array(132 + 96);
  new DataView(body.buffer).setUint32(0, 1, false);
  body.set(Buffer.from(recipient.slice(2), 'hex'), 36);
  body.set(Buffer.from(amount.toString(16).padStart(64, '0'), 'hex'), 68);
  body.set(Buffer.from(sender20.slice(2), 'hex'), 112);
  return body;
}

test("a CCTP V2 mint is attributed to the burner Circle's own event names", async () => {
  const w = await world();
  const burner = '0x1111111111111111111111111111111111111111';
  const body = burnMessage({ sender20: burner, recipient: ACME_WALLET, amount: 5_000_000n });
  const decoded = decodeBurnMessageV2(body);
  assert.equal(decoded.amount, 5_000_000n);
  assert.equal(normalizeSuiAddress(decoded.mintRecipient), ACME_WALLET);
  assert.equal(burnerAddress('ETHEREUM', decoded.messageSender), burner);
  assert.equal(burnerAddress('ETHEREUM', `0x${'ff'.repeat(32)}`), null, 'a 32-byte value that is not a padded EVM address is no burner');

  const added = await addFundingSource(w.deps('acme'), 'u-owner', { kind: 'wallet', chain: 'EVM', address: burner });
  const circle = { packageId: CCTP_SUI_MESSAGE_TRANSMITTER.testnet, eventType: `${CCTP_SUI_MESSAGE_TRANSMITTER.testnet}::receive_message::MessageReceived`, json: { source_domain: 0, message_body: toBase64(body) } };
  const r = await recordDeposit(w.deps('acme'), { digest: w.deliver({ amount: 5_000_000n, events: [circle] }) });
  assert.equal(r.deposits[0].channel, 'cctp');
  assert.equal(r.deposits[0].originChain, 'ETHEREUM');
  assert.equal(r.deposits[0].originAddress, burner);
  assert.equal(r.deposits[0].sourceId, added.source.id);
  assert.deepEqual(r.deposits[0].holdReasons, ['source_unverified'], 'an EVM wallet is not proven, so it is held');

  // The same event from any other package is not Circle's.
  const fake = { ...circle, packageId: `0x${'99'.repeat(32)}`, eventType: `0x${'99'.repeat(32)}::receive_message::MessageReceived` };
  const intent = await createFundingIntent(w.deps('acme'), { channel: 'cctp', amount: '5', sourceChain: 'ETHEREUM', userId: 'u', clientKey: 'k-cctp-0001' });
  assert.equal((await recordDeposit(w.deps('acme'), { digest: w.deliver({ events: [fake] }), intentId: intent.intent.id })).code, 'not_a_cctp_mint');
  const plain = await recordDeposit(w.deps('acme'), { digest: w.deliver({ events: [fake] }) });
  assert.equal(plain.deposits[0].channel, 'wallet');
});

/* ── Partner webhooks ──────────────────────────────────────────────────── */

async function providerWorld() {
  const w = await world();
  const bank = { holderName: 'Acme Trading Sdn Bhd', country: 'MY', bankCode: 'MBBEMYKL', accountNumber: '514012345678' };
  const src = await addFundingSource(w.deps('acme'), 'u-owner', { kind: 'bank_account', ...bank });
  const intent = await createFundingIntent(w.deps('acme'), { channel: 'provider', provider: 'stripe', method: 'bank', amount: '250', userId: 'u', clientKey: 'k-hook-00001', sourceId: src.source.id, acceptedArrivesMinMinor: '250000000' });
  assert.equal(intent.ok, true, JSON.stringify(intent));
  const ref = intent.intent.instructions.next.reference;
  const env = ENV;
  const send = async (body, { at = w.now(), secret = sandboxWebhookSecret(env), provider = 'stripe' } = {}) => {
    const raw = JSON.stringify(body);
    return handleProviderWebhook({ provider, rawBody: raw, signature: signWebhook(raw, secret, at), env, now: w.now(), db: w.db }, async (orgId) => w.deps(orgId));
  };
  // The partner reports the paying account itself; Splash keys it and keeps nothing of the number.
  const payer = { kind: 'bank_account', country: 'MY', bankCode: 'MBBEMYKL', accountNumber: '5140 1234 5678', holderName: 'ACME TRADING SDN. BHD.', last4: '5678' };
  return { ...w, src, intent: intent.intent, ref, send, payer, env };
}

test('a partner delivery is recorded from the chain; the first use verifies the bank account', async () => {
  const w = await providerWorld();
  const d = w.deliver({ amount: 250_000_000n, sender: STRIPE_SENDER });
  const ev = { eventId: 'evt_000001', providerRef: w.ref, intentId: w.intent.id, status: 'delivered', suiDigest: d, payer: w.payer, occurredAt: w.now().toISOString() };
  const r = await w.send(ev);
  assert.equal(r.status, 200, JSON.stringify(r));
  const [dep] = await listWalletDeposits(w.deps('acme'));
  assert.equal(dep.status, 'cleared', JSON.stringify(dep));
  assert.equal(dep.amountMinor, '250000000');
  assert.equal(dep.sourceId, w.src.source.id);
  const [src] = await w.db.select().from(schema.fundingSources).where(eq(schema.fundingSources.id, w.src.source.id));
  assert.equal(src.status, 'verified');
  assert.equal(src.method, 'first_use');
  assert.equal((await getFundingIntent(w.deps('acme'), w.intent.id)).intent.status, 'arrived');

  // The same event again counts once; a late "pending" or "failed" moves nothing back.
  assert.deepEqual((await w.send(ev)).body, { duplicate: true });
  await w.send({ ...ev, eventId: 'evt_000002', status: 'pending', suiDigest: undefined });
  await w.send({ ...ev, eventId: 'evt_000003', status: 'failed', suiDigest: undefined });
  assert.equal((await getFundingIntent(w.deps('acme'), w.intent.id)).intent.status, 'arrived');
  assert.equal((await listWalletDeposits(w.deps('acme'))).length, 1);
});

test('a webhook must be signed, fresh, and for its own order; a payer not in the company name is held', async () => {
  const w = await providerWorld();
  const base = { eventId: 'evt_100001', providerRef: w.ref, intentId: w.intent.id, status: 'pending', occurredAt: w.now().toISOString() };
  assert.equal((await w.send(base, { secret: 'wrong-secret' })).status, 401);
  assert.equal((await w.send(base, { at: new Date(w.now().getTime() - (WEBHOOK_TOLERANCE_SECONDS + 5) * 1000) })).body.code, 'stale');
  const raw = JSON.stringify(base);
  assert.equal((await handleProviderWebhook({ provider: 'stripe', rawBody: raw, signature: null, env: w.env, now: w.now(), db: w.db }, async (o) => w.deps(o))).status, 401);
  // A body altered after signing.
  const sig = signWebhook(raw, sandboxWebhookSecret(w.env), w.now());
  assert.equal((await handleProviderWebhook({ provider: 'stripe', rawBody: raw.replace('pending', 'failed'), signature: sig, env: w.env, now: w.now(), db: w.db }, async (o) => w.deps(o))).status, 401);
  // Signed, but naming another order or the wrong partner: ignored.
  assert.deepEqual((await w.send({ ...base, eventId: 'evt_100002', providerRef: 'sb_stripe_someone_else' })).body, { ignored: true });
  assert.deepEqual((await w.send({ ...base, eventId: 'evt_100003' }, { provider: 'halliday' })).body, { ignored: true });
  assert.equal((await w.send({ ...base, eventId: 'evt_100004', status: 'refunded' })).status, 401, 'an unknown event is refused, not guessed at');
  assert.equal((await getFundingIntent(w.deps('acme'), w.intent.id)).intent.status, 'provider_pending');

  // Delivered, but the chain has not seen it yet: the partner retries, and the retry counts.
  const d = digest();
  const ev = { ...base, eventId: 'evt_100005', status: 'delivered', suiDigest: d, payer: { ...w.payer, holderName: 'A Different Company Ltd' } };
  assert.equal((await w.send(ev)).status, 503);
  w.chain.set(d, { digest: d, success: true, sender: STRIPE_SENDER, timestampMs: 1, balanceChanges: [{ address: ACME_WALLET, coinType: USDC, amount: '250000000' }], events: [] });
  assert.equal((await w.send(ev)).status, 200);
  const [dep] = await listWalletDeposits(w.deps('acme'));
  assert.equal(dep.status, 'held');
  assert.ok(dep.holdReasons.includes('first_use_failed') && dep.holdReasons.includes('source_unverified'), JSON.stringify(dep.holdReasons));
});

test('a delivery someone recorded before the webhook is re-read with the partner’s facts', async () => {
  const w = await providerWorld();
  const d = w.deliver({ amount: 250_000_000n, sender: STRIPE_SENDER });
  const early = await recordDeposit(w.deps('acme'), { digest: d });
  assert.equal(early.deposits[0].status, 'held');
  assert.deepEqual(early.deposits[0].holdReasons, ['source_unknown']);
  const r = await w.send({ eventId: 'evt_300001', providerRef: w.ref, intentId: w.intent.id, status: 'delivered', suiDigest: d, payer: w.payer, occurredAt: w.now().toISOString() });
  assert.equal(r.status, 200, JSON.stringify(r));
  const deps = await listWalletDeposits(w.deps('acme'));
  assert.equal(deps.length, 1);
  assert.equal(deps[0].status, 'cleared', JSON.stringify(deps[0]));
  assert.equal(deps[0].intentId, w.intent.id);
  assert.equal((await getFundingIntent(w.deps('acme'), w.intent.id)).intent.status, 'arrived');
});

test('a swap delivery is held: naming a proven wallet does not clear money the chain cannot trace to it', async () => {
  const w = await world();
  const kp = new Ed25519Keypair();
  const address = toBase58(kp.getPublicKey().toRawBytes());
  const added = await addFundingSource(w.deps('acme'), 'u-owner', { kind: 'wallet', chain: 'SOLANA', address });
  const ch = await walletSourceChallenge(w.deps('acme'), added.source.id);
  await verifyWalletSource(w.deps('acme'), { userId: 'u', sourceId: added.source.id, challengeId: ch.challenge.id, signature: toBase58(await kp.sign(new TextEncoder().encode(ch.challenge.message))) });
  const intent = await createFundingIntent(w.deps('acme'), { channel: 'swap', route: 'lifi', sourceChain: 'SOLANA', fromToken: 'SOL', fromDecimals: 9, amountIn: '10000000000', sourceId: added.source.id, userId: 'u', clientKey: 'k-swap-00001', acceptedArrivesMinMinor: '1' });
  assert.equal(intent.ok, true, JSON.stringify(intent));
  const r = await recordDeposit(w.deps('acme'), { digest: w.deliver({ amount: 9_000_000n }), intentId: intent.intent.id });
  assert.equal(r.deposits[0].status, 'held');
  assert.ok(r.deposits[0].holdReasons.includes('origin_unconfirmed'), JSON.stringify(r.deposits[0]));
  assert.equal((await recheckDeposit(w.deps('acme'), r.deposits[0].id)).deposit.status, 'held');
});

test('a CCTP mint reported against a plain wallet top-up is still read as a CCTP arrival', async () => {
  const w = await world();
  const intent = await createFundingIntent(w.deps('acme'), { channel: 'wallet', amount: '5', userId: 'u', clientKey: 'k-cctpw-0001' });
  const body = burnMessage({ sender20: '0x2222222222222222222222222222222222222222', recipient: ACME_WALLET, amount: 5_000_000n });
  const circle = { packageId: CCTP_SUI_MESSAGE_TRANSMITTER.testnet, eventType: `${CCTP_SUI_MESSAGE_TRANSMITTER.testnet}::receive_message::MessageReceived`, json: { source_domain: 6, message_body: Array.from(body) } };
  const r = await recordDeposit(w.deps('acme'), { digest: w.deliver({ amount: 5_000_000n, events: [circle] }), intentId: intent.intent.id });
  assert.equal(r.deposits[0].channel, 'cctp');
  assert.equal(r.deposits[0].originChain, 'BASE');
  assert.equal(r.deposits[0].originAddress, '0x2222222222222222222222222222222222222222');
});

test('a payer other than the source the top-up named is held', async () => {
  const w = await providerWorld();
  const other = { holderName: 'Acme Trading Sdn Bhd', country: 'MY', bankCode: 'CIBBMYKL', accountNumber: '800012349999' };
  await addFundingSource(w.deps('acme'), 'u-owner', { kind: 'bank_account', ...other });
  const d = w.deliver({ amount: 250_000_000n, sender: STRIPE_SENDER });
  await w.send({ eventId: 'evt_200001', providerRef: w.ref, intentId: w.intent.id, status: 'delivered', suiDigest: d, payer: { ...w.payer, bankCode: other.bankCode, accountNumber: other.accountNumber, last4: '9999' }, occurredAt: w.now().toISOString() });
  const [dep] = await listWalletDeposits(w.deps('acme'));
  assert.ok(dep.holdReasons.includes('payer_mismatch'), JSON.stringify(dep));
});

/* ── Held funds are not spent ──────────────────────────────────────────── */

test('Splash builds no wallet payment that would spend held funds', async () => {
  const members = [softPasskey(), softPasskey()].map((p, i) => ({ userId: `u-${i}`, publicKey: p.publicKey }));
  const ms = buildBusinessMultisig({ members });
  const wallet = { multisigPublicKey: ms.multisigPublicKey, members: ms.members.map((m) => ({ userId: m.userId, publicKey: m.suiPublicKey, weight: m.weight })) };
  const ctx = (held) => ({ heldUsdc: async () => held, readUsdc: async () => ({ coinMinor: 60n, addressBalanceMinor: 40n }), signing: { sponsor: null }, chain: {}, account: {} });
  const payment = { amountMinor: 70n, maxFeeMinor: 1n };
  const onHold = await requestWalletPayment(ctx(50n), { orgId: 'acme', requestedBy: 'u-0', wallet, payment });
  assert.equal(onHold.code, 'funds_on_hold', JSON.stringify(onHold));
  assert.equal(onHold.details.spendableMinor, '50');
  // Without the hold, the same payment goes on to the next check (no sponsor here).
  assert.equal((await requestWalletPayment(ctx(0n), { orgId: 'acme', requestedBy: 'u-0', wallet, payment })).code, 'no_sponsor');
  assert.equal((await requestWalletPayment(ctx(29n), { orgId: 'acme', requestedBy: 'u-0', wallet, payment })).code, 'no_sponsor', '100 - 29 covers 71');
  assert.equal(spendableAfterHolds(10n, 25n), 0n);
  const deps = await readFile(new URL('../lib/server/wallet-deps.ts', import.meta.url), 'utf8');
  assert.match(deps, /heldUsdc: async/, 'the live wallet context reads the holds');
});

/* ── Rules as pure functions ───────────────────────────────────────────── */

test('statuses never go backwards', () => {
  assert.equal(canAdvanceIntent('arrived', 'provider_pending'), false);
  assert.equal(canAdvanceIntent('arrived', 'failed'), false);
  assert.equal(canAdvanceIntent('provider_pending', 'awaiting_funds'), false);
  assert.equal(canAdvanceIntent('failed', 'arrived'), true, 'the chain beats a reported failure');
  assert.equal(canAdvanceIntent('arriving', 'arrived'), true);
  assert.equal(canAdvanceIntent('arriving', 'failed'), false, 'money that came is not undone by a reported failure');
  assert.equal(canAdvanceIntent('arrived', 'arriving'), false);
  assert.equal(canAdvanceIntent('cancelled', 'provider_pending'), false);
  assert.equal(canMoveDeposit('blocked', 'cleared'), false);
  assert.equal(canMoveDeposit('cleared', 'held'), false);
  assert.equal(canMoveDeposit('held', 'cleared'), true);
  assert.deepEqual(decideDeposit({ source: { status: 'verified', firstUse: 'passed' }, screening: { verdict: 'CLEAR' } }), { status: 'cleared', reasons: [] });
  assert.equal(decideDeposit({ source: { status: 'verified', firstUse: 'passed' }, screening: { verdict: null } }).status, 'held');
  assert.equal(decideDeposit({ source: null, screening: { verdict: 'BLOCK' } }).status, 'blocked');
});

test('an intent lapses after a day, and money that still arrives is recorded', async () => {
  const w = await world();
  const intent = await createFundingIntent(w.deps('acme'), { channel: 'wallet', amount: '2', userId: 'u', clientKey: 'k-lapse-0001' });
  w.advance(25 * 60 * 60 * 1000);
  assert.equal((await getFundingIntent(w.deps('acme'), intent.intent.id)).intent.status, 'expired');
  assert.equal((await cancelFundingIntent(w.deps('acme'), intent.intent.id)).code, 'not_cancellable');
  await recordDeposit(w.deps('acme'), { digest: w.deliver({ amount: 2_000_000n }), intentId: intent.intent.id });
  assert.equal((await getFundingIntent(w.deps('acme'), intent.intent.id)).intent.status, 'arriving', 'recorded (from no known source, so held) after it lapsed');
});

/* ── Production fails closed ───────────────────────────────────────────── */

test('in production every partner and route refuses without credentials, and still refuses with them', async () => {
  const prod = { NODE_ENV: 'production' };
  for (const id of ['halliday', 'stripe', 'transfi']) {
    const a = fundingProvider(id, prod);
    assert.equal(a.mode, 'live');
    await assert.rejects(a.quote({ method: 'bank', deliverMinor: 1n, walletAddress: ACME_WALLET, now: T0 }), (e) => e instanceof FundingProviderUnavailable && e.code === 'provider_not_configured');
    await assert.rejects(a.createOrder({ intentId: 'fi_x', method: 'bank', deliverMinor: 1n, walletAddress: ACME_WALLET, quoteRef: 'q', now: T0 }), /not set up/);
    // A webhook signed with the sandbox secret is not accepted in production.
    const raw = JSON.stringify({ eventId: 'evt_x00001', providerRef: 'sb_x_000001', intentId: `fi_${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}`, status: 'delivered' });
    assert.throws(() => a.verifyWebhook({ rawBody: raw, signature: signWebhook(raw, sandboxWebhookSecret({}), T0), now: T0 }), FundingProviderUnavailable);
  }
  const keyed = fundingProvider('stripe', { ...prod, STRIPE_SECRET_KEY: 'sk_live_x', STRIPE_FUNDING_WEBHOOK_SECRET: 'whsec_x' });
  await assert.rejects(keyed.quote({ method: 'card', deliverMinor: 1n, walletAddress: ACME_WALLET, now: T0 }), (e) => e.code === 'provider_not_connected');
  assert.throws(() => fundingProvider('bridge', { ...prod, FUNDING_PROVIDER_BRIDGE_ENABLED: 'true' }).verifyWebhook({ rawBody: '{}', signature: null, now: T0 }), FundingProviderUnavailable);
  for (const id of ['lifi', 'debridge']) {
    await assert.rejects(swapRoute(id, prod).quote({ fromChain: 'ETHEREUM', fromToken: 'WETH', fromDecimals: 18, amountIn: 1n, toAddress: ACME_WALLET, slippageBps: 50, now: T0 }), (e) => e instanceof SwapRouteUnavailable && e.code === 'route_not_configured');
  }
  await assert.rejects(swapRoute('lifi', { ...prod, LIFI_API_KEY: 'k' }).quote({}), (e) => e.code === 'route_not_connected');
  // Screening: no provider in production answers no verdict; Elliptic configured answers none either.
  assert.equal((await kytProviderFromEnv(prod).screen({ chain: 'SUI', address: clearAddr(), direction: 'deposit' })).verdict, null);
  const elliptic = await kytProviderFromEnv({ ...prod, ELLIPTIC_API_KEY: 'k', ELLIPTIC_API_SECRET: 's' }).screen({ chain: 'SUI', address: clearAddr(), direction: 'deposit' });
  assert.deepEqual([elliptic.provider, elliptic.verdict], ['elliptic', null]);
  // Chainalysis answers from its response only.
  const fetcher = async () => new Response(JSON.stringify({ identifications: [{ name: 'SDN' }] }), { status: 200 });
  assert.equal((await kytProviderFromEnv({ ...prod, CHAINALYSIS_SANCTIONS_API_KEY: 'chainalysis-key' }, { fetcher }).screen({ chain: 'EVM', address: '0x1', direction: 'deposit' })).verdict, 'BLOCK');
  const down = async () => new Response('', { status: 500 });
  assert.equal((await kytProviderFromEnv({ ...prod, CHAINALYSIS_SANCTIONS_API_KEY: 'chainalysis-key' }, { fetcher: down }).screen({ chain: 'EVM', address: '0x1', direction: 'deposit' })).verdict, null);

  // Through the service: nothing is stored when a partner refuses.
  const w = await world();
  const r = await createFundingIntent(w.deps('acme', { env: prod }), { channel: 'provider', provider: 'halliday', method: 'bank', amount: '10', userId: 'u', clientKey: 'k-prod-00001', acceptedArrivesMinMinor: '10000000' });
  assert.equal(r.status, 503);
  assert.equal(r.code, 'provider_not_configured');
  assert.deepEqual(await listFundingIntents(w.deps('acme')), []);
  const opts = await fundingOptions(w.deps('acme', { env: prod }));
  assert.ok(opts.channels.provider.every((p) => p.available === false));
});

test('sandbox webhooks verify only with their secret, inside the window', () => {
  const raw = '{"a":1}';
  const at = T0;
  verifySignedWebhook(raw, signWebhook(raw, 's3cret', at), 's3cret', at);
  assert.throws(() => verifySignedWebhook(raw, signWebhook(raw, 's3cret', at), '', at), /No webhook secret/);
  assert.throws(() => verifySignedWebhook(raw, 't=1,v1=zz', 's3cret', at), /malformed/);
  assert.throws(() => verifySignedWebhook(raw, signWebhook(raw, 's3cret', new Date(at.getTime() + 301_000)), 's3cret', at), /replay window/);
});

/* ── The routes ────────────────────────────────────────────────────────── */

async function routeFiles(dir) {
  const out = [];
  for (const e of await readdir(new URL(dir, import.meta.url), { withFileTypes: true })) {
    const rel = `${dir}${e.name}`;
    if (e.isDirectory()) out.push(...(await routeFiles(`${rel}/`)));
    else if (e.name === 'route.ts') out.push(rel);
  }
  return out;
}

test('every funding route is scoped to the session’s org and never takes a destination or an org from the request', async () => {
  const files = await routeFiles('../app/api/wallet/funding/');
  assert.ok(files.length >= 8, files.join(', '));
  for (const f of files) {
    const src = await readFile(new URL(f, import.meta.url), 'utf8');
    assert.match(src, /fundingRoute\(request\)/, `${f} goes through fundingRoute`);
    assert.doesNotMatch(src, /body\.(orgId|org|accountId|wallet|destination|walletAddress|toAddress|amountMinor)\b/, `${f} reads no org, account or destination from the body`);
  }
  const gate = await readFile(new URL('../lib/server/wallet-funding-route.ts', import.meta.url), 'utf8');
  assert.match(gate, /walletRoute\(request\)/);
  const walletGate = await readFile(new URL('../lib/server/wallet-route.ts', import.meta.url), 'utf8');
  assert.match(walletGate, /requireSessionAccount\(/);
  // Owners alone change where money may come from.
  for (const f of ['sources/route.ts', 'sources/[id]/route.ts', 'sources/[id]/challenge/route.ts', 'sources/[id]/verify/route.ts']) {
    const src = await readFile(new URL(`../app/api/wallet/funding/${f}`, import.meta.url), 'utf8');
    const posts = src.split(/export async function (POST|DELETE)/).length - 1;
    const owners = (src.match(/requireFundingOwner\(/g) ?? []).length;
    assert.ok(posts >= 1 && owners >= posts / 2, `${f} is owners only`);
  }
  const hook = await readFile(new URL('../app/api/webhooks/funding/[provider]/route.ts', import.meta.url), 'utf8');
  assert.match(hook, /request\.text\(\)/, 'the raw body is what is verified');
  assert.doesNotMatch(hook, /request\.json\(\)/);
});

test('the new funding path never makes a deposit address of its own (the Phase 1 mainnet refusals stay)', async () => {
  for (const f of ['lib/server/wallet-funding.ts', 'lib/server/wallet-funding-deps.ts', 'lib/funding/providers.ts', 'lib/funding/swap-routes.ts', 'lib/server/funding-conversion.ts']) {
    const src = await readFile(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /FUNDING_DEPOSIT_DERIVATION_SECRET|FUNDING_CCTP_DEPOSIT_ADDRESSES_JSON|deriveSuiAddress|Ed25519Keypair\.fromSecretKey/, f);
  }
  const sessions = await readFile(new URL('../lib/server/funding-sessions.ts', import.meta.url), 'utf8');
  assert.match(sessions, /if \(onMainnet\(env\)\) throw new DepositAddressRefusedError\(\)/);
});
