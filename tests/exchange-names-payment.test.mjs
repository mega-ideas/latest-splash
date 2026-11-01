/**
 * v2 Phase 3, whose name the exchange is told, on the real payment path
 * (PGlite with every migration, software passkeys, the model chain; nothing is
 * signed or sent on any network).
 *
 *   default            "Sent by NAME (Title): purpose", in the confirmation and
 *                      in the message the provider receives.
 *   business switch   off: "Sent by COMPANY NAME: purpose".
 *   person switch     off: the same.
 *   either off         no person's name or title anywhere in what is shown,
 *                      kept with the payment or sent.
 *   read on the server the page cannot choose; a switch changed after the
 *                      message was read makes the message change and the
 *                      person confirm again; a message not yet sent goes out
 *                      in the form the switches allow at that moment.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { eq } from 'drizzle-orm';
import { normalizeSuiAddress } from '@mysten/sui/utils';

import * as schema from '../lib/db/schema.ts';
import { ComplianceProviderUnavailable } from '../lib/compliance/sumsub.ts';
import { exchangeAloneOf } from '../lib/server/exchange-alone.ts';
import { setBusinessNameSharing, setOwnNameSharing } from '../lib/server/exchange-names.ts';
import { setMemberAccess } from '../lib/server/team-admin.ts';
import * as T from '../lib/server/wallet-transfers.ts';
import { amountInput, feeFor, OWNER, setup, STAFF, staffKey, U } from './fixtures/staff-rule-world.mjs';

const EXCHANGE = normalizeSuiAddress(`0x${'79'.repeat(32)}`);
const NAME = 'Maya Rahman-Okafor';
const TITLE = 'Head of Buying';
const COMPANY = 'Acme Trading Sdn Bhd';
const WHO = `${NAME} (${TITLE})`;
const INVOICE = 'Paying a supplier invoice';

function spyProvider() {
  const sent = [];
  return {
    id: 'sandbox',
    sandbox: true,
    sent,
    failNext: 0,
    async submitOutbound(input) {
      if (this.failNext > 0) {
        this.failNext -= 1;
        throw new ComplianceProviderUnavailable('provider_error', 'The provider did not answer.', 502);
      }
      sent.push(input);
      return { provider: 'sandbox', sandbox: true, reference: `sandbox_tr_${sent.length}`, status: 'submitted' };
    },
  };
}

async function world() {
  const t = await setup();
  const db = t.w.db;
  await db.update(schema.organizations).set({ legalName: COMPANY, registrationNumber: '201901234567', addressLine1: '8 Jalan Ampang', addressCity: 'Kuala Lumpur', addressPostalCode: '50450', addressCountry: 'MY', kybLifecycle: 'ACTIVE' }).where(eq(schema.organizations.id, 'acme'));
  await db.insert(schema.kybCases).values({ id: 'kyb-acme', orgId: 'acme', businessName: COMPANY, registrationNumber: '201901234567', state: 'APPROVED', sumsubApplicantId: 'applicant-acme' });
  await db.update(schema.users).set({ name: NAME }).where(eq(schema.users.id, 'u-staff'));
  await db.update(schema.memberships).set({ title: TITLE }).where(eq(schema.memberships.userId, 'u-staff'));
  await t.w.screenClear(EXCHANGE);
  const exchangeId = await t.w.saveRecipient(EXCHANGE, { kind: 'EXCHANGE', exchange: 'pdax' });
  await t.verify(EXCHANGE, 'exchange');
  await t.give(t.rule(staffKey.address));
  await setMemberAccess(db, { orgId: 'acme', actorUserId: 'u-founder', userId: 'u-staff', access: 'pay_exchange_alone', allowed: true, now: () => new Date() });
  const provider = spyProvider();
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
  const preview = (d, over = {}) =>
    T.previewExchangeDisclosure(d, STAFF, { clientKey: over.clientKey ?? 'tx_key_000001', payee: { kind: 'recipient', recipientId: exchangeId }, amountMinor: U(1_000).toString(), purpose: 'invoice' });
  const pay = (d, shown, over = {}) =>
    T.createTransfer(d, STAFF, amountInput(exchangeId, 1_000, { maxFeeMinor: feeFor(U(1_000), 2).toString(), exchangeDisclosure: { purpose: 'invoice', confirmedHash: shown.hash }, via: 'rule', ...over }));
  const stored = () => db.select().from(schema.walletTransferDisclosures);
  const owner = (share) => setBusinessNameSharing(db, { orgId: 'acme', actorUserId: 'u-founder', share, now: () => new Date() });
  const person = (share) => setOwnNameSharing(db, { orgId: 'acme', actorUserId: 'u-staff', userId: 'u-staff', share, now: () => new Date() });
  return { ...t, db, exchangeId, provider, records, deps, preview, pay, stored, owner, person };
}

const rows = (shown) => Object.fromEntries(shown.text.rows.map((r) => [r.label, r.value]));
const nobody = (value) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  assert.doesNotMatch(text, /Maya|Rahman|Okafor|Head of Buying/);
};

test('by default the name is shared with the title: confirmation, kept message and the provider all read the same', async () => {
  const t = await world();
  const d = t.deps();
  const shown = await t.preview(d);
  assert.equal(shown.ok, true, JSON.stringify(shown));
  assert.equal(rows(shown)['Sent by'], WHO);
  assert.equal(rows(shown)['Payment details as sent'], `Sent by ${WHO}: ${INVOICE}`);
  const paid = await t.pay(d, shown);
  assert.equal(paid.ok, true, JSON.stringify(paid));
  assert.equal(t.provider.sent.length, 1);
  assert.equal(t.provider.sent[0].purpose, `Sent by ${WHO}: ${INVOICE}`);
  const [kept] = await t.stored();
  assert.equal(kept.payload.sender.name, NAME);
  assert.equal(kept.payload.sender.title, TITLE);
  await t.w.client.close();
});

test('business switch off: "Sent by COMPANY NAME", and no person\'s name or title is shown, kept or sent', async () => {
  const t = await world();
  assert.equal((await t.owner(false)).ok, true);
  const d = t.deps();
  const shown = await t.preview(d);
  assert.equal(shown.ok, true, JSON.stringify(shown));
  assert.equal(rows(shown)['Payment details as sent'], `Sent by ${COMPANY}: ${INVOICE}`);
  nobody(shown.text);
  nobody(shown.disclosure);
  const paid = await t.pay(d, shown);
  assert.equal(paid.ok, true, JSON.stringify(paid));
  assert.equal(t.provider.sent[0].purpose, `Sent by ${COMPANY}: ${INVOICE}`);
  nobody(t.provider.sent);
  const [kept] = await t.stored();
  nobody(kept.payload);
  nobody(kept.canonical);
  assert.equal(kept.payload.sender.userId, 'u-staff', 'the internal id is kept: who started it is never lost');
  await t.w.client.close();
});

test('person switch off: the same, whatever the business switch says', async () => {
  const t = await world();
  assert.equal((await t.person(false)).ok, true);
  const d = t.deps();
  const shown = await t.preview(d);
  assert.equal(rows(shown)['Payment details as sent'], `Sent by ${COMPANY}: ${INVOICE}`);
  nobody(shown.text);
  const paid = await t.pay(d, shown);
  assert.equal(paid.ok, true, JSON.stringify(paid));
  nobody(t.provider.sent);
  nobody((await t.stored())[0].payload);
  await t.w.client.close();
});

test('either off hides the person AND the title; both on shows both; both off is the company too', async () => {
  const t = await world();
  const d = t.deps();
  for (const [business, mine, expected] of [
    [true, true, WHO],
    [false, true, COMPANY],
    [true, false, COMPANY],
    [false, false, COMPANY],
  ]) {
    await t.owner(business);
    await t.person(mine);
    const shown = await t.preview(d);
    assert.equal(rows(shown)['Sent by'], expected, `business ${business}, person ${mine}`);
    if (expected === COMPANY) nobody(shown.text);
    assert.doesNotMatch(rows(shown)['Payment details as sent'], expected === COMPANY ? /Maya|Head of Buying/ : /^$/);
  }
  await t.w.client.close();
});

test('the setting is read from the database on the server: the page cannot choose it', async () => {
  const t = await world();
  await t.person(false);
  const d = t.deps();
  const shown = await t.preview(d);
  // A request that claims the opposite changes nothing: the confirmation is the server's.
  const paid = await t.pay(d, shown, { shareName: true, shareNames: true, senderName: 'Someone Else', exchangeDisclosure: { purpose: 'invoice', confirmedHash: shown.hash, shareName: true, sender: { name: NAME } } });
  assert.equal(paid.ok, true, JSON.stringify(paid));
  nobody(t.provider.sent);
  await t.w.client.close();
});

test('a switch changed after the message was read makes the message change: the person reads it again and confirms again', async () => {
  const t = await world();
  const d = t.deps();
  const shown = await t.preview(d);
  assert.equal(rows(shown)['Sent by'], WHO);
  await t.owner(false);
  const stale = await t.pay(d, shown);
  assert.equal(stale.ok, false);
  assert.deepEqual([stale.status, stale.code], [409, 'exchange_disclosure_changed']);
  assert.equal(stale.disclosure.text.rows.find((r) => r.label === 'Payment details as sent').value, `Sent by ${COMPANY}: ${INVOICE}`);
  assert.equal(t.provider.sent.length, 0, 'nothing was sent on the old words');
  assert.equal((await t.stored()).length, 0);
  const again = await t.pay(d, { hash: stale.disclosure.hash });
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(t.provider.sent[0].purpose, `Sent by ${COMPANY}: ${INVOICE}`);
  await t.w.client.close();
});

test('read at send time: a message that did not go is sent in the form the switches allow when it is finally sent', async () => {
  const t = await world();
  const d = t.deps();
  const shown = await t.preview(d);
  t.provider.failNext = 1;
  const paid = await t.pay(d, shown);
  assert.equal(paid.ok, true, JSON.stringify(paid));
  assert.equal(paid.exchange.travelRule.state, 'not_sent');
  // The person (or the business) now chooses not to share, before the message has gone anywhere.
  await t.person(false);
  const resent = await T.sendStoredExchangeMessage(d, STAFF, { signingRequestId: paid.signingRequest.id });
  assert.equal(resent.ok, true, JSON.stringify(resent));
  assert.equal(resent.travelRule.state, 'sent');
  assert.equal(t.provider.sent.length, 1);
  assert.equal(t.provider.sent[0].purpose, `Sent by ${COMPANY}: ${INVOICE}`, 'the later, more private choice wins');
  nobody(t.provider.sent);
  await t.w.client.close();
});

test('a switch turned ON after the message was confirmed never adds a name that was not confirmed', async () => {
  const t = await world();
  await t.owner(false);
  const d = t.deps();
  const shown = await t.preview(d);
  t.provider.failNext = 1;
  const paid = await t.pay(d, shown);
  assert.equal(paid.exchange.travelRule.state, 'not_sent');
  await t.owner(true);
  const resent = await T.sendStoredExchangeMessage(d, STAFF, { signingRequestId: paid.signingRequest.id });
  assert.equal(resent.travelRule.state, 'sent');
  assert.equal(t.provider.sent[0].purpose, `Sent by ${COMPANY}: ${INVOICE}`);
  nobody(t.provider.sent);
  await t.w.client.close();
});

test('existing payments are not changed by a switch: the kept message and its hash stay as they were', async () => {
  const t = await world();
  const d = t.deps();
  const shown = await t.preview(d);
  const paid = await t.pay(d, shown);
  assert.equal(paid.ok, true);
  const before = (await t.stored())[0];
  await t.owner(false);
  await t.person(false);
  const after = (await t.stored())[0];
  assert.equal(after.canonical, before.canonical);
  assert.equal(after.payloadHash, before.payloadHash);
  assert.equal(after.payload.sender.name, NAME);
  await t.w.client.close();
});

test('the confirmation says the network, not the processor, and that details go to a payout partner in that country', async () => {
  const t = await world();
  const shown = await t.preview(t.deps());
  assert.equal(rows(shown)['Payment network'], 'InstaPay or PESONet');
  assert.ok(!('Exchange you saved this account at' in rows(shown)));
  assert.match(shown.text.sharing, /payout partner in the Philippines/);
  assert.doesNotMatch(JSON.stringify(shown.text), /PDAX|payout partner\b.*PDAX/);
  // Even with the agreement signed, the screen names the network and not the company.
  const signed = await t.preview(t.deps({ signedPartners: new Set(['pdax', 'fiuu', 'hata']) }));
  assert.doesNotMatch(JSON.stringify(signed.text), /PDAX|Fiuu|Hata/);
  assert.equal(rows(signed)['Payment network'], 'InstaPay or PESONet');
  await t.w.client.close();
});

test('the owners\' own payments to an exchange are unaffected (they send their own message)', async () => {
  const t = await world();
  const refused = await T.previewExchangeDisclosure(t.deps(), OWNER, { clientKey: 'tx_key_000009', payee: { kind: 'recipient', recipientId: t.exchangeId }, amountMinor: U(1_000).toString(), purpose: 'invoice' });
  assert.equal(refused.code, 'owners_send_their_own');
  await t.w.client.close();
});
