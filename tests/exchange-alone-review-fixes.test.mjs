/**
 * v2 Phase 3, review fixes for "staff pay an exchange account alone".
 *
 *   switch          read again inside the claim (under the business's lock)
 *                   and again right before the Travel Rule message goes, so an
 *                   owner who turns it off between the first read and the send
 *                   stops the message and the payment, instantly.
 *   binding         the bytes that are signed carry the payment reference and
 *                   the commitment; the signing gate compares both with the
 *                   stored message, so "bound to the intent id" is checked,
 *                   not claimed.
 *   resend          a message that did not go can be sent again after a reload
 *                   or a replay: the state comes back with the payment and from
 *                   its own route.
 *   words           the confirmation shows the exchange as Recipients does, the
 *                   payment details exactly as they are sent, and says which
 *                   purpose a replayed payment already shared.
 *   splash business a Splash business on a person's rule is judged as the
 *                   kind it is declared as, at open time.
 *   gate order      the switch is asked before the recipient's own rule, so the
 *                   reason a person reads is the owner's switch.
 *
 * PGlite with every migration, software passkeys and the model chain
 * (tests/fixtures/spend-world.mjs). Nothing is signed or sent on any network.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { eq } from 'drizzle-orm';
import { normalizeSuiAddress } from '@mysten/sui/utils';

import * as schema from '../lib/db/schema.ts';
import { ComplianceProviderUnavailable } from '../lib/compliance/sumsub.ts';
import { disclosureText, purposeTextOf } from '../lib/compliance/exchange-disclosure.ts';
import { EXCHANGE_OPTIONS } from '../lib/transfer/payee.ts';
import { exchangeAloneOf } from '../lib/server/exchange-alone.ts';
import { setMemberAccess } from '../lib/server/team-admin.ts';
import { paymentBeforeSign } from '../lib/server/payment-compliance-gate.ts';
import { readSigningRequest } from '../lib/server/wallet-signing-store.ts';
import * as T from '../lib/server/wallet-transfers.ts';
import { amountInput, feeFor, NORTH_WALLET, setup, sign, STAFF, STAFF2, staffKey, staff2Key, U } from './fixtures/staff-rule-world.mjs';
import { submitPartialSignature } from '../lib/server/wallet-signing.ts';

const EXCHANGE = normalizeSuiAddress(`0x${'79'.repeat(32)}`);
const KIND = 'pay_exchange_alone';
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

function spyProvider() {
  const sent = [];
  return {
    id: 'sandbox',
    sandbox: true,
    sent,
    async submitOutbound(input) {
      sent.push(input);
      return { provider: 'sandbox', sandbox: true, reference: `sandbox_tr_${sent.length}`, status: 'submitted' };
    },
  };
}

async function exchangeSetup(opts = {}) {
  const t = await setup(opts);
  const db = t.w.db;
  await db
    .update(schema.organizations)
    .set({ legalName: 'Acme Trading Sdn Bhd', registrationNumber: '201901234567', addressLine1: '8 Jalan Ampang', addressCity: 'Kuala Lumpur', addressPostalCode: '50450', addressCountry: 'MY', kybLifecycle: 'ACTIVE' })
    .where(eq(schema.organizations.id, 'acme'));
  await db.insert(schema.kybCases).values({ id: 'kyb-acme', orgId: 'acme', businessName: 'Acme Trading Sdn Bhd', registrationNumber: '201901234567', state: 'APPROVED', sumsubApplicantId: 'applicant-acme' });
  await t.w.screenClear(EXCHANGE);
  const exchangeId = await t.w.saveRecipient(EXCHANGE, { kind: 'EXCHANGE', exchange: 'pdax' });
  await t.verify(EXCHANGE, 'exchange');
  const provider = spyProvider();
  const gateDeps = () => ({ db, now: () => t.w.signing.now(), env: { NODE_ENV: 'test' } });
  t.w.signing.beforeSign = (request) => paymentBeforeSign(gateDeps(), request);
  const allow = (userId = 'u-staff', allowed = true) => setMemberAccess(db, { orgId: 'acme', actorUserId: 'u-founder', userId, access: KIND, allowed, now: () => new Date() });
  const xdeps = (orgId = 'acme', over = {}) => t.deps(orgId, { payExchangeAlone: (userId) => exchangeAloneOf(db, orgId, userId), travelRule: () => provider, ...over });
  const body = (usdc = 1_000, over = {}) => amountInput(exchangeId, usdc, { maxFeeMinor: feeFor(U(usdc), 2).toString(), ...over });
  const preview = (deps, actor, usdc = 1_000, over = {}) =>
    T.previewExchangeDisclosure(deps, actor, { clientKey: over.clientKey ?? 'tx_key_000001', payee: { kind: 'recipient', recipientId: exchangeId }, amountMinor: U(usdc).toString(), purpose: 'purpose' in over ? over.purpose : 'invoice' });
  const confirmed = async (deps, actor, usdc = 1_000, over = {}) => {
    const shown = await preview(deps, actor, usdc, over);
    assert.equal(shown.ok, true, JSON.stringify(shown));
    return { shown, request: body(usdc, { exchangeDisclosure: { purpose: over.purpose ?? 'invoice', confirmedHash: shown.hash }, ...over }) };
  };
  const requests = () => db.select().from(schema.walletSigningRequests).where(eq(schema.walletSigningRequests.purpose, 'staff_rule_payment'));
  const liveRequests = async () => (await requests()).filter((r) => r.status === 'collecting');
  const disclosures = () => db.select().from(schema.walletTransferDisclosures);
  const transfers = () => db.select().from(schema.walletTransfers);
  const gateOf = async (id) => paymentBeforeSign(gateDeps(), await readSigningRequest(db, 'acme', id));
  const paysOwn = (view, who = 'u-staff', key = staffKey) => sign(key, view).then((signature) => submitPartialSignature(t.w.signing, { orgId: 'acme', userId: who, id: view.id, signature, digest: view.digest }));
  return { ...t, db, exchangeId, provider, allow, xdeps, body, preview, confirmed, requests, liveRequests, disclosures, transfers, gateOf, paysOwn };
}

const nothingLeft = async (t) => {
  assert.equal((await t.disclosures()).length, 0, 'no message is kept');
  assert.equal(t.provider.sent.length, 0, 'no Travel Rule message went anywhere');
  assert.equal((await t.liveRequests()).length, 0, 'no payment is waiting to be signed');
  assert.equal(t.w.spends.length, 0, 'nothing is drawn');
};

// ─── 1. The switch is honoured up to the moment the message goes ───────────

test('the owner turns it off right after the first read: the claim sees it, so the owners are asked and nothing is built or shared', async () => {
  const t = await exchangeSetup();
  await t.give(t.rule(staffKey.address));
  await t.allow();
  const { request } = await t.confirmed(t.xdeps(), STAFF);
  const base = t.xdeps();
  let reads = 0;
  const deps = {
    ...base,
    payExchangeAlone: async (userId) => {
      reads += 1;
      const answer = await base.payExchangeAlone(userId);
      if (reads === 1) await t.allow('u-staff', false);
      return answer;
    },
  };
  const asked = await T.createTransfer(deps, STAFF, request);
  assert.equal(asked.ok, true, JSON.stringify(asked));
  assert.equal(asked.transfer.route, 'asked_owners');
  assert.deepEqual(asked.plan.reasons, ['exchange_needs_owners']);
  await nothingLeft(t);
  await t.w.client.close();
});

test('the owner turns it off right after the first read and the person insisted on paying alone: refused in words, nothing stored', async () => {
  const t = await exchangeSetup();
  await t.give(t.rule(staffKey.address));
  await t.allow();
  const { request } = await t.confirmed(t.xdeps(), STAFF);
  const base = t.xdeps();
  let reads = 0;
  const deps = { ...base, payExchangeAlone: async (userId) => { reads += 1; const a = await base.payExchangeAlone(userId); if (reads === 1) await t.allow('u-staff', false); return a; } };
  const r = await T.createTransfer(deps, STAFF, { ...request, via: 'rule' });
  assert.deepEqual([r.ok, r.status, r.code], [false, 409, 'outside_rule'], JSON.stringify(r));
  assert.deepEqual(r.reasons, ['exchange_needs_owners']);
  assert.equal((await t.transfers()).length, 0);
  await nothingLeft(t);
  await t.w.client.close();
});

test('the owner turns it off after the claim and before the message goes: the message is not sent, the request is withdrawn, and the owners are asked', async () => {
  const t = await exchangeSetup();
  await t.give(t.rule(staffKey.address));
  await t.allow();
  const { request } = await t.confirmed(t.xdeps(), STAFF);
  const base = t.xdeps();
  // The audit record is made after the claim and before the request is opened: the owner's change lands there.
  const deps = { ...base, paymentRecord: async (input) => { await t.allow('u-staff', false); return base.paymentRecord(input); } };
  const asked = await T.createTransfer(deps, STAFF, request);
  assert.equal(asked.ok, true, JSON.stringify(asked));
  assert.equal(asked.transfer.route, 'asked_owners');
  assert.equal(asked.exchange, undefined, 'no message state: none was sent');
  assert.ok(asked.ask, 'the owners are asked');
  await nothingLeft(t);
  const [row] = await t.transfers();
  assert.equal(row.route, 'asked_owners');
  await t.w.client.close();
});

test('the owner turns it off after the claim and the person insisted on paying alone: refused in words and nothing is kept', async () => {
  const t = await exchangeSetup();
  await t.give(t.rule(staffKey.address));
  await t.allow();
  const { request } = await t.confirmed(t.xdeps(), STAFF);
  const base = t.xdeps();
  const deps = { ...base, paymentRecord: async (input) => { await t.allow('u-staff', false); return base.paymentRecord(input); } };
  const r = await T.createTransfer(deps, STAFF, { ...request, via: 'rule' });
  assert.deepEqual([r.ok, r.status, r.code], [false, 409, 'outside_rule'], JSON.stringify(r));
  assert.match(r.error, /owner/i);
  assert.equal((await t.transfers()).length, 0);
  await nothingLeft(t);
  await t.w.client.close();
});

// ─── 2. The bytes carry the payment reference and the commitment, and the gate compares them ───

const sha = (text) => createHash('sha256').update(text).digest('hex');
const hexOf = (v) => String(v).toLowerCase().replace(/^0x/, '');

test('what is signed carries the payment reference and the commitment over the kept message, and they are the ones the server derives', async () => {
  const t = await exchangeSetup();
  await t.give(t.rule(staffKey.address));
  await t.allow();
  const { request } = await t.confirmed(t.xdeps(), STAFF);
  const r = await T.createTransfer(t.xdeps(), STAFF, request);
  assert.equal(r.ok, true, JSON.stringify(r));
  const [open, , pay] = r.signingRequest.description.actions;
  const [stored] = await t.disclosures();
  const [transfer] = await t.transfers();
  assert.equal(normalizeSuiAddress(open.paymentRef), normalizeSuiAddress(stored.paymentRef), 'the reference in the bytes is the one the message is bound to');
  assert.equal(hexOf(open.commitment), sha(JSON.stringify(['splash-transfer-commitment', 'acme', transfer.id, EXCHANGE, U(1_000).toString(), pay.maxFeeMinor, 2, stored.payloadHash])), 'the commitment covers the hash of the message');
  await t.w.client.close();
});

test('a kept message that was swapped for another that still names the same account and amount is not signed: the commitment in the bytes does not match it', async () => {
  const t = await exchangeSetup();
  await t.give(t.rule(staffKey.address));
  await t.allow();
  const { request } = await t.confirmed(t.xdeps(), STAFF);
  const r = await T.createTransfer(t.xdeps(), STAFF, request);
  const [stored] = await t.disclosures();
  assert.equal(await t.gateOf(r.signingRequest.id), null, 'as built, nothing stops it');
  await t.w.client.exec('ALTER TABLE wallet_transfer_disclosures DISABLE TRIGGER USER');
  const rewrite = async (payload, extra = {}) => {
    const canonical = JSON.stringify(payload);
    await t.db.update(schema.walletTransferDisclosures).set({ payload, canonical, payloadHash: sha(canonical), ...extra }).where(eq(schema.walletTransferDisclosures.id, stored.id));
    return t.gateOf(r.signingRequest.id);
  };
  // Same recipient, same amount, another purpose, hashed consistently: only the commitment in the bytes can tell.
  const refund = { ...stored.payload, purpose: { code: 'refund', label: 'A refund to a customer' } };
  assert.equal((await rewrite(refund))?.code, 'disclosure_mismatch');
  // Another payment reference, in the payload and in the row, hashed consistently: the reference in the bytes does not match it.
  const otherRef = `0x${'5a'.repeat(32)}`;
  assert.equal((await rewrite({ ...stored.payload, paymentRef: otherRef }, { paymentRef: otherRef }))?.code, 'disclosure_mismatch');
  // Put back exactly as it was kept, it is signable again.
  await t.db.update(schema.walletTransferDisclosures).set({ payload: stored.payload, canonical: stored.canonical, payloadHash: stored.payloadHash, paymentRef: stored.paymentRef }).where(eq(schema.walletTransferDisclosures.id, stored.id));
  assert.equal(await t.gateOf(r.signingRequest.id), null);
  await t.w.client.exec('ALTER TABLE wallet_transfer_disclosures ENABLE TRIGGER USER');
  await t.w.client.close();
});

// ─── 3. A message that did not go can be sent again after a reload ─────────

function flakyProvider() {
  const state = { up: false, sent: [] };
  return {
    state,
    id: 'sandbox',
    sandbox: true,
    async submitOutbound(input) {
      if (!state.up) throw new ComplianceProviderUnavailable('provider_error', 'The provider did not answer.', 502);
      state.sent.push(input);
      return { provider: 'sandbox', sandbox: true, reference: 'sandbox_tr_retry', status: 'submitted' };
    },
  };
}

test('replay and reload keep the message state: not sent stays "not sent" with the way to send it, and sent says sent', async () => {
  const t = await exchangeSetup();
  await t.give(t.rule(staffKey.address));
  await t.allow();
  const flaky = flakyProvider();
  const deps = t.xdeps('acme', { travelRule: () => flaky });
  const { request } = await t.confirmed(deps, STAFF);
  const first = await T.createTransfer(deps, STAFF, request);
  assert.equal(first.exchange.travelRule.state, 'not_sent');
  // The response was lost: the same intent id answers the same payment, and still says the message has not gone.
  const again = await T.createTransfer(deps, STAFF, request);
  assert.equal(again.created, false);
  assert.equal(again.exchange?.travelRule.state, 'not_sent', JSON.stringify(again.exchange));
  assert.match(again.exchange.travelRule.text, /not been sent/i);
  // The payment's own page asks for it by the signing request.
  const asked = await T.readExchangeMessage(deps, STAFF, { signingRequestId: first.signingRequest.id });
  assert.equal(asked.ok, true, JSON.stringify(asked));
  assert.equal(asked.travelRule?.state, 'not_sent');
  flaky.state.up = true;
  const resent = await T.sendStoredExchangeMessage(deps, STAFF, { signingRequestId: first.signingRequest.id });
  assert.equal(resent.travelRule.state, 'sent');
  const after = await T.createTransfer(deps, STAFF, request);
  assert.equal(after.exchange?.travelRule.state, 'sent');
  assert.equal((await T.readExchangeMessage(deps, STAFF, { signingRequestId: first.signingRequest.id })).travelRule?.state, 'sent');
  assert.equal(flaky.state.sent.length, 1, 'sent once');
  await t.w.client.close();
});

test('the message state is the person’s own: another person, another business and a payment with no message read as absent or empty', async () => {
  const t = await exchangeSetup();
  await t.give(t.rule(staffKey.address));
  await t.give(t.rule(staff2Key.address));
  await t.allow();
  const deps = t.xdeps();
  const { request } = await t.confirmed(deps, STAFF);
  const r = await T.createTransfer(deps, STAFF, request);
  const colleague = await T.readExchangeMessage(deps, STAFF2, { signingRequestId: r.signingRequest.id });
  assert.deepEqual([colleague.ok, colleague.status], [false, 404]);
  const north = await T.readExchangeMessage(t.xdeps('northwind'), { userId: 'u-north-staff', role: 'MAKER' }, { signingRequestId: r.signingRequest.id });
  assert.deepEqual([north.ok, north.status], [false, 404]);
  const wallet = await T.createTransfer(deps, STAFF, amountInput(t.recipientId, 500, { clientKey: 'tx_key_000007' }));
  assert.equal(wallet.transfer.route, 'staff_rule');
  const none = await T.readExchangeMessage(deps, STAFF, { signingRequestId: wallet.signingRequest.id });
  assert.deepEqual([none.ok, none.travelRule], [true, null]);
  await t.w.client.close();
});

test('the page offers the resend wherever the signing request is shown, not only in the first answer', () => {
  const panel = read('components/transfer/SignPanel.tsx');
  assert.match(panel, /ExchangeMessage/, 'the signing panel shows the state');
  assert.match(panel, /staff_rule_payment/);
  const messageUi = read('components/transfer/ExchangeMessage.tsx');
  assert.match(messageUi, /exchange-message/);
  assert.match(messageUi, /Send the message again/);
  const route = read('app/api/wallet/transfers/[ref]/exchange-message/route.ts');
  assert.match(route, /export async function GET/);
});

// ─── 4. Replay says which purpose was already shared ───────────────────────

test('a retry with another purpose answers the payment already made and says which purpose the exchange was already told', async () => {
  const t = await exchangeSetup();
  await t.give(t.rule(staffKey.address));
  await t.allow();
  const deps = t.xdeps();
  const { request } = await t.confirmed(deps, STAFF, 1_000, { purpose: 'invoice' });
  const first = await T.createTransfer(deps, STAFF, request);
  assert.equal(first.created, true);
  const other = await T.createTransfer(deps, STAFF, { ...request, exchangeDisclosure: { purpose: 'refund', confirmedHash: 'a'.repeat(64) } });
  assert.equal(other.created, false);
  assert.match(other.exchange.notice, /Paying a supplier invoice/, 'what was shared');
  assert.match(other.exchange.notice, /A refund to a customer/, 'what the retry asked for');
  const same = await T.createTransfer(deps, STAFF, request);
  assert.equal(same.exchange.notice, undefined);
  assert.equal(t.provider.sent.length, 1);
  await t.w.client.close();
});

// ─── 5. A Splash business on a person's rule is judged as the kind it is declared as ───

test('a Splash business on a person’s rule is refused up front like any wallet that is not saved, not opened and sponsored and then refused at signing', async () => {
  const t = await exchangeSetup();
  await t.give(t.rule(staffKey.address));
  // The chain would not tag a Splash business address as a wallet without an ownership proof, so it is put on the rule in the model chain directly:
  // the test is about what the server does if one ever is.
  for (const p of t.w.spend.policies.values()) p.recipients.push({ domain: 8, address: NORTH_WALLET, kind: 1 });
  await t.w.screenClear(NORTH_WALLET);
  const deps = t.xdeps('acme', { businessWallet: async (id) => (id === 'northwind' ? { ok: true, name: 'Northwind Traders', wallet: NORTH_WALLET, country: 'PH' } : null) });
  const r = await T.createTransfer(deps, STAFF, { clientKey: 'tx_key_000011', payee: { kind: 'splash_business', businessId: 'northwind' }, amountMinor: U(500).toString(), maxFeeMinor: feeFor(U(500), 0).toString(), via: 'rule' });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.deepEqual([r.status, r.code, r.reasons], [409, 'recipient_not_saved', undefined], JSON.stringify(r));
  assert.equal((await t.requests()).length, 0, 'no request was opened or sponsored');
  assert.equal((await t.transfers()).length, 0);
  await t.w.client.close();
});

// ─── 6. At signing, the owner's switch is the reason given ─────────────────

test('an owner who turned the switch off is named as the reason, even while the exchange has not confirmed the account', async () => {
  const t = await exchangeSetup();
  await t.give(t.rule(staffKey.address));
  await t.allow();
  const { request } = await t.confirmed(t.xdeps(), STAFF);
  const r = await T.createTransfer(t.xdeps(), STAFF, request);
  assert.equal(r.ok, true, JSON.stringify(r));
  // The exchange has not confirmed the account yet.
  await t.db.update(schema.travelRuleTransfers).set({ status: 'submitted' }).where(eq(schema.travelRuleTransfers.orgId, 'acme'));
  assert.equal((await t.gateOf(r.signingRequest.id))?.code, 'exchange_unconfirmed', 'as it is, the exchange’s confirmation is what is missing');
  await t.allow('u-staff', false);
  assert.equal((await t.gateOf(r.signingRequest.id))?.code, 'exchange_alone_off', 'with the switch off, that is the reason');
  await t.w.client.close();
});

// ─── 7. What the person confirms is what is sent ───────────────────────────

const message = (over = {}) => ({
  version: 1,
  intentId: 'tx_key_000001',
  paymentRef: `0x${'ab'.repeat(32)}`,
  amountMinor: '1250000000',
  asset: 'USDC',
  sender: { userId: 'u-staff', name: 'Mei Tan' },
  business: { legalName: 'Acme Trading Sdn Bhd', registrationNumber: '201901234567', country: 'MY', town: 'Kuala Lumpur', street: '8 Jalan Ampang', postCode: '50450', walletAddress: `0x${'cd'.repeat(32)}` },
  beneficiary: { legalName: 'Dela Cruz Trading Corp', registrationNumber: 'CS201912345', country: 'PH', town: 'Makati', street: '1 Ayala Ave', postCode: null, exchange: 'pdax', accountReference: `0x${'79'.repeat(32)}` },
  purpose: { code: 'invoice', label: 'Paying a supplier invoice' },
  ...over,
});

test('the exchange is shown as the recipient picker shows it (the exchange the person saved the account at), and its real name once its agreement is signed', () => {
  const picked = EXCHANGE_OPTIONS.find((o) => o.id === 'pdax').label;
  const rows = disclosureText(message()).rows;
  const row = rows.find((r) => /saved this account at/i.test(r.label));
  assert.ok(row, JSON.stringify(rows.map((r) => r.label)));
  assert.equal(row.value, picked, 'the same words the person chose it by');
  const signed = disclosureText(message(), new Set(['pdax'])).rows.find((r) => /saved this account at/i.test(r.label));
  assert.equal(signed.value, 'PDAX');
  // A different exchange reads differently: the words are not one fixed phrase.
  const other = disclosureText(message({ beneficiary: { ...message().beneficiary, exchange: 'bitkub' } })).rows.find((r) => /saved this account at/i.test(r.label));
  assert.notEqual(other.value, picked);
});

test('the payment details are shown exactly as they are sent, the person’s name cut to what travels', () => {
  const long = message({ sender: { userId: 'u-staff', name: 'Mei Tan-Delacroix of the Very Long Family Name Group' } });
  const shown = disclosureText(long).rows.find((r) => /payment details/i.test(r.label));
  assert.ok(shown, 'a row for what the exchange’s provider is told is for');
  assert.equal(shown.value, purposeTextOf(long), 'exactly the string that is sent');
  assert.ok(shown.value.length <= 140);
  assert.match(shown.value, /^Sent by Mei Tan-Delacroix of the Very Long Fa/);
});

// ─── 8. The page: only a purpose that was not accepted is the person's to change ───

test('the message lays an address out as one steady string that breaks anywhere, not as words that leave two characters alone on a line', () => {
  const panel = read('components/transfer/ExchangeDisclosure.tsx');
  assert.match(panel, /break-all font-mono/);
  assert.match(panel, /0x\[0-9a-f\]\{40,\}/);
});

test('the page treats only a refused purpose as the person’s to fix; any other refusal hands them to the owners', () => {
  const panel = read('components/transfer/ExchangeDisclosure.tsx');
  assert.match(panel, /bad_purpose/);
  assert.doesNotMatch(panel, /status !== 400/);
});

// ─── 9. The case the red tests had and the green ones dropped ──────────────

test('a recipient saved as an exchange account without its exchange cannot exist: the database refuses it, so the message never has to guess', async () => {
  const t = await exchangeSetup();
  await assert.rejects(() => t.db.update(schema.suppliers).set({ exchangeId: null }).where(eq(schema.suppliers.id, t.exchangeId)), (e) => /suppliers_exchange_check/.test(String(e.cause?.message ?? e.message)));
  await t.w.client.close();
});

test('every switch read in the server is the same one: the live wiring reads it from the database and the claim reads it inside the lock', () => {
  const transfers = read('lib/server/wallet-transfers.ts');
  assert.match(transfers, /pg_advisory_xact_lock[\s\S]*exchangeAloneOf\(tx/, 'read under the lock, on the claim’s own connection');
});
