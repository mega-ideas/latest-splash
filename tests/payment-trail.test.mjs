/**
 * v2 Phase 3, the audit proof for these payments.
 *
 * Sky's rule: the switches for sharing names change ONLY what the exchange is
 * told and what the confirmation shows. The Seal-encrypted evidence record on
 * Walrus, and the Sui anchor that points at it, must ALWAYS record who started
 * the payment, who approved it, who declined, the times and the rule, even with
 * both switches off. No name goes into anything stored or anchored in plain
 * text: names stay inside the encrypted record, and the database rows and the
 * chain hold internal ids and hashes only.
 *
 * What the record held before: the payer, the payee, the amount, the fee bound
 * and the reference. It carried neither the actor nor any approver. This adds
 * both, additively:
 *
 *   the payment's own record   made when the payment is built: who started it,
 *                              in which role, when, by which route, under which
 *                              rule, and who could approve it. Its hash and
 *                              Walrus blob are what the chain anchors.
 *   a decision record          one more sealed record for each signature,
 *                              decline or ask answered afterwards, bound to the
 *                              first by its hash. Written when the decision is.
 *
 * PGlite with every migration; nothing is signed or sent on any network.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { eq } from 'drizzle-orm';
import { normalizeSuiAddress } from '@mysten/sui/utils';

import * as schema from '../lib/db/schema.ts';
import { exchangeAloneOf } from '../lib/server/exchange-alone.ts';
import { setBusinessNameSharing, setOwnNameSharing } from '../lib/server/exchange-names.ts';
import { canonicalRecord, makePaymentRecorder, makeRecordSealer } from '../lib/server/payment-record.ts';
import { decisionsOf, recordPaymentDecision, sealPendingDecisions } from '../lib/server/payment-trail.ts';
import { declineApprovalAsk } from '../lib/server/payment-approval-asks.ts';
import { setMemberAccess } from '../lib/server/team-admin.ts';
import { declineSigningRequest } from '../lib/server/wallet-signing.ts';
import * as T from '../lib/server/wallet-transfers.ts';
import { amountInput, feeFor, OWNER, setup, sign, signBy, STAFF, staffKey, U } from './fixtures/staff-rule-world.mjs';
import { submitPartialSignature } from '../lib/server/wallet-signing.ts';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const EXCHANGE = normalizeSuiAddress(`0x${'79'.repeat(32)}`);
const NAME = 'Maya Rahman-Okafor';
const TITLE = 'Head of Buying';
const BASE_HASH = '04'.repeat(32);
const noNames = (value) => assert.doesNotMatch(typeof value === 'string' ? value : JSON.stringify(value), /Maya|Rahman|Okafor|Head of Buying|Founder Person/);

/** A Seal and a Walrus that remember what they were given. The plain text is only ever in `plains`; `stored` is what Walrus holds. */
function sealing(over = {}) {
  const plains = [];
  const stored = [];
  const seal = {
    async encrypt(base64, allowlist) {
      const raw = Buffer.from(base64, 'base64').toString('utf8');
      plains.push({ raw, record: JSON.parse(raw), allowlist });
      return { ciphertext: `sealed:${plains.length}:${createHash('sha256').update(base64).digest('hex')}`, policy: { policyId: 'seal_1', mode: 'live' } };
    },
    ...over.seal,
  };
  const store = over.store ?? (async (ciphertext) => (stored.push(ciphertext), { blobId: `blob${stored.length}`, mode: 'live' }));
  return { plains, stored, seal, store, sealer: makeRecordSealer({ seal, store, env: { NODE_ENV: 'test' } }) };
}

async function world() {
  const t = await setup();
  const db = t.w.db;
  await db.update(schema.organizations).set({ legalName: 'Acme Trading Sdn Bhd', registrationNumber: '201901234567', addressLine1: '8 Jalan Ampang', addressCity: 'Kuala Lumpur', addressPostalCode: '50450', addressCountry: 'MY', kybLifecycle: 'ACTIVE' }).where(eq(schema.organizations.id, 'acme'));
  await db.insert(schema.kybCases).values({ id: 'kyb-acme', orgId: 'acme', businessName: 'Acme Trading Sdn Bhd', registrationNumber: '201901234567', state: 'APPROVED', sumsubApplicantId: 'applicant-acme' });
  await db.update(schema.users).set({ name: NAME }).where(eq(schema.users.id, 'u-staff'));
  await db.update(schema.users).set({ name: 'Founder Person' }).where(eq(schema.users.id, 'u-founder'));
  await db.update(schema.memberships).set({ title: TITLE }).where(eq(schema.memberships.userId, 'u-staff'));
  await t.w.screenClear(EXCHANGE);
  const exchangeId = await t.w.saveRecipient(EXCHANGE, { kind: 'EXCHANGE', exchange: 'pdax' });
  await t.verify(EXCHANGE, 'exchange');
  await t.give(t.rule(staffKey.address));
  await setMemberAccess(db, { orgId: 'acme', actorUserId: 'u-founder', userId: 'u-staff', access: 'pay_exchange_alone', allowed: true, now: () => new Date() });
  const sent = [];
  const provider = { id: 'sandbox', sandbox: true, sent, async submitOutbound(input) { sent.push(input); return { provider: 'sandbox', sandbox: true, reference: 'sandbox_tr_1', status: 'submitted' }; } };
  const records = [];
  const deps = (over = {}) =>
    t.deps('acme', {
      payExchangeAlone: (userId) => exchangeAloneOf(db, 'acme', userId),
      travelRule: () => provider,
      paymentRecord: async (input) => {
        records.push(input);
        return { ok: true, contentHash: new Uint8Array(32).fill(4), walrusBlobId: new TextEncoder().encode('blob-tx') };
      },
      ...over,
    });
  const confirmedPayment = async (d, over = {}) => {
    const shown = await T.previewExchangeDisclosure(d, STAFF, { clientKey: 'tx_key_000001', payee: { kind: 'recipient', recipientId: exchangeId }, amountMinor: U(1_000).toString(), purpose: 'invoice' });
    assert.equal(shown.ok, true, JSON.stringify(shown));
    return T.createTransfer(d, STAFF, amountInput(exchangeId, 1_000, { maxFeeMinor: feeFor(U(1_000), 2).toString(), exchangeDisclosure: { purpose: 'invoice', confirmedHash: shown.hash }, via: 'rule', ...over }));
  };
  return { ...t, db, exchangeId, provider, records, deps, confirmedPayment };
}

// ─── The payment's own record ───────────────────────────────────────────────

test('the record gains who, when, the route and the rule, and a record without them is byte for byte what it was', () => {
  const plain = { orgId: 'acme', transferId: 'wtr_1', payer: 'Acme', payee: 'Dela Cruz', amountMinor: '5000000000', maxFeeMinor: '1', reference: 'INV-1' };
  assert.equal(
    canonicalRecord(plain),
    '{"schema":"splash.payment-record.v1","org":"acme","transfer":"wtr_1","payer":"Acme","payee":"Dela Cruz","amountMinor":"5000000000","maxFeeMinor":"1","reference":"INV-1"}',
    'the earlier records are unchanged',
  );
  const trail = {
    startedBy: { userId: 'u-staff', role: 'staff', name: NAME, title: TITLE },
    startedAt: '2026-11-02T09:00:00.000Z',
    route: 'staff_rule',
    rule: { perPaymentMaxMinor: '2000000000', spendableNowMinor: '15000000000', status: 'active', startsAtMs: null, expiresAtMs: null },
    mayApprove: ['u-founder'],
  };
  const withTrail = JSON.parse(canonicalRecord({ ...plain, trail }));
  assert.equal(withTrail.schema, 'splash.payment-record.v2');
  assert.equal(withTrail.payer, 'Acme');
  assert.deepEqual(withTrail.trail.startedBy, trail.startedBy);
  assert.equal(withTrail.trail.route, 'staff_rule');
  assert.deepEqual(withTrail.trail.decisions, [], 'none yet: each later decision is its own record, bound to this one by its hash');
  assert.equal(canonicalRecord({ ...plain, trail }), canonicalRecord({ ...plain, trail: { ...trail } }), 'a fixed order: the same facts, the same hash');
});

test('with BOTH switches off the sealed record still holds who started the payment, when, the route and the rule; the exchange is told none of it', async () => {
  const t = await world();
  await setBusinessNameSharing(t.db, { orgId: 'acme', actorUserId: 'u-founder', share: false, now: () => new Date() });
  await setOwnNameSharing(t.db, { orgId: 'acme', actorUserId: 'u-staff', userId: 'u-staff', share: false, now: () => new Date() });
  const s = sealing();
  const d = t.deps({ paymentRecord: makePaymentRecorder({ seal: s.seal, store: s.store, env: { NODE_ENV: 'test' } }) });
  const paid = await t.confirmedPayment(d);
  assert.equal(paid.ok, true, JSON.stringify(paid));
  // What the exchange was told: the company, no person.
  assert.match(t.provider.sent[0].purpose, /^Sent by Acme Trading Sdn Bhd: /);
  noNames(t.provider.sent);
  // What was sealed: the actor, the role, the time, the route and the rule.
  assert.equal(s.plains.length, 1);
  const record = s.plains[0].record;
  assert.equal(record.schema, 'splash.payment-record.v2');
  assert.equal(record.trail.startedBy.userId, 'u-staff');
  assert.equal(record.trail.startedBy.role, 'staff');
  assert.equal(record.trail.startedBy.name, NAME, 'the name is inside the encrypted record');
  assert.equal(record.trail.startedBy.title, TITLE);
  assert.equal(record.trail.startedAt, paid.transfer.createdAt instanceof Date ? paid.transfer.createdAt.toISOString() : new Date(paid.transfer.createdAt).toISOString());
  assert.equal(record.trail.route, 'staff_rule');
  assert.equal(record.trail.rule.perPaymentMaxMinor, U(2_000).toString());
  assert.deepEqual(record.trail.mayApprove, ['u-founder']);
  assert.deepEqual(s.plains[0].allowlist, ['acme', 'auditor']);
  // What is stored in plain text: ciphertext only. What the chain would hold: the hash of the plain record.
  assert.equal(s.stored.length, 1);
  noNames(s.stored);
  assert.ok(!s.stored[0].includes('u-staff'));
  const [row] = await t.db.select().from(schema.walletTransfers);
  assert.equal(row.recordHash, createHash('sha256').update(s.plains[0].raw).digest('hex'), 'the hash kept with the payment is the hash of the plain record');
  assert.match(row.recordHash, /^[0-9a-f]{64}$/);
  assert.equal(row.recordBlobId, Buffer.from('blob1').toString('hex'));
  await t.w.client.close();
});

test('an owners\' payment records its starter as an owner and every owner who could approve it', async () => {
  const t = await world();
  const d = t.deps();
  const paid = await T.createTransfer(d, OWNER, amountInput(t.recipientId, 100));
  assert.equal(paid.ok, true, JSON.stringify(paid));
  const trail = t.records.at(-1).trail;
  assert.equal(trail.startedBy.userId, 'u-founder');
  assert.equal(trail.startedBy.role, 'owner');
  assert.equal(trail.route, 'owners_sign');
  assert.equal(trail.rule, null);
  assert.ok(trail.mayApprove.includes('u-founder') && trail.mayApprove.includes('u-two'));
  assert.ok(!trail.mayApprove.includes('u-staff'), 'staff cannot approve');
  await t.w.client.close();
});

// ─── The decisions ──────────────────────────────────────────────────────────

test('each signature is a record of its own, bound to the payment\'s record; the rows hold ids and hashes, never a name', async () => {
  const t = await world();
  const s = sealing();
  t.w.signing.onDecision = (decision) => recordPaymentDecision({ db: t.db, seal: s.sealer, now: () => new Date() }, decision);
  const d = t.deps();
  const paid = await t.confirmedPayment(d);
  const view = paid.signingRequest;
  const signed = await submitPartialSignature(t.w.signing, { orgId: 'acme', userId: 'u-staff', id: view.id, signature: await sign(staffKey, view), digest: view.digest });
  assert.equal(signed.ok, true, JSON.stringify(signed));
  const [row] = await decisionsOf(t.db, 'acme', paid.transfer.id);
  assert.equal(row.userId, 'u-staff');
  assert.equal(row.kind, 'signed');
  assert.equal(row.baseHash, BASE_HASH);
  assert.match(row.contentHash, /^[0-9a-f]{64}$/);
  assert.equal(row.walrusBlobId, Buffer.from('blob1').toString('hex'));
  noNames(row);
  noNames(s.stored);
  assert.equal(s.plains.length, 1);
  const sealed = s.plains[0].record;
  assert.equal(sealed.schema, 'splash.payment-decision.v1');
  assert.equal(sealed.base, BASE_HASH);
  assert.equal(sealed.event, 'signed');
  assert.equal(sealed.by.userId, 'u-staff');
  assert.equal(sealed.by.name, NAME, 'inside the encrypted record only');
  assert.equal(row.contentHash, createHash('sha256').update(s.plains[0].raw).digest('hex'), 'the hash is of the plain record');
  assert.ok(new Date(sealed.at).getTime() > 0);
  await t.w.client.close();
});

test('owners who sign and an owner who declines are all recorded, with both switches off', async () => {
  const t = await world();
  await setBusinessNameSharing(t.db, { orgId: 'acme', actorUserId: 'u-founder', share: false, now: () => new Date() });
  const s = sealing();
  t.w.signing.onDecision = (decision) => recordPaymentDecision({ db: t.db, seal: s.sealer, now: () => new Date() }, decision);
  const d = t.deps();
  const paid = await T.createTransfer(d, OWNER, amountInput(t.recipientId, 100));
  assert.equal(paid.ok, true, JSON.stringify(paid));
  await signBy(t.w, paid.signingRequest, ['two']);
  const declined = await declineSigningRequest(t.w.signing, { orgId: 'acme', userId: 'u-three', id: paid.signingRequest.id });
  assert.equal(declined.ok, true, JSON.stringify(declined));
  await signBy(t.w, paid.signingRequest, ['founder']);
  const rows = await decisionsOf(t.db, 'acme', paid.transfer.id);
  assert.deepEqual(rows.map((r) => [r.userId, r.kind]).sort(), [['u-founder', 'signed'], ['u-three', 'declined'], ['u-two', 'signed']]);
  for (const r of rows) assert.equal(r.baseHash, BASE_HASH);
  assert.equal(s.plains.filter((p) => p.record.event === 'declined').length, 1);
  noNames(rows);
  noNames(s.stored);
  await t.w.client.close();
});

test('an owner\'s answer to a staff member\'s ask is recorded, declined or accepted', async () => {
  const t = await world();
  const s = sealing();
  const hook = (decision) => recordPaymentDecision({ db: t.db, seal: s.sealer, now: () => new Date() }, decision);
  const d = t.deps();
  // Outside the rule (over the per-payment maximum), so the owners are asked.
  const asked = await T.createTransfer(d, STAFF, amountInput(t.recipientId, 5_000, { clientKey: 'tx_key_000777' }));
  assert.equal(asked.ok, true, JSON.stringify(asked));
  assert.equal(asked.transfer.route, 'asked_owners');
  const declined = await declineApprovalAsk(t.db, { orgId: 'acme', userId: 'u-founder', askId: asked.ask.id, reason: 'not now' }, { onDecision: hook });
  assert.equal(declined.ok, true, JSON.stringify(declined));
  const rows = await decisionsOf(t.db, 'acme', asked.transfer.id);
  assert.deepEqual(rows.map((r) => [r.userId, r.kind]), [['u-founder', 'ask_declined']]);
  assert.equal(rows[0].baseHash, BASE_HASH);
  assert.equal(s.plains[0].record.event, 'ask_declined');
  noNames(rows);
  // The same answer again is the same record.
  const again = await recordPaymentDecision({ db: t.db, seal: s.sealer, now: () => new Date() }, { orgId: 'acme', askId: asked.ask.id, userId: 'u-founder', kind: 'ask_declined' });
  assert.equal(again.ok, true);
  assert.equal(again.recorded, false);
  assert.equal((await decisionsOf(t.db, 'acme', asked.transfer.id)).length, 1);
  const accepted = await recordPaymentDecision({ db: t.db, seal: s.sealer, now: () => new Date() }, { orgId: 'acme', askId: asked.ask.id, userId: 'u-two', kind: 'ask_accepted' });
  assert.equal(accepted.recorded, true);
  await t.w.client.close();
});

test('another business\'s decision reads as absent: nothing is recorded under a payment of a business that is not the caller\'s', async () => {
  const t = await world();
  const s = sealing();
  const paid = await t.confirmedPayment(t.deps());
  const stray = await recordPaymentDecision({ db: t.db, seal: s.sealer, now: () => new Date() }, { orgId: 'northwind', signingRequestId: paid.signingRequest.id, userId: 'u-staff', kind: 'signed' });
  assert.equal(stray.ok, false);
  assert.equal(stray.code, 'not_found');
  assert.equal(s.plains.length, 0);
  assert.equal((await t.db.select().from(schema.paymentTrailEvents)).length, 0);
  assert.deepEqual(await decisionsOf(t.db, 'northwind', paid.transfer.id), []);
  const nobody = await recordPaymentDecision({ db: t.db, seal: s.sealer, now: () => new Date() }, { orgId: 'acme', signingRequestId: 'wsr_missing', userId: 'u-staff', kind: 'signed' });
  assert.equal(nobody.ok, false);
  // A person who is no member of the business cannot be recorded as having decided in it.
  const outsider = await recordPaymentDecision({ db: t.db, seal: s.sealer, now: () => new Date() }, { orgId: 'acme', signingRequestId: paid.signingRequest.id, userId: 'u-nobody', kind: 'signed' });
  assert.equal(outsider.ok, false);
  await t.w.client.close();
});

test('a record that cannot be sealed never stops the decision: it waits, unsealed, and is sealed later; in production a demo service seals nothing', async () => {
  const t = await world();
  const paid = await t.confirmedPayment(t.deps());
  const down = sealing({ store: async () => { throw new Error('walrus is down'); } });
  const first = await recordPaymentDecision({ db: t.db, seal: down.sealer, now: () => new Date() }, { orgId: 'acme', signingRequestId: paid.signingRequest.id, userId: 'u-staff', kind: 'signed' });
  assert.deepEqual([first.ok, first.recorded, first.sealed], [true, true, false]);
  let [row] = await decisionsOf(t.db, 'acme', paid.transfer.id);
  assert.equal(row.contentHash, null);
  assert.equal(row.walrusBlobId, null);
  assert.equal(row.userId, 'u-staff', 'the decision itself is on record');
  // A sealed record cannot be rewritten to say something else.
  await assert.rejects(() => t.db.update(schema.paymentTrailEvents).set({ userId: 'u-other' }).where(eq(schema.paymentTrailEvents.id, row.id)), /append-only/);
  const up = sealing();
  const swept = await sealPendingDecisions({ db: t.db, seal: up.sealer, now: () => new Date() });
  assert.deepEqual(swept, { sealed: 1, failed: 0 });
  [row] = await decisionsOf(t.db, 'acme', paid.transfer.id);
  assert.match(row.contentHash, /^[0-9a-f]{64}$/);
  assert.equal((await sealPendingDecisions({ db: t.db, seal: up.sealer, now: () => new Date() })).sealed, 0, 'sealed once');
  await assert.rejects(() => t.db.update(schema.paymentTrailEvents).set({ walrusBlobId: 'ff' }).where(eq(schema.paymentTrailEvents.id, row.id)), /append-only/);
  // Fail closed in production.
  const demo = makeRecordSealer({ seal: { encrypt: async () => ({ ciphertext: 'ct', policy: { policyId: 'DEMO', mode: 'demo' } }) }, store: async () => ({ blobId: 'DEMO_blob', mode: 'demo' }), env: { NODE_ENV: 'production' } });
  assert.deepEqual(await demo('{}'), { ok: false });
  await t.w.client.close();
});

test('the hook that records a decision is wired into signing, the asks and the live context', () => {
  const signing = read('lib/server/wallet-signing.ts');
  assert.match(signing, /onDecision/);
  assert.ok((signing.match(/onDecision/g) ?? []).length >= 4, 'signed and declined both call it');
  assert.match(read('lib/server/payment-approval-asks.ts'), /onDecision/);
  assert.match(read('lib/server/wallet-deps.ts'), /onDecision/);
  const ask = read('app/api/wallet/approval-asks/[id]/route.ts');
  assert.match(ask, /onDecision/);
});

test('the notes for Sebastian: names inside evidence records are only as private as the key policy', () => {
  const security = read('SECURITY.md');
  assert.match(security, /A-13/);
  assert.match(security, /names? (inside|in) (the )?(sealed )?evidence records?[\s\S]{0,200}(only as private as|key policy)/i);
  assert.match(security, /payment_trail_events/);
  assert.match(read('docs/v2/migrations.md'), /0085/);
});
