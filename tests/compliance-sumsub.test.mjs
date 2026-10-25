/**
 * Sumsub (v2 §4.6, D8): the KYB adapter, the webhook, and the Travel Rule
 * for payments to exchange recipients.
 *
 * What must hold:
 *   - KYB: the applicant is the business (`org:<orgId>`), the request is
 *     signed as Sumsub documents it, production without credentials refuses
 *     and never reaches the sandbox, the sandbox is labelled;
 *   - the webhook verifies before it reads, inside a retry window, applies
 *     each delivery once, names the org only by `externalUserId`, moves a
 *     business only as the PROVIDER actor, never backwards, and treats a RED
 *     the applicant may retry as no verdict;
 *   - the Travel Rule message goes once per payment (Sumsub's txnId is the
 *     payment), a retry answers the same transfer and anything different is
 *     refused, a failed send records nothing as sent, production refuses
 *     without Sumsub's Travel Rule switched on, and a webhook moves a
 *     transfer forward only, for its own reference, txnId and business.
 *
 * PGlite with every migration. Nothing reaches a network.
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import { eq } from 'drizzle-orm';

import * as schema from '../lib/db/schema.ts';
import {
  ComplianceProviderUnavailable,
  kybDecision,
  kybProviderFromEnv,
  sumsubSignature,
  sumsubTravelRuleBody,
  SUMSUB_WEBHOOK_MAX_AGE_MS,
  travelRuleAdvances,
  travelRuleProviderFromEnv,
  travelRuleStatusOf,
  verifySumsubWebhook,
} from '../lib/compliance/sumsub.ts';
import { handleSumsubWebhook } from '../lib/server/sumsub-webhook.ts';
import { readTravelRuleTransfer, sendTravelRule } from '../lib/server/travel-rule-transfers.ts';

import { migratedDb } from './helpers/store-db.mjs';

const T0 = new Date('2026-10-25T08:00:00Z');
const PROD = { NODE_ENV: 'production' };
const SUMSUB = { SUMSUB_APP_TOKEN: 'sbx:app-token', SUMSUB_SECRET_KEY: 'sumsub-secret-key' };
const WEBHOOK_SECRET = 'webhook-secret-123';
const INTENT = `0x${'a1'.repeat(32)}`;
const WALLET = `0x${'b2'.repeat(32)}`;
const DEPOSIT = `0x${'c3'.repeat(32)}`;

function sumsubFetcher(routes) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    for (const [match, answer] of routes) {
      if (url.includes(match)) {
        const a = typeof answer === 'function' ? answer(url, init, calls.length) : answer;
        return new Response(JSON.stringify(a.body ?? {}), { status: a.status ?? 200 });
      }
    }
    return new Response('{}', { status: 404 });
  };
  return { fetcher, calls };
}

/* 1 ── KYB ───────────────────────────────────────────────────────────────── */

test('the KYB applicant is the business, and Sumsub requests are signed as Sumsub documents', async () => {
  const { fetcher, calls } = sumsubFetcher([
    ['/resources/applicants?', { body: { id: 'applicant-001' } }],
    ['/resources/accessTokens', { body: { token: 'act-token-xyz' } }],
  ]);
  const kyb = kybProviderFromEnv({ ...PROD, ...SUMSUB }, { fetcher, now: () => T0 });
  const session = await kyb.createSession({ orgId: 'acme', kybCaseId: 'kyb_1', businessName: 'Acme Trading Sdn Bhd', registrationNumber: '202001012345' });
  assert.deepEqual([session.provider, session.sandbox, session.applicantId, session.externalUserId, session.accessToken], ['sumsub', false, 'applicant-001', 'org:acme', 'act-token-xyz']);
  const [create, token] = calls;
  const body = JSON.parse(create.init.body);
  assert.equal(body.externalUserId, 'org:acme');
  assert.equal(body.fixedInfo.companyInfo.registrationNumber, '202001012345');
  const ts = String(Math.floor(T0.getTime() / 1000));
  const path = new URL(create.url).pathname + new URL(create.url).search;
  assert.equal(create.init.headers['X-App-Access-Ts'], ts);
  assert.equal(create.init.headers['X-App-Access-Sig'], createHmac('sha256', SUMSUB.SUMSUB_SECRET_KEY).update(`${ts}POST${path}${create.init.body}`).digest('hex'));
  assert.equal(sumsubSignature(SUMSUB.SUMSUB_SECRET_KEY, ts, 'post', path, create.init.body), create.init.headers['X-App-Access-Sig']);
  assert.match(token.url, /userId=org%3Aacme/);
  assert.ok(!JSON.stringify(calls).includes(SUMSUB.SUMSUB_SECRET_KEY));
});

test('an existing applicant is resumed, and Sumsub without a token is a failure', async () => {
  const resumed = sumsubFetcher([
    ['/resources/applicants?', { status: 409, body: { description: 'exists' } }],
    ['/resources/accessTokens', { body: { token: 'act-token-2' } }],
  ]);
  const s = await kybProviderFromEnv({ ...PROD, ...SUMSUB }, { fetcher: resumed.fetcher }).createSession({ orgId: 'acme', kybCaseId: 'k', businessName: 'A', registrationNumber: '1' });
  assert.deepEqual([s.applicantId, s.accessToken], [null, 'act-token-2']);
  const empty = sumsubFetcher([['/resources/applicants?', { body: { id: 'a' } }], ['/resources/accessTokens', { body: {} }]]);
  await assert.rejects(kybProviderFromEnv({ ...PROD, ...SUMSUB }, { fetcher: empty.fetcher }).createSession({ orgId: 'acme', kybCaseId: 'k', businessName: 'A', registrationNumber: '1' }), (e) => e instanceof ComplianceProviderUnavailable && e.code === 'provider_error');
  const down = sumsubFetcher([['/resources/applicants?', { status: 500 }]]);
  await assert.rejects(kybProviderFromEnv({ ...PROD, ...SUMSUB }, { fetcher: down.fetcher }).createSession({ orgId: 'acme', kybCaseId: 'k', businessName: 'A', registrationNumber: '1' }), (e) => e.code === 'provider_error' && !/secret/i.test(e.message));
});

test('production without Sumsub refuses KYB, mocks or not; outside production the sandbox is labelled', async () => {
  for (const env of [PROD, { ...PROD, USE_MOCK_APIS: 'true' }, { ...PROD, SUMSUB_APP_TOKEN: 'only-token' }]) {
    assert.throws(() => kybProviderFromEnv(env), (e) => e instanceof ComplianceProviderUnavailable && e.code === 'kyb_not_configured' && e.status === 503);
  }
  const s = await kybProviderFromEnv({ NODE_ENV: 'development' }, { now: () => T0 }).createSession({ orgId: 'acme', kybCaseId: 'k', businessName: 'A', registrationNumber: '1' });
  assert.deepEqual([s.provider, s.sandbox, s.applicantId], ['sandbox', true, null]);
  assert.match(s.accessToken, /^sandbox_/);
});

test('the KYB session route reads the case by the session org and sends the case, not the request', async () => {
  const { readFile } = await import('node:fs/promises');
  const route = (await readFile(new URL('../app/api/kyb/sumsub/route.ts', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  assert.match(route, /requireSessionAccount\(auth\.session\)/);
  assert.match(route, /readKybCase\(orgId, kybCaseId\)/);
  assert.match(route, /businessName: kybCase\.businessName/);
  assert.match(route, /registrationNumber: kybCase\.registrationNumber/);
  assert.doesNotMatch(route, /body\.businessName|body\.registrationNumber/);
});

/* 2 ── The webhook ───────────────────────────────────────────────────────── */

const stamp = (d) => d.toISOString().replace('T', ' ').replace('Z', '');
function signed(payload, { alg = 'HMAC_SHA256_HEX', secret = WEBHOOK_SECRET } = {}) {
  const raw = JSON.stringify(payload);
  const algorithm = alg === 'HMAC_SHA512_HEX' ? 'sha512' : alg === 'HMAC_SHA256_HEX' ? 'sha256' : 'sha1';
  return { raw, digest: createHmac(algorithm, secret).update(raw).digest('hex'), alg };
}

test('a webhook is verified before it is read, in the algorithm Sumsub names, inside the window', () => {
  const p = { type: 'applicantReviewed', externalUserId: 'org:acme', createdAtMs: stamp(T0) };
  for (const alg of ['HMAC_SHA256_HEX', 'HMAC_SHA512_HEX', 'HMAC_SHA1_HEX']) {
    const s = signed(p, { alg });
    assert.equal(verifySumsubWebhook({ ...s, secret: WEBHOOK_SECRET, now: T0 }).ok, true, alg);
  }
  const s = signed(p);
  assert.equal(verifySumsubWebhook({ ...s, secret: undefined, now: T0 }).reason, 'unsigned');
  assert.equal(verifySumsubWebhook({ ...s, digest: null, secret: WEBHOOK_SECRET, now: T0 }).reason, 'unsigned');
  assert.equal(verifySumsubWebhook({ ...s, alg: 'HMAC_MD5_HEX', secret: WEBHOOK_SECRET, now: T0 }).reason, 'unknown_algorithm');
  assert.equal(verifySumsubWebhook({ ...s, digest: s.digest.replace(/^./, (c) => (c === 'a' ? 'b' : 'a')), secret: WEBHOOK_SECRET, now: T0 }).reason, 'bad_signature');
  assert.equal(verifySumsubWebhook({ ...signed(p, { secret: 'another' }), secret: WEBHOOK_SECRET, now: T0 }).reason, 'bad_signature');
  assert.equal(verifySumsubWebhook({ ...signed({ type: 'x' }), secret: WEBHOOK_SECRET, now: T0 }).reason, 'undated');
  const old = signed({ ...p, createdAtMs: stamp(new Date(T0.getTime() - SUMSUB_WEBHOOK_MAX_AGE_MS - 1000)) });
  assert.equal(verifySumsubWebhook({ ...old, secret: WEBHOOK_SECRET, now: T0 }).reason, 'stale');
  const ahead = signed({ ...p, createdAtMs: stamp(new Date(T0.getTime() + 10 * 60_000)) });
  assert.equal(verifySumsubWebhook({ ...ahead, secret: WEBHOOK_SECRET, now: T0 }).reason, 'future');
  const zoned = signed({ type: 'x', createdAt: '2026-10-25 16:00:00+0800' });
  const v = verifySumsubWebhook({ ...zoned, secret: WEBHOOK_SECRET, now: T0 });
  assert.equal(v.ok, true);
  assert.equal(v.createdAt.toISOString(), T0.toISOString());
  // A broken body with a good signature is 400, not a crash.
  const broken = '{not json';
  assert.equal(verifySumsubWebhook({ raw: broken, digest: createHmac('sha256', WEBHOOK_SECRET).update(broken).digest('hex'), alg: 'HMAC_SHA256_HEX', secret: WEBHOOK_SECRET, now: T0 }).reason, 'bad_body');
});

test('a KYB verdict is GREEN, or RED with a final rejection; anything else changes nothing', () => {
  assert.equal(kybDecision({ type: 'applicantReviewed', reviewResult: { reviewAnswer: 'GREEN' } }).next, 'KYB_PROVIDER_APPROVED');
  assert.equal(kybDecision({ type: 'applicantReviewed', reviewResult: { reviewAnswer: 'RED', reviewRejectType: 'FINAL' } }).next, 'REJECTED');
  assert.equal(kybDecision({ type: 'applicantReviewed', reviewResult: { reviewAnswer: 'RED', reviewRejectType: 'RETRY' } }).next, null);
  assert.equal(kybDecision({ type: 'applicantReviewed', reviewResult: { reviewAnswer: 'RED' } }).next, null);
  assert.equal(kybDecision({ type: 'applicantPending', reviewResult: { reviewAnswer: 'GREEN' } }).next, null);
  assert.equal(kybDecision({ type: 'applicantOnHold' }).next, null);
});

async function hookWorld({ production = false, withDb = true } = {}) {
  const { db } = withDb ? await migratedDb() : { db: null };
  const applied = [];
  let refuseNext = false;
  const deps = {
    db,
    secret: WEBHOOK_SECRET,
    production,
    now: () => T0,
    applyKyb: async (orgId, next) => {
      if (refuseNext) throw new Error('illegal transition');
      applied.push([orgId, next]);
      return { from: 'KYB_SUBMITTED', to: next };
    },
  };
  return { db, deps, applied, refuse: () => { refuseNext = true; } };
}

test('a KYB webhook moves only the org it names by externalUserId, as the provider, once', async () => {
  const w = await hookWorld();
  const green = signed({ type: 'applicantReviewed', applicantId: 'applicant-001', externalUserId: 'org:acme', inspectionId: 'org:northwind', reviewResult: { reviewAnswer: 'GREEN' }, createdAtMs: stamp(T0) });
  const r = await handleSumsubWebhook(w.deps, green);
  assert.deepEqual([r.status, r.body.applied], [200, true], JSON.stringify(r));
  assert.deepEqual(w.applied, [['acme', 'KYB_PROVIDER_APPROVED']]);
  // The same delivery again changes nothing.
  const replay = await handleSumsubWebhook(w.deps, green);
  assert.deepEqual([replay.status, replay.body.applied, replay.body.reason], [200, false, 'replay']);
  assert.equal(w.applied.length, 1);
  // Not ours, or not a verdict: acknowledged, nothing moves.
  for (const p of [
    { type: 'applicantReviewed', externalUserId: 'kyb_case_123', reviewResult: { reviewAnswer: 'RED', reviewRejectType: 'FINAL' } },
    { type: 'applicantReviewed', externalUserId: 'org:acme', reviewResult: { reviewAnswer: 'RED', reviewRejectType: 'RETRY' } },
    { type: 'applicantPending', externalUserId: 'org:acme' },
  ]) {
    const x = await handleSumsubWebhook(w.deps, signed({ ...p, createdAtMs: stamp(T0) }));
    assert.deepEqual([x.status, x.body.applied], [200, false], JSON.stringify(p));
  }
  assert.equal(w.applied.length, 1);
  // A transition the machine refuses is acknowledged, not retried forever.
  w.refuse();
  const late = await handleSumsubWebhook(w.deps, signed({ type: 'applicantReviewed', externalUserId: 'org:acme', reviewResult: { reviewAnswer: 'RED', reviewRejectType: 'FINAL' }, createdAtMs: stamp(T0), n: 2 }));
  assert.deepEqual([late.status, late.body.applied, late.body.reason], [200, false, 'transition not permitted']);
  // Unsigned is 403 and stores nothing.
  const before = (await w.db.select().from(schema.webhookEvents)).length;
  const bad = await handleSumsubWebhook(w.deps, { ...green, digest: 'f'.repeat(64) });
  assert.equal(bad.status, 403);
  assert.equal((await w.db.select().from(schema.webhookEvents)).length, before);
});

test('the webhook route moves a business only as the PROVIDER actor, never to ACTIVE', async () => {
  const { readFile } = await import('node:fs/promises');
  const route = await readFile(new URL('../app/api/webhooks/sumsub/route.ts', import.meta.url), 'utf8');
  assert.match(route, /setOrgKybState\(orgId, next, 'PROVIDER'\)/);
  assert.doesNotMatch(route.replace(/\/\*[\s\S]*?\*\//g, ''), /'ACTIVE'/);
  assert.match(route, /request\.text\(\)/);
  const machine = await readFile(new URL('../lib/compliance/kyb-state.ts', import.meta.url), 'utf8');
  assert.match(machine, /PROVIDER: \['KYB_PROVIDER_APPROVED', 'REJECTED'\]/);
});

test('production without a database refuses a webhook it cannot keep once', async () => {
  const w = await hookWorld({ production: true, withDb: false });
  const r = await handleSumsubWebhook(w.deps, signed({ type: 'applicantReviewed', externalUserId: 'org:acme', reviewResult: { reviewAnswer: 'GREEN' }, createdAtMs: stamp(T0) }));
  assert.equal(r.status, 503);
  assert.equal(w.applied.length, 0);
});

test('a failure of ours releases the delivery, so Sumsub can send it again', async () => {
  const w = await hookWorld();
  const p = signed({ type: 'applicantKytTxnApproved', kytTxnId: 'txn-sumsub-1', kytDataTxnId: INTENT, createdAtMs: stamp(T0) });
  const broken = { ...w.deps, db: new Proxy(w.db, { get: (t, k) => (k === 'select' ? () => { throw new Error('db down'); } : t[k]) }) };
  await assert.rejects(handleSumsubWebhook(broken, p), /db down/);
  assert.equal((await w.db.select().from(schema.webhookEvents)).length, 0);
});

/* 3 ── The Travel Rule ───────────────────────────────────────────────────── */

function transfer(overrides = {}) {
  return {
    intentId: INTENT,
    orgId: 'acme',
    applicantId: 'applicant-001',
    at: T0,
    amountMinor: 1_250_500_000n,
    originator: { legalName: 'Acme Trading Sdn Bhd', registrationNumber: '202001012345', country: 'MY', town: 'Kuala Lumpur', street: 'Jalan Ampang', postCode: '50450', walletAddress: WALLET },
    beneficiary: { legalName: 'Dela Cruz Trading Corp', registrationNumber: 'CS201912345', country: 'PH', town: 'Makati', exchange: 'pdax', depositAddress: DEPOSIT },
    purpose: 'Invoice INV-1',
    signingRequestId: null,
    createdBy: 'u-owner',
    ...overrides,
  };
}

test("the Travel Rule body is the business's own wallet and the supplier at its exchange, USDC on Sui", () => {
  const b = sumsubTravelRuleBody(transfer());
  assert.equal(b.txnId, INTENT);
  assert.equal(b.type, 'travelRule');
  assert.equal(b.txnDate, '2026-10-25 08:00:00+0000');
  assert.deepEqual(b.applicant.paymentMethod, { type: 'unhostedWallet', accountId: WALLET });
  assert.equal(b.applicant.externalUserId, 'org:acme');
  assert.equal(b.applicant.residenceCountry, 'MYS');
  assert.deepEqual(b.counterparty.paymentMethod, { type: 'crypto', accountId: DEPOSIT });
  assert.equal(b.counterparty.residenceCountry, 'PHL');
  assert.ok(b.counterparty.institutionInfo.name);
  assert.deepEqual(b.info, { direction: 'out', amount: 1250.5, currencyCode: 'USDC', currencyType: 'crypto', cryptoParams: { cryptoChain: 'SUI' }, paymentDetails: 'Invoice INV-1' });
  assert.throws(() => sumsubTravelRuleBody(transfer({ beneficiary: { ...transfer().beneficiary, country: 'XX' } })), ComplianceProviderUnavailable);
});

test("Travel Rule statuses come from Sumsub's review and move forward only", () => {
  assert.equal(travelRuleStatusOf({ reviewStatus: 'completed', reviewResult: { reviewAnswer: 'GREEN' } }), 'approved');
  assert.equal(travelRuleStatusOf({ reviewStatus: 'completed', reviewResult: { reviewAnswer: 'RED' } }), 'rejected');
  assert.equal(travelRuleStatusOf({ reviewStatus: 'onHold' }), 'on_hold');
  assert.equal(travelRuleStatusOf({ reviewStatus: 'awaitingCounterparty' }), 'awaiting_counterparty');
  assert.equal(travelRuleStatusOf({ reviewStatus: 'completed' }), 'submitted');
  assert.equal(travelRuleStatusOf(undefined), 'submitted');
  assert.equal(travelRuleAdvances('submitted', 'approved'), true);
  assert.equal(travelRuleAdvances('on_hold', 'awaiting_counterparty'), true);
  assert.equal(travelRuleAdvances('approved', 'rejected'), false);
  assert.equal(travelRuleAdvances('rejected', 'approved'), false);
  assert.equal(travelRuleAdvances('on_hold', 'submitted'), false);
  assert.equal(travelRuleAdvances('submitted', 'submitted'), false);
});

test('production refuses the Travel Rule message without Sumsub, and without the switch', () => {
  for (const env of [PROD, { ...PROD, ...SUMSUB }, { ...PROD, USE_MOCK_APIS: 'true' }, { ...PROD, SUMSUB_TRAVEL_RULE_ENABLED: 'true' }]) {
    assert.throws(() => travelRuleProviderFromEnv(env), (e) => e instanceof ComplianceProviderUnavailable && e.code === 'travel_rule_not_configured', JSON.stringify(env));
  }
  assert.equal(travelRuleProviderFromEnv({ ...PROD, ...SUMSUB, SUMSUB_TRAVEL_RULE_ENABLED: 'true' }).id, 'sumsub');
  const dev = travelRuleProviderFromEnv({ NODE_ENV: 'development' });
  assert.deepEqual([dev.id, dev.sandbox], ['sandbox', true]);
});

const LIVE_TR = { ...PROD, ...SUMSUB, SUMSUB_TRAVEL_RULE_ENABLED: 'true' };

test('the Travel Rule message goes once per payment; a retry answers the same transfer', async () => {
  const { db } = await migratedDb();
  const { fetcher, calls } = sumsubFetcher([['/kyt/txns/-/data', { body: { id: 'txn-sumsub-1', data: { txnId: INTENT }, review: { reviewStatus: 'pending' } } }]]);
  const provider = travelRuleProviderFromEnv(LIVE_TR, { fetcher, now: () => T0 });
  const deps = { db, provider, orgId: 'acme', now: () => T0 };
  const a = await sendTravelRule(deps, transfer());
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.deepEqual([a.created, a.transfer.reference, a.transfer.status, a.transfer.sandbox], [true, 'txn-sumsub-1', 'submitted', false]);
  assert.match(calls[0].url, /\/resources\/applicants\/applicant-001\/kyt\/txns\/-\/data$/);
  const b = await sendTravelRule(deps, transfer({ at: new Date(T0.getTime() + 60_000) }));
  assert.deepEqual([b.ok, b.created, b.transfer.reference], [true, false, 'txn-sumsub-1']);
  assert.equal(calls.length, 1, 'Sumsub is asked once');
  // The same payment with another amount or deposit address is refused.
  for (const o of [{ amountMinor: 1n }, { beneficiary: { ...transfer().beneficiary, depositAddress: `0x${'d4'.repeat(32)}` } }]) {
    const c = await sendTravelRule(deps, transfer(o));
    assert.deepEqual([c.ok, c.status, c.code], [false, 409, 'travel_rule_conflict']);
  }
  assert.equal(calls.length, 1);
  // Another business's payment of the same intent id is its own; a mismatched org is absent.
  const other = await sendTravelRule(deps, transfer({ orgId: 'northwind' }));
  assert.deepEqual([other.ok, other.status], [false, 404]);
  assert.equal(await readTravelRuleTransfer(db, 'northwind', INTENT), null);
});

test('a failed send records nothing as sent, and the retry sends it under the same txnId', async () => {
  const { db } = await migratedDb();
  let fail = true;
  const { fetcher, calls } = sumsubFetcher([['/kyt/txns/-/data', () => (fail ? { status: 503 } : { body: { id: 'txn-sumsub-2', review: { reviewStatus: 'onHold' } } })]]);
  const deps = { db, provider: travelRuleProviderFromEnv(LIVE_TR, { fetcher }), orgId: 'acme', now: () => T0 };
  const a = await sendTravelRule(deps, transfer());
  assert.deepEqual([a.ok, a.status, a.code], [false, 502, 'provider_error']);
  const row = await readTravelRuleTransfer(db, 'acme', INTENT);
  assert.deepEqual([row.status, row.providerRef], ['preparing', null]);
  fail = false;
  const b = await sendTravelRule(deps, transfer());
  assert.deepEqual([b.ok, b.transfer.reference, b.transfer.status], [true, 'txn-sumsub-2', 'on_hold']);
  assert.equal(JSON.parse(calls[0].init.body).txnId, JSON.parse(calls[1].init.body).txnId);
  // An answer that does not name its transfer, or names another, is no submission.
  const { db: db2 } = await migratedDb();
  for (const body of [{}, { id: 'txn-3333', data: { txnId: `0x${'ee'.repeat(32)}` } }]) {
    const f = sumsubFetcher([['/kyt/txns/-/data', { body }]]);
    const r = await sendTravelRule({ db: db2, provider: travelRuleProviderFromEnv(LIVE_TR, { fetcher: f.fetcher }), orgId: 'acme', now: () => T0 }, transfer());
    assert.equal(r.ok, false, JSON.stringify(body));
  }
  assert.equal((await readTravelRuleTransfer(db2, 'acme', INTENT)).providerRef, null);
});

test('a Travel Rule webhook moves its own transfer forward only, for its txnId and business', async () => {
  const w = await hookWorld();
  const { fetcher } = sumsubFetcher([['/kyt/txns/-/data', { body: { id: 'txn-sumsub-9', review: { reviewStatus: 'pending' } } }]]);
  await sendTravelRule({ db: w.db, provider: travelRuleProviderFromEnv(LIVE_TR, { fetcher }), orgId: 'acme', now: () => T0 }, transfer());
  const hook = (p, n) => handleSumsubWebhook(w.deps, signed({ ...p, createdAtMs: stamp(T0), n }));
  const status = async () => (await readTravelRuleTransfer(w.db, 'acme', INTENT)).status;
  // Another txnId, another reference, another business: nothing.
  assert.equal((await hook({ type: 'applicantKytTxnApproved', kytTxnId: 'txn-sumsub-9', kytDataTxnId: `0x${'ff'.repeat(32)}` }, 1)).body.applied, false);
  assert.equal((await hook({ type: 'applicantKytTxnApproved', kytTxnId: 'txn-unknown', kytDataTxnId: INTENT }, 2)).body.applied, false);
  assert.equal((await hook({ type: 'applicantKytTxnApproved', kytTxnId: 'txn-sumsub-9', kytDataTxnId: INTENT, externalUserId: 'org:northwind' }, 3)).body.applied, false);
  assert.equal(await status(), 'submitted');
  assert.equal((await hook({ type: 'applicantKytOnHold', kytTxnId: 'txn-sumsub-9', kytDataTxnId: INTENT }, 4)).body.applied, true);
  assert.equal(await status(), 'on_hold');
  assert.equal((await hook({ type: 'applicantKytTxnApproved', kytTxnId: 'txn-sumsub-9', kytDataTxnId: INTENT, externalUserId: 'org:acme' }, 5)).body.applied, true);
  assert.equal(await status(), 'approved');
  // Never backwards, never from a final status.
  assert.equal((await hook({ type: 'applicantKytTxnRejected', kytTxnId: 'txn-sumsub-9', kytDataTxnId: INTENT }, 6)).body.applied, false);
  assert.equal((await hook({ type: 'applicantKytOnHold', kytTxnId: 'txn-sumsub-9' }, 7)).body.applied, false);
  assert.equal(await status(), 'approved');
  const [row] = await w.db.select().from(schema.travelRuleTransfers).where(eq(schema.travelRuleTransfers.orgId, 'acme'));
  assert.equal(row.providerRef, 'txn-sumsub-9');
});
