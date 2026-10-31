/**
 * KYT screening (v2 §4.6, D8): Elliptic and the Chainalysis sanctions list
 * behind one interface, the recipient screening service, and its store.
 *
 * What must hold:
 *   - no verdict without a provider's answer: an error, a timeout, an answer
 *     without the provider's own id, a score Splash cannot read, a
 *     misconfigured provider and no provider at all are all `null`, never
 *     CLEAR; Elliptic's null score is REVIEW;
 *   - Elliptic's request is signed as Elliptic documents it, and its score
 *     decides by the thresholds; a sanctions listing still blocks;
 *   - production never reaches the sandbox, USE_MOCK_APIS or not;
 *   - an address is checked against its chain before it is screened;
 *   - every screening is kept, once per provider reference, per business,
 *     append-only; another business's screening of the same address does
 *     not count for this one.
 *
 * PGlite with every migration. Nothing reaches a network.
 */
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import test from 'node:test';

import * as schema from '../lib/db/schema.ts';
import {
  ELLIPTIC_DEFAULT_BLOCK_SCORE,
  ELLIPTIC_DEFAULT_REVIEW_SCORE,
  ellipticSignature,
  kytProviderFromEnv,
  normalizeScreeningSubject,
  ScreeningSubjectError,
  screeningPermitsPayment,
} from '../lib/compliance/kyt.ts';
import { latestScreening, recordScreening, screenRecipient, screeningsOf } from '../lib/server/kyt-screenings.ts';

import { migratedDb } from './helpers/store-db.mjs';

const T0 = new Date('2026-10-25T08:00:00Z');
const SECRET = randomBytes(32).toString('base64');
const PROD = { NODE_ENV: 'production' };
const ELLIPTIC = { ELLIPTIC_API_KEY: 'elliptic-key-1', ELLIPTIC_API_SECRET: SECRET };
const sui = (tail = '') => `0x${randomBytes(32).toString('hex').slice(0, 64 - tail.length)}${tail}`;

function ellipticFetcher(answer, status = 200) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    if (answer instanceof Error) throw answer;
    return new Response(typeof answer === 'string' ? answer : JSON.stringify(answer), { status });
  };
  return { fetcher, calls };
}

/* 1 ── Elliptic ──────────────────────────────────────────────────────────── */

test("Elliptic's request is signed over timestamp, method, path and body with the decoded secret", async () => {
  const { fetcher, calls } = ellipticFetcher({ id: 'b7f1c2d3-aaaa-bbbb', risk_score: 1.2 });
  const kyt = kytProviderFromEnv({ ...PROD, ...ELLIPTIC }, { fetcher, now: () => T0 });
  const address = sui();
  const s = await kyt.screen({ chain: 'SUI', address, direction: 'recipient' });
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, 'https://aml-api.elliptic.co/v2/wallet/synchronous');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['x-access-key'], 'elliptic-key-1');
  assert.equal(init.headers['x-access-timestamp'], String(T0.getTime()));
  const expected = createHmac('sha256', Buffer.from(SECRET, 'base64')).update(`${T0.getTime()}POST/v2/wallet/synchronous${init.body}`).digest('base64');
  assert.equal(init.headers['x-access-sign'], expected);
  assert.equal(ellipticSignature(SECRET, String(T0.getTime()), 'post', '/V2/Wallet/Synchronous', init.body), expected);
  const body = JSON.parse(init.body);
  assert.deepEqual(body.subject, { asset: 'holistic', blockchain: 'holistic', type: 'address', hash: address });
  assert.equal(body.type, 'wallet_exposure');
  // The secret never travels.
  assert.ok(!JSON.stringify(init).includes(SECRET));
  assert.deepEqual([s.provider, s.verdict, s.reference, s.riskScore], ['elliptic', 'CLEAR', 'elliptic:b7f1c2d3-aaaa-bbbb', 1.2]);
  assert.equal(s.screenedAt, T0.toISOString());
});

test("Elliptic's score decides by the thresholds, and a null score is REVIEW, not CLEAR", async () => {
  const at = async (risk_score, env = {}) => (await kytProviderFromEnv({ ...PROD, ...ELLIPTIC, ...env }, { fetcher: ellipticFetcher({ id: 'analysis-001', risk_score }).fetcher }).screen({ chain: 'SUI', address: sui(), direction: 'recipient' })).verdict;
  assert.equal(await at(0), 'CLEAR');
  assert.equal(await at(ELLIPTIC_DEFAULT_REVIEW_SCORE - 0.01), 'CLEAR');
  assert.equal(await at(ELLIPTIC_DEFAULT_REVIEW_SCORE), 'REVIEW');
  assert.equal(await at(ELLIPTIC_DEFAULT_BLOCK_SCORE), 'BLOCK');
  assert.equal(await at(10), 'BLOCK');
  assert.equal(await at(null), 'REVIEW');
  // Compliance moves the thresholds.
  assert.equal(await at(2, { ELLIPTIC_REVIEW_SCORE: '1', ELLIPTIC_BLOCK_SCORE: '2' }), 'BLOCK');
});

test('Elliptic without an answer of its own is no verdict: errors, timeouts, no id, a bad score', async () => {
  const cases = [
    ellipticFetcher({ id: 'analysis-002', risk_score: 1 }, 500),
    ellipticFetcher({ id: 'analysis-002', risk_score: 1 }, 401),
    ellipticFetcher(new Error('timeout')),
    ellipticFetcher('not json'),
    ellipticFetcher({ risk_score: 0 }),
    ellipticFetcher({ id: 'analysis-002', risk_score: 'low' }),
    ellipticFetcher({ id: 'analysis-002', risk_score: 11 }),
    ellipticFetcher({ id: 'analysis-002', error: { message: 'unsupported' }, risk_score: 0 }),
  ];
  for (const c of cases) {
    const s = await kytProviderFromEnv({ ...PROD, ...ELLIPTIC }, { fetcher: c.fetcher, now: () => T0 }).screen({ chain: 'SUI', address: sui(), direction: 'deposit', txRef: 'D1' });
    assert.deepEqual([s.provider, s.verdict, s.reference, s.screenedAt], ['elliptic', null, null, null], JSON.stringify(s));
    assert.equal(screeningPermitsPayment(s), false);
  }
});

test('a misconfigured Elliptic says so and asks nobody', async () => {
  for (const env of [{ ELLIPTIC_API_KEY: 'k' }, { ELLIPTIC_API_KEY: 'k', ELLIPTIC_API_SECRET: 's' }, { ...ELLIPTIC, ELLIPTIC_REVIEW_SCORE: '8', ELLIPTIC_BLOCK_SCORE: '7' }, { ...ELLIPTIC, ELLIPTIC_BLOCK_SCORE: 'high' }]) {
    const { fetcher, calls } = ellipticFetcher({ id: 'x-000001', risk_score: 0 });
    const s = await kytProviderFromEnv({ ...PROD, ...env }, { fetcher }).screen({ chain: 'SUI', address: sui(), direction: 'recipient' });
    assert.equal(s.verdict, null, JSON.stringify(env));
    assert.equal(calls.length, 0);
  }
});

test('with the sanctions list beside Elliptic, a listing blocks and "not listed" is not a verdict', async () => {
  const env = { ...PROD, ...ELLIPTIC, CHAINALYSIS_SANCTIONS_API_KEY: 'chainalysis-key' };
  const route = (listed, elliptic) => async (url) => new Response(JSON.stringify(url.includes('chainalysis') ? { identifications: listed ? [{ name: 'SDN' }] : [] } : elliptic), { status: 200 });
  const blocked = await kytProviderFromEnv(env, { fetcher: route(true, { id: 'analysis-003', risk_score: 0 }) }).screen({ chain: 'SUI', address: sui(), direction: 'recipient' });
  assert.equal(blocked.verdict, 'BLOCK');
  assert.equal(blocked.provider, 'chainalysis_sanctions');
  const unanswered = await kytProviderFromEnv(env, { fetcher: route(false, { nothing: true }) }).screen({ chain: 'SUI', address: sui(), direction: 'recipient' });
  assert.equal(unanswered.verdict, null);
  const clear = await kytProviderFromEnv(env, { fetcher: route(false, { id: 'analysis-004', risk_score: 0.5 }) }).screen({ chain: 'SUI', address: sui(), direction: 'recipient' });
  assert.deepEqual([clear.provider, clear.verdict], ['elliptic', 'CLEAR']);
});

/* 2 ── Fail closed in production ─────────────────────────────────────────── */

test('production with no provider answers no verdict, and USE_MOCK_APIS does not bring the sandbox back', async () => {
  for (const env of [PROD, { ...PROD, USE_MOCK_APIS: 'true' }, { ...PROD, NEXT_PUBLIC_DEMO_MODE: 'true' }]) {
    const kyt = kytProviderFromEnv(env);
    assert.equal(kyt.id, 'none');
    assert.notEqual(kyt.sandbox, true);
    const s = await kyt.screen({ chain: 'SUI', address: sui(), direction: 'recipient' });
    assert.equal(s.verdict, null);
  }
  const dev = kytProviderFromEnv({ NODE_ENV: 'development' }, { now: () => T0 });
  assert.equal(dev.sandbox, true);
  assert.equal((await dev.screen({ chain: 'SUI', address: sui('dead'), direction: 'recipient' })).verdict, 'BLOCK');
  assert.equal((await dev.screen({ chain: 'SUI', address: sui('beef'), direction: 'recipient' })).verdict, 'REVIEW');
});

/* 3 ── Address formats ───────────────────────────────────────────────────── */

test('each chain has its address format, and a recipient kind its chains', () => {
  const s = normalizeScreeningSubject('sui', '0xABC', 'wallet_recipient');
  assert.equal(s.address, `0x${'0'.repeat(61)}abc`);
  assert.equal(normalizeScreeningSubject('base', `0x${'AB'.repeat(20)}`, 'cross_chain_recipient').address, `0x${'ab'.repeat(20)}`);
  const sol = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
  assert.equal(normalizeScreeningSubject('SOLANA', sol, 'cross_chain_recipient').address, sol);
  const bad = [
    ['DOGE', sui(), 'cross_chain_recipient', 'unsupported_chain'],
    ['SUI', '0xzz', 'wallet_recipient', 'bad_address'],
    ['ETHEREUM', `0x${'ab'.repeat(19)}`, 'cross_chain_recipient', 'bad_address'],
    ['SOLANA', '0OIl'.repeat(10), 'cross_chain_recipient', 'bad_address'],
    ['SUI', sui(), 'cross_chain_recipient', 'wrong_chain_for_kind'],
    ['BASE', `0x${'ab'.repeat(20)}`, 'wallet_recipient', 'wrong_chain_for_kind'],
  ];
  for (const [chain, address, kind, code] of bad) {
    assert.throws(() => normalizeScreeningSubject(chain, address, kind), (e) => e instanceof ScreeningSubjectError && e.code === code, `${chain} ${address}`);
  }
});

/* 4 ── The service and the store ─────────────────────────────────────────── */

async function world() {
  const { db } = await migratedDb();
  const deps = (orgId, kyt) => ({ db, orgId, kyt, now: () => T0 });
  return { db, deps };
}

test('a recipient is screened and kept for its own business only', async () => {
  const w = await world();
  const { fetcher, calls } = ellipticFetcher({ id: 'analysis-005', risk_score: 0.1 });
  const kyt = kytProviderFromEnv({ ...PROD, ...ELLIPTIC }, { fetcher, now: () => T0 });
  const address = sui();
  const r = await screenRecipient(w.deps('acme', kyt), { kind: 'exchange_recipient', chain: 'SUI', address: address.toUpperCase().replace('0X', '0x'), requestedBy: 'u-owner' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual([r.screening.verdict, r.screening.reference, r.screening.permitsPayment, r.screening.address], ['CLEAR', 'elliptic:analysis-005', true, address]);
  assert.equal(calls.length, 1);
  // Another business sees nothing of it.
  assert.equal(await latestScreening(w.db, 'northwind', 'SUI', address), null);
  assert.equal((await latestScreening(w.db, 'acme', 'SUI', address)).id, r.screening.id);
  // The same provider answer kept twice is one row.
  const again = await recordScreening(w.db, { orgId: 'acme', kind: 'exchange_recipient', chain: 'SUI', address, screening: { provider: 'elliptic', verdict: 'CLEAR', reference: 'elliptic:analysis-005', detail: 'x', screenedAt: T0.toISOString() }, requestedBy: 'u' });
  assert.equal(again.id, r.screening.id);
  assert.equal((await screeningsOf(w.db, 'acme', 'SUI', address)).length, 1);
  // Northwind's own screening of the same address is its own row.
  const nw = await recordScreening(w.db, { orgId: 'northwind', kind: 'wallet_recipient', chain: 'SUI', address, screening: { provider: 'elliptic', verdict: 'BLOCK', reference: 'elliptic:analysis-005', detail: 'x', screenedAt: T0.toISOString() }, requestedBy: 'u' });
  assert.notEqual(nw.id, r.screening.id);
  assert.equal((await latestScreening(w.db, 'acme', 'SUI', address)).verdict, 'CLEAR');
});

test('an unanswered screening is kept as unscreened, and a verdict without a reference is not kept as one', async () => {
  const w = await world();
  const address = sui();
  const r = await screenRecipient(w.deps('acme', kytProviderFromEnv(PROD)), { kind: 'wallet_recipient', chain: 'SUI', address, requestedBy: 'u-owner' });
  assert.equal(r.ok, true);
  assert.deepEqual([r.screening.provider, r.screening.verdict, r.screening.reference, r.screening.permitsPayment], ['none', null, null, false]);
  const forged = await recordScreening(w.db, { orgId: 'acme', kind: 'wallet_recipient', chain: 'SUI', address, screening: { provider: 'elliptic', verdict: 'CLEAR', reference: null, detail: 'made up', screenedAt: T0.toISOString() }, requestedBy: 'u' });
  assert.equal(forged.verdict, null);
  // The database refuses it too.
  await assert.rejects(
    w.db.insert(schema.kytScreenings).values({ id: 'kyt_forged', orgId: 'acme', subjectKind: 'wallet_recipient', chain: 'SUI', address, provider: 'elliptic', verdict: 'CLEAR', reference: null, detail: 'x', requestedBy: 'u' }),
    (e) => /kyt_screenings_answered_check/.test(String(e?.cause?.message ?? e?.message)),
  );
});

test('screenings are append-only, and a wrong address or kind is refused before any provider is asked', async () => {
  const w = await world();
  const { fetcher, calls } = ellipticFetcher({ id: 'analysis-006', risk_score: 0 });
  const kyt = kytProviderFromEnv({ ...PROD, ...ELLIPTIC }, { fetcher });
  const ok = await screenRecipient(w.deps('acme', kyt), { kind: 'cross_chain_recipient', chain: 'BASE', address: `0x${'cd'.repeat(20)}`, requestedBy: 'u-staff' });
  assert.equal(ok.ok, true);
  assert.equal(ok.screening.chain, 'BASE');
  await assert.rejects(w.db.update(schema.kytScreenings).set({ verdict: 'CLEAR' }), (e) => /append-only/.test(String(e?.cause?.message ?? e?.message)));
  await assert.rejects(w.db.delete(schema.kytScreenings), (e) => /append-only/.test(String(e?.cause?.message ?? e?.message)));
  for (const input of [
    { kind: 'deposit', chain: 'SUI', address: sui() },
    { kind: 'wallet_recipient', chain: 'SUI', address: 'not an address' },
    { kind: 'cross_chain_recipient', chain: 'SUI', address: sui() },
    { kind: 'cross_chain_recipient', chain: 'TRON', address: 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb' },
  ]) {
    const r = await screenRecipient(w.deps('acme', kyt), { ...input, requestedBy: 'u' });
    assert.equal(r.ok, false, JSON.stringify(input));
    assert.equal(r.status, 400);
  }
  assert.equal(calls.length, 1);
});
