/**
 * v2 Phase 3, staff pay an exchange account alone, when an owner allows it
 * (Sky's decision), and the Travel Rule message they confirm first.
 *
 *   switch          default OFF. Honoured by the server before it builds
 *                   anything (default deny): a person who is not allowed is
 *                   sent to the owners with the reason in words, or told no
 *                   and nothing stored when they insisted on paying alone.
 *                   It is read again before every signature, so an owner who
 *                   turns it off stops a payment already opened.
 *   rule            it only WIDENS what the rule allows. The per-payment
 *                   maximum, the cap, the expiry and the verified-recipient
 *                   requirement still bind, and the recipient must be on the
 *                   rule as an EXCHANGE account.
 *   Travel Rule     the message the person confirms is built on the server;
 *                   the payment is refused without a matching confirmation;
 *                   the exact payload is stored with the payment, bound to
 *                   the intent id, and the message sent to the provider is
 *                   made from that stored payload, nothing else.
 *   fail closed     no provider in production, a business or recipient
 *                   missing what the message needs: refused with a plain
 *                   reason and nothing is built.
 *
 * PGlite with every migration, software passkeys and the model chain
 * (tests/fixtures/spend-world.mjs). Nothing is signed or sent on any network.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { and, eq } from 'drizzle-orm';
import { normalizeSuiAddress } from '@mysten/sui/utils';

import * as schema from '../lib/db/schema.ts';
import { ComplianceProviderUnavailable } from '../lib/compliance/sumsub.ts';
import { approvalPlan, APPROVAL_REASON_TEXT } from '../lib/transfer/plan.ts';
import { readSpendingRules } from '../lib/server/spend-rules.ts';
import { deriveNearThresholdAlerts } from '../lib/server/near-threshold.ts';
import { exchangeAloneOf } from '../lib/server/exchange-alone.ts';
import { readStoredDisclosure } from '../lib/server/exchange-disclosure.ts';
import { setMemberAccess } from '../lib/server/team-admin.ts';
import { readTravelRuleTransfer } from '../lib/server/travel-rule-transfers.ts';
import { paymentBeforeSign } from '../lib/server/payment-compliance-gate.ts';
import { readSigningRequest } from '../lib/server/wallet-signing-store.ts';
import * as T from '../lib/server/wallet-transfers.ts';
import { amountInput, DAY, feeFor, OWNER, setup, sign, STAFF, STAFF2, staff2Key, staffKey, t0, U } from './fixtures/staff-rule-world.mjs';
import { submitPartialSignature } from '../lib/server/wallet-signing.ts';

const EXCHANGE = normalizeSuiAddress(`0x${'79'.repeat(32)}`);
const STRANGER_EXCHANGE = normalizeSuiAddress(`0x${'7a'.repeat(32)}`);
const KIND = 'pay_exchange_alone';

/** A Travel Rule provider that remembers what it was asked to send. */
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

/** The staff-rule world, plus an approved business with a KYB case, a confirmed exchange recipient on the rule, and the owner's switch. */
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
  const allow = (userId = 'u-staff', allowed = true) => setMemberAccess(db, { orgId: 'acme', actorUserId: 'u-founder', userId, access: KIND, allowed, now: () => new Date() });
  const xdeps = (orgId = 'acme', over = {}) =>
    t.deps(orgId, {
      payExchangeAlone: (userId) => exchangeAloneOf(db, orgId, userId),
      travelRule: () => provider,
      ...over,
    });
  const body = (usdc = 1_000, over = {}) => amountInput(exchangeId, usdc, { maxFeeMinor: feeFor(U(usdc), 2).toString(), ...over });
  const preview = (deps, actor, usdc = 1_000, over = {}) =>
    T.previewExchangeDisclosure(deps, actor, { clientKey: over.clientKey ?? 'tx_key_000001', payee: { kind: 'recipient', recipientId: exchangeId }, amountMinor: U(usdc).toString(), purpose: over.purpose ?? 'invoice' });
  /** What the page does: ask what will be shared, show it, and send the payment with the confirmation. */
  const confirmed = async (deps, actor, usdc = 1_000, over = {}) => {
    const shown = await preview(deps, actor, usdc, over);
    assert.equal(shown.ok, true, JSON.stringify(shown));
    return { shown, request: body(usdc, { exchangeDisclosure: { purpose: over.purpose ?? 'invoice', confirmedHash: shown.hash }, ...over }) };
  };
  const requests = () => db.select().from(schema.walletSigningRequests).where(eq(schema.walletSigningRequests.purpose, 'staff_rule_payment'));
  const disclosures = () => db.select().from(schema.walletTransferDisclosures);
  const transfers = () => db.select().from(schema.walletTransfers);
  const paysOwn = (view, who = 'u-staff', key = staffKey) => sign(key, view).then((signature) => submitPartialSignature(t.w.signing, { orgId: 'acme', userId: who, id: view.id, signature, digest: view.digest }));
  return { ...t, db, exchangeId, provider, allow, xdeps, body, preview, confirmed, requests, disclosures, transfers, paysOwn };
}

// ─── The plan: the same function on the page and on the server ─────────────

const rule = { status: 'active', perPaymentMaxMinor: U(2_000).toString(), spendableNowMinor: U(15_000).toString(), startsAtMs: null, expiresAtMs: null, renewsAtMs: null };
const policy = (tag = 'exchange') => ({ secondApprovalThresholdMinor: U(10_000).toString(), recipients: [{ address: EXCHANGE, tag }] });
const plan = (over = {}) =>
  approvalPlan({ role: 'MAKER', amountMinor: U(1_000), feeMinor: 0n, payee: { kind: 'wallet', wallet: 'exchange', address: EXCHANGE }, rule, policy: policy(), asset: 'USDC', ...over });

test('the plan: an exchange account goes to the owners unless the person is allowed; allowed, it is judged by the rule like any other payee', () => {
  assert.deepEqual(plan().reasons, ['exchange_needs_owners'], 'default deny');
  assert.deepEqual(plan({ exchangeAlone: false }).reasons, ['exchange_needs_owners']);
  const allowed = plan({ exchangeAlone: true });
  assert.equal(allowed.route, 'staff_rule');
  assert.match(APPROVAL_REASON_TEXT.exchange_needs_owners, /turned on|turn it on|allow/i, 'the words say the switch is what is missing');
  assert.match(APPROVAL_REASON_TEXT.exchange_needs_owners, /owner/i);
});

test('the plan: allowed or not, the rule still binds an exchange payment', () => {
  const on = { exchangeAlone: true };
  assert.deepEqual(plan({ ...on, amountMinor: U(2_500) }).reasons, ['over_payment_max']);
  assert.deepEqual(plan({ ...on, rule: { ...rule, spendableNowMinor: '0' } }).reasons, ['cap_used_up']);
  assert.deepEqual(plan({ ...on, rule: { ...rule, status: 'expired' } }).reasons, ['rule_expired']);
  assert.deepEqual(plan({ ...on, rule: null }).reasons, ['no_rule']);
  assert.deepEqual(plan({ ...on, policy: { ...policy(), recipients: [] } }).reasons, ['recipient_not_on_rule']);
  assert.deepEqual(plan({ ...on, policy: policy('wallet') }).reasons, ['exchange_not_verified_as_exchange'], 'on the rule as a wallet is not on it as an exchange');
  assert.deepEqual(plan({ ...on, runningTotalMinor: U(9_500), amountMinor: U(600) }).reasons, ['above_threshold']);
  assert.equal(plan({ ...on, role: 'OWNER' }).route, 'owners_sign');
  assert.equal(plan({ ...on, role: 'VIEWER' }).route, 'blocked');
  // A wallet payee tagged an exchange on the rule is still not a wallet payment, whatever the switch says.
  assert.deepEqual(plan({ ...on, payee: { kind: 'wallet', wallet: 'self_custody', address: EXCHANGE } }).reasons, ['exchange_needs_owners']);
  // A bank and another chain stay the owners', whatever the switch says.
  assert.deepEqual(plan({ ...on, payee: { kind: 'bank' } }).reasons, ['owners_pay_this_kind']);
  assert.deepEqual(plan({ ...on, payee: { kind: 'wallet', wallet: 'cross_chain', address: EXCHANGE } }).reasons, ['owners_pay_this_kind']);
});

// ─── The switch is honoured before anything is built ───────────────────────

test('switch off (the default): the owners are asked with the reason in words, or the person is refused when they insisted, and nothing is built or stored', async () => {
  const t = await exchangeSetup();
  await t.give(t.rule(staffKey.address));
  const deps = t.xdeps();
  // Even with a confirmed message in hand, the server decides from its own record of the owner's switch.
  const { request } = await (async () => {
    await t.allow('u-staff', true);
    const c = await t.confirmed(deps, STAFF);
    await t.allow('u-staff', false);
    return c;
  })();
  const insisted = await T.createTransfer(deps, STAFF, { ...request, via: 'rule' });
  assert.equal(insisted.ok, false, JSON.stringify(insisted));
  assert.deepEqual([insisted.status, insisted.code], [409, 'outside_rule']);
  assert.deepEqual(insisted.reasons, ['exchange_needs_owners']);
  assert.match(insisted.error, /owner/i);
  assert.equal((await t.transfers()).length, 0);
  assert.equal((await t.disclosures()).length, 0);
  assert.equal((await t.requests()).length, 0);
  assert.equal(t.provider.sent.length, 0, 'no Travel Rule message went anywhere');
  const asked = await T.createTransfer(deps, STAFF, { ...request, clientKey: 'tx_key_000002' });
  assert.equal(asked.ok, true, JSON.stringify(asked));
  assert.equal(asked.transfer.route, 'asked_owners');
  assert.deepEqual(asked.plan.reasons, ['exchange_needs_owners']);
  assert.equal((await t.requests()).length, 0);
  assert.equal((await t.disclosures()).length, 0, 'an ask to the owners shares nothing: the owners send their own message');
  assert.equal(t.provider.sent.length, 0);
  assert.equal(t.w.spends.length, 0);
  await t.w.client.close();
});

test('the preview is refused for a person who is not allowed, and for an owner, in words', async () => {
  const t = await exchangeSetup();
  await t.give(t.rule(staffKey.address));
  const off = await t.preview(t.xdeps(), STAFF);
  assert.deepEqual([off.ok, off.status, off.code], [false, 409, 'exchange_alone_off']);
  assert.match(off.error, /owner/i);
  await t.allow();
  const own = await t.preview(t.xdeps(), OWNER);
  assert.equal(own.ok, false);
  assert.equal(own.code, 'owners_send_their_own');
  const viewer = await t.preview(t.xdeps(), { userId: 'u-viewer', role: 'VIEWER' });
  assert.equal(viewer.ok, false);
  await t.w.client.close();
});

test('switch on: a staff member whose rule covers it pays an exchange account alone, as an EXCHANGE payment with the fee shown, and the allowance is charged once', async () => {
  const t = await exchangeSetup();
  await t.give(t.rule(staffKey.address));
  await t.allow();
  const deps = t.xdeps();
  const { shown, request } = await t.confirmed(deps, STAFF);
  const r = await T.createTransfer(deps, STAFF, { ...request, via: 'rule' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.transfer.route, 'staff_rule');
  assert.equal(r.transfer.payeeKind, 'exchange');
  assert.equal(r.transfer.feeKind, 2);
  assert.equal(r.ask, null);
  const req = r.signingRequest;
  assert.equal(req.purpose, 'staff_rule_payment');
  assert.equal(req.threshold, 1);
  const [open, , pay] = req.description.actions;
  assert.equal(open.kind, 2, 'declared as an exchange payment');
  assert.equal(open.recipient, EXCHANGE);
  assert.equal(pay.maxFeeMinor, feeFor(U(1_000), 2).toString(), 'the fee shown is the fee signed');
  assert.equal(r.exchange.travelRule.state, 'sent');
  assert.equal(t.provider.sent.length, 1, 'one Travel Rule message, once');
  const row = await readTravelRuleTransfer(t.db, 'acme', req.id);
  assert.ok(row?.providerRef, 'the message is on file under the payment');
  assert.equal(row.exchange, 'pdax');
  assert.equal(shown.hash.length, 64);

  assert.equal(t.w.spends.length, 0, 'nothing is drawn before the person signs');
  const signed = await t.paysOwn(req);
  assert.equal(signed.ok, true, JSON.stringify(signed));
  assert.equal(signed.request.status, 'executed');
  const [allowance] = [...t.w.spend.allowances.values()];
  assert.equal(allowance.currentSpend, U(1_000) + feeFor(U(1_000), 2));
  assert.equal(t.w.balances.get(EXCHANGE)?.addressBalanceMinor, U(1_000));
  assert.equal((await T.getTransfer(deps, r.transfer.id)).status, 'settled');
  await t.w.client.close();
});

test('the switch is per person: one staff member is allowed, the next is not', async () => {
  const t = await exchangeSetup();
  await t.give(t.rule(staffKey.address));
  await t.give(t.rule(staff2Key.address));
  await t.allow('u-staff');
  const deps = t.xdeps();
  const a = await t.confirmed(deps, STAFF);
  assert.equal((await T.createTransfer(deps, STAFF, a.request)).transfer.route, 'staff_rule');
  const b = await t.preview(deps, STAFF2);
  assert.equal(b.code, 'exchange_alone_off');
  const asked = await T.createTransfer(deps, STAFF2, t.body(1_000, { clientKey: 'tx_key_000009' }));
  assert.equal(asked.transfer.route, 'asked_owners');
  assert.deepEqual(asked.plan.reasons, ['exchange_needs_owners']);
  await t.w.client.close();
});

// ─── The rule still binds ──────────────────────────────────────────────────

const BOUND = [
  ['more than the rule allows for one payment', async () => {}, 'over_payment_max', { usdc: 2_500 }],
  [
    'a cap already used up for now',
    async (t) => {
      const id = [...t.w.spend.allowances.keys()][0];
      t.w.charge(id, U(15_000), t0);
    },
    'cap_used_up',
    {},
  ],
  [
    'a rule that has been taken back',
    async (t) => {
      const [id] = [...t.w.spend.allowances.keys()];
      t.w.spend.allowances.delete(id);
      for (const [cap, c] of t.w.spend.caps) if (c.allowance === id) t.w.spend.caps.delete(cap);
    },
    'rule_revoked',
    {},
  ],
  ['no rule at all', async () => {}, 'no_rule', { noRule: true }],
];
for (const [name, prepare, reason, opts] of BOUND) {
  test(`switch on does not widen the rule: ${name} still goes to the owners, with nothing built`, async () => {
    const t = await exchangeSetup();
    if (!opts.noRule) await t.give(t.rule(staffKey.address));
    await t.allow();
    await prepare(t);
    const deps = t.xdeps();
    const { request } = await t.confirmed(deps, STAFF, opts.usdc ?? 1_000);
    const insisted = await T.createTransfer(deps, STAFF, { ...request, via: 'rule' });
    assert.deepEqual([insisted.ok, insisted.status, insisted.code], [false, 409, 'outside_rule'], JSON.stringify(insisted));
    assert.ok(insisted.reasons.includes(reason), `${reason} in ${insisted.reasons}`);
    assert.equal((await t.disclosures()).length, 0);
    assert.equal((await t.requests()).length, 0);
    assert.equal(t.provider.sent.length, 0);
    const asked = await T.createTransfer(deps, STAFF, { ...request, clientKey: 'tx_key_000002' });
    assert.equal(asked.transfer.route, 'asked_owners');
    assert.ok(asked.plan.reasons.includes(reason));
    assert.equal(t.w.spends.length, 0);
    await t.w.client.close();
  });
}

test('switch on does not widen the rule: an exchange account the owners have not put on the rule, or put on it as a wallet, is not paid alone', async () => {
  const t = await exchangeSetup();
  await t.give(t.rule(staffKey.address));
  await t.allow();
  // A second confirmed exchange account, saved but never put on the rule.
  await t.w.screenClear(STRANGER_EXCHANGE);
  const other = await t.w.saveRecipient(STRANGER_EXCHANGE, { kind: 'EXCHANGE', exchange: 'pdax' });
  const deps = t.xdeps();
  const shown = await T.previewExchangeDisclosure(deps, STAFF, { clientKey: 'tx_key_000003', payee: { kind: 'recipient', recipientId: other }, amountMinor: U(1_000).toString(), purpose: 'invoice' });
  assert.equal(shown.ok, true, JSON.stringify(shown));
  const request = amountInput(other, 1_000, { clientKey: 'tx_key_000003', maxFeeMinor: feeFor(U(1_000), 2).toString(), exchangeDisclosure: { purpose: 'invoice', confirmedHash: shown.hash } });
  const insisted = await T.createTransfer(deps, STAFF, { ...request, via: 'rule' });
  assert.deepEqual([insisted.status, insisted.code], [409, 'outside_rule']);
  assert.deepEqual(insisted.reasons, ['recipient_not_on_rule']);
  assert.match(insisted.error, /not on your rule/i);
  assert.equal((await t.requests()).length, 0);
  await t.w.client.close();
});

test('an expired rule does not pay an exchange account either', async () => {
  const t = await exchangeSetup();
  await t.give(t.rule(staffKey.address, { expiresAtMs: t0 + 2n * DAY }));
  await t.allow();
  t.w.setNow(new Date(Number(t0 + 3n * DAY)));
  await t.w.screenClear(EXCHANGE);
  const deps = t.xdeps();
  const { request } = await t.confirmed(deps, STAFF);
  const r = await T.createTransfer(deps, STAFF, { ...request, via: 'rule' });
  assert.equal(r.ok, false);
  assert.ok(['rule_expired', 'rule_revoked'].some((x) => r.reasons?.includes(x)), JSON.stringify(r.reasons));
  await t.w.client.close();
});

// ─── The Travel Rule message ───────────────────────────────────────────────

test('what the person is shown: who sends, which business, the exchange and the account, the purpose and the amount, in plain words, and nothing is sent by showing it', async () => {
  const t = await exchangeSetup();
  await t.give(t.rule(staffKey.address));
  await t.allow();
  const shown = await t.preview(t.xdeps(), STAFF, 1_250, { purpose: 'contractor' });
  assert.equal(shown.ok, true, JSON.stringify(shown));
  const text = [shown.text.headline, ...shown.text.lines].join('\n');
  assert.match(text, /u-staff/, 'who is sending');
  assert.match(text, /Acme Trading Sdn Bhd/, 'which business');
  assert.match(text, /201901234567/, 'its registration number');
  assert.match(text, /PDAX/i, 'the exchange, by its name');
  assert.ok(text.includes(EXCHANGE), 'the account at the exchange, in full');
  assert.match(text, /contractor/i, 'the purpose they picked');
  assert.match(text, /1,250(\.00)? USDC/);
  assert.match(text, /Dela Cruz Trading Corp/, 'the beneficiary');
  assert.doesNotMatch(text, /coming soon|demo|testnet|non-custodial/i);
  assert.equal(t.provider.sent.length, 0, 'showing it shares nothing');
  assert.equal((await t.disclosures()).length, 0, 'and stores nothing');
  assert.deepEqual(shown.disclosure.purpose.code, 'contractor');
  // The same facts give the same message and the same hash; another purpose gives another.
  assert.equal((await t.preview(t.xdeps(), STAFF, 1_250, { purpose: 'contractor' })).hash, shown.hash);
  assert.notEqual((await t.preview(t.xdeps(), STAFF, 1_250, { purpose: 'invoice' })).hash, shown.hash);
  assert.notEqual((await t.preview(t.xdeps(), STAFF, 1_251, { purpose: 'contractor' })).hash, shown.hash);
  assert.notEqual((await t.preview(t.xdeps(), STAFF, 1_250, { purpose: 'contractor', clientKey: 'tx_key_000777' })).hash, shown.hash, 'bound to the intent id');
  await t.w.client.close();
});

test('the purpose must be one of the listed purposes: anything else is refused in words before anything is built', async () => {
  const t = await exchangeSetup();
  await t.give(t.rule(staffKey.address));
  await t.allow();
  for (const purpose of [undefined, '', 'gift to a friend', { a: 1 }, 'x'.repeat(500)]) {
    const r = await t.preview(t.xdeps(), STAFF, 1_000, { purpose });
    assert.deepEqual([r.ok, r.status, r.code], [false, 400, 'bad_purpose'], String(purpose));
  }
  await t.w.client.close();
});

test('without the confirmation, or with a confirmation of something else, nothing is built and nothing is shared', async () => {
  const t = await exchangeSetup();
  await t.give(t.rule(staffKey.address));
  await t.allow();
  const deps = t.xdeps();
  const { request } = await t.confirmed(deps, STAFF);
  const missing = await T.createTransfer(deps, STAFF, { ...t.body(), via: 'rule' });
  assert.deepEqual([missing.ok, missing.status, missing.code], [false, 409, 'exchange_disclosure_required']);
  assert.match(missing.error, /shared with the exchange/i);
  const stale = await T.createTransfer(deps, STAFF, { ...request, exchangeDisclosure: { purpose: 'invoice', confirmedHash: 'f'.repeat(64) }, via: 'rule' });
  assert.deepEqual([stale.ok, stale.status, stale.code], [false, 409, 'exchange_disclosure_changed']);
  assert.ok(stale.disclosure?.text?.lines?.length, 'the new message comes back to be read again');
  // A confirmation of another purpose is not this one's.
  const swapped = await T.createTransfer(deps, STAFF, { ...request, exchangeDisclosure: { purpose: 'refund', confirmedHash: request.exchangeDisclosure.confirmedHash }, via: 'rule' });
  assert.equal(swapped.code, 'exchange_disclosure_changed');
  // The amount changed after it was shown.
  const bigger = await T.createTransfer(deps, STAFF, { ...request, amountMinor: U(1_100).toString(), maxFeeMinor: feeFor(U(1_100), 2).toString(), via: 'rule' });
  assert.equal(bigger.code, 'exchange_disclosure_changed');
  for (const r of [missing, stale, swapped, bigger]) assert.equal(r.ok, false);
  assert.equal((await t.transfers()).length, 0);
  assert.equal((await t.disclosures()).length, 0);
  assert.equal((await t.requests()).length, 0);
  assert.equal(t.provider.sent.length, 0);
  await t.w.client.close();
});

test('the exact payload is stored with the payment, bound to the intent id, and the message sent is made from that payload and nothing else', async () => {
  const t = await exchangeSetup();
  await t.give(t.rule(staffKey.address));
  await t.allow();
  const deps = t.xdeps();
  const { shown, request } = await t.confirmed(deps, STAFF, 1_000, { purpose: 'invoice' });
  const r = await T.createTransfer(deps, STAFF, request);
  assert.equal(r.ok, true, JSON.stringify(r));
  const [stored] = await t.disclosures();
  const [transfer] = await t.transfers();
  assert.equal(stored.orgId, 'acme');
  assert.equal(stored.transferId, transfer.id);
  assert.equal(stored.signingRequestId, r.signingRequest.id);
  assert.equal(stored.confirmedBy, 'u-staff');
  assert.equal(stored.payloadHash, shown.hash, 'what the person confirmed is what is kept');
  assert.equal(createHash('sha256').update(stored.canonical).digest('hex'), stored.payloadHash, 'and the kept text hashes to it');
  assert.deepEqual(JSON.parse(stored.canonical), stored.payload);
  assert.equal(stored.payload.intentId, 'tx_key_000001', 'bound to the intent id');
  assert.equal(stored.payload.paymentRef, normalizeSuiAddress(transfer.paymentRef));
  assert.equal(stored.payload.amountMinor, U(1_000).toString());
  assert.equal(stored.payload.beneficiary.accountReference, EXCHANGE);
  assert.equal(stored.payload.beneficiary.exchange, 'pdax');
  assert.equal(stored.payload.business.legalName, 'Acme Trading Sdn Bhd');
  assert.equal(stored.payload.sender.userId, 'u-staff');
  assert.equal(stored.payload.purpose.code, 'invoice');
  assert.deepEqual(await readStoredDisclosure(t.db, 'acme', { signingRequestId: r.signingRequest.id }), { ...(await readStoredDisclosure(t.db, 'acme', { transferId: transfer.id })) });

  // What went to the provider is made from the stored payload.
  const [sent] = t.provider.sent;
  assert.equal(sent.intentId, r.signingRequest.id, 'the message is kept under the payment the gate looks for');
  assert.equal(sent.orgId, 'acme');
  assert.equal(sent.applicantId, 'applicant-acme');
  assert.equal(sent.amountMinor, BigInt(stored.payload.amountMinor));
  assert.equal(sent.originator.legalName, stored.payload.business.legalName);
  assert.equal(sent.originator.registrationNumber, stored.payload.business.registrationNumber);
  assert.equal(sent.originator.country, stored.payload.business.country);
  assert.equal(sent.beneficiary.depositAddress, stored.payload.beneficiary.accountReference);
  assert.equal(sent.beneficiary.exchange, stored.payload.beneficiary.exchange);
  assert.equal(sent.beneficiary.legalName, stored.payload.beneficiary.legalName);
  assert.match(sent.purpose, /invoice/i);
  assert.match(sent.purpose, /u-staff/, 'who is sending travels with it');
  // The disclosure is append-only: it cannot be rewritten after it is stored.
  await assert.rejects(() => t.db.update(schema.walletTransferDisclosures).set({ canonical: '{}' }).where(eq(schema.walletTransferDisclosures.id, stored.id)));
  await t.w.client.close();
});

test('replay: the same intent id answers the same payment, with one stored payload and one message; another person gets nothing of it', async () => {
  const t = await exchangeSetup();
  await t.give(t.rule(staffKey.address));
  await t.give(t.rule(staff2Key.address));
  await t.allow();
  await t.allow('u-staff2');
  const deps = t.xdeps();
  const { request } = await t.confirmed(deps, STAFF);
  const first = await T.createTransfer(deps, STAFF, request);
  assert.equal(first.created, true);
  const again = await T.createTransfer(deps, STAFF, request);
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(again.created, false);
  assert.equal(again.transfer.id, first.transfer.id);
  assert.equal(again.signingRequest.id, first.signingRequest.id);
  // A lost response retried with another purpose still answers the payment already made, and changes what was shared by nothing.
  const other = await T.createTransfer(deps, STAFF, { ...request, exchangeDisclosure: { purpose: 'refund', confirmedHash: 'a'.repeat(64) } });
  assert.equal(other.ok, true);
  assert.equal(other.created, false);
  assert.equal((await t.disclosures()).length, 1);
  assert.equal((await t.requests()).length, 1);
  assert.equal(t.provider.sent.length, 1);
  assert.equal((await t.db.select().from(schema.travelRuleTransfers).where(eq(schema.travelRuleTransfers.paymentRef, first.signingRequest.id))).length, 1);
  // Another member using the same intent id is told nothing of it.
  const probe = await T.createTransfer(deps, STAFF2, request);
  assert.deepEqual([probe.ok, probe.status, probe.code], [false, 409, 'idempotency_key_reused']);
  assert.equal(JSON.stringify(probe).includes('Acme Trading'), false);
  // A second payment is a second payload.
  const second = await t.confirmed(deps, STAFF, 1_000, { clientKey: 'tx_key_000002' });
  assert.equal((await T.createTransfer(deps, STAFF, second.request)).created, true);
  assert.equal((await t.disclosures()).length, 2);
  assert.equal(t.provider.sent.length, 2);
  await t.w.client.close();
});

test('two sends racing on one intent id make one payment, one payload and one message', async () => {
  const t = await exchangeSetup();
  await t.give(t.rule(staffKey.address));
  await t.allow();
  const deps = t.xdeps();
  const { request } = await t.confirmed(deps, STAFF);
  const [a, b] = await Promise.all([T.createTransfer(deps, STAFF, request), T.createTransfer(deps, STAFF, request)]);
  assert.equal(a.ok && b.ok, true, JSON.stringify([a, b]));
  assert.equal((await t.transfers()).length, 1);
  assert.equal((await t.disclosures()).length, 1);
  assert.equal((await t.requests()).length, 1);
  assert.equal(t.provider.sent.length, 1);
  await t.w.client.close();
});

// ─── Switched off after the payment was opened ─────────────────────────────

test('the owner switches it off after the payment is opened and before it is signed: the signature is refused in words, nothing moves, and switching it on again lets it through', async () => {
  const t = await exchangeSetup();
  await t.give(t.rule(staffKey.address));
  await t.allow();
  const deps = t.xdeps();
  const { request } = await t.confirmed(deps, STAFF);
  const r = await T.createTransfer(deps, STAFF, request);
  assert.equal(r.transfer.route, 'staff_rule');
  await t.allow('u-staff', false);
  const refused = await t.paysOwn(r.signingRequest);
  assert.equal(refused.ok, false, JSON.stringify(refused));
  assert.equal(refused.code, 'exchange_alone_off');
  assert.match(refused.error, /owner/i);
  assert.equal(t.w.spends.length, 0);
  assert.equal([...t.w.spend.allowances.values()].reduce((a, x) => a + x.currentSpend, 0n), 0n);
  // The server tells the request's own gate the same.
  const stored = await readSigningRequest(t.db, 'acme', r.signingRequest.id);
  const gate = await paymentBeforeSign({ db: t.db, now: () => t.w.signing.now(), env: { NODE_ENV: 'test' } }, stored);
  assert.equal(gate?.code, 'exchange_alone_off');
  // The owner changes their mind: it is instant, and the same payment can be signed.
  await t.allow('u-staff', true);
  await t.w.screenClear(EXCHANGE);
  const signed = await t.paysOwn(r.signingRequest);
  assert.equal(signed.ok, true, JSON.stringify(signed));
  assert.equal(signed.request.status, 'executed');
  await t.w.client.close();
});

test('switched on then off before the payment is made: it is the owners’ to pay', async () => {
  const t = await exchangeSetup();
  await t.give(t.rule(staffKey.address));
  await t.allow();
  const deps = t.xdeps();
  const { request } = await t.confirmed(deps, STAFF);
  await t.allow('u-staff', false);
  const r = await T.createTransfer(deps, STAFF, request);
  assert.equal(r.transfer.route, 'asked_owners');
  assert.deepEqual(r.plan.reasons, ['exchange_needs_owners']);
  assert.equal((await t.disclosures()).length, 0);
  await t.w.client.close();
});

test('a payment whose stored message is gone or changed is not signed: the bytes and the record must match', async () => {
  const t = await exchangeSetup();
  await t.give(t.rule(staffKey.address));
  await t.allow();
  const deps = t.xdeps();
  const { request } = await t.confirmed(deps, STAFF);
  const r = await T.createTransfer(deps, STAFF, request);
  const [stored] = await t.disclosures();
  const gateOf = async () => paymentBeforeSign({ db: t.db, now: () => t.w.signing.now(), env: { NODE_ENV: 'test' } }, await readSigningRequest(t.db, 'acme', r.signingRequest.id));
  assert.equal(await gateOf(), null, 'as built, nothing stops it');

  // The kept payload no longer matches the bytes: another account, another amount.
  await t.w.client.exec("ALTER TABLE wallet_transfer_disclosures DISABLE TRIGGER USER");
  const tamper = async (patch) => {
    await t.db.update(schema.walletTransferDisclosures).set(patch).where(eq(schema.walletTransferDisclosures.id, stored.id));
    return gateOf();
  };
  const otherAccount = { ...stored.payload, beneficiary: { ...stored.payload.beneficiary, accountReference: STRANGER_EXCHANGE } };
  assert.equal((await tamper({ payload: otherAccount, canonical: JSON.stringify(otherAccount), payloadHash: createHash('sha256').update(JSON.stringify(otherAccount)).digest('hex') }))?.code, 'disclosure_mismatch');
  const otherAmount = { ...stored.payload, amountMinor: U(999).toString() };
  assert.equal((await tamper({ payload: otherAmount, canonical: JSON.stringify(otherAmount), payloadHash: createHash('sha256').update(JSON.stringify(otherAmount)).digest('hex') }))?.code, 'disclosure_mismatch');
  // The kept text no longer hashes to its hash.
  assert.equal((await tamper({ payload: stored.payload, canonical: stored.canonical, payloadHash: 'b'.repeat(64) }))?.code, 'disclosure_mismatch');
  await t.w.client.exec("ALTER TABLE wallet_transfer_disclosures ENABLE TRIGGER USER");
  // The record is gone altogether.
  await t.w.client.exec("ALTER TABLE wallet_transfer_disclosures DISABLE TRIGGER USER");
  await t.db.delete(schema.walletTransferDisclosures).where(eq(schema.walletTransferDisclosures.id, stored.id));
  assert.equal((await gateOf())?.code, 'disclosure_missing');
  const signed = await t.paysOwn(r.signingRequest);
  assert.equal(signed.ok, false);
  assert.equal(t.w.spends.length, 0);
  await t.w.client.close();
});

test('a staff payment to a wallet is untouched by the switch: it needs no message and no switch', async () => {
  const t = await exchangeSetup();
  await t.give(t.rule(staffKey.address));
  const deps = t.xdeps();
  const r = await T.createTransfer(deps, STAFF, amountInput(t.recipientId, 1_000));
  assert.equal(r.transfer.route, 'staff_rule');
  assert.equal(r.exchange, undefined);
  assert.equal((await t.disclosures()).length, 0);
  assert.equal(t.provider.sent.length, 0);
  assert.equal(r.signingRequest.description.actions[0].kind, 1);
  await t.w.client.close();
});

// ─── Second approval and alerts count these payments like any other ────────

test('an exchange payment counts towards the recipient’s running total: together with others it can cross the second-approval line, and the alerts read it', async () => {
  const t = await exchangeSetup();
  await t.give(t.rule(staffKey.address, { perPaymentMaxMinor: U(6_000), cap: { period: 'month', limitMinor: U(50_000) } }));
  await t.give(t.rule(staff2Key.address, { perPaymentMaxMinor: U(6_000), cap: { period: 'month', limitMinor: U(50_000) } }));
  await t.allow('u-staff');
  await t.allow('u-staff2');
  const deps = t.xdeps();
  const pay = async (actor, key, who, clientKey, usdc) => {
    const c = await t.confirmed(deps, actor, usdc, { clientKey });
    const r = await T.createTransfer(deps, actor, c.request);
    if (r.transfer?.route === 'staff_rule') {
      const s = await t.paysOwn(r.signingRequest, who, key);
      assert.equal(s.ok, true, JSON.stringify(s));
      await t.w.screenClear(EXCHANGE);
    }
    return r;
  };
  const first = await pay(STAFF, staffKey, 'u-staff', 'tx_key_000001', 6_000);
  assert.equal(first.transfer.route, 'staff_rule');
  // The first person is at 6,000; the second, alone under the line, would take the same recipient to 10,001.
  const view = (await readSpendingRules(t.w.sc)).view;
  const alerts = deriveNearThresholdAlerts(view);
  assert.ok(alerts.some((a) => a.recipient === EXCHANGE), JSON.stringify(alerts.map((a) => [a.kind, a.recipient])));
  const second = await pay(STAFF2, staff2Key, 'u-staff2', 'tx_key_000002', 4_001);
  assert.equal(second.transfer.route, 'asked_owners');
  assert.deepEqual(second.plan.reasons, ['above_threshold']);
  const exactly = await pay(STAFF2, staff2Key, 'u-staff2', 'tx_key_000003', 4_000);
  assert.equal(exactly.transfer.route, 'staff_rule', 'exactly the line needs no approval');
  await t.w.client.close();
});

test('a payment on its way counts for the second-approval line before it is signed', async () => {
  const t = await exchangeSetup();
  await t.give(t.rule(staffKey.address, { perPaymentMaxMinor: U(6_000), cap: { period: 'month', limitMinor: U(50_000) } }));
  await t.allow();
  const deps = t.xdeps();
  const a = await t.confirmed(deps, STAFF, 6_000, { clientKey: 'tx_key_000001' });
  assert.equal((await T.createTransfer(deps, STAFF, a.request)).transfer.route, 'staff_rule');
  const b = await t.confirmed(deps, STAFF, 4_001, { clientKey: 'tx_key_000002' });
  const second = await T.createTransfer(deps, STAFF, b.request);
  assert.equal(second.transfer.route, 'asked_owners');
  assert.deepEqual(second.plan.reasons, ['above_threshold']);
  await t.w.client.close();
});

// ─── Fail closed ───────────────────────────────────────────────────────────

test('production without the Travel Rule provider configured: refused, 503, and nothing is built, stored or shown as sent', async () => {
  const t = await exchangeSetup();
  await t.give(t.rule(staffKey.address));
  await t.allow();
  const deps = t.xdeps('acme', {
    env: { NODE_ENV: 'production' },
    travelRule: () => {
      throw new ComplianceProviderUnavailable('travel_rule_not_configured', 'The Travel Rule message to exchanges is not configured on this server.');
    },
  });
  const shown = await t.preview(deps, STAFF);
  assert.equal(shown.ok, false);
  assert.deepEqual([shown.status, shown.code], [503, 'travel_rule_not_configured']);
  const r = await T.createTransfer(deps, STAFF, { ...t.body(), exchangeDisclosure: { purpose: 'invoice', confirmedHash: 'c'.repeat(64) }, via: 'rule' });
  assert.deepEqual([r.ok, r.status, r.code], [false, 503, 'travel_rule_not_configured']);
  assert.equal((await t.transfers()).length, 0);
  assert.equal((await t.disclosures()).length, 0);
  assert.equal((await t.requests()).length, 0);
  assert.equal(t.provider.sent.length, 0);
  await t.w.client.close();
});

test('production with no provider supplied at all falls back to the environment, which refuses; the sandbox is never reached', async () => {
  const t = await exchangeSetup();
  await t.give(t.rule(staffKey.address));
  await t.allow();
  const deps = t.xdeps('acme', { env: { NODE_ENV: 'production' }, travelRule: undefined });
  const shown = await t.preview(deps, STAFF);
  assert.deepEqual([shown.ok, shown.status, shown.code], [false, 503, 'travel_rule_not_configured']);
  assert.equal((await t.disclosures()).length, 0);
  await t.w.client.close();
});

test('a sandbox message on file is not the provider’s: in production the signature is refused', async () => {
  const t = await exchangeSetup();
  await t.give(t.rule(staffKey.address));
  await t.allow();
  const deps = t.xdeps();
  const { request } = await t.confirmed(deps, STAFF);
  const r = await T.createTransfer(deps, STAFF, request);
  const stored = await readSigningRequest(t.db, 'acme', r.signingRequest.id);
  const gate = await paymentBeforeSign({ db: t.db, now: () => t.w.signing.now(), env: { NODE_ENV: 'production' } }, stored);
  assert.ok(gate, 'a refusal');
  assert.equal(gate.code, 'travel_rule_missing');
  await t.w.client.close();
});

test('what the message needs is missing: the business’s details, its verification, or the recipient’s: refused with a plain reason and nothing built', async () => {
  const cases = [
    ['the business has no registered country', (t) => t.db.update(schema.organizations).set({ addressCountry: null }).where(eq(schema.organizations.id, 'acme')), 'originator_incomplete', /registered address/i],
    ['the business is not verified', (t) => t.db.update(schema.organizations).set({ kybLifecycle: 'REGISTERED' }).where(eq(schema.organizations.id, 'acme')), 'kyb_not_approved', /verification/i],
    ['the business has no case with the provider', (t) => t.db.update(schema.kybCases).set({ sumsubApplicantId: null }).where(eq(schema.kybCases.orgId, 'acme')), 'kyb_applicant_missing', /verification/i],
    ['the recipient has no country', (t) => t.db.update(schema.suppliers).set({ addressCountry: null, country: '' }).where(eq(schema.suppliers.id, t.exchangeId)), 'recipient_incomplete', /recipient/i],
    ['the recipient has no exchange', (t) => t.db.update(schema.suppliers).set({ exchangeId: null }).where(eq(schema.suppliers.id, t.exchangeId)), 'recipient_incomplete', /recipient|exchange/i],
  ];
  for (const [name, break_, code, words] of cases) {
    const t = await exchangeSetup();
    await t.give(t.rule(staffKey.address));
    await t.allow();
    await break_(t);
    const shown = await t.preview(t.xdeps(), STAFF);
    assert.equal(shown.ok, false, name);
    assert.equal(shown.code, code, `${name}: ${JSON.stringify(shown)}`);
    assert.match(shown.error, words, name);
    const r = await T.createTransfer(t.xdeps(), STAFF, { ...t.body(), exchangeDisclosure: { purpose: 'invoice', confirmedHash: 'd'.repeat(64) }, via: 'rule' });
    assert.equal(r.ok, false, name);
    assert.equal((await t.transfers()).length, 0, name);
    assert.equal((await t.disclosures()).length, 0, name);
    assert.equal((await t.requests()).length, 0, name);
    assert.equal(t.provider.sent.length, 0, name);
    await t.w.client.close();
  }
});

test('a recipient that is not screened clear is refused, not guessed', async () => {
  const t = await exchangeSetup();
  await t.give(t.rule(staffKey.address));
  await t.allow();
  await t.db.delete(schema.kytScreenings);
  const deps = t.xdeps();
  const shown = await t.preview(deps, STAFF);
  const r = await T.createTransfer(deps, STAFF, { ...t.body(), exchangeDisclosure: { purpose: 'invoice', confirmedHash: shown.hash ?? 'e'.repeat(64) }, via: 'rule' });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal((await t.requests()).length, 0);
  assert.equal(t.provider.sent.length, 0);
  await t.w.client.close();
});

test('a provider that cannot be reached leaves the payment unsignable and honest about it: the message can be sent again, once, from the stored payload', async () => {
  const t = await exchangeSetup();
  await t.give(t.rule(staffKey.address));
  await t.allow();
  let up = false;
  const flaky = {
    id: 'sandbox',
    sandbox: true,
    sent: [],
    async submitOutbound(input) {
      if (!up) throw new ComplianceProviderUnavailable('provider_error', 'The provider did not answer.', 502);
      flaky.sent.push(input);
      return { provider: 'sandbox', sandbox: true, reference: 'sandbox_tr_retry', status: 'submitted' };
    },
  };
  const deps = t.xdeps('acme', { travelRule: () => flaky });
  const { request } = await t.confirmed(deps, STAFF);
  const r = await T.createTransfer(deps, STAFF, request);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.exchange.travelRule.state, 'not_sent');
  assert.match(r.exchange.travelRule.text, /not been sent|could not be sent/i);
  assert.equal((await t.disclosures()).length, 1, 'the payload is kept');
  const blocked = await t.paysOwn(r.signingRequest);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'travel_rule_missing');
  up = true;
  const resent = await T.sendStoredExchangeMessage(deps, STAFF, { signingRequestId: r.signingRequest.id });
  assert.equal(resent.ok, true, JSON.stringify(resent));
  assert.equal(resent.travelRule.state, 'sent');
  const again = await T.sendStoredExchangeMessage(deps, STAFF, { signingRequestId: r.signingRequest.id });
  assert.equal(again.ok, true);
  assert.equal(flaky.sent.length, 1, 'sent once');
  assert.equal(flaky.sent[0].beneficiary.depositAddress, EXCHANGE);
  const signed = await t.paysOwn(r.signingRequest);
  assert.equal(signed.ok, true, JSON.stringify(signed));
  await t.w.client.close();
});

// ─── Another business ──────────────────────────────────────────────────────

test('another business reads none of it: not the payload, not the switch, not the recipient, and its staff cannot send the message for this one', async () => {
  const t = await exchangeSetup();
  await t.give(t.rule(staffKey.address));
  await t.allow();
  const deps = t.xdeps();
  const { request } = await t.confirmed(deps, STAFF);
  const r = await T.createTransfer(deps, STAFF, request);
  const [stored] = await t.disclosures();
  assert.equal(await readStoredDisclosure(t.db, 'northwind', { signingRequestId: r.signingRequest.id }), null);
  assert.equal(await readStoredDisclosure(t.db, 'northwind', { transferId: stored.transferId }), null);
  assert.equal(await exchangeAloneOf(t.db, 'northwind', 'u-staff'), false, 'the switch is the business’s own');
  assert.equal(await exchangeAloneOf(t.db, 'acme', 'u-north-staff'), false);
  const north = t.xdeps('northwind');
  const probe = await T.previewExchangeDisclosure(north, { userId: 'u-north-staff', role: 'MAKER' }, { clientKey: 'tx_key_north_1', payee: { kind: 'recipient', recipientId: t.exchangeId }, amountMinor: U(1_000).toString(), purpose: 'invoice' });
  assert.equal(probe.ok, false);
  assert.ok([404, 409].includes(probe.status), String(probe.status));
  assert.equal(JSON.stringify(probe).includes('Acme Trading'), false);
  const resend = await T.sendStoredExchangeMessage(north, { userId: 'u-north-staff', role: 'MAKER' }, { signingRequestId: r.signingRequest.id });
  assert.equal(resend.ok, false);
  assert.equal(resend.status, 404);
  // And inside the business: another staff member cannot send this payment's message.
  const colleague = await T.sendStoredExchangeMessage(deps, STAFF2, { signingRequestId: r.signingRequest.id });
  assert.equal(colleague.ok, false);
  assert.equal(colleague.status, 404);
  await t.w.client.close();
});

test('the switch of one business is no switch of another: the same person id in another business starts off', async () => {
  const t = await exchangeSetup();
  await t.allow();
  const rows = await t.db.select().from(schema.walletMemberAccess).where(and(eq(schema.walletMemberAccess.access, KIND), eq(schema.walletMemberAccess.orgId, 'acme')));
  assert.equal(rows.length, 1);
  assert.equal(await exchangeAloneOf(t.db, 'northwind', 'u-north-staff'), false);
  await t.w.client.close();
});
