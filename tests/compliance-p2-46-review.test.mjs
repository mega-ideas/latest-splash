/**
 * The second §4.6 review's fixes.
 *
 *   - a sanctions-list BLOCK on a recipient is sticky: a later CLEAR (a
 *     re-screen during a list outage, say) never lifts it, and a re-screen
 *     does not even ask the provider;
 *   - with Elliptic and the sanctions list both configured, a list that gave
 *     no answer leaves the screening unanswered: Elliptic's CLEAR alone is
 *     not "not listed";
 *   - the evidence keeps a clearing code (a US routing number, a sort code)
 *     as the public bank identifier it is, and still refuses an account
 *     number under any other key;
 *   - the evidence exists for an owner's second approval of a rule payment
 *     (`spend_approval`): the recipient, the amount, the rule and the
 *     signers; the money that funded the wallet and how it was screened;
 *   - a rule payment to an exchange waits for its Travel Rule message too;
 *   - a KYB state read before another writer changed it is not written over.
 *
 * PGlite with every migration. Nothing reaches a network.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { normalizeSuiAddress } from '@mysten/sui/utils';

import * as schema from '../lib/db/schema.ts';
import { assertEvidenceClean, EvidenceLeak } from '../lib/compliance/controls-evidence.ts';
import { kytProviderFromEnv } from '../lib/compliance/kyt.ts';
import { controlsEvidenceFor } from '../lib/server/controls-evidence.ts';
import { recordScreening, recipientScreeningGate, screenRecipient } from '../lib/server/kyt-screenings.ts';
import { paymentBeforeSign } from '../lib/server/payment-compliance-gate.ts';

import { attachDb, migratedDb } from './helpers/store-db.mjs';
import { saveWalletRecipient } from './fixtures/saved-recipients.mjs';

const T0 = new Date('2026-10-20T10:00:00.000Z');
const HOUR = 3_600_000;
const PAYEE = normalizeSuiAddress('0x' + '77'.repeat(32));
const INTENT = normalizeSuiAddress('0x' + '99'.repeat(32));
const sui = () => normalizeSuiAddress(`0x${randomUUID().replaceAll('-', '').padEnd(64, 'a')}`);

const answer = (address, { provider = 'elliptic', verdict = 'CLEAR', at = T0, orgId = 'acme' } = {}) => ({
  orgId, kind: 'wallet_recipient', chain: 'SUI', address, requestedBy: 'u-two',
  screening: { provider, verdict, reference: verdict ? `${provider}:${randomUUID()}` : null, detail: 'x', screenedAt: verdict ? at.toISOString() : null },
});
const later = () => new Promise((r) => setTimeout(r, 8));

/* 1 ── A sanctions listing stays ─────────────────────────────────────── */

test('a sanctions-list BLOCK is not lifted by a later CLEAR, and a re-screen does not ask the provider', async () => {
  const { db, client } = await migratedDb();
  await recordScreening(db, answer(PAYEE, { provider: 'chainalysis_sanctions', verdict: 'BLOCK' }));
  await later();
  // The list was down; Elliptic scored the listed address low.
  await recordScreening(db, answer(PAYEE, { provider: 'elliptic', verdict: 'CLEAR' }));
  const deps = { db, orgId: 'acme', now: T0, kyt: null, requestedBy: 'u-two' };
  const gate = await recipientScreeningGate(deps, PAYEE);
  assert.deepEqual([gate?.status, gate?.code], [403, 'recipient_blocked']);

  let asked = 0;
  const kyt = { id: 'elliptic', async screen() { asked += 1; return { provider: 'elliptic', verdict: 'CLEAR', reference: 'elliptic:again', detail: 'x', screenedAt: T0.toISOString() }; } };
  const again = await screenRecipient({ db, kyt, orgId: 'acme', now: () => T0 }, { kind: 'wallet_recipient', chain: 'SUI', address: PAYEE, requestedBy: 'u-staff' });
  assert.equal(again.ok, true);
  assert.equal(again.screening.verdict, 'BLOCK');
  assert.equal(again.screening.permitsPayment, false);
  assert.equal(asked, 0, 'a listed address is not asked about again');

  // Another business's address, and an Elliptic BLOCK (its score can move), are not sticky.
  const other = sui();
  await recordScreening(db, answer(other, { provider: 'elliptic', verdict: 'BLOCK' }));
  const rescreened = await screenRecipient({ db, kyt, orgId: 'acme', now: () => T0 }, { kind: 'wallet_recipient', chain: 'SUI', address: other, requestedBy: 'u-staff' });
  assert.equal(rescreened.screening.verdict, 'CLEAR');
  assert.equal(asked, 1);
  const northwind = await screenRecipient({ db, kyt, orgId: 'northwind', now: () => T0 }, { kind: 'wallet_recipient', chain: 'SUI', address: PAYEE, requestedBy: 'u-staff' });
  assert.equal(northwind.screening.verdict, 'CLEAR', "another business's listing is its own");
  await client.close();
});

test('with Elliptic and the sanctions list, a list that gave no answer leaves the screening unanswered', async () => {
  const env = { NODE_ENV: 'production', ELLIPTIC_API_KEY: 'k', ELLIPTIC_API_SECRET: 'c2VjcmV0LXNlY3JldC1zZWNyZXQ=', CHAINALYSIS_SANCTIONS_API_KEY: 'chainalysis-key' };
  const route = (listStatus) => async (url) =>
    url.includes('chainalysis') ? new Response(JSON.stringify({ identifications: [] }), { status: listStatus }) : new Response(JSON.stringify({ id: 'analysis-0001', risk_score: 0.5 }), { status: 200 });
  const down = await kytProviderFromEnv(env, { fetcher: route(503), now: () => T0 }).screen({ chain: 'SUI', address: sui(), direction: 'recipient' });
  assert.equal(down.verdict, null, JSON.stringify(down));
  assert.equal(down.reference, null);
  const up = await kytProviderFromEnv(env, { fetcher: route(200), now: () => T0 }).screen({ chain: 'SUI', address: sui(), direction: 'recipient' });
  assert.equal(up.verdict, 'CLEAR');
});

/* 2 ── A bank's clearing code is public ──────────────────────────────── */

test('a clearing code is kept as the bank identifier it is, and an account number under another key is still refused', () => {
  for (const code of ['021000021', '200415', 'DEUTDEFF', '1234567890']) {
    assertEvidenceClean({ iso20022: { creditorAgent: code } });
  }
  assert.throws(() => assertEvidenceClean({ iso20022: { remittanceInfo: '021000021' } }), EvidenceLeak);
  assert.throws(() => assertEvidenceClean({ iso20022: { creditorAgentNote: '1234567890' } }), EvidenceLeak);
});

/* 3 ── Evidence for an owner's second approval of a rule payment ──────── */

async function world() {
  const { db, client } = await migratedDb();
  await client.exec(`INSERT INTO users (id, email, name) VALUES ('u-owner', 'owner@acme.test', 'Owner')`);
  await db.insert(schema.kybCases).values({ id: 'kyb_acme_1', orgId: 'acme', businessName: 'Acme Trading Sdn Bhd', registrationNumber: '202001012345', state: 'APPROVED', sumsubApplicantId: 'applicant-001', updatedAt: new Date(T0.getTime() - 30 * 24 * HOUR) });
  return { db, client };
}

async function ruleApproval(db, { recipient = PAYEE, kind = 1 } = {}) {
  const id = `wsr_${randomUUID()}`;
  const intent = { intentId: INTENT, recipient, amountMinor: '1500000000', kind, targetCurrency: 'USDC', fxRateUsdLocal: '1000000', expiresAtMs: '9', asset: '0x2::usdc::USDC' };
  await db.insert(schema.walletSigningRequests).values({
    id, orgId: 'acme', purpose: 'spend_approval', dedupeKey: id, senderAddress: `0x${'01'.repeat(32)}`, signerKind: 'single', threshold: 1, gasMode: 'sponsored',
    txBytes: 'AAAA', txDigest: `digest-${id}`, bytesHash: 'h'.repeat(64), status: 'executed', requestedBy: 'u-owner', expiresAt: new Date(T0.getTime() + HOUR), executedDigest: 'D1gest', createdAt: new Date(T0.getTime() - HOUR),
    summary: {
      description: { actions: [{ type: 'approve_payout', policy: `0x${'5a'.repeat(32)}`, intent, payer: `0x${'42'.repeat(32)}`, maxTotalMinor: '1500300000', settleByMs: '9' }] },
      openIntent: intent,
      spend: { policyIds: [`0x${'5a'.repeat(32)}`], allowanceIds: [`0x${'a1'.repeat(32)}`] },
    },
  });
  await db.insert(schema.walletSigningSigners).values({ requestId: id, orgId: 'acme', userId: 'u-owner', address: `0x${'01'.repeat(32)}`, publicKey: 'pk-1', weight: 1, signedAt: T0, signatureSha256: 's'.repeat(64) });
  return id;
}
const evDeps = (db) => ({ db, orgId: 'acme', now: () => new Date(T0.getTime() + 10 * 24 * HOUR), readTransaction: async () => null, corePackageOriginalId: null });

test("the evidence exists for an owner's second approval of a rule payment, with its rule and signers", async () => {
  const { db, client } = await world();
  await recordScreening(db, answer(PAYEE, { at: new Date(T0.getTime() - HOUR) }));
  const id = await ruleApproval(db);
  const r = await controlsEvidenceFor(evDeps(db), id, 'u-owner');
  assert.equal(r.ok, true, JSON.stringify(r));
  const e = r.evidence;
  assert.deepEqual([e.payment.paidTo, e.payment.amountMinor, e.payment.intentId, e.payment.maxFeeMinor], [PAYEE, '1500000000', INTENT, '300000']);
  assert.equal(e.approval.purpose, 'spend_approval');
  assert.deepEqual(e.approval.spendingRule.allowanceIds, [`0x${'a1'.repeat(32)}`]);
  assert.equal(e.approval.secondApproval.payer, `0x${'42'.repeat(32)}`);
  assert.equal(e.approval.signers.length, 1);
  assert.equal(e.screenings.length, 1, 'the recipient screening before approval');
  assert.ok(!e.gaps.some((g) => /No CLEAR screening/.test(g)), e.gaps.join(' | '));
  await client.close();
});

test('the evidence names the screenings of the money that funded the wallet', async () => {
  const { db, client } = await world();
  const id = await ruleApproval(db);
  await db.insert(schema.walletDeposits).values({
    id: `wdp_${randomUUID()}`, orgId: 'acme', walletAddress: `0x${'01'.repeat(32)}`, suiDigest: 'DepositD1gest', coinType: '0x2::usdc::USDC', asset: 'USDC', amountMinor: 2_000_000_000n,
    channel: 'wallet', status: 'cleared', screening: { provider: 'elliptic', verdict: 'CLEAR', reference: 'elliptic:dep-0001', screenedAt: new Date(T0.getTime() - 2 * HOUR).toISOString() }, arrivedAt: new Date(T0.getTime() - 2 * HOUR),
  });
  const r = await controlsEvidenceFor(evDeps(db), id, 'u-owner');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.evidence.fundingScreenings.length, 1);
  assert.deepEqual(
    [r.evidence.fundingScreenings[0].provider, r.evidence.fundingScreenings[0].reference, r.evidence.fundingScreenings[0].verdict, r.evidence.fundingScreenings[0].status],
    ['elliptic', 'elliptic:dep-0001', 'CLEAR', 'cleared'],
  );
  await client.close();
});

test('a rule payment to an exchange waits for its Travel Rule message too', async () => {
  const { db, client } = await world();
  const EXCHANGE = normalizeSuiAddress('0x' + '66'.repeat(32));
  await recordScreening(db, { ...answer(EXCHANGE), kind: 'exchange_recipient' });
  await saveWalletRecipient(db, { address: EXCHANGE, kind: 'EXCHANGE' });
  const id = await ruleApproval(db, { recipient: EXCHANGE, kind: 2 });
  const { readSigningRequest } = await import('../lib/server/wallet-signing-store.ts');
  const stored = () => readSigningRequest(db, 'acme', id);
  const gate = (request) => paymentBeforeSign({ db, now: () => T0 }, request);
  assert.equal((await gate(await stored()))?.code, 'travel_rule_missing');
  await db.insert(schema.travelRuleTransfers).values({
    id: `trt_${randomUUID()}`, orgId: 'acme', paymentRef: INTENT, signingRequestId: id, exchange: 'pdax', depositAddress: EXCHANGE, amountMinor: 1_500_000_000n,
    requestHash: 'h', provider: 'sumsub', sandbox: false, providerRef: 'txn-1', status: 'submitted', createdBy: 'u', createdAt: T0, updatedAt: T0,
  });
  assert.equal(await gate(await stored()), null);
  await client.close();
});

/* 4 ── Two writers of one business's KYB state ───────────────────────── */

test("a KYB state read before another writer changed it is not written over", async () => {
  const { db, client } = await migratedDb();
  await client.exec(`UPDATE organizations SET kyb_lifecycle = 'KYB_SUBMITTED' WHERE id = 'acme'`);
  const undo = attachDb(db);
  try {
    const { setOrgKybState } = await import('../lib/compliance/org-kyb.ts');
    // Both read KYB_SUBMITTED; only the first write may land.
    const settled = await Promise.allSettled([setOrgKybState('acme', 'KYB_PROVIDER_APPROVED', 'PROVIDER'), setOrgKybState('acme', 'REJECTED', 'PROVIDER')]);
    assert.deepEqual(settled.map((s) => s.status).sort(), ['fulfilled', 'rejected']);
    const lost = settled.find((s) => s.status === 'rejected');
    assert.equal(lost.reason.name, 'KybTransitionError');
    const [org] = await client.query(`SELECT kyb_lifecycle FROM organizations WHERE id = 'acme'`).then((r) => r.rows);
    assert.equal(org.kyb_lifecycle, settled[0].status === 'fulfilled' ? 'KYB_PROVIDER_APPROVED' : 'REJECTED');
  } finally {
    undo();
    await client.close();
  }
});
