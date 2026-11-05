/**
 * v2 Phase 3, Sky's decision on whose name the exchange is told when a staff
 * member pays an exchange account alone.
 *
 *   Default        "Sent by NAME (Title): purpose".
 *   Either off     the business's switch (owners only) or the person's own
 *                  switch: "Sent by COMPANY NAME: purpose", and no person's name
 *                  or title is sent at all.
 *   The switches change ONLY what the exchange is told and what the
 *   confirmation shows (the audit proof is tested in payment-trail.test.mjs).
 *
 * Pure words first, then the two switches on a real database (PGlite with every
 * migration), then the migration itself.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { migratedDb } from './helpers/store-db.mjs';
import * as schema from '../lib/db/schema.ts';
import { canonicalDisclosure, disclosureText, purposeTextOf } from '../lib/compliance/exchange-disclosure.ts';
import { PAYMENT_NETWORKS } from '../lib/compliance/payment-networks.ts';
import { listAuthorityEvents } from '../lib/server/wallet-authority.ts';
import { appointFinanceLead, listTeamActivity } from '../lib/server/team-admin.ts';
import { nameSharingOf, setBusinessNameSharing, setOwnNameSharing } from '../lib/server/exchange-names.ts';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const T0 = new Date('2026-11-02T09:00:00Z');
const VERIFIED = new Date('2026-10-01T00:00:00Z');

const party = (over = {}) => ({ legalName: 'Acme Trading Sdn Bhd', registrationNumber: '201901234567', country: 'MY', town: 'Kuala Lumpur', street: '8 Jalan Ampang', postCode: '50450', ...over });
const disclosure = (over = {}) => ({
  version: 1,
  intentId: 'tx_key_000001',
  paymentRef: `0x${'ab'.repeat(32)}`,
  amountMinor: '1000000000',
  asset: 'USDC',
  sender: { userId: 'u-maker', name: 'Aisha Rahman', title: 'CFO' },
  business: { ...party(), walletAddress: `0x${'11'.repeat(32)}` },
  beneficiary: { ...party({ legalName: 'Manila Supplies Inc', registrationNumber: null, country: 'PH', town: 'Makati', street: null, postCode: null }), exchange: 'pdax', accountReference: `0x${'22'.repeat(32)}` },
  purpose: { code: 'invoice', label: 'Paying a supplier invoice' },
  ...over,
});

// ─── The words ──────────────────────────────────────────────────────────────

test('by default the payment details read "Sent by NAME (Title): purpose"', () => {
  assert.equal(purposeTextOf(disclosure()), 'Sent by Aisha Rahman (CFO): Paying a supplier invoice');
  assert.equal(purposeTextOf(disclosure({ sender: { userId: 'u-maker', name: 'Aisha Rahman', title: null } })), 'Sent by Aisha Rahman: Paying a supplier invoice', 'no title set: the name alone');
  assert.equal(purposeTextOf(disclosure({ sender: { userId: 'u-maker', name: 'Aisha Rahman' } })), 'Sent by Aisha Rahman: Paying a supplier invoice', 'a message made before titles existed reads as it did');
});

test('with no person named the details read "Sent by COMPANY NAME: purpose", and no name or title is in them', () => {
  const d = disclosure({ sender: { userId: 'u-maker', name: null } });
  const sent = purposeTextOf(d);
  assert.equal(sent, 'Sent by Acme Trading Sdn Bhd: Paying a supplier invoice');
  assert.doesNotMatch(sent, /Aisha|CFO|\(/);
  // Even if a title were left on the payload, with no name nothing about the person is said.
  assert.equal(purposeTextOf(disclosure({ sender: { userId: 'u-maker', name: null, title: 'CFO' } })), sent);
});

test('the confirmation shows exactly the words that are sent', () => {
  for (const sender of [{ userId: 'u-maker', name: 'Aisha Rahman', title: 'CFO' }, { userId: 'u-maker', name: null }]) {
    const d = disclosure({ sender });
    const text = disclosureText(d);
    const row = (label) => text.rows.find((r) => r.label === label)?.value;
    assert.equal(row('Payment details as sent'), purposeTextOf(d));
    assert.equal(`Sent by ${row('Sent by')}: ${d.purpose.label}`, purposeTextOf(d), 'the "Sent by" row is the who-part of the string');
    assert.equal(text.lines.filter((l) => l.startsWith('Sent by')).length, 1);
  }
  const off = disclosureText(disclosure({ sender: { userId: 'u-maker', name: null } }));
  assert.doesNotMatch(JSON.stringify(off), /Aisha|CFO/);
  assert.match(off.notes.join(' '), /No person.s name or job title is sent/i);
  const on = disclosureText(disclosure());
  assert.match(on.notes.join(' '), /name and job title/i);
});

test('hostile names are cleaned: no line breaks, no fake title, no overlong text', () => {
  const hostile = 'Eve\r\n(CEO) <img src=x onerror=alert(1)>\u0000‮';
  const d = disclosure({ sender: { userId: 'u-maker', name: hostile, title: 'Buyer' } });
  const sent = purposeTextOf(d);
  assert.doesNotMatch(sent, /[\u0000-\u001f‮]/);
  assert.equal([...sent.matchAll(/\(/g)].length, 1, 'only the real title is in brackets: a name cannot dress itself as a title');
  assert.ok(sent.endsWith('(Buyer): Paying a supplier invoice') || sent.includes('(Buyer)'));
  assert.ok(sent.length <= 140);
  const company = purposeTextOf(disclosure({ sender: { userId: 'u-maker', name: null }, business: { ...party({ legalName: `Evil\nCo ${'x'.repeat(300)}` }), walletAddress: `0x${'11'.repeat(32)}` } }));
  assert.doesNotMatch(company, /[\u0000-\u001f]/);
  assert.ok(company.length <= 140);
  assert.ok(company.endsWith('Paying a supplier invoice') || company.length === 140);
  // The page renders every value as text, never as markup.
  const ui = read('components/transfer/ExchangeDisclosure.tsx');
  assert.doesNotMatch(ui, /dangerouslySetInnerHTML|innerHTML/);
});

test('a message made before this change keeps the text it was hashed from', () => {
  const old = { ...disclosure(), sender: { userId: 'u-maker', name: 'Aisha Rahman' } };
  const expected = JSON.stringify({
    version: 1, intentId: old.intentId, paymentRef: old.paymentRef, amountMinor: old.amountMinor, asset: 'USDC',
    sender: { userId: 'u-maker', name: 'Aisha Rahman' },
    business: { legalName: 'Acme Trading Sdn Bhd', registrationNumber: '201901234567', country: 'MY', town: 'Kuala Lumpur', street: '8 Jalan Ampang', postCode: '50450', walletAddress: old.business.walletAddress },
    beneficiary: { legalName: 'Manila Supplies Inc', registrationNumber: null, country: 'PH', town: 'Makati', street: null, postCode: null, exchange: 'pdax', accountReference: old.beneficiary.accountReference },
    purpose: { code: 'invoice', label: 'Paying a supplier invoice' },
  });
  assert.equal(canonicalDisclosure(old), expected);
});

test('the place the money goes is the network the person knows, with what is shared said plainly', () => {
  const text = disclosureText(disclosure());
  const network = text.rows.find((r) => r.label === 'Payment network');
  assert.equal(network?.value, 'InstaPay or PESONet');
  assert.ok(!text.rows.some((r) => r.label === 'Exchange you saved this account at'));
  const all = JSON.stringify(text);
  assert.doesNotMatch(all, /PDAX|our Philippines payout partner/);
  assert.match(text.sharing, /shared with the exchange that holds the account, which pays out in the Philippines over InstaPay or PESONet/);
  for (const what of [/registered name/i, /registration number/i, /address/i, /wallet/i, /amount/i, /payment details/i]) assert.match(text.sharing, what);
  assert.ok(text.lines.includes(text.sharing));
  assert.match(disclosureText(disclosure({ beneficiary: { ...disclosure().beneficiary, exchange: 'hata', country: 'MY' } })).rows.find((r) => r.label === 'Payment network').value, /^DuitNow$/);
});

test('a flagged corridor names the receiving institution; the signed list does not matter', () => {
  const flagged = { ...PAYMENT_NETWORKS, PH: { ...PAYMENT_NETWORKS.PH, mustNameReceivingInstitution: true } };
  const named = disclosureText(disclosure(), flagged);
  assert.match(named.rows.find((r) => r.label === 'Payment network').value, /InstaPay or PESONet.*PDAX/);
  assert.match(named.sharing, /PDAX/);
  const plain = disclosureText(disclosure(), PAYMENT_NETWORKS);
  assert.doesNotMatch(JSON.stringify(plain), /PDAX/);
  // Another corridor on the same flagged table stays unnamed.
  const hata = disclosureText(disclosure({ beneficiary: { ...disclosure().beneficiary, exchange: 'hata', country: 'MY' } }), flagged);
  assert.doesNotMatch(JSON.stringify(hata), /Hata|Fiuu/);
});

// ─── The switches ───────────────────────────────────────────────────────────

async function seeded() {
  const { client, db } = await migratedDb();
  const people = [
    ['u-owner', 'Asha', 'acme', 'admin', 'CEO'],
    ['u-lead', 'Lena', 'acme', 'checker', null],
    ['u-maker', 'Maya', 'acme', 'maker', 'Buyer'],
    ['u-viewer', 'Vera', 'acme', 'viewer', null],
    ['u-n-owner', 'Nadia', 'northwind', 'admin', null],
    ['u-n-maker', 'Noor', 'northwind', 'maker', null],
  ];
  for (const [id, name, org, role, title] of people) {
    await db.insert(schema.users).values({ id, email: `${id}@example.test`, name, emailVerifiedAt: VERIFIED });
    await db.insert(schema.memberships).values({ id: `m-${id}`, userId: id, orgId: org, role, title });
  }
  return { client, db };
}
const at = { now: () => T0 };

test('both switches default to sharing', async () => {
  const { client, db } = await seeded();
  assert.deepEqual(await nameSharingOf(db, 'acme', 'u-maker'), { business: true, person: true, shared: true, title: 'Buyer' });
  assert.deepEqual(await nameSharingOf(db, 'acme', 'u-owner'), { business: true, person: true, shared: true, title: 'CEO' });
  await client.close();
});

test('the business switch is the owners\': Finance lead, staff, viewer and another business cannot change it', async () => {
  const { client, db } = await seeded();
  await appointFinanceLead(db, { orgId: 'acme', actorUserId: 'u-owner', userId: 'u-lead', now: () => T0 });
  for (const who of ['u-lead', 'u-maker', 'u-viewer']) {
    const refused = await setBusinessNameSharing(db, { orgId: 'acme', actorUserId: who, share: false, ...at });
    assert.equal(refused.ok, false, who);
    assert.equal(refused.status, 403, who);
  }
  const stranger = await setBusinessNameSharing(db, { orgId: 'acme', actorUserId: 'u-n-owner', share: false, ...at });
  assert.equal(stranger.ok, false, 'an owner of another business is no member here');
  assert.equal((await nameSharingOf(db, 'acme', 'u-maker')).business, true, 'nothing changed');
  assert.equal((await nameSharingOf(db, 'northwind', 'u-n-maker')).business, true);
  const done = await setBusinessNameSharing(db, { orgId: 'acme', actorUserId: 'u-owner', share: false, ...at });
  assert.deepEqual([done.ok, done.changed, done.share], [true, true, false]);
  assert.equal((await nameSharingOf(db, 'acme', 'u-maker')).shared, false);
  assert.equal((await nameSharingOf(db, 'acme', 'u-maker')).person, true, 'the person\'s own switch is untouched');
  assert.equal((await nameSharingOf(db, 'northwind', 'u-n-maker')).business, true, 'another business is untouched');
  await client.close();
});

test('an owner\'s change is instant, writes one trail line in words, and the same value again writes none', async () => {
  const { client, db } = await seeded();
  const first = await setBusinessNameSharing(db, { orgId: 'acme', actorUserId: 'u-owner', share: false, ...at });
  assert.equal(first.changed, true);
  const again = await setBusinessNameSharing(db, { orgId: 'acme', actorUserId: 'u-owner', share: false, ...at });
  assert.deepEqual([again.ok, again.changed], [true, false]);
  const lines = (await listAuthorityEvents(db, 'acme')).filter((e) => e.action === 'exchange_name_sharing_changed');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].actorUserId, 'u-owner');
  assert.deepEqual(lines[0].detail, { to: false });
  await setBusinessNameSharing(db, { orgId: 'acme', actorUserId: 'u-owner', share: true, ...at });
  const said = (await listTeamActivity(db, 'acme')).filter((a) => a.action === 'exchange_name_sharing_changed').map((a) => a.summary);
  assert.equal(said.length, 2, 'taking it back in the same second works: no cooldown');
  assert.match(said[0], /Asha .*(stopped|no longer).*names/i);
  assert.match(said[1], /Asha .*(started|turned on).*names/i);
  assert.equal((await listAuthorityEvents(db, 'northwind')).filter((e) => e.action === 'exchange_name_sharing_changed').length, 0);
  await client.close();
});

test('each person controls their own switch, and only their own', async () => {
  const { client, db } = await seeded();
  const own = await setOwnNameSharing(db, { orgId: 'acme', actorUserId: 'u-maker', userId: 'u-maker', share: false, ...at });
  assert.deepEqual([own.ok, own.changed, own.share], [true, true, false]);
  const state = await nameSharingOf(db, 'acme', 'u-maker');
  assert.deepEqual([state.person, state.business, state.shared], [false, true, false]);
  // Not another person's, not even an owner's over a staff member's.
  const other = await setOwnNameSharing(db, { orgId: 'acme', actorUserId: 'u-owner', userId: 'u-maker', share: true, ...at });
  assert.equal(other.ok, false);
  assert.equal(other.status, 403);
  assert.equal((await nameSharingOf(db, 'acme', 'u-maker')).person, false);
  // A person of another business reads as absent.
  const away = await setOwnNameSharing(db, { orgId: 'acme', actorUserId: 'u-owner', userId: 'u-n-maker', share: false, ...at });
  assert.equal(away.ok, false);
  assert.equal(away.status, 404);
  assert.equal((await nameSharingOf(db, 'northwind', 'u-n-maker')).person, true);
  // Someone who is no member of the business they name cannot change it.
  const outsider = await setOwnNameSharing(db, { orgId: 'acme', actorUserId: 'u-n-maker', userId: 'u-n-maker', share: false, ...at });
  assert.equal(outsider.ok, false);
  assert.equal((await nameSharingOf(db, 'northwind', 'u-n-maker')).person, true);
  // And back on, instantly.
  assert.equal((await setOwnNameSharing(db, { orgId: 'acme', actorUserId: 'u-maker', userId: 'u-maker', share: true, ...at })).changed, true);
  assert.equal((await nameSharingOf(db, 'acme', 'u-maker')).shared, true);
  await client.close();
});

test('a person who is not a member of the business shares nothing', async () => {
  const { client, db } = await seeded();
  const state = await nameSharingOf(db, 'acme', 'u-n-maker');
  assert.equal(state.shared, false, 'default private for a stranger');
  assert.equal(state.title, null);
  await client.close();
});

// ─── The routes, the page and the migration ─────────────────────────────────

test('the routes take the business and the person from the session and the owner check from the service', () => {
  const business = read('app/api/team/exchange-names/route.ts');
  assert.match(business, /teamRoute\(request\)/);
  assert.match(business, /setBusinessNameSharing/);
  assert.doesNotMatch(business, /body\.(orgId|userId)/);
  const own = read('app/api/team/members/[userId]/exchange-name/route.ts');
  assert.match(own, /teamRoute\(request\)/);
  assert.match(own, /setOwnNameSharing/);
  assert.doesNotMatch(own, /body\.(orgId|userId)/);
});

test('Settings offers the owners the business switch and every person their own', () => {
  const card = read('components/team/ExchangeNames.tsx');
  assert.match(card, /\/api\/team\/exchange-names/);
  assert.match(card, /exchange-name/);
  assert.match(card, /role="switch"|type="checkbox"/);
  assert.match(read('components/settings/TeamCard.tsx'), /ExchangeNames/);
});

test('migration 0084 adds the two switches (on for everyone), re-lists the whole trail check, and is in the journal in order', () => {
  const sql = read('drizzle/0084_exchange_name_sharing.sql');
  assert.match(sql, /ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "share_names_with_exchange" boolean NOT NULL DEFAULT true/);
  assert.match(sql, /ALTER TABLE "memberships" ADD COLUMN IF NOT EXISTS "share_name_with_exchange" boolean NOT NULL DEFAULT true/);
  const listed = (text) => [...(text.match(/wallet_authority_events_action_check" CHECK \("action" IN \(([\s\S]*?)\)\);/)?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  const before = listed(read('drizzle/0083_member_title.sql'));
  const after = listed(sql);
  assert.ok(before.length > 40);
  for (const action of before) assert.ok(after.includes(action), `${action} stays on the list`);
  assert.ok(after.includes('exchange_name_sharing_changed'));
  const types = read('lib/server/wallet-authority.ts');
  for (const action of after) assert.ok(types.includes(`'${action}'`), `${action} is in AuthorityAction`);
  assert.ok(read('lib/team/view.ts').includes("'exchange_name_sharing_changed'"), 'it is a team line');
  const journal = JSON.parse(read('drizzle/meta/_journal.json'));
  const tags = journal.entries.map((e) => e.tag);
  const place = tags.indexOf('0084_exchange_name_sharing');
  assert.ok(place > 0 && tags[place - 1] === '0083_member_title');
  assert.equal(journal.entries[place].idx, place);
  assert.ok(journal.entries[place].when > journal.entries[place - 1].when);
  assert.doesNotMatch(sql, /UPDATE\s+"?(organizations|memberships)/i, 'nothing existing is changed');
});
