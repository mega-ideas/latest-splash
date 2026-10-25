/**
 * The §4.6 review's fixes: what the screening and the Travel Rule actually
 * hold back, and what the evidence says about the time of the payment.
 *
 * What must hold:
 *   - a wallet payment, an owners' payment of an open intent and an owner's
 *     second approval of a rule payment are opened only for a recipient
 *     whose newest screening at this business is CLEAR and fresh: BLOCK is
 *     403, REVIEW and unscreened are 409, a stale CLEAR is screened again
 *     when a provider is at hand and refused when not;
 *   - the same check runs again before every signature, and a wallet
 *     payment to an exchange recipient is not signed until its Travel Rule
 *     message is with the provider; a rejected message refuses, on hold
 *     holds;
 *   - a KYB verdict lost to a failure of ours is delivered again, and only
 *     the state machine's own refusal is acknowledged;
 *   - a screening kept is the screening of the address asked about;
 *   - the evidence separates what was screened before the payment was
 *     approved from what came after, and says so when nothing CLEAR came
 *     before, or when the Travel Rule message is missing;
 *   - the Travel Rule message names one saved recipient, goes once under
 *     concurrency, and a send whose outcome is unknown is held, not lost;
 *   - the originator is the business the provider verified;
 *   - the evidence refuses an account number under any key;
 *   - production refuses SHA-1 webhooks unless switched on, and only an
 *     owner opens a KYB session.
 *
 * PGlite with every migration. Nothing reaches a network, nothing is signed
 * for any network.
 */
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { fromBase64, normalizeSuiAddress } from '@mysten/sui/utils';

import * as schema from '../lib/db/schema.ts';
import { assertEvidenceClean, EvidenceLeak } from '../lib/compliance/controls-evidence.ts';
import { KybTransitionError } from '../lib/compliance/kyb-state.ts';
import { kytProviderFromEnv } from '../lib/compliance/kyt.ts';
import { verifySumsubWebhook } from '../lib/compliance/sumsub.ts';
import { buildBusinessMultisig } from '../lib/wallet/business-multisig.ts';
import { requestOpenIntentPayment, requestWalletPayment, startBusinessWallet } from '../lib/server/business-wallet.ts';
import { controlsEvidenceFor } from '../lib/server/controls-evidence.ts';
import { travelRuleForPayment } from '../lib/server/exchange-payment-compliance.ts';
import { recordScreening, recipientScreeningGate } from '../lib/server/kyt-screenings.ts';
import { paymentBeforeSign } from '../lib/server/payment-compliance-gate.ts';
import { handleSumsubWebhook } from '../lib/server/sumsub-webhook.ts';
import { applyTravelRuleEvent, readTravelRuleTransfer } from '../lib/server/travel-rule-transfers.ts';
import { signingInbox, submitPartialSignature } from '../lib/server/wallet-signing.ts';

import { migratedDb } from './helpers/store-db.mjs';
import { ACCOUNT, T0, USDC, world } from './fixtures/wallet-world.mjs';

const PAYEE = normalizeSuiAddress('0x' + '77'.repeat(32));
const INTENT = normalizeSuiAddress('0x' + '99'.repeat(32));
const HOUR = 3_600_000;

const clear = (address, { at = T0, ref = `elliptic:${randomUUID()}`, verdict = 'CLEAR', kind = 'wallet_recipient', orgId = 'acme' } = {}) => ({
  orgId, kind, chain: 'SUI', address, requestedBy: 'u-two',
  screening: { provider: 'elliptic', verdict, reference: verdict ? ref : null, detail: 'x', screenedAt: verdict ? at.toISOString() : null, riskScore: 0.5 },
});

async function sign(passkey, view) {
  return (await passkey.keypair.signTransaction(fromBase64(view.transactionBytes))).signature;
}

async function signBy(w, view, ...who) {
  let last;
  for (const name of who) {
    last = await submitPartialSignature(w.signing, { orgId: 'acme', userId: name === 'founder' ? 'u-founder' : `u-${name}`, id: view.id, signature: await sign(w.keys[name], view), digest: view.digest });
  }
  return last;
}

async function registered(w) {
  const started = await startBusinessWallet(w.ctx, { orgId: 'acme', requestedBy: 'u-founder', founder: { userId: 'u-founder', passkeyPublicKey: w.keys.founder.publicKey }, owners: w.owners });
  assert.equal(started.ok, true, JSON.stringify(started));
  await signBy(w, started.request, 'founder');
  const [register] = await signingInbox(w.signing, { orgId: 'acme', userId: 'u-two' });
  const done = await signBy(w, register, 'two', 'three');
  assert.equal(done.request.status, 'executed');
  w.notices.length = 0;
  const wallet = buildBusinessMultisig({ members: w.owners });
  return { wallet, members: { multisigPublicKey: wallet.multisigPublicKey, members: wallet.members.map((m) => ({ userId: m.userId, publicKey: m.suiPublicKey, weight: m.weight })) } };
}

const bytes32 = (b) => new Uint8Array(32).fill(b);
function payment(overrides = {}) {
  return {
    paymentRef: bytes32(1), recipient: PAYEE, beneficiaryRef: new Uint8Array(), amountMinor: 250_000_000n, targetCurrency: 'USDC', fxRateUsdLocal: 1_000_000n,
    commitment: bytes32(2), kind: 1, railCommitment: bytes32(3), expiresAtMs: BigInt(T0.getTime() + 7 * 24 * HOUR), maxFeeMinor: 250_000n,
    settleByMs: BigInt(T0.getTime() + 5 * 60_000), contentHash: bytes32(4), walrusBlobId: new TextEncoder().encode('blob-1'), ...overrides,
  };
}
function staffIntent(overrides = {}) {
  return { id: INTENT, initialSharedVersion: 7, account: ACCOUNT, recipient: PAYEE, amountMinor: 12_500_000n, kind: 1, targetCurrency: 'USDC', fxRateUsdLocal: 1_000_000n, expiresAtMs: BigInt(T0.getTime() + 3 * 24 * HOUR), status: 0, asset: USDC, maker: '0x' + '42'.repeat(32), beneficiaryRef: '', ...overrides };
}
const audit = { contentHash: bytes32(4), walrusBlobId: new TextEncoder().encode('blob-1') };

/* 1 ── The recipient's screening holds the payment back ───────────────── */

test('a wallet payment is opened only for a recipient whose newest screening here is CLEAR', async () => {
  const w = await world();
  const { members } = await registered(w);
  const pay = (n) => requestWalletPayment(w.ctx, { orgId: 'acme', requestedBy: 'u-two', wallet: members, payment: payment({ paymentRef: bytes32(n) }) });

  const unscreened = await pay(1);
  assert.deepEqual([unscreened.ok, unscreened.status, unscreened.code], [false, 409, 'recipient_not_screened']);
  // Another business's CLEAR does not count here.
  await recordScreening(w.db, clear(PAYEE, { orgId: 'northwind' }));
  assert.equal((await pay(1)).code, 'recipient_not_screened');
  await recordScreening(w.db, clear(PAYEE, { verdict: 'REVIEW', at: new Date(T0.getTime() - 3000) }));
  assert.deepEqual([(await pay(1)).status, (await pay(1)).code], [409, 'recipient_in_review']);
  await new Promise((r) => setTimeout(r, 5));
  await recordScreening(w.db, clear(PAYEE, { verdict: 'BLOCK', at: new Date(T0.getTime() - 2000) }));
  assert.deepEqual([(await pay(1)).status, (await pay(1)).code], [403, 'recipient_blocked']);
  await new Promise((r) => setTimeout(r, 5));
  // An unanswered screening is not an answer.
  await recordScreening(w.db, clear(PAYEE, { verdict: null }));
  assert.equal((await pay(1)).code, 'recipient_not_screened');
  assert.equal((await w.db.select().from(schema.walletSigningRequests)).filter((r) => r.purpose === 'wallet_payment').length, 0, 'nothing was stored');
  await new Promise((r) => setTimeout(r, 5));
  await recordScreening(w.db, clear(PAYEE, { at: new Date(T0.getTime() - 1000) }));
  const opened = await pay(1);
  assert.equal(opened.ok, true, JSON.stringify(opened));
  await w.client.close();
});

test('a CLEAR older than the screening age is screened again, or refused when no provider is at hand', async () => {
  const w = await world();
  const { members } = await registered(w);
  await recordScreening(w.db, clear(PAYEE, { at: new Date(T0.getTime() - 25 * HOUR) }));
  const pay = (n) => requestWalletPayment(w.ctx, { orgId: 'acme', requestedBy: 'u-two', wallet: members, payment: payment({ paymentRef: bytes32(n) }) });
  assert.deepEqual([(await pay(1)).status, (await pay(1)).code], [409, 'recipient_screening_stale']);
  // With the server's provider (the sandbox here), it is screened again and kept.
  w.ctx.kyt = kytProviderFromEnv({ NODE_ENV: 'test' }, { now: () => T0 });
  const opened = await pay(1);
  assert.equal(opened.ok, true, JSON.stringify(opened));
  const rows = await w.db.select().from(schema.kytScreenings);
  assert.equal(rows.length, 2);
  assert.ok(rows.some((r) => r.provider === 'sandbox' && r.verdict === 'CLEAR' && r.address === PAYEE));
  // A fresh re-screen that blocks refuses.
  const DEAD = normalizeSuiAddress('0x' + '55'.repeat(30) + 'dead');
  await recordScreening(w.db, clear(DEAD, { at: new Date(T0.getTime() - 48 * HOUR) }));
  const blocked = await requestWalletPayment(w.ctx, { orgId: 'acme', requestedBy: 'u-two', wallet: members, payment: payment({ paymentRef: bytes32(2), recipient: DEAD }) });
  assert.deepEqual([blocked.status, blocked.code], [403, 'recipient_blocked']);
  await w.client.close();
});

test("the owners' payment of an open intent is held to the same screening", async () => {
  const w = await world();
  const { members } = await registered(w);
  w.model.addIntent(staffIntent());
  const ask = { orgId: 'acme', requestedBy: 'u-two', wallet: members, intentId: INTENT, maxFeeMinor: 0n, settleByMs: BigInt(T0.getTime() + 60_000), ...audit };
  assert.equal((await requestOpenIntentPayment(w.ctx, ask)).code, 'recipient_not_screened');
  await recordScreening(w.db, clear(PAYEE, { verdict: 'BLOCK' }));
  assert.deepEqual([(await requestOpenIntentPayment(w.ctx, ask)).status, (await requestOpenIntentPayment(w.ctx, ask)).code], [403, 'recipient_blocked']);
  await w.client.close();
});

test('the screening gate reads the newest screening of this business, by chain and address', async () => {
  const { db, client } = await migratedDb();
  const deps = { db, orgId: 'acme', now: T0, requestedBy: 'u' };
  assert.equal((await recipientScreeningGate(deps, PAYEE)).code, 'recipient_not_screened');
  await recordScreening(db, clear(PAYEE));
  assert.equal(await recipientScreeningGate(deps, PAYEE), null);
  assert.equal(await recipientScreeningGate(deps, '0x' + '77'.repeat(32)), null, 'the same address, written either way');
  assert.equal((await recipientScreeningGate({ ...deps, orgId: 'northwind' }, PAYEE)).code, 'recipient_not_screened');
  // A screening dated ahead of the clock is not fresh either.
  await recordScreening(db, clear(INTENT, { at: new Date(T0.getTime() + HOUR) }));
  assert.equal((await recipientScreeningGate(deps, INTENT)).code, 'recipient_screening_stale');
  await client.close();
});

/* 2 ── Before each signature ────────────────────────────────────────────── */

test('every signature of a wallet payment re-checks the screening, and an exchange payment waits for its Travel Rule message', async () => {
  const w = await world();
  const { members } = await registered(w);
  w.signing.beforeSign = (request) => paymentBeforeSign({ db: w.db, now: () => T0 }, request);
  await recordScreening(w.db, clear(PAYEE));
  const opened = await requestWalletPayment(w.ctx, { orgId: 'acme', requestedBy: 'u-two', wallet: members, payment: payment() });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  // Blocked after it was opened: no one may sign it.
  await new Promise((r) => setTimeout(r, 5));
  await recordScreening(w.db, clear(PAYEE, { verdict: 'BLOCK' }));
  const refused = await submitPartialSignature(w.signing, { orgId: 'acme', userId: 'u-two', id: opened.request.id, signature: await sign(w.keys.two, opened.request), digest: opened.request.digest });
  assert.deepEqual([refused.ok, refused.code], [false, 'recipient_blocked']);

  // An exchange payment: CLEAR, but no Travel Rule message yet.
  const EXCHANGE = normalizeSuiAddress('0x' + '66'.repeat(32));
  await recordScreening(w.db, clear(EXCHANGE, { kind: 'exchange_recipient' }));
  const ex = await requestWalletPayment(w.ctx, { orgId: 'acme', requestedBy: 'u-two', wallet: members, payment: payment({ paymentRef: bytes32(5), recipient: EXCHANGE, kind: 2 }) });
  assert.equal(ex.ok, true, JSON.stringify(ex));
  const stored = async () => (await import('../lib/server/wallet-signing-store.ts')).readSigningRequest(w.db, 'acme', ex.request.id);
  assert.equal((await paymentBeforeSign({ db: w.db, now: () => T0 }, await stored())).code, 'travel_rule_missing');
  const now = T0;
  const row = (status, providerRef) => ({ id: `trt_${randomUUID()}`, orgId: 'acme', paymentRef: ex.request.id, signingRequestId: ex.request.id, exchange: 'pdax', depositAddress: EXCHANGE, amountMinor: 250_000_000n, requestHash: 'h', provider: 'sumsub', sandbox: false, providerRef, status, createdBy: 'u', createdAt: now, updatedAt: now });
  await w.db.insert(schema.travelRuleTransfers).values(row('preparing', null));
  assert.equal((await paymentBeforeSign({ db: w.db, now: () => T0 }, await stored())).code, 'travel_rule_missing', 'not yet with the provider');
  for (const [status, code] of [['on_hold', 'travel_rule_on_hold'], ['rejected', 'travel_rule_rejected'], ['submitted', null], ['approved', null]]) {
    await w.client.exec(`UPDATE travel_rule_transfers SET status = '${status}', provider_ref = 'txn-1'`);
    const r = await paymentBeforeSign({ db: w.db, now: () => T0 }, await stored());
    assert.equal(r?.code ?? null, code, status);
  }
  // Signing then goes ahead.
  const signed = await submitPartialSignature(w.signing, { orgId: 'acme', userId: 'u-two', id: ex.request.id, signature: await sign(w.keys.two, ex.request), digest: ex.request.digest });
  assert.equal(signed.ok, true, JSON.stringify(signed));

  // An address this business screened as an exchange's is an exchange payment whatever kind it is sent as.
  const EX2 = normalizeSuiAddress('0x' + '65'.repeat(32));
  await recordScreening(w.db, clear(EX2, { kind: 'exchange_recipient' }));
  const disguised = await requestWalletPayment(w.ctx, { orgId: 'acme', requestedBy: 'u-two', wallet: members, payment: payment({ paymentRef: bytes32(6), recipient: EX2, kind: 1 }) });
  assert.equal(disguised.ok, true);
  const d = await (await import('../lib/server/wallet-signing-store.ts')).readSigningRequest(w.db, 'acme', disguised.request.id);
  assert.equal((await paymentBeforeSign({ db: w.db, now: () => T0 }, d)).code, 'travel_rule_missing');
  await w.client.close();
});

test('the live wiring runs the payment check before each signature', async () => {
  const deps = await readFile(new URL('../lib/server/wallet-deps.ts', import.meta.url), 'utf8');
  assert.match(deps, /paymentBeforeSign/);
  assert.match(deps, /kyt: kytProviderFromEnv\(\)/);
});

/* 3 ── A KYB verdict is not lost to a failure of ours ───────────────────── */

const WEBHOOK_SECRET = 'whsec-test-1';
const stamp = (d) => d.toISOString().replace('T', ' ').replace('Z', '');
function signedHook(payload, alg = 'HMAC_SHA256_HEX') {
  const raw = JSON.stringify(payload);
  const algorithm = alg === 'HMAC_SHA256_HEX' ? 'sha256' : 'sha1';
  return { raw, digest: createHmac(algorithm, WEBHOOK_SECRET).update(raw).digest('hex'), alg };
}

test('a database failure while applying a KYB verdict releases the delivery, and the redelivery applies it', async () => {
  const { db, client } = await migratedDb();
  let fail = true;
  const applied = [];
  const deps = {
    db, secret: WEBHOOK_SECRET, production: false, now: () => T0,
    applyKyb: async (orgId, next) => {
      if (fail) throw new Error('connection terminated');
      applied.push([orgId, next]);
      return { from: 'KYB_SUBMITTED', to: next };
    },
  };
  const green = signedHook({ type: 'applicantReviewed', externalUserId: 'org:acme', reviewResult: { reviewAnswer: 'GREEN' }, createdAtMs: stamp(T0) });
  await assert.rejects(handleSumsubWebhook(deps, green), /connection terminated/);
  assert.equal((await db.select().from(schema.webhookEvents)).length, 0, 'the claim is released');
  fail = false;
  const again = await handleSumsubWebhook(deps, green);
  assert.deepEqual([again.status, again.body.applied], [200, true], JSON.stringify(again));
  assert.deepEqual(applied, [['acme', 'KYB_PROVIDER_APPROVED']]);
  // The state machine's own refusal is still acknowledged.
  const refusing = { ...deps, applyKyb: async () => { throw new KybTransitionError('ACTIVE', 'REJECTED', 'PROVIDER', 'not reachable'); } };
  const late = await handleSumsubWebhook(refusing, signedHook({ type: 'applicantReviewed', externalUserId: 'org:acme', reviewResult: { reviewAnswer: 'RED', reviewRejectType: 'FINAL' }, createdAtMs: stamp(T0) }));
  assert.deepEqual([late.status, late.body.applied, late.body.reason], [200, false, 'transition not permitted']);
  await client.close();
});

test('production refuses a SHA-1 webhook unless the transition switch is on', () => {
  const p = { type: 'applicantReviewed', externalUserId: 'org:acme', createdAtMs: stamp(T0) };
  for (const alg of ['HMAC_SHA1_HEX', '']) {
    const s = signedHook(p, alg);
    assert.equal(verifySumsubWebhook({ ...s, secret: WEBHOOK_SECRET, now: T0, allowSha1: false }).reason, 'weak_algorithm', alg);
    assert.equal(verifySumsubWebhook({ ...s, secret: WEBHOOK_SECRET, now: T0, allowSha1: true }).ok, true, alg);
  }
  assert.equal(verifySumsubWebhook({ ...signedHook(p), secret: WEBHOOK_SECRET, now: T0, allowSha1: false }).ok, true);
});

test('the webhook route allows SHA-1 outside production or by switch only, and the KYB session is opened by an owner', async () => {
  const route = await readFile(new URL('../app/api/webhooks/sumsub/route.ts', import.meta.url), 'utf8');
  assert.match(route, /allowSha1: !isProductionRuntime\(\) \|\| process\.env\.SUMSUB_WEBHOOK_ALLOW_SHA1 === 'true'/);
  const kyb = await readFile(new URL('../app/api/kyb/sumsub/route.ts', import.meta.url), 'utf8');
  assert.match(kyb, /accountCheck\.account\.role !== 'admin'/);
});

/* 4 ── A screening kept is the screening of the address asked about ─────── */

test('two addresses answered under one provider reference each keep their own screening', async () => {
  const { db, client } = await migratedDb();
  const A = normalizeSuiAddress('0x' + '0a'.repeat(32));
  const B = normalizeSuiAddress('0x' + '0b'.repeat(32));
  const a = await recordScreening(db, clear(A, { ref: 'chainalysis:sanctions:2026-10-25T08:00:00.000Z' }));
  const b = await recordScreening(db, clear(B, { ref: 'chainalysis:sanctions:2026-10-25T08:00:00.000Z' }));
  assert.equal(a.address, A);
  assert.equal(b.address, B, 'never another address');
  // The same answer offered again for the same address is the same row.
  const a2 = await recordScreening(db, clear(A, { ref: 'chainalysis:sanctions:2026-10-25T08:00:00.000Z' }));
  assert.equal(a2.id, a.id);
  // The Chainalysis fallback's reference names the address.
  const fetcher = async () => new Response(JSON.stringify({ identifications: [] }), { status: 200 });
  const kyt = kytProviderFromEnv({ NODE_ENV: 'production', CHAINALYSIS_SANCTIONS_API_KEY: 'k' }, { fetcher, now: () => T0 });
  const [sa, sb] = await Promise.all([kyt.screen({ chain: 'SUI', address: A, direction: 'recipient' }), kyt.screen({ chain: 'SUI', address: B, direction: 'recipient' })]);
  assert.equal(sa.verdict, 'CLEAR');
  assert.notEqual(sa.reference, sb.reference);
  assert.ok(sa.reference.includes(A));
  await client.close();
});

/* 5 ── The evidence is about the time of the payment ────────────────────── */

async function evidenceWorld() {
  const { db, client } = await migratedDb();
  await client.exec(`INSERT INTO users (id, email, name) VALUES ('u-owner', 'owner@acme.test', 'Owner'), ('u-owner2', 'owner2@acme.test', 'Owner Two')`);
  await client.exec(`UPDATE organizations SET legal_name = 'Acme Trading Sdn Bhd', registration_number = '202001012345', address_line1 = 'Jalan Ampang', address_city = 'Kuala Lumpur', address_postal_code = '50450', address_country = 'MY', kyb_lifecycle = 'ACTIVE' WHERE id = 'acme'`);
  await db.insert(schema.kybCases).values({ id: 'kyb_acme_1', orgId: 'acme', businessName: 'Acme Trading Sdn Bhd', registrationNumber: '202001012345', state: 'APPROVED', sumsubApplicantId: 'applicant-001', updatedAt: new Date(T0.getTime() - 30 * 24 * HOUR) });
  return { db, client };
}

const WALLET = `0x${'b2'.repeat(32)}`;
async function walletPaymentRequest(db, { recipient = PAYEE, kind = 1, status = 'executed', signedAt = T0, amountMinor = '1250500000' } = {}) {
  const id = `wsr_${randomUUID()}`;
  await db.insert(schema.walletSigningRequests).values({
    id, orgId: 'acme', purpose: 'wallet_payment', dedupeKey: id, senderAddress: WALLET, signerKind: 'multisig', multisigPublicKey: 'msig-pk', threshold: 2, gasMode: 'sponsored',
    txBytes: 'AAAA', txDigest: `digest-${id}`, bytesHash: 'h'.repeat(64), status, requestedBy: 'u-owner', expiresAt: new Date(T0.getTime() + HOUR), executedDigest: status === 'executed' ? 'D1gest' : null, createdAt: new Date(signedAt.getTime() - HOUR),
    summary: { description: { actions: [{ type: 'open_intent', asset: 'USDC', recipient, amountMinor, kind, targetCurrency: 'USD', fxRateUsdLocal: '1000000', beneficiaryRef: '00', expiresAtMs: '9' }, { type: 'pay_intent', asset: 'USDC', maxFeeMinor: '1', settleByMs: '9', paysFromCommand: 0, intentFromCommand: 0, intent: null }] } },
  });
  const done = status === 'collecting' ? null : signedAt;
  await db.insert(schema.walletSigningSigners).values([
    { requestId: id, orgId: 'acme', userId: 'u-owner', address: `0x${'01'.repeat(32)}`, publicKey: 'pk-1', weight: 1, signedAt: done ? new Date(done.getTime() - 60_000) : null, signatureSha256: done ? 's'.repeat(64) : null },
    { requestId: id, orgId: 'acme', userId: 'u-owner2', address: `0x${'02'.repeat(32)}`, publicKey: 'pk-2', weight: 1, signedAt: done, signatureSha256: done ? 't'.repeat(64) : null },
  ]);
  return id;
}
const evDeps = (db) => ({ db, orgId: 'acme', now: () => new Date(T0.getTime() + 10 * 24 * HOUR), readTransaction: async () => null, corePackageOriginalId: null });

test('a screening made after the payment was approved is listed apart, and a payment with no CLEAR before it says so', async () => {
  const w = await evidenceWorld();
  const id = await walletPaymentRequest(w.db);
  // Day 10: screened CLEAR, after the payment.
  await recordScreening(w.db, clear(PAYEE, { at: new Date(T0.getTime() + 10 * 24 * HOUR) }));
  const r = await controlsEvidenceFor(evDeps(w.db), id, 'u-owner');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.evidence.screenings.length, 0, 'nothing screened before the payment');
  assert.equal(r.evidence.screeningsAfterApproval.length, 1);
  assert.equal(r.evidence.approvedAt, T0.toISOString());
  assert.ok(r.evidence.gaps.some((g) => /no CLEAR screening .* before the payment was approved/i.test(g)), r.evidence.gaps.join(' | '));

  // A REVIEW before it, the CLEAR after: still a gap.
  await recordScreening(w.db, clear(PAYEE, { verdict: 'REVIEW', at: new Date(T0.getTime() - HOUR) }));
  const r2 = await controlsEvidenceFor(evDeps(w.db), id, 'u-owner');
  assert.equal(r2.evidence.screenings.length, 1);
  assert.equal(r2.evidence.screenings[0].verdict, 'REVIEW');
  assert.ok(r2.evidence.gaps.some((g) => /no CLEAR screening/i.test(g)));

  // The KYB case changed after the payment: said.
  await w.client.exec(`UPDATE kyb_cases SET updated_at = '${new Date(T0.getTime() + 2 * 24 * HOUR).toISOString()}'`);
  const r3 = await controlsEvidenceFor(evDeps(w.db), id, 'u-owner');
  assert.ok(r3.evidence.gaps.some((g) => /KYB case changed after the payment was approved/i.test(g)), r3.evidence.gaps.join(' | '));
  await w.client.close();
});

test('a CLEAR before approval leaves no screening gap, and an exchange payment without its Travel Rule message is a gap', async () => {
  const w = await evidenceWorld();
  const id = await walletPaymentRequest(w.db, { kind: 2 });
  await recordScreening(w.db, clear(PAYEE, { at: new Date(T0.getTime() - HOUR), kind: 'exchange_recipient' }));
  const r = await controlsEvidenceFor(evDeps(w.db), id, 'u-owner');
  assert.equal(r.evidence.screenings.length, 1);
  assert.ok(!r.evidence.gaps.some((g) => /screening/i.test(g)), r.evidence.gaps.join(' | '));
  assert.ok(r.evidence.gaps.some((g) => /Travel Rule message/i.test(g)), r.evidence.gaps.join(' | '));
  await w.client.close();
});

/* 6 ── The Travel Rule message ──────────────────────────────────────────── */

async function exchangeSetup() {
  const w = await evidenceWorld();
  await w.client.exec(`UPDATE organizations SET kyb_lifecycle = 'ACTIVE' WHERE id = 'acme'`);
  const id = await walletPaymentRequest(w.db, { kind: 2, status: 'collecting' });
  await recordScreening(w.db, clear(PAYEE, { kind: 'exchange_recipient' }));
  return { ...w, id };
}
const SUPPLIER = { name: 'Dela Cruz', country: 'PH', legalName: 'Dela Cruz Trading Corp', registrationNumber: 'CS201912345', town: 'Makati', street: 'Ayala Avenue', postCode: '1226' };

test('the Travel Rule message names one saved recipient, and goes once when two callers ask together', async () => {
  const w = await exchangeSetup();
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const provider = { id: 'sumsub', sandbox: false, async submitOutbound() { calls += 1; await gate; return { provider: 'sumsub', sandbox: false, reference: 'txn-sumsub-9', status: 'submitted' }; } };
  const d = { db: w.db, orgId: 'acme', now: () => T0, recipientAt: async () => SUPPLIER, provider };
  const ambiguous = await travelRuleForPayment({ ...d, recipientAt: async () => ({ ambiguous: true }) }, { requestId: w.id, exchange: 'pdax', createdBy: 'u' });
  assert.deepEqual([ambiguous.status, ambiguous.code], [409, 'recipient_ambiguous']);
  const one = travelRuleForPayment(d, { requestId: w.id, exchange: 'pdax', createdBy: 'u' });
  await new Promise((r) => setTimeout(r, 20));
  const two = await travelRuleForPayment(d, { requestId: w.id, exchange: 'pdax', createdBy: 'u' });
  assert.deepEqual([two.ok, two.code], [false, 'travel_rule_in_progress']);
  release();
  const first = await one;
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(calls, 1);
  await w.client.close();
});

test('a send Sumsub says it already has is held as unconfirmed, and its webhook by txnId recovers it', async () => {
  const w = await exchangeSetup();
  const { ComplianceProviderUnavailable } = await import('../lib/compliance/sumsub.ts');
  const provider = { id: 'sumsub', sandbox: false, async submitOutbound() { throw new ComplianceProviderUnavailable('provider_conflict', 'Sumsub answered 409.'); } };
  const d = { db: w.db, orgId: 'acme', now: () => T0, recipientAt: async () => SUPPLIER, provider };
  const r = await travelRuleForPayment(d, { requestId: w.id, exchange: 'pdax', createdBy: 'u' });
  assert.deepEqual([r.ok, r.code], [false, 'travel_rule_unconfirmed']);
  assert.equal((await readTravelRuleTransfer(w.db, 'acme', w.id)).status, 'unconfirmed');
  // Asked again, it is not sent again.
  assert.equal((await travelRuleForPayment(d, { requestId: w.id, exchange: 'pdax', createdBy: 'u' })).code, 'travel_rule_unconfirmed');
  // Sumsub's webhook for that txnId, for this business, names its reference.
  assert.equal((await applyTravelRuleEvent(w.db, { provider: 'sumsub', reference: 'txn-sumsub-x', txnId: w.id, status: 'approved', orgId: 'northwind' }, T0)).applied, false, 'not another business');
  const rec = await applyTravelRuleEvent(w.db, { provider: 'sumsub', reference: 'txn-sumsub-x', txnId: w.id, status: 'approved', orgId: 'acme' }, T0);
  assert.equal(rec.applied, true, JSON.stringify(rec));
  const row = await readTravelRuleTransfer(w.db, 'acme', w.id);
  assert.deepEqual([row.status, row.providerRef], ['approved', 'txn-sumsub-x']);
  // A plain failure goes back to preparing and can be retried.
  const w2 = await exchangeSetup();
  let n = 0;
  const flaky = { id: 'sumsub', sandbox: false, async submitOutbound() { n += 1; if (n === 1) throw new ComplianceProviderUnavailable('provider_error', 'Sumsub answered 500.'); return { provider: 'sumsub', sandbox: false, reference: 'txn-ok', status: 'submitted' }; } };
  const d2 = { ...d, db: w2.db, provider: flaky };
  assert.equal((await travelRuleForPayment(d2, { requestId: w2.id, exchange: 'pdax', createdBy: 'u' })).code, 'provider_error');
  assert.equal((await travelRuleForPayment(d2, { requestId: w2.id, exchange: 'pdax', createdBy: 'u' })).ok, true);
  await w.client.close();
  await w2.client.close();
});

test("the originator is the business the provider verified, and only once it is approved", async () => {
  const w = await exchangeSetup();
  const calls = [];
  const provider = { id: 'sumsub', sandbox: false, async submitOutbound(input) { calls.push(input); return { provider: 'sumsub', sandbox: false, reference: 'txn-1', status: 'submitted' }; } };
  const d = { db: w.db, orgId: 'acme', now: () => T0, recipientAt: async () => SUPPLIER, provider };
  await w.client.exec(`UPDATE organizations SET kyb_lifecycle = 'KYB_SUBMITTED' WHERE id = 'acme'`);
  assert.equal((await travelRuleForPayment(d, { requestId: w.id, exchange: 'pdax', createdBy: 'u' })).code, 'kyb_not_approved');
  await w.client.exec(`UPDATE organizations SET kyb_lifecycle = 'ACTIVE', legal_name = 'Someone Else Ltd', registration_number = '999' WHERE id = 'acme'`);
  const sent = await travelRuleForPayment(d, { requestId: w.id, exchange: 'pdax', createdBy: 'u' });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  assert.deepEqual([calls[0].originator.legalName, calls[0].originator.registrationNumber], ['Acme Trading Sdn Bhd', '202001012345']);
  await w.client.close();
});

test('a later payment to the same deposit address names the same exchange', async () => {
  const w = await exchangeSetup();
  const provider = { id: 'sumsub', sandbox: false, async submitOutbound(input) { return { provider: 'sumsub', sandbox: false, reference: `txn-${input.intentId}`, status: 'submitted' }; } };
  const d = { db: w.db, orgId: 'acme', now: () => T0, recipientAt: async () => SUPPLIER, provider };
  assert.equal((await travelRuleForPayment(d, { requestId: w.id, exchange: 'pdax', createdBy: 'u' })).ok, true);
  const second = await walletPaymentRequest(w.db, { kind: 2, status: 'collecting', amountMinor: '5000000' });
  assert.equal((await travelRuleForPayment(d, { requestId: second, exchange: 'bitkub', createdBy: 'u' })).code, 'exchange_mismatch');
  assert.equal((await travelRuleForPayment(d, { requestId: second, exchange: 'pdax', createdBy: 'u' })).ok, true);
  await w.client.close();
});

/* 7 ── No account number under any key ──────────────────────────────────── */

test('the evidence refuses an account number under any key, and keeps amounts, times and ids', () => {
  for (const leak of [{ iban: 'x' }, { creditorAccount: 'x' }, { accountNo: 'x' }, { x: { remittanceInfo: 'pay to 001234567890' } }, { y: 'GB33BUKB20201555555555' }, { z: '1234 5678 9012' }]) {
    assert.throws(() => assertEvidenceClean(leak), EvidenceLeak, JSON.stringify(leak));
  }
  assert.doesNotThrow(() => assertEvidenceClean({
    amountMinor: '1250500000', maxFeeMinor: '2500000', rateMicro: '56000000', receiveMinor: '5590000', settleByMs: '1792195200000', riskScore: '0.4',
    createdAt: '2026-10-25T08:00:00.000Z', ref: 'wdr_00000000-0000-4000-8000-000000000001', address: `0x${'01'.repeat(32)}`, creditorAccountLast4: '****7890',
    receiptId: 'Fq3nXdigest1111111111111111111111111111111#2', contentHash: 'ab'.repeat(32), threshold: 2,
  }));
});
