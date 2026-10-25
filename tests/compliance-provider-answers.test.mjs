/**
 * What counts as a provider's answer (v2 §4.6), and the cross-chain half of
 * recipient screening.
 *
 * What must hold:
 *   - a screening verdict is a provider's answer only with the provider's
 *     reference and time, and the sandbox's never is one in production: a
 *     sandbox CLEAR on file (kept by a non-production server writing to the
 *     same database, say) does not let a production payment be opened or
 *     signed, does not send a Travel Rule message, and does not clear a held
 *     deposit; it is screened again by the live provider or refused. A
 *     sandbox BLOCK still blocks;
 *   - production keeps no sandbox verdict;
 *   - in production a sandbox Travel Rule message does not let an exchange
 *     payment be signed;
 *   - a cross-chain payment's receipt is opened only when this business's
 *     newest screening of the destination address, on its own chain, is a
 *     fresh CLEAR: BLOCK 403, REVIEW and unscreened 409, a stale CLEAR
 *     screened again or refused, another business's CLEAR not counted. A
 *     retry of a receipt already opened answers it as before;
 *   - the evidence of a cross-chain payment lists the screenings of the
 *     destination address and says when none was CLEAR before approval; in
 *     production it says when a screening or a Travel Rule message on file
 *     is the sandbox's.
 *
 * PGlite with every migration. Nothing reaches a network, nothing is signed.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';

import { eq } from 'drizzle-orm';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { normalizeStructTag, normalizeSuiAddress, toBase58, toHex } from '@mysten/sui/utils';

import * as schema from '../lib/db/schema.ts';
import { asProviderAnswer, isProviderAnswer, kytProviderFromEnv } from '../lib/compliance/kyt.ts';
import { controlsEvidenceFor } from '../lib/server/controls-evidence.ts';
import { openCrossChainTransfer } from '../lib/server/cross-chain-transfers.ts';
import { travelRuleForPayment } from '../lib/server/exchange-payment-compliance.ts';
import { crossChainRecipientGate, latestScreening, recipientScreeningGate, recordScreening } from '../lib/server/kyt-screenings.ts';
import { travelRuleHold } from '../lib/server/payment-compliance-gate.ts';
import { sendTravelRule } from '../lib/server/travel-rule-transfers.ts';
import { addFundingSource, listWalletDeposits, recheckDeposit, recordDeposit, verifyWalletSource, walletSourceChallenge } from '../lib/server/wallet-funding.ts';
import { createWalletRecipient } from '../lib/server/wallet-recipients.ts';

import { migratedDb } from './helpers/store-db.mjs';

const T0 = new Date('2026-10-25T08:00:00Z');
const HOUR = 3_600_000;
const PROD = { NODE_ENV: 'production' };
const TEST = { NODE_ENV: 'test' };
const PAYEE = normalizeSuiAddress(`0x${'77'.repeat(32)}`);
const INTENT = normalizeSuiAddress(`0x${'a1'.repeat(32)}`);
const WALLET = normalizeSuiAddress(`0x${'b2'.repeat(32)}`);
const CORE = normalizeSuiAddress(`0x${'c0'.repeat(32)}`);
const BASE_ADDRESS = '0x52908400098527886e0f7030069857d2e4169ee7';
const BASE_CHECKSUMMED = '0x52908400098527886E0F7030069857D2E4169EE7';

/** A screening kept for `orgId`, by `provider`. */
const kept = (address, { provider = 'elliptic', verdict = 'CLEAR', at = T0, kind = 'wallet_recipient', chain = 'SUI', orgId = 'acme', env = TEST } = {}) => ({
  orgId, kind, chain, address, requestedBy: 'u-test', env,
  screening: { provider, verdict, reference: verdict ? `${provider}:${randomUUID()}` : null, detail: 'x', screenedAt: verdict ? at.toISOString() : null },
});

/** A live provider that answers `verdict` with its own reference, and counts the times it was asked. */
function liveProvider(verdict = 'CLEAR', answeredAt = new Date(T0.getTime() + 1000)) {
  const asked = [];
  return {
    asked,
    provider: {
      id: 'elliptic',
      async screen(subject) {
        asked.push(subject);
        return { provider: 'elliptic', verdict, reference: `elliptic:${randomUUID()}`, detail: 'live', screenedAt: answeredAt.toISOString(), riskScore: 1 };
      },
    },
  };
}

const pause = () => new Promise((r) => setTimeout(r, 5));
const show = (x) => JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? v.toString() : v));

/* 1 ── What a provider's answer is ─────────────────────────────────────── */

test("a verdict is a provider's answer only with its reference and time, and never the sandbox's in production", () => {
  const answer = { provider: 'elliptic', verdict: 'CLEAR', reference: 'elliptic:a1', screenedAt: T0.toISOString(), detail: 'x' };
  assert.equal(isProviderAnswer(answer, PROD), true);
  assert.equal(isProviderAnswer({ ...answer, reference: null }, PROD), false, 'no reference');
  assert.equal(isProviderAnswer({ ...answer, screenedAt: null }, PROD), false, 'no time');
  assert.equal(isProviderAnswer({ ...answer, verdict: null }, TEST), false, 'no verdict');
  const sandbox = { ...answer, provider: 'sandbox', reference: 'sandbox:clear:1' };
  assert.equal(isProviderAnswer(sandbox, TEST), true, 'outside production the labelled sandbox answers');
  assert.equal(isProviderAnswer(sandbox, PROD), false, 'in production it never does');
  assert.equal(isProviderAnswer(sandbox, { NODE_ENV: 'production', USE_MOCK_APIS: 'true' }), false, 'mock flags do not change that');
  const stripped = asProviderAnswer(sandbox, PROD);
  assert.deepEqual([stripped.verdict, stripped.provider, stripped.reference], [null, 'sandbox', 'sandbox:clear:1']);
  assert.match(stripped.detail, /not a provider's answer/);
  assert.equal(asProviderAnswer(answer, PROD), answer, 'an answer is passed through as it is');
});

test('production keeps no sandbox verdict', async () => {
  const { db, client } = await migratedDb();
  const row = await recordScreening(db, kept(PAYEE, { provider: 'sandbox', env: PROD }));
  assert.deepEqual([row.verdict, row.reference, row.screenedAt], [null, null, null]);
  const dev = await recordScreening(db, kept(PAYEE, { provider: 'sandbox', env: TEST }));
  assert.equal(dev.verdict, 'CLEAR', 'outside production the sandbox is kept, labelled');
  await client.close();
});

/* 2 ── A sandbox answer on file in production ────────────────────────────── */

test('in production a sandbox screening on file never lets a payment through: it is screened again, or refused', async () => {
  const { db, client } = await migratedDb();
  await recordScreening(db, kept(PAYEE, { provider: 'sandbox' }));
  const gate = (o = {}) => recipientScreeningGate({ db, orgId: 'acme', now: T0, requestedBy: 'u-test', env: PROD, ...o }, PAYEE);
  assert.equal(await recipientScreeningGate({ db, orgId: 'acme', now: T0, requestedBy: 'u-test', env: TEST }, PAYEE), null, 'outside production the sandbox CLEAR holds');
  const refused = await gate();
  assert.deepEqual([refused.status, refused.code], [409, 'recipient_not_screened']);
  // With the live provider at hand it is asked, and its answer decides and is kept.
  const live = liveProvider('CLEAR');
  assert.equal(await gate({ kyt: live.provider }), null);
  assert.equal(live.asked.length, 1);
  assert.equal((await latestScreening(db, 'acme', 'SUI', PAYEE)).provider, 'elliptic');
  // A sandbox BLOCK still blocks, and is not screened away.
  const OTHER = normalizeSuiAddress(`0x${'78'.repeat(32)}`);
  await recordScreening(db, kept(OTHER, { provider: 'sandbox', verdict: 'BLOCK' }));
  const again = liveProvider('CLEAR');
  const blocked = await recipientScreeningGate({ db, orgId: 'acme', now: T0, requestedBy: 'u-test', env: PROD, kyt: again.provider }, OTHER);
  assert.deepEqual([blocked.status, blocked.code, again.asked.length], [403, 'recipient_blocked', 0]);
  await client.close();
});

test('in production a sandbox Travel Rule message does not let an exchange payment be signed', async () => {
  const { db, client } = await migratedDb();
  const ref = `wsr_${randomUUID()}`;
  const row = (sandbox) => ({ id: `trt_${randomUUID()}`, orgId: 'acme', paymentRef: ref, signingRequestId: ref, exchange: 'pdax', depositAddress: PAYEE, amountMinor: 1n, requestHash: 'h', provider: sandbox ? 'sandbox' : 'sumsub', sandbox, providerRef: sandbox ? 'sandbox_tr_1' : 'txn-1', status: 'approved', createdBy: 'u', createdAt: T0, updatedAt: T0 });
  await db.insert(schema.travelRuleTransfers).values(row(true));
  const payment = { recipient: PAYEE, kind: 2, paymentRef: ref };
  const request = { orgId: 'acme', id: ref };
  assert.equal(await travelRuleHold(db, request, payment, TEST), null, 'outside production the sandbox message stands');
  assert.equal((await travelRuleHold(db, request, payment, PROD)).code, 'travel_rule_missing');
  await db.update(schema.travelRuleTransfers).set({ provider: 'sumsub', sandbox: false, providerRef: 'txn-1' }).where(eq(schema.travelRuleTransfers.paymentRef, ref));
  assert.equal(await travelRuleHold(db, request, payment, PROD), null, "the provider's own message lets it be signed");
  await client.close();
});

test('in production the Travel Rule message is not sent on a sandbox CLEAR', async () => {
  const { db, client } = await migratedDb();
  await client.exec(`INSERT INTO users (id, email, name) VALUES ('u-owner', 'owner@acme.test', 'Owner')`);
  await client.exec(`UPDATE organizations SET legal_name = 'Acme Trading Sdn Bhd', address_line1 = 'Jalan Ampang', address_city = 'Kuala Lumpur', address_country = 'MY', kyb_lifecycle = 'ACTIVE' WHERE id = 'acme'`);
  await db.insert(schema.kybCases).values({ id: 'kyb_acme_1', orgId: 'acme', businessName: 'Acme Trading Sdn Bhd', registrationNumber: '202001012345', state: 'APPROVED', sumsubApplicantId: 'applicant-001', updatedAt: new Date(T0.getTime() - 86_400_000) });
  const requestId = `wsr_${randomUUID()}`;
  await db.insert(schema.walletSigningRequests).values({
    id: requestId, orgId: 'acme', purpose: 'wallet_payment', dedupeKey: requestId, senderAddress: WALLET, signerKind: 'multisig', multisigPublicKey: 'msig-pk', threshold: 2, gasMode: 'sponsored',
    txBytes: 'AAAA', txDigest: `digest-${requestId}`, bytesHash: 'h'.repeat(64), status: 'collecting', requestedBy: 'u-owner', expiresAt: new Date(T0.getTime() + HOUR), createdAt: T0,
    summary: { description: { actions: [{ type: 'open_intent', asset: 'USDC', recipient: PAYEE, amountMinor: '1000000', kind: 2, targetCurrency: 'USD', fxRateUsdLocal: '1000000', beneficiaryRef: '00', expiresAtMs: '9' }, { type: 'pay_intent', asset: 'USDC', maxFeeMinor: '1', settleByMs: '9', paysFromCommand: 0, intentFromCommand: 0, intent: null }] } },
  });
  await recordScreening(db, kept(PAYEE, { provider: 'sandbox', kind: 'exchange_recipient' }));
  const calls = [];
  const provider = { id: 'sumsub', sandbox: false, async submitOutbound(input) { calls.push(input); return { provider: 'sumsub', sandbox: false, reference: 'txn-sumsub-1', status: 'submitted' }; } };
  const supplier = { name: 'Dela Cruz', country: 'PH', legalName: 'Dela Cruz Trading Corp', registrationNumber: 'CS1', town: 'Makati', street: 'Ayala', postCode: '1226', deliveryKind: 'EXCHANGE', exchange: 'pdax' };
  const d = { db, orgId: 'acme', now: () => T0, recipientAt: async (orgId, address) => (orgId === 'acme' && address === PAYEE ? supplier : null), provider };
  const refused = await travelRuleForPayment({ ...d, env: PROD }, { requestId, exchange: 'pdax', createdBy: 'u-owner' });
  assert.deepEqual([refused.status, refused.code, calls.length], [409, 'not_screened', 0]);
  const sent = await travelRuleForPayment({ ...d, env: TEST }, { requestId, exchange: 'pdax', createdBy: 'u-owner' });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  await client.close();
});

test('in production a held deposit is not cleared by a sandbox screening kept from before', async () => {
  const { db, client } = await migratedDb();
  await db.update(schema.organizations).set({ legalName: 'Acme Trading Sdn. Bhd.' }).where(eq(schema.organizations.id, 'acme'));
  const USDC = normalizeStructTag('0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN');
  const ACME_WALLET = normalizeSuiAddress(`0x${'a1'.repeat(32)}`);
  const chain = new Map();
  const ENV = { NODE_ENV: 'test', FUNDING_SOURCE_FINGERPRINT_KEY: toHex(randomBytes(24)) };
  const deps = (env, kyt) => ({
    db, orgId: 'acme', env, now: () => T0, network: 'testnet',
    readWallet: async () => ACME_WALLET, readTransaction: async (d) => chain.get(d) ?? null,
    kyt, companyName: async () => 'Acme Trading Sdn. Bhd.', coinTypes: { USDC, USDT: USDC, USDSUI: USDC },
    splashAddresses: [], signedPartners: new Set(),
    bookReader: async () => null,
  });
  const dev = deps(ENV, kytProviderFromEnv(TEST, { now: () => T0 }));
  const prod = deps({ ...ENV, NODE_ENV: 'production' }, kytProviderFromEnv(PROD));
  const kp = new Ed25519Keypair();
  const sender = kp.getPublicKey().toSuiAddress();
  const digest = toBase58(randomBytes(32));
  chain.set(digest, { digest, success: true, sender, timestampMs: T0.getTime(), balanceChanges: [{ address: ACME_WALLET, coinType: USDC, amount: '5000000' }, { address: sender, coinType: USDC, amount: '-5000000' }], events: [] });
  // Recorded by a non-production server: screened by the sandbox, held for its unknown source.
  const r = await recordDeposit(dev, { digest });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual([r.deposits[0].status, r.deposits[0].screening.provider], ['held', 'sandbox']);
  // Proven in production, where no provider is configured: still held, as unscreened.
  const added = await addFundingSource(prod, 'u-owner', { kind: 'wallet', chain: 'SUI', address: sender });
  assert.equal(added.ok, true, JSON.stringify(added));
  const linked = await recheckDeposit(prod, r.deposits[0].id);
  assert.deepEqual([linked.deposit.status, linked.deposit.holdReasons.includes('not_screened')], ['held', true], JSON.stringify(linked));
  const ch = await walletSourceChallenge(prod, added.source.id);
  const { signature } = await kp.signPersonalMessage(new TextEncoder().encode(ch.challenge.message));
  const v = await verifyWalletSource(prod, { userId: 'u-owner', sourceId: added.source.id, challengeId: ch.challenge.id, signature });
  assert.equal(v.ok, true, JSON.stringify(v));
  const [dep] = await listWalletDeposits(prod);
  assert.equal(dep.status, 'held');
  assert.ok(dep.holdReasons.includes('not_screened'), JSON.stringify(dep.holdReasons));
  await client.close();
});

/* 3 ── Cross-chain recipients are screened when their payment is opened ──── */

async function crossChainWorld() {
  const { db, client } = await migratedDb();
  await client.exec(`INSERT INTO users (id, email, name) VALUES ('u-owner', 'owner@acme.test', 'Owner')`);
  const supplier = { name: 'Dela Cruz', legalName: 'Dela Cruz Trading Corp', registrationNumber: 'CS201912345', country: 'PH', addressLine1: '1 Ayala Ave', addressCity: 'Makati', email: 'ap@delacruz.test' };
  const saved = await createWalletRecipient(
    { db, orgId: 'acme', now: () => T0, kyt: kytProviderFromEnv(TEST, { now: () => T0 }) },
    { body: { ...supplier, deliveryKind: 'CROSS_CHAIN', chain: 'BASE', address: BASE_CHECKSUMMED }, requestedBy: 'u-owner', requestedRole: 'OWNER' },
  );
  assert.equal(saved.ok, true, JSON.stringify(saved));
  return { db, client, recipientId: saved.recipient.id };
}

test('a cross-chain payment is opened only when the destination address is a fresh CLEAR here, on its own chain', async () => {
  const w = await crossChainWorld();
  const open = (deps = {}, input = {}) => openCrossChainTransfer(
    { db: w.db, orgId: 'acme', now: () => T0, requestedBy: 'u-owner', env: TEST, ...deps },
    { paymentRef: INTENT, recipientId: w.recipientId, amountMinor: 1_000_000_000n, maxBridgeFeeMinor: 0n, ...input },
  );
  const at = (ms) => () => new Date(T0.getTime() + ms);
  // The screening on save is a fresh CLEAR: it opens. (Below, other payments.)
  const first = await open({}, { paymentRef: normalizeSuiAddress(`0x${'e1'.repeat(32)}`) });
  assert.equal(first.ok, true, show(first));

  await pause();
  await recordScreening(w.db, kept(BASE_ADDRESS, { chain: 'BASE', kind: 'cross_chain_recipient', verdict: 'REVIEW' }));
  assert.deepEqual([(await open()).status, (await open()).code], [409, 'recipient_in_review']);
  // Another business's CLEAR of the same address does not count here.
  await pause();
  await recordScreening(w.db, kept(BASE_ADDRESS, { chain: 'BASE', kind: 'cross_chain_recipient', orgId: 'northwind' }));
  assert.equal((await open()).code, 'recipient_in_review');
  // Nor does a CLEAR of that address on another chain.
  await pause();
  await recordScreening(w.db, kept(BASE_ADDRESS, { chain: 'ETHEREUM', kind: 'cross_chain_recipient' }));
  assert.equal((await open()).code, 'recipient_in_review');
  await pause();
  await recordScreening(w.db, kept(BASE_ADDRESS, { chain: 'BASE', kind: 'cross_chain_recipient', verdict: 'BLOCK' }));
  assert.deepEqual([(await open()).status, (await open()).code], [403, 'recipient_blocked']);
  assert.equal((await w.db.select().from(schema.crossChainTransfers)).length, 1, 'nothing opened for a refused payment');

  // A stale CLEAR: screened again by the provider at hand, or refused without one.
  await pause();
  await recordScreening(w.db, kept(BASE_ADDRESS, { chain: 'BASE', kind: 'cross_chain_recipient' }));
  assert.equal((await open({ now: at(25 * HOUR) })).code, 'recipient_screening_stale');
  const live = liveProvider('CLEAR', at(25 * HOUR)());
  const reopened = await open({ now: at(25 * HOUR), kyt: live.provider });
  assert.equal(reopened.ok, true, show(reopened));
  assert.deepEqual([live.asked[0].chain, live.asked[0].address], ['BASE', BASE_ADDRESS]);
  const newest = await latestScreening(w.db, 'acme', 'BASE', BASE_ADDRESS);
  assert.deepEqual([newest.provider, newest.subjectKind], ['elliptic', 'cross_chain_recipient']);

  // A retry of a receipt already opened is screened again: a BLOCK since is
  // refused, and the receipt is kept as it was (nothing is deleted).
  await pause();
  await recordScreening(w.db, kept(BASE_ADDRESS, { chain: 'BASE', kind: 'cross_chain_recipient', verdict: 'BLOCK', at: at(25 * HOUR)() }));
  const retry = await open({ now: at(25 * HOUR) });
  assert.deepEqual([retry.ok, retry.status, retry.code], [false, 403, 'recipient_blocked'], show(retry));
  const kept1 = await w.db.select().from(schema.crossChainTransfers).where(eq(schema.crossChainTransfers.paymentRef, INTENT));
  assert.deepEqual([kept1.length, kept1[0].status], [1, 'awaiting_burn'], 'the receipt is kept');
  // A fresh CLEAR again: the retry answers the receipt already opened.
  await pause();
  await recordScreening(w.db, kept(BASE_ADDRESS, { chain: 'BASE', kind: 'cross_chain_recipient', at: at(25 * HOUR)() }));
  const again = await open({ now: at(25 * HOUR) });
  assert.deepEqual([again.ok, again.created], [true, false], show(again));
  await w.client.close();
});

test('in production a sandbox screening of a cross-chain recipient does not open its payment', async () => {
  const w = await crossChainWorld();
  const refused = await openCrossChainTransfer({ db: w.db, orgId: 'acme', now: () => T0, requestedBy: 'u-owner', env: PROD }, { paymentRef: INTENT, recipientId: w.recipientId, amountMinor: 1_000_000n, maxBridgeFeeMinor: 0n });
  assert.deepEqual([refused.status, refused.code], [409, 'recipient_not_screened']);
  const direct = await crossChainRecipientGate({ db: w.db, orgId: 'acme', now: T0, requestedBy: 'u-owner', env: PROD }, 'BASE', BASE_ADDRESS);
  assert.equal(direct.code, 'recipient_not_screened');
  // A chain Splash does not screen is refused, not let through.
  const unknown = await crossChainRecipientGate({ db: w.db, orgId: 'acme', now: T0, requestedBy: 'u-owner', env: TEST }, 'STELLAR', 'G');
  assert.equal(unknown.code, 'recipient_not_screened');
  await w.client.close();
});

/* 4 ── The evidence ──────────────────────────────────────────────────────── */

async function signedRequest(db, summary) {
  const id = `wsr_${randomUUID()}`;
  await db.insert(schema.walletSigningRequests).values({
    id, orgId: 'acme', purpose: 'wallet_payment', dedupeKey: id, senderAddress: WALLET, signerKind: 'multisig', multisigPublicKey: 'msig-pk', threshold: 1, gasMode: 'sponsored',
    txBytes: 'AAAA', txDigest: `digest-${id}`, bytesHash: 'h'.repeat(64), summary, status: 'executed', requestedBy: 'u-owner', expiresAt: new Date(T0.getTime() + HOUR), executedDigest: null, createdAt: T0,
  });
  await db.insert(schema.walletSigningSigners).values({ requestId: id, orgId: 'acme', publicKey: 'pk-owner', weight: 1, userId: 'u-owner', address: `0x${'01'.repeat(32)}`, signedAt: new Date(T0.getTime() + 2 * HOUR), signatureSha256: 's'.repeat(64) });
  return id;
}

test("a cross-chain payment's evidence lists the screenings of its destination address, and says when none was CLEAR before approval", async () => {
  const w = await crossChainWorld();
  const opened = await openCrossChainTransfer({ db: w.db, orgId: 'acme', now: () => T0, requestedBy: 'u-owner', env: TEST }, { paymentRef: INTENT, recipientId: w.recipientId, amountMinor: 1_000_000_000n, maxBridgeFeeMinor: 0n });
  assert.equal(opened.ok, true, show(opened));
  const intent = { intentId: INTENT, recipient: PAYEE, amountMinor: '1000000000', kind: 3, targetCurrency: 'USDC', fxRateUsdLocal: '1000000', expiresAtMs: '9', asset: 'USDC' };
  const requestId = await signedRequest(w.db, { description: { actions: [{ type: 'pay_intent', asset: 'USDC', maxFeeMinor: '0', settleByMs: '2', paysFromCommand: 0, intentFromCommand: null, intent }] } });
  const deps = { db: w.db, orgId: 'acme', now: () => T0, readTransaction: async () => null, corePackageOriginalId: CORE, env: TEST };
  const ev = await controlsEvidenceFor(deps, requestId, 'u-owner');
  assert.equal(ev.ok, true, JSON.stringify(ev));
  const dest = ev.evidence.screenings.filter((s) => s.subject === 'cross_chain_recipient');
  assert.equal(dest.length, 1);
  assert.deepEqual([dest[0].chain, dest[0].address, dest[0].verdict, dest[0].provider], ['BASE', BASE_ADDRESS, 'CLEAR', 'sandbox']);
  assert.ok(!ev.evidence.gaps.some((g) => /No CLEAR screening of the cross-chain recipient/.test(g)), ev.evidence.gaps.join('\n'));
  assert.ok(!ev.evidence.gaps.some((g) => /No CLEAR screening of the recipient address/.test(g)), 'the Sui side of a cross-chain payment is not the recipient');

  // A REVIEW before approval, then a CLEAR after it: the gap is named, the CLEAR listed apart.
  const w2 = await crossChainWorld();
  await openCrossChainTransfer({ db: w2.db, orgId: 'acme', now: () => T0, requestedBy: 'u-owner', env: TEST }, { paymentRef: INTENT, recipientId: w2.recipientId, amountMinor: 1_000_000_000n, maxBridgeFeeMinor: 0n });
  await recordScreening(w2.db, kept(BASE_ADDRESS, { chain: 'BASE', kind: 'cross_chain_recipient', verdict: 'REVIEW', at: new Date(T0.getTime() + HOUR) }));
  await recordScreening(w2.db, kept(BASE_ADDRESS, { chain: 'BASE', kind: 'cross_chain_recipient', at: new Date(T0.getTime() + 3 * HOUR) }));
  const req2 = await signedRequest(w2.db, { description: { actions: [{ type: 'pay_intent', asset: 'USDC', maxFeeMinor: '0', settleByMs: '2', paysFromCommand: 0, intentFromCommand: null, intent }] } });
  const ev2 = await controlsEvidenceFor({ ...deps, db: w2.db }, req2, 'u-owner');
  const before = ev2.evidence.screenings.filter((s) => s.subject === 'cross_chain_recipient');
  const after = ev2.evidence.screeningsAfterApproval.filter((s) => s.subject === 'cross_chain_recipient');
  assert.deepEqual([before[0].verdict, after[0].verdict], ['REVIEW', 'CLEAR']);
  assert.ok(ev2.evidence.gaps.some((g) => /No CLEAR screening of the cross-chain recipient/.test(g)), ev2.evidence.gaps.join('\n'));
  await w.client.close();
  await w2.client.close();
});

test("in production the evidence says when a screening or a Travel Rule message on file is the sandbox's", async () => {
  const { db, client } = await migratedDb();
  await client.exec(`INSERT INTO users (id, email, name) VALUES ('u-owner', 'owner@acme.test', 'Owner')`);
  await recordScreening(db, kept(PAYEE, { provider: 'sandbox', kind: 'exchange_recipient' }));
  const open = { type: 'open_intent', asset: 'USDC', recipient: PAYEE, amountMinor: '5000000', kind: 2, targetCurrency: 'USDC', fxRateUsdLocal: '1000000', beneficiaryRef: '', expiresAtMs: '1' };
  const requestId = await signedRequest(db, { description: { actions: [open, { type: 'pay_intent', asset: 'USDC', maxFeeMinor: '100', settleByMs: '2', paysFromCommand: 0, intentFromCommand: 0, intent: null }] } });
  await db.insert(schema.travelRuleTransfers).values({ id: `trt_${randomUUID()}`, orgId: 'acme', paymentRef: requestId, signingRequestId: requestId, exchange: 'pdax', depositAddress: PAYEE, amountMinor: 5_000_000n, requestHash: 'h', provider: 'sandbox', sandbox: true, providerRef: 'sandbox_tr_1', status: 'submitted', createdBy: 'u', createdAt: T0, updatedAt: T0 });
  const deps = (env) => ({ db, orgId: 'acme', now: () => T0, readTransaction: async () => null, corePackageOriginalId: CORE, env });
  const dev = await controlsEvidenceFor(deps(TEST), requestId, 'u-owner');
  assert.ok(!dev.evidence.gaps.some((g) => /sandbox/i.test(g)), dev.evidence.gaps.join('\n'));
  const prod = await controlsEvidenceFor(deps(PROD), requestId, 'u-owner');
  assert.ok(prod.evidence.gaps.some((g) => /screening .*sandbox's, not a provider's answer/.test(g)), prod.evidence.gaps.join('\n'));
  assert.ok(prod.evidence.gaps.some((g) => /Travel Rule message .*sandbox's/.test(g)), prod.evidence.gaps.join('\n'));
  assert.ok(prod.evidence.gaps.some((g) => /No CLEAR screening of the recipient address/.test(g)), 'a sandbox CLEAR is not the CLEAR that applied');
  await client.close();
});

/* 5 ── A Solana recipient is screened by the wallet that owns its token account ── */

const SOL_TOKEN_ACCOUNT = '4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T';
const SOL_OWNER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';

/** A live provider whose answer depends on the address asked about. */
function scriptedProvider(verdicts, answeredAt = T0) {
  const asked = [];
  return {
    asked,
    provider: {
      id: 'elliptic',
      async screen(subject) {
        asked.push(subject);
        const verdict = verdicts[subject.address] ?? 'CLEAR';
        return { provider: 'elliptic', verdict, reference: `elliptic:${randomUUID()}`, detail: 'live', screenedAt: answeredAt.toISOString(), riskScore: 1 };
      },
    },
  };
}

const SOL_SUPPLIER = { name: 'Dela Cruz', legalName: 'Dela Cruz Trading Corp', registrationNumber: 'CS201912345', country: 'PH', addressLine1: '1 Ayala Ave', addressCity: 'Makati', email: 'ap@delacruz.test' };
const solanaChecker = { async check() { return { ok: true, tokenOwner: SOL_OWNER }; } };

async function saveSolana(db, kyt) {
  return createWalletRecipient(
    { db, orgId: 'acme', now: () => T0, kyt, solana: solanaChecker },
    { body: { ...SOL_SUPPLIER, deliveryKind: 'CROSS_CHAIN', chain: 'SOLANA', address: SOL_TOKEN_ACCOUNT, addressIsUsdcTokenAccount: true }, requestedBy: 'u-owner', requestedRole: 'OWNER' },
  );
}

test('a Solana recipient whose token account owner is BLOCKed is not saved, though the token account screens CLEAR', async () => {
  const { db, client } = await migratedDb();
  await client.exec(`INSERT INTO users (id, email, name) VALUES ('u-owner', 'owner@acme.test', 'Owner')`);
  const kyt = scriptedProvider({ [SOL_OWNER]: 'BLOCK' });
  const saved = await saveSolana(db, kyt.provider);
  assert.deepEqual([saved.ok, saved.status, saved.code], [false, 403, 'recipient_blocked'], show(saved));
  assert.deepEqual(kyt.asked.map((s) => [s.chain, s.address]).sort(), [['SOLANA', SOL_OWNER], ['SOLANA', SOL_TOKEN_ACCOUNT]].sort());
  assert.equal((await db.select().from(schema.suppliers).where(eq(schema.suppliers.destinationAddress, SOL_TOKEN_ACCOUNT))).length, 0, 'not saved');
  assert.equal((await latestScreening(db, 'acme', 'SOLANA', SOL_OWNER)).verdict, 'BLOCK', 'the owner screening is kept');

  // An owner in REVIEW: saved, and the recipient shows REVIEW, not the token account's CLEAR.
  const { db: db2, client: client2 } = await migratedDb();
  await client2.exec(`INSERT INTO users (id, email, name) VALUES ('u-owner', 'owner@acme.test', 'Owner')`);
  const review = await saveSolana(db2, scriptedProvider({ [SOL_OWNER]: 'REVIEW' }).provider);
  assert.equal(review.ok, true, show(review));
  const [row] = await db2.select().from(schema.suppliers).where(eq(schema.suppliers.id, review.recipient.id));
  assert.equal(row.screeningVerdict, 'REVIEW');
  assert.equal(review.ownerScreening?.verdict, 'REVIEW', show(review));
  await client.close();
  await client2.close();
});

test('a Solana payment is opened only when both the token account and its owner wallet are fresh CLEARs here', async () => {
  const { db, client } = await migratedDb();
  await client.exec(`INSERT INTO users (id, email, name) VALUES ('u-owner', 'owner@acme.test', 'Owner')`);
  const saved = await saveSolana(db, scriptedProvider({}).provider);
  assert.equal(saved.ok, true, show(saved));
  const open = (paymentRef, deps = {}) => openCrossChainTransfer(
    { db, orgId: 'acme', now: () => T0, requestedBy: 'u-owner', env: TEST, ...deps },
    { paymentRef, recipientId: saved.recipient.id, amountMinor: 1_000_000_000n, maxBridgeFeeMinor: 0n },
  );
  const ok = await open(normalizeSuiAddress(`0x${'f1'.repeat(32)}`));
  assert.equal(ok.ok, true, show(ok));

  // The owner BLOCKed since, the token account still CLEAR: refused.
  await pause();
  await recordScreening(db, kept(SOL_OWNER, { chain: 'SOLANA', kind: 'cross_chain_recipient', verdict: 'BLOCK' }));
  const blocked = await open(normalizeSuiAddress(`0x${'f2'.repeat(32)}`));
  assert.deepEqual([blocked.status, blocked.code], [403, 'recipient_blocked'], show(blocked));
  // And a retry of the receipt already opened is refused too.
  const retry = await open(normalizeSuiAddress(`0x${'f1'.repeat(32)}`));
  assert.deepEqual([retry.status, retry.code], [403, 'recipient_blocked'], show(retry));

  // The owner in REVIEW: refused.
  await pause();
  await recordScreening(db, kept(SOL_OWNER, { chain: 'SOLANA', kind: 'cross_chain_recipient', verdict: 'REVIEW' }));
  assert.equal((await open(normalizeSuiAddress(`0x${'f3'.repeat(32)}`))).code, 'recipient_in_review');

  // A stale owner CLEAR: screened again by the live provider.
  await pause();
  await recordScreening(db, kept(SOL_OWNER, { chain: 'SOLANA', kind: 'cross_chain_recipient' }));
  const later = new Date(T0.getTime() + 25 * HOUR);
  const live = scriptedProvider({}, later);
  const reopened = await open(normalizeSuiAddress(`0x${'f4'.repeat(32)}`), { now: () => later, kyt: live.provider });
  assert.equal(reopened.ok, true, show(reopened));
  assert.ok(live.asked.some((s) => s.address === SOL_OWNER), 'the owner is screened again');

  // No owner on file for a Solana recipient: it cannot be screened, so it is not paid.
  await db.update(schema.suppliers).set({ destinationTokenOwner: null }).where(eq(schema.suppliers.id, saved.recipient.id));
  const ownerless = await open(normalizeSuiAddress(`0x${'f5'.repeat(32)}`), { now: () => later });
  assert.deepEqual([ownerless.status, ownerless.code], [409, 'recipient_not_screened'], show(ownerless));
  await client.close();
});

test("a Solana payment's evidence lists its owner wallet's screenings, and says when the owner was not CLEAR before approval", async () => {
  const { db, client } = await migratedDb();
  await client.exec(`INSERT INTO users (id, email, name) VALUES ('u-owner', 'owner@acme.test', 'Owner')`);
  const saved = await saveSolana(db, scriptedProvider({}).provider);
  assert.equal(saved.ok, true, show(saved));
  const opened = await openCrossChainTransfer({ db, orgId: 'acme', now: () => T0, requestedBy: 'u-owner', env: TEST }, { paymentRef: INTENT, recipientId: saved.recipient.id, amountMinor: 1_000_000_000n, maxBridgeFeeMinor: 0n });
  assert.equal(opened.ok, true, show(opened));
  await recordScreening(db, kept(SOL_OWNER, { chain: 'SOLANA', kind: 'cross_chain_recipient', verdict: 'REVIEW', at: new Date(T0.getTime() + HOUR) }));
  const intent = { intentId: INTENT, recipient: PAYEE, amountMinor: '1000000000', kind: 3, targetCurrency: 'USDC', fxRateUsdLocal: '1000000', expiresAtMs: '9', asset: 'USDC' };
  const requestId = await signedRequest(db, { description: { actions: [{ type: 'pay_intent', asset: 'USDC', maxFeeMinor: '0', settleByMs: '2', paysFromCommand: 0, intentFromCommand: null, intent }] } });
  const ev = await controlsEvidenceFor({ db, orgId: 'acme', now: () => T0, readTransaction: async () => null, corePackageOriginalId: CORE, env: TEST }, requestId, 'u-owner');
  assert.equal(ev.ok, true, JSON.stringify(ev));
  const owner = ev.evidence.screenings.filter((s) => s.subject === 'cross_chain_recipient_owner');
  assert.deepEqual(owner.map((s) => [s.address, s.verdict]), [[SOL_OWNER, 'REVIEW'], [SOL_OWNER, 'CLEAR']]);
  const account = ev.evidence.screenings.filter((s) => s.subject === 'cross_chain_recipient');
  assert.deepEqual(account.map((s) => s.address), [SOL_TOKEN_ACCOUNT]);
  assert.ok(ev.evidence.gaps.some((g) => /No CLEAR screening of the wallet that owns the cross-chain recipient's token account/.test(g)), ev.evidence.gaps.join('\n'));
  assert.ok(!ev.evidence.gaps.some((g) => /No CLEAR screening of the cross-chain recipient was/.test(g)), 'the token account itself was CLEAR');
  await client.close();
});

/* 6 ── A sandbox Travel Rule message is replaced by the provider's ──────── */

test("a sandbox Travel Rule message on file is replaced when the payment's message is sent through the provider", async () => {
  const { db, client } = await migratedDb();
  const ref = normalizeSuiAddress(`0x${'a7'.repeat(32)}`);
  const sandboxId = `trt_${randomUUID()}`;
  await db.insert(schema.travelRuleTransfers).values({ id: sandboxId, orgId: 'acme', paymentRef: ref, signingRequestId: null, exchange: 'pdax', depositAddress: PAYEE, amountMinor: 1_000_000n, requestHash: 'sandbox-hash', provider: 'sandbox', sandbox: true, providerRef: 'sandbox_tr_1', status: 'approved', createdBy: 'u-dev', createdAt: T0, updatedAt: T0 });
  const payment = { recipient: PAYEE, kind: 2, paymentRef: ref };
  assert.equal((await travelRuleHold(db, { orgId: 'acme' }, payment, PROD)).code, 'travel_rule_missing');

  const calls = [];
  const live = { id: 'sumsub', sandbox: false, async submitOutbound(input) { calls.push(input); return { provider: 'sumsub', sandbox: false, reference: 'txn-live-1', status: 'submitted' }; } };
  const input = {
    intentId: ref, orgId: 'acme', applicantId: 'applicant-001', at: T0, amountMinor: 1_000_000n,
    originator: { legalName: 'Acme Trading Sdn Bhd', registrationNumber: '202001012345', country: 'MY', town: 'Kuala Lumpur', street: 'Jalan Ampang', postCode: '50450', walletAddress: WALLET },
    beneficiary: { legalName: 'Dela Cruz Trading Corp', registrationNumber: 'CS201912345', country: 'PH', town: 'Makati', exchange: 'pdax', depositAddress: PAYEE },
    purpose: null, signingRequestId: null, createdBy: 'u-owner',
  };
  const sent = await sendTravelRule({ db, provider: live, orgId: 'acme', now: () => T0 }, input);
  assert.equal(sent.ok, true, show(sent));
  assert.deepEqual([calls.length, sent.transfer.provider, sent.transfer.sandbox, sent.transfer.reference, sent.transfer.status], [1, 'sumsub', false, 'txn-live-1', 'submitted']);
  const rows = await db.select().from(schema.travelRuleTransfers).where(eq(schema.travelRuleTransfers.paymentRef, ref));
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].id, sandboxId, "the sandbox's late answer cannot land on the provider's row");
  assert.equal(await travelRuleHold(db, { orgId: 'acme' }, payment, PROD), null, "the provider's message lets it be signed");

  // A retry answers the provider's message; the sandbox may not replace it.
  assert.equal((await sendTravelRule({ db, provider: live, orgId: 'acme', now: () => T0 }, input)).transfer.reference, 'txn-live-1');
  assert.equal(calls.length, 1);
  const sandbox = { id: 'sandbox', sandbox: true, async submitOutbound() { throw new Error('not asked'); } };
  assert.equal((await sendTravelRule({ db, provider: sandbox, orgId: 'acme', now: () => T0 }, input)).code, 'travel_rule_conflict');
  await client.close();
});
