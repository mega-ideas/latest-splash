import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

import { eq } from 'drizzle-orm';

import { copyViolations } from '../scripts/copy-rules.mjs';
import * as schema from '../lib/db/schema.ts';
import { kytProviderFromEnv } from '../lib/compliance/kyt.ts';
import { listRecipients } from '../lib/server/repository/recipients.ts';
import { approveWalletRecipient, createWalletRecipient } from '../lib/server/wallet-recipients.ts';
import { toClientRecipient } from '../lib/recipients-page/wire.ts';
import {
  RECIPIENT_KINDS,
  actionsFor,
  buildEntries,
  countByKind,
  filterEntries,
  kindOfRecipient,
  maskAddress,
  stateOf,
} from '../lib/recipients-page/view.ts';

import { migratedDb } from './helpers/store-db.mjs';

/**
 * v2 Phase 3, brief 5.9: Recipients. Five types (bank, Splash business,
 * exchange, self-custody, cross-chain), each with a verification state in
 * words; what a person may do about it depends on who they are; nothing on the
 * page is invented (no corridor mix, no Demo badge, no attestation in place of
 * a screening).
 */

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const sui = (b) => `0x${b.repeat(32)}`;

const base = { id: 'r1', name: 'Dela Cruz Trading', country: 'PH', bank: '', account: '', kybStatus: 'none', createdAt: '2026-10-20T00:00:00.000Z', screeningVerdict: 'CLEAR', approvedAt: '2026-10-21T00:00:00.000Z', savedByYou: false };
const wallet = (over = {}) => ({ ...base, payoutMethod: 'WALLET', walletAddress: sui('77'), delivery: { deliveryKind: 'SELF_CUSTODY', ownershipStatus: 'proven' }, ...over });
const exchange = (over = {}) => ({ ...base, id: 'r2', name: 'Maria Exchange Ltd', payoutMethod: 'WALLET', walletAddress: sui('66'), delivery: { deliveryKind: 'EXCHANGE', exchangeId: 'pdax', depositNetwork: 'SUI', destinationAddress: sui('66') }, ...over });
const chain = (over = {}) => ({ ...base, id: 'r3', name: 'Base Supplier', payoutMethod: 'CROSS_CHAIN', delivery: { deliveryKind: 'CROSS_CHAIN', destinationChain: 'BASE', destinationAddress: '0x52908400098527886e0f7030069857d2e4169ee7' }, ...over });
const legacyBank = (over = {}) => ({ ...base, id: 'r4', name: 'PT Maju', country: 'ID', bank: 'BCA', account: '1234567890', payoutMethod: 'BANK', delivery: { deliveryKind: 'BANK' }, ...over });
const beneficiary = { id: 'wd_b1', route: 'pdax', country: 'PH', currency: 'PHP', bankCode: 'BNORPHMM', holderName: 'Santos Packaging Inc', last4: '0391', label: 'Santos Packaging', status: 'verified' };

test('there are five types, in the order the brief names them', () => {
  assert.deepEqual(RECIPIENT_KINDS.map((k) => k.id), ['bank', 'splash_business', 'exchange', 'self_custody', 'cross_chain']);
  assert.deepEqual(RECIPIENT_KINDS.map((k) => k.label), ['Bank account', 'Splash business', 'Exchange account', 'Self-custody wallet', 'Another chain']);
  assert.equal(kindOfRecipient(wallet()), 'self_custody');
  assert.equal(kindOfRecipient(exchange()), 'exchange');
  assert.equal(kindOfRecipient(chain()), 'cross_chain');
  assert.equal(kindOfRecipient(legacyBank()), 'bank');
});

test('a self-custody wallet reads: not screened, not proven, not approved, ready, in that order of what is missing', () => {
  assert.deepEqual(stateOf(wallet({ screeningVerdict: 'BLOCK' })), { step: 'blocked', tone: 'bad', label: 'Did not pass screening', detail: 'This address cannot be paid.' });
  assert.equal(stateOf(wallet({ delivery: { deliveryKind: 'SELF_CUSTODY', ownershipStatus: 'unproven' } })).step, 'proof');
  assert.equal(stateOf(wallet({ delivery: { deliveryKind: 'SELF_CUSTODY', ownershipStatus: 'unproven' } })).label, 'Waiting for the supplier to prove the wallet');
  assert.equal(stateOf(wallet({ delivery: { deliveryKind: 'SELF_CUSTODY', ownershipStatus: 'revoked' } })).label, 'Proof withdrawn');
  assert.equal(stateOf(wallet({ screeningVerdict: null })).step, 'screening');
  assert.equal(stateOf(wallet({ screeningVerdict: 'ERROR' })).label, 'Screening did not complete');
  assert.equal(stateOf(wallet({ approvedAt: null })).step, 'approval');
  assert.equal(stateOf(wallet({ approvedAt: null })).label, 'Waiting for an owner’s approval');
  const ready = stateOf(wallet());
  assert.deepEqual([ready.step, ready.tone, ready.label], ['ready', 'ok', 'Ready to pay']);
});

test('an owner’s attestation is not a screening: an old ATTESTED verdict reads as screening still to do', () => {
  const s = stateOf(wallet({ screeningVerdict: 'ATTESTED' }));
  assert.deepEqual([s.step, s.tone], ['screening', 'wait']);
  assert.doesNotMatch(JSON.stringify(s), /[Aa]ttest/);
});

test('an exchange account needs a clean screening and an owner’s approval; a cross-chain one says it is not open yet', () => {
  assert.equal(stateOf(exchange()).step, 'ready');
  assert.equal(stateOf(exchange({ approvedAt: null })).step, 'approval');
  assert.equal(stateOf(exchange({ screeningVerdict: null })).step, 'screening');
  const c = stateOf(chain());
  assert.deepEqual([c.step, c.tone, c.label], ['saved', 'ok', 'Screened and approved']);
  assert.match(c.detail, /not switched on for your business yet/);
  assert.equal(stateOf(chain({ approvedAt: null })).step, 'approval');
});

test('a bank account is verified when the bank confirmed the holder’s name; an older entry says how to pay it', () => {
  const entries = buildEntries({ saved: [legacyBank(), legacyBank({ id: 'r5', name: 'Full KYB Co', kybStatus: 'full' })], beneficiaries: [beneficiary], transfers: [] });
  const bank = entries.filter((e) => e.kind === 'bank');
  assert.equal(bank.length, 3);
  const verified = bank.find((e) => e.id === 'wd_b1');
  assert.deepEqual([verified.state.step, verified.state.tone, verified.state.label], ['ready', 'ok', 'Verified with the bank']);
  assert.equal(verified.masked, '••0391');
  assert.equal(verified.source, 'beneficiary');
  const older = bank.find((e) => e.id === 'r4');
  assert.equal(older.state.step, 'older');
  assert.match(older.state.detail, /add it again in Transfer/);
  assert.equal(bank.find((e) => e.id === 'r5').state.label, 'Business verified');
  // A bank account number is never shown whole.
  for (const e of bank) assert.doesNotMatch(JSON.stringify(e), /1234567890/);
});

test('businesses on Splash come from payments already made to them, once each, newest first', () => {
  const t = (id, name, at, kind = 'splash_business') => ({ id, paymentRef: id, payeeKind: kind, payeeName: name, payeeMasked: null, payeeCountry: 'MY', createdAt: at, status: 'settled' });
  const entries = buildEntries({
    saved: [],
    beneficiaries: [],
    transfers: [t('t1', 'Northwind Sdn Bhd', '2026-10-01T00:00:00Z'), t('t2', 'Northwind Sdn Bhd', '2026-10-05T00:00:00Z'), t('t3', 'Kopi Works', '2026-10-03T00:00:00Z'), t('t4', 'A wallet payee', '2026-10-04T00:00:00Z', 'SELF_CUSTODY')],
  });
  const biz = entries.filter((e) => e.kind === 'splash_business');
  assert.deepEqual(biz.map((e) => e.name), ['Northwind Sdn Bhd', 'Kopi Works']);
  assert.match(biz[0].subtitle, /2 payments/);
  assert.deepEqual([biz[0].state.step, biz[0].state.label], ['ready', 'On Splash']);
  assert.equal(entries.some((e) => e.name === 'A wallet payee'), false, 'only a business on Splash is listed here');
});

test('what a person may do depends on who they are and what is missing', () => {
  const entry = (r, source = 'saved') => buildEntries({ saved: [r], beneficiaries: [], transfers: [] }).find((e) => e.source === source);
  const unproven = entry(wallet({ delivery: { deliveryKind: 'SELF_CUSTODY', ownershipStatus: 'unproven' } }));
  assert.deepEqual(actionsFor(unproven, 'OWNER'), ['send_proof', 'remove']);
  assert.deepEqual(actionsFor(unproven, 'MAKER'), ['send_proof', 'remove'], 'staff may ask for the link and remove what cannot be paid');
  assert.deepEqual(actionsFor(unproven, 'VIEWER'), [], 'a viewer changes nothing');
  const proven = entry(wallet());
  assert.deepEqual(actionsFor(proven, 'OWNER'), ['withdraw_proof', 'remove']);
  assert.deepEqual(actionsFor(proven, 'MAKER'), [], 'a payable recipient is the owners’ to remove');
  const waiting = entry(wallet({ approvedAt: null }));
  assert.deepEqual(actionsFor(waiting, 'OWNER'), ['approve', 'withdraw_proof', 'remove']);
  assert.deepEqual(actionsFor(entry(wallet({ approvedAt: null, savedByYou: true })), 'OWNER'), ['withdraw_proof', 'remove'], 'another owner approves what you saved');
  assert.deepEqual(actionsFor(waiting, 'MAKER'), ['remove']);
  const b = buildEntries({ saved: [], beneficiaries: [beneficiary], transfers: [] })[0];
  assert.deepEqual(actionsFor(b, 'OWNER'), ['remove']);
  assert.deepEqual(actionsFor(b, 'MAKER'), [], 'only an owner removes a supplier’s bank account');
  const biz = buildEntries({ saved: [], beneficiaries: [], transfers: [{ id: 't1', paymentRef: 't1', payeeKind: 'splash_business', payeeName: 'Kopi Works', payeeMasked: null, payeeCountry: 'MY', createdAt: '2026-10-03T00:00:00Z', status: 'settled' }] })[0];
  assert.deepEqual(actionsFor(biz, 'OWNER'), [], 'a business on Splash is found by name; nothing to maintain');
});

test('filter by type and search by name, bank or address; counts per type', () => {
  const entries = buildEntries({ saved: [wallet(), exchange(), chain(), legacyBank()], beneficiaries: [beneficiary], transfers: [] });
  assert.deepEqual(countByKind(entries), { all: 5, bank: 2, splash_business: 0, exchange: 1, self_custody: 1, cross_chain: 1 });
  assert.equal(filterEntries(entries, { kind: 'exchange', query: '' }).length, 1);
  assert.equal(filterEntries(entries, { kind: 'all', query: 'dela' }).length, 1);
  assert.equal(filterEntries(entries, { kind: 'all', query: 'bca' }).length, 1);
  assert.equal(filterEntries(entries, { kind: 'all', query: sui('66').slice(0, 10) }).length, 1);
  assert.equal(filterEntries(entries, { kind: 'bank', query: 'santos' }).length, 1);
  assert.equal(filterEntries(entries, { kind: 'bank', query: 'dela' }).length, 0);
});

test('an address is shown shortened, never as a guess', () => {
  assert.equal(maskAddress(sui('77')), '0x7777…7777');
  assert.equal(maskAddress(null), '');
});

test('the client gets whether you saved a recipient, never who did', () => {
  const out = toClientRecipient({ ...base, orgId: 'acme', tier: 'PAYOUT_ONLY', createdVia: 'manual', swift: '', createdBy: 'u-1', approvedAt: '2026-10-21T00:00:00.000Z' }, 'u-1');
  assert.equal(out.savedByYou, true);
  assert.equal('createdBy' in out, false);
  assert.equal('orgId' in out, false, 'the business is the session’s, never the page’s');
  assert.equal(toClientRecipient({ ...base, orgId: 'acme', createdBy: 'u-2' }, 'u-1').savedByYou, false);
  assert.equal(toClientRecipient({ ...base, orgId: 'acme', createdBy: null }, 'u-1').savedByYou, false);
});

test('the list carries when an owner approved a recipient, and each business reads only its own', async () => {
  const { db, client } = await migratedDb();
  const now = new Date('2026-10-25T08:00:00Z');
  const deps = (orgId) => ({ db, orgId, now: () => now, kyt: kytProviderFromEnv({ NODE_ENV: 'test' }, { now: () => now }) });
  const supplier = { legalName: 'Dela Cruz Trading Corp', name: 'Dela Cruz', registrationNumber: 'CS201912345', country: 'PH', addressLine1: '1 Ayala Ave', addressCity: 'Makati', email: 'ap@delacruz.test' };
  const staffSaved = await createWalletRecipient(deps('acme'), { body: { ...supplier, deliveryKind: 'EXCHANGE', exchange: 'pdax', depositAddress: sui('66') }, requestedBy: 'u-staff', requestedRole: 'MAKER' });
  assert.equal(staffSaved.ok, true, JSON.stringify(staffSaved));
  let [row] = await listRecipients(db, 'acme');
  assert.equal(row.approvedAt ?? null, null, 'a staff member’s save waits for an owner');
  assert.equal(row.createdBy, 'u-staff');
  assert.equal((await approveWalletRecipient(deps('acme'), { recipientId: row.id, approvedBy: 'u-staff', role: 'OWNER' })).code, 'creator_cannot_approve');
  const done = await approveWalletRecipient(deps('acme'), { recipientId: row.id, approvedBy: 'u-owner', role: 'OWNER' });
  assert.equal(done.ok, true);
  [row] = await listRecipients(db, 'acme');
  assert.equal(row.approvedAt, '2026-10-25T08:00:00.000Z');
  // Replaying the approval changes nothing: the first approver and time stay.
  const replay = await approveWalletRecipient({ ...deps('acme'), now: () => new Date('2026-10-26T00:00:00Z') }, { recipientId: row.id, approvedBy: 'u-owner-2', role: 'OWNER' });
  assert.deepEqual([replay.ok, replay.approvedBy, replay.approvedAt], [true, 'u-owner', '2026-10-25T08:00:00.000Z']);
  // Another business reads none of it, and cannot approve it.
  assert.deepEqual(await listRecipients(db, 'northwind'), []);
  assert.equal((await approveWalletRecipient(deps('northwind'), { recipientId: row.id, approvedBy: 'u-nw', role: 'OWNER' })).code, 'not_found');
  assert.equal((await db.select().from(schema.suppliers).where(eq(schema.suppliers.id, row.id)))[0].approvedBy, 'u-owner');
  await client.close();
});

test('the route hands the page recipients through the client shape and from the session’s own business', () => {
  const route = read('app/api/recipients/route.ts');
  assert.match(route, /toClientRecipient\(/);
  assert.match(route, /listRecipientsFor\(accountCheck\.account\.orgId\)/);
});

/* The page ------------------------------------------------------------------ */

const pageFiles = () => {
  const dir = new URL('../components/recipients/', import.meta.url);
  return existsSync(dir) ? readdirSync(dir).filter((f) => /\.tsx?$/.test(f)).map((f) => [`components/recipients/${f}`, read(`components/recipients/${f}`)]) : [];
};

test('the page is built from the real routes, and says so for each type', () => {
  const files = pageFiles();
  assert.ok(files.length >= 3, 'the page is a set of components');
  const joined = files.map(([, t]) => code(t)).join('\n');
  for (const url of ['/api/recipients', '/api/wallet/payouts/beneficiaries', '/api/wallet/transfers', '/api/wallet/overview']) assert.match(joined, new RegExp(url.replaceAll('/', '\\/')), url);
  assert.match(joined, /ownership-proof/);
  assert.match(joined, /\/approval/);
  assert.match(read('app/dashboard/recipients/page.tsx'), /RecipientsPage/);
  assert.ok(read('app/dashboard/recipients/page.tsx').split('\n').length < 30, 'the route is thin');
});

test('nothing on the page is invented: no corridor mix, no Demo badge, no attestation, no link to a page that no longer sends', () => {
  const all = [...pageFiles(), ['app/dashboard/recipients/page.tsx', read('app/dashboard/recipients/page.tsx')]];
  for (const [name, text] of all) {
    const body = code(text);
    assert.doesNotMatch(body, /corridorBreakdown|Corridor mix|Active corridors|Attested by admin|attestKnownRecipient|StatusBadge|r\.demo|Global directory/, name);
    assert.doesNotMatch(body, /E39774|coral|\bDemo\b|\bDEMO\b|Coming soon|testnet|bg-grid|grid-background/i, name);
    assert.doesNotMatch(body, /\b(Hata|Fiuu|PDAX|DurianPay|Halliday|Stripe|TransFi|Bridge|Elliptic|Chainalysis|Sumsub)\b/, `${name} names a partner that is not signed`);
    assert.doesNotMatch(body, /Send USDC|href="\/dashboard\/wallet"/, `${name} links to the page that no longer sends`);
    assert.deepEqual(copyViolations(name, text), [], name);
  }
});

test('the page sends no business, account or wallet of its own, and each action is a button with a name', () => {
  const joined = pageFiles().map(([, t]) => code(t)).join('\n');
  assert.doesNotMatch(joined, /orgId|accountId|\?(org|orgId|account)=/);
  assert.match(joined, /aria-label=/);
  assert.match(joined, /role="radiogroup"/);
  assert.match(joined, /aria-live|role="status"/);
});

test('the proof link is shown to an owner once, with a copy button, and a staff member is told it was emailed', () => {
  const joined = pageFiles().map(([, t]) => code(t)).join('\n');
  assert.match(joined, /answer\.body\.link/);
  assert.match(joined, /emailedTo/);
  assert.match(joined, /CopyButton/);
  assert.match(joined, /Withdraw the proof|withdraw_proof/);
});

test('removing and withdrawing ask first, because a payment on Sui cannot be taken back', () => {
  const joined = pageFiles().map(([, t]) => code(t)).join('\n');
  assert.match(joined, /Remove this recipient\?/);
  assert.match(joined, /window\.confirm|<Modal|confirming/);
});
