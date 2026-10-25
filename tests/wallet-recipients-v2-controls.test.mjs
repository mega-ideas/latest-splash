/**
 * Wallet recipients (v2 §4.7): the controls the §4.7 review found missing.
 *
 * What must hold:
 *   - an exchange account is unproven until the exchange's side confirmed
 *     it: its payments are signed only once that payment's Travel Rule
 *     message is approved (not merely submitted or awaiting the
 *     counterparty), and the EXCHANGE tag is given only to a confirmed one;
 *   - no address Splash controls (operator, treasury, test recipient, gas
 *     sponsor, FeeConfig's recipient and pending recipient, its CCTP deposit
 *     addresses) is saved or paid as a recipient, whatever the kind;
 *   - no address of the business itself (its wallet, its members' passkey
 *     and zkLogin addresses) is saved or paid as a supplier;
 *   - a recipient a staff member saved is payable only once an owner
 *     approves it, and the proof link goes to the supplier's email, never
 *     back to staff;
 *   - an owner's withdrawal of a proof is not undone by a signature check
 *     that finishes after it;
 *   - a self-custody wallet without the supplier's business details is not
 *     payable; the older WALLET body goes through the same save;
 *   - a cross-chain EVM address is taken only in its EIP-55 form; a Solana
 *     mint recipient only once the chain shows it is a USDC token account;
 *   - one EVM transaction may carry the mints of several payments;
 *   - two saves of one Sui address cannot race past one-address-one-recipient.
 *
 * PGlite with every migration. Nothing reaches a network; nothing is signed
 * on a chain.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { eq } from 'drizzle-orm';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { verifyPersonalMessageSignature } from '@mysten/sui/verify';

import * as schema from '../lib/db/schema.ts';
import { kytProviderFromEnv } from '../lib/compliance/kyt.ts';
import { parseWalletRecipient, RecipientInputError } from '../lib/recipients/wallet-recipients.ts';
import { dbOwnershipGate } from '../lib/server/ownership-proofs.ts';
import * as WR from '../lib/server/wallet-recipients.ts';

import { migratedDb } from './helpers/store-db.mjs';

const T0 = new Date('2026-10-25T08:00:00Z');
const sui = (b) => `0x${b.repeat(32)}`;
const supplier = {
  name: 'Dela Cruz',
  legalName: 'Dela Cruz Trading Corp',
  registrationNumber: 'CS201912345',
  country: 'PH',
  addressLine1: '1 Ayala Ave',
  addressCity: 'Makati',
  email: 'ap@delacruz.test',
};
const OPERATOR = sui('0e');
const FEE_RECIPIENT = sui('fe');
const PENDING_FEE = sui('fd');
const splashAddresses = async () => [OPERATOR, FEE_RECIPIENT, PENDING_FEE];

async function world() {
  const { db, client } = await migratedDb();
  await client.exec(`UPDATE organizations SET legal_name = 'Acme Trading Sdn Bhd' WHERE id = 'acme'`);
  await client.exec(`INSERT INTO users (id, email, name) VALUES ('u-owner', 'owner@acme.test', 'Owner'), ('u-maker', 'maker@acme.test', 'Maker'), ('u-nw', 'nw@northwind.test', 'NW')`);
  await client.exec(`INSERT INTO memberships (id, user_id, org_id, role) VALUES ('m1', 'u-owner', 'acme', 'admin'), ('m2', 'u-maker', 'acme', 'maker'), ('m3', 'u-nw', 'northwind', 'admin')`);
  const deps = (orgId = 'acme', extra = {}) => ({ db, orgId, now: () => T0, kyt: kytProviderFromEnv({ NODE_ENV: 'test' }, { now: () => T0 }), splashAddresses, ...extra });
  const save = (body, { orgId = 'acme', by = 'u-owner', role = 'OWNER', extra = {} } = {}) =>
    WR.createWalletRecipient(deps(orgId, extra), { body: { ...supplier, ...body }, requestedBy: by, requestedRole: role });
  const gate = (address, kind, opts = {}, orgId = 'acme') => WR.walletDeliveryGate(db, orgId, address, kind, { splashAddresses, ...opts });
  return { db, client, deps, save, gate };
}

const verifySignature = async (message, signature, address) => {
  try {
    await verifyPersonalMessageSignature(message, signature, { address });
    return true;
  } catch {
    return false;
  }
};
const sign = async (keypair, message) => (await keypair.signPersonalMessage(new TextEncoder().encode(message))).signature;
const tokenOf = (link) => link.split('/wallet-proof/')[1];
const proofDeps = (w, extra = {}) => ({ ...w.deps(), appUrl: 'https://app.splash.test', sendEmail: async () => {}, ...extra });

async function travelRule(w, { paymentRef = `wsr_${randomUUID()}`, address = sui('66'), exchange = 'pdax', status = 'submitted', orgId = 'acme', sandbox = false, createdAt = new Date(Date.now() + 1000) } = {}) {
  await w.db.insert(schema.travelRuleTransfers).values({
    id: `trt_${randomUUID()}`, orgId, paymentRef, signingRequestId: null, exchange, depositAddress: address, amountMinor: 250_000_000n,
    requestHash: 'h', provider: sandbox ? 'sandbox' : 'sumsub', sandbox, providerRef: `txn-${randomUUID()}`, status, createdBy: 'u-owner', createdAt, updatedAt: createdAt,
  });
  return paymentRef;
}

/* 1 ── An exchange account is unproven until the exchange confirmed it ─── */

test('an exchange account is paid only once the exchange side confirmed it, and only then tagged', async () => {
  const w = await world();
  const ex = await w.save({ deliveryKind: 'EXCHANGE', exchange: 'pdax', depositAddress: sui('66') });
  assert.equal(ex.ok, true, JSON.stringify(ex));
  assert.equal(ex.recipient.exchange.confirmed, false, 'a saved exchange account is not yet confirmed');

  // Opening the first payment is allowed: its Travel Rule message is sent from it.
  assert.equal(await w.gate(sui('66'), 2, { stage: 'open' }), null);
  // Signing it is not, while the message is only submitted or awaiting the counterparty.
  for (const status of ['submitted', 'awaiting_counterparty']) {
    const ref = await travelRule(w, { status });
    assert.equal((await w.gate(sui('66'), 2, { stage: 'sign', paymentRef: ref }))?.code, 'exchange_unconfirmed', status);
  }
  assert.equal((await w.gate(sui('66'), 2))?.code, 'exchange_unconfirmed', 'the default is the signing check');
  assert.deepEqual(await dbOwnershipGate(w.db).savedExchanges('acme', [sui('66')]), [], 'no EXCHANGE tag for an unconfirmed account');

  // A message at another exchange, a sandbox one, or another business's, confirms nothing.
  await travelRule(w, { status: 'approved', exchange: 'bitkub' });
  await travelRule(w, { status: 'approved', orgId: 'northwind' });
  assert.equal((await w.gate(sui('66'), 2))?.code, 'exchange_unconfirmed');

  // The first payment whose message the exchange approved may be signed, and confirms the account.
  const first = await travelRule(w, { status: 'approved' });
  assert.equal(await w.gate(sui('66'), 2, { stage: 'sign', paymentRef: first }), null);
  const later = await travelRule(w, { status: 'submitted' });
  assert.equal(await w.gate(sui('66'), 2, { stage: 'sign', paymentRef: later }), null, 'a confirmed account: the usual Travel Rule hold applies');
  assert.deepEqual(await dbOwnershipGate(w.db).savedExchanges('acme', [sui('66')]), [sui('66')]);
  await w.client.close();
});

test('an approval from before the account was saved, or from the sandbox in production, confirms nothing', async () => {
  const w = await world();
  await travelRule(w, { status: 'approved', createdAt: new Date('2020-01-01T00:00:00Z') });
  await w.save({ deliveryKind: 'EXCHANGE', exchange: 'pdax', depositAddress: sui('66') });
  assert.equal((await w.gate(sui('66'), 2))?.code, 'exchange_unconfirmed', 'an approval for whoever held the address before');
  await travelRule(w, { status: 'approved', sandbox: true });
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    assert.equal((await w.gate(sui('66'), 2))?.code, 'exchange_unconfirmed', 'a sandbox approval is not a confirmation in production');
  } finally {
    process.env.NODE_ENV = prev;
  }
  await w.client.close();
});

/* 2 ── Splash's own addresses ─────────────────────────────────────────── */

test('no address Splash controls is saved or paid as a recipient, whatever the kind', async () => {
  const w = await world();
  for (const address of [OPERATOR, FEE_RECIPIENT, PENDING_FEE]) {
    const asEx = await w.save({ deliveryKind: 'EXCHANGE', exchange: 'pdax', depositAddress: address });
    assert.deepEqual([asEx.status, asEx.code], [409, 'splash_controlled_address'], address);
    const asWallet = await w.save({ deliveryKind: 'SELF_CUSTODY', address });
    assert.deepEqual([asWallet.status, asWallet.code], [409, 'splash_controlled_address'], address);
  }
  assert.equal((await w.db.select().from(schema.kytScreenings)).length, 0, 'refused before screening');
  // A row already saved at an address that became Splash's (FeeConfig's recipient changed) is not paid.
  await w.client.exec(`INSERT INTO suppliers (id, org_id, name, country, payout_method, wallet_address, delivery_kind, exchange_id, deposit_network, approved_by, approved_at, legal_name, registration_number, address_line1, address_city)
    VALUES ('rcp_old', 'acme', 'x', 'PH', 'WALLET', '${FEE_RECIPIENT}', 'EXCHANGE', 'pdax', 'SUI', 'u-owner', now(), 'X Corp', 'R1', '1 St', 'Manila')`);
  assert.equal((await w.gate(FEE_RECIPIENT, 2, { stage: 'open' }))?.code, 'splash_controlled_address');
  await travelRule(w, { status: 'approved', address: FEE_RECIPIENT });
  assert.deepEqual(await dbOwnershipGate(w.db, { splashAddresses }).savedExchanges('acme', [FEE_RECIPIENT]), []);
  // An unreadable list refuses, never lets through.
  const unreadable = await WR.walletDeliveryGate(w.db, 'acme', FEE_RECIPIENT, 2, { stage: 'open', splashAddresses: async () => { throw new Error('rpc down'); } });
  assert.equal(unreadable?.code, 'splash_addresses_unreadable');
  await w.client.close();
});

test("Splash's addresses come from its configuration, and production refuses without the fee recipient", async () => {
  const { splashAddressSourceFromEnv } = await import('../lib/server/splash-addresses.ts');
  const env = { NODE_ENV: 'test', OPERATOR_SUI_ADDRESS: OPERATOR, TREASURY_ADDRESS: sui('0d'), SPLASH_TEST_RECIPIENT_ADDRESS: sui('0c') };
  assert.deepEqual((await splashAddressSourceFromEnv(env)()).sort(), [OPERATOR, sui('0d'), sui('0c')].sort());
  await assert.rejects(() => splashAddressSourceFromEnv({ NODE_ENV: 'production', OPERATOR_SUI_ADDRESS: OPERATOR })(), /fee/i);
  const withFee = splashAddressSourceFromEnv({ NODE_ENV: 'production', OPERATOR_SUI_ADDRESS: OPERATOR, SPLASH_FEE_CONFIG_ID: sui('fc') }, async () => ({ feeRecipient: FEE_RECIPIENT, pendingRecipient: { recipient: PENDING_FEE } }));
  assert.deepEqual((await withFee()).sort(), [OPERATOR, FEE_RECIPIENT, PENDING_FEE].sort());
  const { splashCrossChainAddresses } = await import('../lib/server/splash-addresses.ts');
  assert.deepEqual(splashCrossChainAddresses({ FUNDING_CCTP_DEPOSIT_ADDRESSES_JSON: JSON.stringify({ BASE: '0x52908400098527886E0F7030069857D2E4169EE7' }) }), ['0x52908400098527886e0f7030069857d2e4169ee7']);
});

test("a cross-chain recipient at one of Splash's CCTP addresses is refused", async () => {
  const w = await world();
  const r = await w.save(
    { deliveryKind: 'CROSS_CHAIN', chain: 'BASE', address: '0x52908400098527886E0F7030069857D2E4169EE7' },
    { extra: { splashCrossChain: ['0x52908400098527886e0f7030069857d2e4169ee7'] } },
  );
  assert.deepEqual([r.status, r.code], [409, 'splash_controlled_address']);
  await w.client.close();
});

/* 3 ── The business's own addresses ───────────────────────────────────── */

test("the business's own wallet and its members' addresses are not suppliers", async () => {
  const w = await world();
  const WALLET = sui('b1');
  const PASSKEY = sui('b2');
  const ZKLOGIN = sui('b3');
  await w.client.exec(`INSERT INTO wallet_deposit_sync (org_id, wallet_address, usdc_type) VALUES ('acme', '${WALLET}', 'usdc')`);
  await w.client.exec(`INSERT INTO passkey_credentials (id, user_id, credential_id, public_key, sui_address, rp_id) VALUES ('pk1', 'u-maker', 'c1', 'k', '${PASSKEY}', 'localhost')`);
  await w.client.exec(`INSERT INTO wallet_identities (id, user_id, org_id, sui_address, oauth_iss, oauth_sub, oauth_aud) VALUES ('wi1', 'u-maker', 'acme', '${ZKLOGIN}', 'iss', 'sub', 'aud')`);
  for (const address of [WALLET, PASSKEY, ZKLOGIN]) {
    const r = await w.save({ deliveryKind: 'SELF_CUSTODY', address }, { by: 'u-maker', role: 'MAKER' });
    assert.deepEqual([r.status, r.code], [409, 'own_address'], address);
  }
  // Another business may pay a member of this one: it is not theirs.
  assert.equal((await w.save({ deliveryKind: 'SELF_CUSTODY', address: PASSKEY }, { orgId: 'northwind', by: 'u-nw' })).ok, true);
  // A row that names one anyway is not paid.
  await w.client.exec(`INSERT INTO suppliers (id, org_id, name, country, payout_method, wallet_address, wallet_provider, delivery_kind, ownership_status, approved_by, approved_at, legal_name, registration_number, address_line1, address_city)
    VALUES ('rcp_own', 'acme', 'x', 'PH', 'WALLET', '${ZKLOGIN}', 'SLUSH', 'SELF_CUSTODY', 'proven', 'u-owner', now(), 'X Corp', 'R1', '1 St', 'Manila')`);
  assert.equal((await w.gate(ZKLOGIN, 1))?.code, 'own_address');
  await w.client.close();
});

/* 4 ── Maker-checker, and the link is the supplier's ──────────────────── */

test('a recipient a staff member saved is payable only once an owner approves it', async () => {
  const w = await world();
  const key = Ed25519Keypair.generate();
  const saved = await w.save({ deliveryKind: 'SELF_CUSTODY', address: key.toSuiAddress() }, { by: 'u-maker', role: 'MAKER' });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.deepEqual([saved.recipient.controls.createdBy, saved.recipient.controls.approvedBy], ['u-maker', null]);
  const link = await WR.requestOwnershipProof(proofDeps(w), { recipientId: saved.recipient.id, requestedBy: 'u-maker', revealLink: false });
  assert.equal(link.ok, true, JSON.stringify(link));
  assert.equal(link.link, null, 'staff are not handed the link');
  assert.equal(link.emailedTo, 'ap@delacruz.test');
  // The owner may see it; here the owner asks again to sign as the supplier would.
  const ownerLink = await WR.requestOwnershipProof(proofDeps(w), { recipientId: saved.recipient.id, requestedBy: 'u-owner', revealLink: true });
  const proved = await WR.submitOwnershipProof({ db: w.db, now: () => T0, verifySignature }, { token: tokenOf(ownerLink.link), signature: await sign(key, ownerLink.message) });
  assert.equal(proved.ok, true, JSON.stringify(proved));

  assert.equal((await w.gate(key.toSuiAddress(), 1))?.code, 'recipient_not_approved', 'proven, but no owner approved it');
  assert.deepEqual(await dbOwnershipGate(w.db).provenAddresses('acme', [key.toSuiAddress()]), [], 'nor may it be tagged');
  assert.equal((await WR.approveWalletRecipient({ db: w.db, orgId: 'acme', now: () => T0 }, { recipientId: saved.recipient.id, approvedBy: 'u-maker', role: 'MAKER' })).code, 'owner_only');
  assert.equal((await WR.approveWalletRecipient({ db: w.db, orgId: 'northwind', now: () => T0 }, { recipientId: saved.recipient.id, approvedBy: 'u-nw', role: 'OWNER' })).code, 'not_found');
  const approved = await WR.approveWalletRecipient({ db: w.db, orgId: 'acme', now: () => T0 }, { recipientId: saved.recipient.id, approvedBy: 'u-owner', role: 'OWNER' });
  assert.equal(approved.ok, true, JSON.stringify(approved));
  assert.equal(await w.gate(key.toSuiAddress(), 1), null);
  assert.deepEqual(await dbOwnershipGate(w.db).provenAddresses('acme', [key.toSuiAddress()]), [key.toSuiAddress()]);
  // Who saved, approved and proved it is on the recipient.
  const [row] = await w.db.select().from(schema.suppliers).where(eq(schema.suppliers.id, saved.recipient.id));
  assert.deepEqual([row.createdBy, row.approvedBy, Boolean(row.ownershipProvenAt), row.ownershipChallengeId], ['u-maker', 'u-owner', true, proved.challengeId]);

  // An owner's own save is approved by that owner.
  const own = await w.save({ deliveryKind: 'EXCHANGE', exchange: 'pdax', depositAddress: sui('67') });
  assert.deepEqual([own.recipient.controls.createdBy, own.recipient.controls.approvedBy], ['u-owner', 'u-owner']);
  await w.client.close();
});

test('staff cannot ask for a link the supplier would not get, and a failed email hands nothing back', async () => {
  const w = await world();
  const key = Ed25519Keypair.generate();
  const noEmail = await w.save({ deliveryKind: 'SELF_CUSTODY', address: key.toSuiAddress(), email: '' }, { by: 'u-maker', role: 'MAKER' });
  const r = await WR.requestOwnershipProof(proofDeps(w), { recipientId: noEmail.recipient.id, requestedBy: 'u-maker', revealLink: false });
  assert.deepEqual([r.status, r.code], [409, 'supplier_email_needed']);
  const k2 = Ed25519Keypair.generate();
  const withEmail = await w.save({ deliveryKind: 'SELF_CUSTODY', address: k2.toSuiAddress() }, { by: 'u-maker', role: 'MAKER' });
  const failed = await WR.requestOwnershipProof(proofDeps(w, { sendEmail: async () => { throw new Error('smtp down'); } }), { recipientId: withEmail.recipient.id, requestedBy: 'u-maker', revealLink: false });
  assert.deepEqual([failed.status, failed.code], [502, 'email_failed']);
  const open = (await w.db.select().from(schema.recipientOwnershipChallenges)).filter((c) => !c.usedAt);
  assert.equal(open.length, 0, 'no link is left open that nobody was sent');
  await w.client.close();
});

/* 5 ── A withdrawal is not undone by a late signature check ──────────── */

test("an owner's withdrawal during the signature check leaves the wallet withdrawn", async () => {
  const w = await world();
  const key = Ed25519Keypair.generate();
  const saved = await w.save({ deliveryKind: 'SELF_CUSTODY', address: key.toSuiAddress() });
  const id = saved.recipient.id;
  // First proven, so the owner has something to withdraw.
  const l1 = await WR.requestOwnershipProof(proofDeps(w), { recipientId: id, requestedBy: 'u-owner', revealLink: true });
  assert.equal((await WR.submitOwnershipProof({ db: w.db, now: () => T0, verifySignature }, { token: tokenOf(l1.link), signature: await sign(key, l1.message) })).ok, true);
  await WR.revokeRecipientOwnership({ db: w.db, orgId: 'acme', now: () => T0 }, { recipientId: id });
  // A new link; while its signature is checked, the owner withdraws again.
  const l2 = await WR.requestOwnershipProof(proofDeps(w), { recipientId: id, requestedBy: 'u-owner', revealLink: true });
  const slow = async (m, s, a) => {
    await WR.revokeRecipientOwnership({ db: w.db, orgId: 'acme', now: () => T0 }, { recipientId: id });
    return verifySignature(m, s, a);
  };
  const r = await WR.submitOwnershipProof({ db: w.db, now: () => T0, verifySignature: slow }, { token: tokenOf(l2.link), signature: await sign(key, l2.message) });
  assert.deepEqual([r.status, r.code], [409, 'proof_withdrawn']);
  const [row] = await w.db.select().from(schema.suppliers).where(eq(schema.suppliers.id, id));
  assert.equal(row.ownershipStatus, 'revoked');
  assert.equal((await w.gate(key.toSuiAddress(), 1))?.code, 'ownership_not_proven');
  const [proof] = await w.db.select().from(schema.walletOwnershipProofs);
  assert.ok(proof.revokedAt, 'the proof row stays withdrawn');
  // And a link made after the withdrawal works again.
  const l3 = await WR.requestOwnershipProof(proofDeps(w), { recipientId: id, requestedBy: 'u-owner', revealLink: true });
  assert.equal((await WR.submitOwnershipProof({ db: w.db, now: () => T0, verifySignature }, { token: tokenOf(l3.link), signature: await sign(key, l3.message) })).ok, true);
  assert.equal(await w.gate(key.toSuiAddress(), 1), null);
  await w.client.close();
});

/* 6 ── The supplier's details, and the older WALLET body ─────────────── */

test("a wallet without the supplier's business details is not payable, and the older body takes the same save", async () => {
  const w = await world();
  const legacy = sui('71');
  await w.client.exec(`INSERT INTO suppliers (id, org_id, name, country, payout_method, wallet_address, wallet_provider, delivery_kind, ownership_status, approved_by, approved_at)
    VALUES ('rcp_legacy', 'acme', 'Old', 'PH', 'WALLET', '${legacy}', 'SLUSH', 'SELF_CUSTODY', 'proven', 'u-owner', now())`);
  await w.db.insert(schema.walletOwnershipProofs).values({ orgId: 'acme', address: legacy, method: 'test', evidenceSha256: 'x'.repeat(64), verifiedAt: T0 });
  assert.equal((await w.gate(legacy, 1))?.code, 'supplier_details_missing');
  assert.equal((await WR.requestOwnershipProof(proofDeps(w), { recipientId: 'rcp_legacy', requestedBy: 'u-owner', revealLink: true })).code, 'supplier_details_missing');

  // The older body: payoutMethod WALLET, a name, a country, an address.
  const old = await WR.createWalletRecipient(w.deps(), { body: WR.legacyWalletBody({ payoutMethod: 'WALLET', name: 'X', country: 'PH', walletAddress: sui('72'), walletProvider: 'SLUSH' }), requestedBy: 'u-maker', requestedRole: 'MAKER' });
  assert.deepEqual([old.status, old.code], [400, 'supplier_details_missing']);
  const full = await WR.createWalletRecipient(w.deps(), { body: WR.legacyWalletBody({ ...supplier, payoutMethod: 'WALLET', walletAddress: sui('72'), walletProvider: 'METAMASK_SUI_SNAP' }), requestedBy: 'u-maker', requestedRole: 'MAKER' });
  assert.equal(full.ok, true, JSON.stringify(full));
  assert.deepEqual([full.recipient.deliveryKind, full.recipient.wallet.label, full.recipient.wallet.ownership], ['SELF_CUSTODY', 'METAMASK_SUI_SNAP', 'unproven']);

  const route = await readFile(new URL('../app/api/recipients/route.ts', import.meta.url), 'utf8');
  const walletBranch = route.slice(route.indexOf("if (body.payoutMethod === 'WALLET')"));
  assert.match(walletBranch.slice(0, 600), /recipientRoute\(request\)/, 'owners and staff only');
  assert.match(walletBranch.slice(0, 900), /createWalletRecipient\(/, 'the same save as every wallet recipient');
  assert.doesNotMatch(route, /screenWalletAddress\(|attestKnownRecipient/, 'no second, weaker save');
  await w.client.close();
});

/* 7 ── Cross-chain addresses ──────────────────────────────────────────── */

test('a cross-chain EVM address is taken only in its EIP-55 form', () => {
  for (const address of ['0x52908400098527886e0f7030069857d2e4169ee7', '0x52908400098527886E0F7030069857D2E4169EE7'.toUpperCase().replace('0X', '0x')]) {
    assert.throws(() => parseWalletRecipient({ ...supplier, deliveryKind: 'CROSS_CHAIN', chain: 'BASE', address }), (e) => e instanceof RecipientInputError && e.code === 'bad_address', address);
  }
  assert.equal(parseWalletRecipient({ ...supplier, deliveryKind: 'CROSS_CHAIN', chain: 'BASE', address: '0x52908400098527886E0F7030069857D2E4169EE7' }).chain, 'BASE');
});

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SOL_ACCOUNT = '4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T';
const SOL_OWNER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const rpcAnswer = (value) => async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value } }), { status: 200 });
const tokenAccount = ({ program = TOKEN_PROGRAM, mint = USDC_MINT, owner = SOL_OWNER, state = 'initialized', type = 'account' } = {}) => ({
  owner: program, lamports: 2039280, executable: false, data: { program: 'spl-token', parsed: { type, info: { mint, owner, state, tokenAmount: { amount: '0', decimals: 6 } } }, space: 165 },
});

test('a Solana mint recipient is saved only once the chain shows it is a USDC token account', async () => {
  const { solanaTokenAccountReaderFromEnv } = await import('../lib/server/solana-token-accounts.ts');
  const w = await world();
  const body = { deliveryKind: 'CROSS_CHAIN', chain: 'SOLANA', address: SOL_ACCOUNT, addressIsUsdcTokenAccount: true };
  const env = { NODE_ENV: 'production', CCTP_MINT_RPC_URLS_JSON: JSON.stringify({ SOLANA: 'https://solana.rpc.test' }) };
  const withReader = (fetcher) => ({ extra: { solana: solanaTokenAccountReaderFromEnv(env, fetcher) } });
  assert.equal((await w.save(body, withReader(rpcAnswer(null)))).code, 'solana_not_usdc_token_account', 'no such account');
  assert.equal((await w.save(body, withReader(rpcAnswer({ ...tokenAccount(), owner: '11111111111111111111111111111111', data: ['', 'base64'] })))).code, 'solana_not_usdc_token_account', 'a wallet, not a token account');
  assert.equal((await w.save(body, withReader(rpcAnswer(tokenAccount({ mint: 'So11111111111111111111111111111111111111112' }))))).code, 'solana_not_usdc_token_account', 'another mint');
  assert.equal((await w.save(body, withReader(rpcAnswer(tokenAccount({ state: 'frozen' }))))).code, 'solana_not_usdc_token_account', 'frozen');
  assert.equal((await w.save(body, withReader(async () => new Response('no', { status: 500 })))).code, 'solana_check_unavailable');
  assert.equal((await w.save(body, { extra: { solana: solanaTokenAccountReaderFromEnv({ NODE_ENV: 'production' }) } })).code, 'solana_check_not_configured', 'production without an RPC refuses');
  assert.equal((await w.save(body)).code, 'solana_check_not_configured', 'no reader at all refuses');
  const ok = await w.save(body, withReader(rpcAnswer(tokenAccount())));
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.recipient.crossChain.tokenAccountOwner, SOL_OWNER, "the token account's owner is recorded");
  await w.client.close();
});

/* 8 ── One EVM transaction, several mints; racing saves ──────────────── */

test('one EVM transaction may carry the mints of two payments', async () => {
  const w = await world();
  const mk = (id, nonce) => ({
    id, orgId: 'acme', paymentRef: sui(id.slice(-2)), destinationChain: 'BASE', destinationDomain: 6, mintRecipient: `0x${'0'.repeat(24)}52908400098527886e0f7030069857d2e4169ee7`,
    amountMinor: 1_000_000n, status: 'awaiting_burn',
  });
  await w.db.insert(schema.crossChainTransfers).values([mk('cct_a1', null), mk('cct_a2', null)]);
  await w.client.exec(`UPDATE cross_chain_transfers SET status = 'burned', burn_digest = id, burned_at = now()`);
  await w.client.exec(`UPDATE cross_chain_transfers SET status = 'attested', message = '0x00', message_nonce = '0x' || repeat(right(id, 2), 32), attestation = '0xa7', attested_at = now()`);
  await w.client.exec(`UPDATE cross_chain_transfers SET status = 'minted', mint_tx_hash = '0x${'de'.repeat(32)}', minted_amount_minor = 1000000, minted_at = now()`);
  const rows = await w.db.select().from(schema.crossChainTransfers);
  assert.deepEqual(rows.map((r) => r.status), ['minted', 'minted']);
  await w.client.close();
});

test('two saves of one Sui address at once leave one recipient', async () => {
  const w = await world();
  const results = await Promise.all([
    w.save({ deliveryKind: 'EXCHANGE', exchange: 'pdax', depositAddress: sui('69') }),
    w.save({ deliveryKind: 'SELF_CUSTODY', address: sui('69') }),
  ]);
  assert.deepEqual(results.map((r) => r.ok).sort(), [false, true]);
  assert.equal((await w.db.select().from(schema.suppliers)).filter((r) => r.walletAddress === sui('69')).length, 1);
  await w.client.close();
});

/* 9 ── Routes ─────────────────────────────────────────────────────────── */

test('removing a recipient and approving one follow the roles', async () => {
  const read = (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8');
  const del = await read('app/api/recipients/[id]/route.ts');
  assert.match(del, /recipientRoute\(request\)/, 'owners and staff, not any member');
  assert.match(del, /route\.authority\.role !== 'OWNER'/, 'a proven wallet or a tagged one only by an owner');
  const proof = await read('app/api/recipients/[id]/ownership-proof/route.ts');
  assert.match(proof, /revealLink: route\.authority\.role === 'OWNER'/, 'the link only to an owner');
  const approve = await read('app/api/recipients/[id]/approval/route.ts');
  assert.match(approve, /recipientRoute\(request\)/);
  assert.match(approve, /approveWalletRecipient\(/);
});
