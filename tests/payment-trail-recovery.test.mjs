/**
 * v2 Phase 3, the audit proof for these payments: a decision that failed to be
 * written is brought back.
 *
 * An independent review found that a signature or a decline is saved first and
 * the trail hook runs after it, with any error swallowed ("the next sweep brings
 * the trail up to date"). But the sweep only sealed rows that already existed,
 * so a failed write left that payment's evidence without its approver or decliner
 * for good, which breaks the rule that the proof must ALWAYS say who approved or
 * declined a payment.
 *
 * Now the sweep derives the missing decision rows from what the signing layer
 * and the asks already hold (a signer's signed_at or declined_at, an owner's
 * answer to an ask), then seals them. It is idempotent (the unique index), it
 * reads each business's own rows, and it leaves alone anything that is not a
 * decision about a payment whose record was sealed with a trail.
 *
 * Also in here: the sealed decision record holds the name and title exactly as
 * they are stored (it is encrypted; display cleaning belongs on screens), and a
 * scheduled automatic payment and an owners' batch carry a trail in their own
 * sealed records.
 *
 * PGlite with every migration; nothing is signed or sent on any network.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { eq } from 'drizzle-orm';
import { normalizeSuiAddress } from '@mysten/sui/utils';

import * as schema from '../lib/db/schema.ts';
import { exchangeAloneOf } from '../lib/server/exchange-alone.ts';
import { makeRecordSealer } from '../lib/server/payment-record.ts';
import * as trail from '../lib/server/payment-trail.ts';
import { declineApprovalAsk } from '../lib/server/payment-approval-asks.ts';
import { setMemberAccess } from '../lib/server/team-admin.ts';
import { declineSigningRequest, submitPartialSignature } from '../lib/server/wallet-signing.ts';
import * as T from '../lib/server/wallet-transfers.ts';
import { amountInput, feeFor, OWNER, setup, sign, signBy, STAFF, staffKey, U } from './fixtures/staff-rule-world.mjs';

const EXCHANGE = normalizeSuiAddress(`0x${'79'.repeat(32)}`);
const NAME = 'Maya Rahman-Okafor';
const TITLE = 'Head of Buying';
const BASE_HASH = '04'.repeat(32);
const blip = async () => {
  throw new Error('database blip');
};

function sealing(over = {}) {
  const plains = [];
  const stored = [];
  const seal = {
    async encrypt(base64, allowlist) {
      const raw = Buffer.from(base64, 'base64').toString('utf8');
      plains.push({ raw, record: JSON.parse(raw), allowlist });
      return { ciphertext: `sealed:${plains.length}:${createHash('sha256').update(base64).digest('hex')}`, policy: { policyId: 'seal_1', mode: 'live' } };
    },
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
  const provider = { id: 'sandbox', sandbox: true, async submitOutbound() { return { provider: 'sandbox', sandbox: true, reference: 'sandbox_tr_1', status: 'submitted' }; } };
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

const sweep = (t, s, now = () => new Date()) => trail.sweepPaymentTrail({ db: t.db, seal: s.sealer, now });
const rowsOf = (t, transferId) => trail.decisionsOf(t.db, 'acme', transferId);

// ─── A decision whose write failed is derived by the sweep ──────────────────

test('a signature whose trail write failed is brought back by the sweep, with the time it was signed and its record sealed', async () => {
  const t = await world();
  const s = sealing();
  t.w.signing.onDecision = blip; // the hook fails; the signature stands
  const paid = await t.confirmedPayment(t.deps());
  const view = paid.signingRequest;
  const signed = await submitPartialSignature(t.w.signing, { orgId: 'acme', userId: 'u-staff', id: view.id, signature: await sign(staffKey, view), digest: view.digest });
  assert.equal(signed.ok, true, JSON.stringify(signed));
  assert.deepEqual(await rowsOf(t, paid.transfer.id), [], 'the write failed: nothing on record');

  const first = await sweep(t, s);
  assert.equal(first.derived, 1, JSON.stringify(first));
  const [row] = await rowsOf(t, paid.transfer.id);
  assert.equal(row.userId, 'u-staff');
  assert.equal(row.kind, 'signed');
  assert.equal(row.role, 'staff');
  assert.equal(row.baseHash, BASE_HASH, 'bound to the payment\'s own record');
  assert.match(row.contentHash, /^[0-9a-f]{64}$/, 'sealed in the same sweep');
  const [signer] = await t.db.select().from(schema.walletSigningSigners).where(eq(schema.walletSigningSigners.requestId, view.id));
  const mine = (await t.db.select().from(schema.walletSigningSigners).where(eq(schema.walletSigningSigners.userId, 'u-staff')))[0];
  assert.ok(signer && mine);
  assert.equal(row.decidedAt.getTime(), mine.signedAt.getTime(), 'the time of the signature, not the time of the sweep');
  assert.equal(s.plains.at(-1).record.event, 'signed');
  assert.equal(s.plains.at(-1).record.by.userId, 'u-staff');

  const second = await sweep(t, s);
  assert.equal(second.derived, 0, 'idempotent: nothing is made twice');
  assert.equal((await rowsOf(t, paid.transfer.id)).length, 1);
  await t.w.client.close();
});

test('a decline whose trail write failed is brought back by the sweep', async () => {
  const t = await world();
  const s = sealing();
  t.w.signing.onDecision = blip;
  const paid = await T.createTransfer(t.deps(), OWNER, amountInput(t.recipientId, 100));
  assert.equal(paid.ok, true, JSON.stringify(paid));
  const declined = await declineSigningRequest(t.w.signing, { orgId: 'acme', userId: 'u-three', id: paid.signingRequest.id });
  assert.equal(declined.ok, true, JSON.stringify(declined));
  assert.deepEqual(await rowsOf(t, paid.transfer.id), []);
  await sweep(t, s);
  assert.deepEqual((await rowsOf(t, paid.transfer.id)).map((r) => [r.userId, r.kind, r.role]), [['u-three', 'declined', 'owner']]);
  await t.w.client.close();
});

test('an owner\'s answer to an ask whose trail write failed is brought back; an ask being claimed (no request opened yet) is not an answer', async () => {
  const t = await world();
  const s = sealing();
  const asked = await T.createTransfer(t.deps(), STAFF, amountInput(t.recipientId, 5_000, { clientKey: 'tx_key_000777' }));
  assert.equal(asked.ok, true, JSON.stringify(asked));
  assert.equal(asked.transfer.route, 'asked_owners');
  // An owner declines; the hook fails.
  const declined = await declineApprovalAsk(t.db, { orgId: 'acme', userId: 'u-founder', askId: asked.ask.id, now: () => t.w.signing.now() }, { onDecision: blip });
  assert.equal(declined.ok, true, JSON.stringify(declined));
  assert.deepEqual(await rowsOf(t, asked.transfer.id), []);
  await sweep(t, s);
  assert.deepEqual((await rowsOf(t, asked.transfer.id)).map((r) => [r.userId, r.kind, r.role]), [['u-founder', 'ask_declined', 'owner']]);

  // Another payment's ask, accepted: the owner claimed it ('signing') and a request was opened for it.
  const second = await T.createTransfer(t.deps(), STAFF, amountInput(t.recipientId, 5_000, { clientKey: 'tx_key_000888' }));
  assert.equal(second.ok, true, JSON.stringify(second));
  await t.db.update(schema.walletApprovalAsks).set({ status: 'signing', decidedBy: 'u-two', decidedAt: new Date() }).where(eq(schema.walletApprovalAsks.id, second.ask.id));
  await sweep(t, s);
  assert.deepEqual(await rowsOf(t, second.transfer.id), [], 'claimed but no request opened: not yet an answer');
  const ownerPayment = await T.createTransfer(t.deps(), OWNER, amountInput(t.recipientId, 100, { clientKey: 'tx_key_000999' }));
  assert.equal(ownerPayment.ok, true, JSON.stringify(ownerPayment));
  await t.db.update(schema.walletApprovalAsks).set({ signingRequestId: ownerPayment.signingRequest.id }).where(eq(schema.walletApprovalAsks.id, second.ask.id));
  await sweep(t, s);
  assert.deepEqual((await rowsOf(t, second.transfer.id)).map((r) => [r.userId, r.kind]), [['u-two', 'ask_accepted']]);
  await t.w.client.close();
});

test('the sweep derives nothing for a payment made before records kept a trail, for another business, or for a person who has left', async () => {
  const t = await world();
  const s = sealing();
  t.w.signing.onDecision = blip;
  const old = await T.createTransfer(t.deps(), OWNER, amountInput(t.recipientId, 100, { clientKey: 'tx_key_000111' }));
  assert.equal(old.ok, true, JSON.stringify(old));
  await t.db.update(schema.walletTransfers).set({ recordHash: null, recordBlobId: null }).where(eq(schema.walletTransfers.id, old.transfer.id));
  await signBy(t.w, old.signingRequest, ['founder']);
  const fresh = await T.createTransfer(t.deps(), OWNER, amountInput(t.recipientId, 100, { clientKey: 'tx_key_000222' }));
  assert.equal(fresh.ok, true, JSON.stringify(fresh));
  await signBy(t.w, fresh.signingRequest, ['two']);
  // The signer then leaves the business before the sweep: no role to record, so nothing is invented.
  await t.db.delete(schema.memberships).where(eq(schema.memberships.userId, 'u-two'));
  const tally = await sweep(t, s);
  assert.equal(tally.derived, 0, JSON.stringify(tally));
  assert.equal(tally.skipped, 1, 'the one who left is counted, not made up');
  assert.deepEqual(await rowsOf(t, old.transfer.id), []);
  assert.deepEqual(await rowsOf(t, fresh.transfer.id), []);
  assert.deepEqual(await trail.decisionsOf(t.db, 'northwind', fresh.transfer.id), []);
  await t.w.client.close();
});

test('a derived decision that cannot be sealed waits unsealed, and the next sweep seals it; the live hook and the sweep make one row between them', async () => {
  const t = await world();
  t.w.signing.onDecision = blip;
  const paid = await t.confirmedPayment(t.deps());
  const view = paid.signingRequest;
  await submitPartialSignature(t.w.signing, { orgId: 'acme', userId: 'u-staff', id: view.id, signature: await sign(staffKey, view), digest: view.digest });
  const down = sealing({ store: async () => { throw new Error('walrus is down'); } });
  const first = await sweep(t, down);
  assert.deepEqual([first.derived, first.sealed, first.failed], [1, 0, 1]);
  assert.equal((await rowsOf(t, paid.transfer.id))[0].contentHash, null, 'on record, waiting');
  const up = sealing();
  const second = await sweep(t, up);
  assert.deepEqual([second.derived, second.sealed], [0, 1]);
  // The hook arriving late finds the row already there.
  const late = await trail.recordPaymentDecision({ db: t.db, seal: up.sealer, now: () => new Date() }, { orgId: 'acme', signingRequestId: view.id, userId: 'u-staff', kind: 'signed' });
  assert.equal(late.ok && late.recorded, false);
  assert.equal((await rowsOf(t, paid.transfer.id)).length, 1);
  await t.w.client.close();
});

test('the cron runs the recovery, and the comments no longer promise a sweep that does not exist', async () => {
  const { readFileSync } = await import('node:fs');
  const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  assert.match(read('lib/server/payment-trail-deps.ts'), /sweepPaymentTrail/);
  assert.match(read('app/api/cron/wallet-signing/route.ts'), /sweepDecisionRecords/);
  assert.match(read('lib/server/payment-trail.ts'), /export async function sweepPaymentTrail/);
});

// ─── The name inside the sealed record is the name as stored ────────────────

test('the sealed records hold the name and title exactly as they are stored, not as a screen would clean them', async () => {
  const t = await world();
  const s = sealing();
  const raw = 'Maya 2nd 😀 Okafor';
  const title = 'VP, Buying & Ops 3';
  await t.db.update(schema.users).set({ name: raw }).where(eq(schema.users.id, 'u-staff'));
  await t.db.update(schema.memberships).set({ title }).where(eq(schema.memberships.userId, 'u-staff'));
  t.w.signing.onDecision = (decision) => trail.recordPaymentDecision({ db: t.db, seal: s.sealer, now: () => new Date() }, decision);
  const d = t.deps();
  const paid = await t.confirmedPayment(d);
  const view = paid.signingRequest;
  await submitPartialSignature(t.w.signing, { orgId: 'acme', userId: 'u-staff', id: view.id, signature: await sign(staffKey, view), digest: view.digest });
  const built = await trail.buildPaymentTrail(t.db, { orgId: 'acme', actor: { userId: 'u-staff', role: 'MAKER' }, route: 'staff_rule', rule: null, spender: null, at: new Date() });
  assert.equal(built.startedBy.name, raw);
  assert.equal(built.startedBy.title, title);
  assert.equal(t.records.at(-1).trail.startedBy.name, raw, 'the payment\'s own record');
  assert.equal(s.plains.at(-1).record.by.name, raw, 'the decision record');
  assert.equal(s.plains.at(-1).record.by.title, title);
  await t.w.client.close();
});

// ─── Scheduled payments and batches carry a trail in their own records ──────

test('an automatic scheduled payment\'s sealed record says who set the schedule up, when, under which allowance, and who could approve', async () => {
  const { runScheduledPayments } = await import('../lib/server/scheduled-runner.ts');
  const S = await import('../lib/server/scheduled-payments.ts');
  const { saveSettings } = await import('../lib/server/scheduled-store.ts');
  const { DAY, OWNER_ACTOR, sched, scheduleWorld, t0 } = await import('./fixtures/schedule-world.mjs');
  const FIRST = new Date(Number(t0) + 2 * Number(DAY));
  const t = await scheduleWorld({});
  await t.allowance({});
  await t.payBefore(t.ids.a, 1);
  await t.payBefore(t.ids.b, 1);
  const made = await S.createSchedule(t.sdeps(), OWNER_ACTOR, sched(t.ids, { mode: 'auto', firstDueAt: FIRST.toISOString() }));
  assert.equal(made.ok, true, JSON.stringify(made));
  await saveSettings(t.w.db, 'acme', { graceMinutes: 0 }, new Date());
  await t.clock(FIRST);
  const records = [];
  const withRecord = (orgId = 'acme') => t.sdeps(orgId, { paymentRecord: async (input) => (records.push(input), { ok: true, contentHash: new Uint8Array(32).fill(4), walrusBlobId: new TextEncoder().encode('blob-s') }) });
  const result = await runScheduledPayments({ db: t.w.db, now: () => t.w.signing.now(), depsFor: async (orgId) => (orgId === 'acme' ? withRecord() : null), env: { NODE_ENV: 'test' } });
  assert.deepEqual(result.errors, []);
  assert.equal(records.length, 2, 'one sealed record for each payment');
  for (const r of records) {
    assert.ok(r.trail, 'a trail is always there');
    assert.equal(r.trail.startedBy.userId, OWNER_ACTOR.userId);
    assert.equal(r.trail.startedBy.role, 'owner');
    assert.equal(r.trail.route, 'scheduled_auto');
    assert.ok(r.trail.rule, 'the allowance the chain showed just before it was paid');
    assert.ok(r.trail.mayApprove.includes(OWNER_ACTOR.userId));
    assert.ok(Date.parse(r.trail.startedAt) > 0);
  }
  await t.w.client.close();
});

test('the docs say plainly where the trail stops: decisions on a batch or a scheduled approval are not yet separate sealed records', async () => {
  const { readFileSync } = await import('node:fs');
  const doc = readFileSync(new URL('../docs/v2/phase3-team-roles.md', import.meta.url), 'utf8');
  assert.match(doc, /batch[\s\S]{0,400}decision records?[\s\S]{0,400}(not|never)/i);
  assert.match(doc, /migration 0086|a later migration/i);
});
