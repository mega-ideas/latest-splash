/**
 * Wallet recipients (v2 §4.7, D5): exchange accounts, wallets the supplier
 * holds, and USDC on another chain over CCTP V2.
 *
 * What must hold:
 *   - each kind's fields are checked for that kind: the exchange from the
 *     offered list and its deposit on Sui; a Sui address for a wallet, never
 *     an EVM one; a cross-chain address in its own chain's format, written
 *     as CCTP's mint recipient, USDC only; the supplier's business details;
 *   - a recipient is screened before it is saved, a BLOCK never saved, one
 *     address is one recipient, and each business sees its own only;
 *   - a wallet the supplier holds is paid only after the supplier signs the
 *     fixed message (address, supplier, paying business, single-use nonce,
 *     expiry) with that wallet; a link is used once, expires, is replaced
 *     by a newer one, and a signature by any other key proves nothing; the
 *     proof is also the WALLET tag's gate and is withdrawn with it;
 *   - a wallet payment goes only to a proven wallet, an exchange payment
 *     only to a saved exchange account, and neither kind can stand in for
 *     the other; a cross-chain payment is never a payment on Sui;
 *   - the cross-chain receipt records the Sui burn only from this
 *     business's own multisig-signed transaction that confirmed the intent,
 *     Circle's attestation only for a message that mints exactly this
 *     payment, and the mint only from the destination chain's receipt;
 *     once each, forward only; production refuses without Circle's service.
 *
 * PGlite with every migration. Nothing reaches a network; signatures are
 * made with throwaway keys; nothing is signed on a chain.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { eq } from 'drizzle-orm';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { toHex } from '@mysten/sui/utils';
import { verifyPersonalMessageSignature } from '@mysten/sui/verify';

import * as schema from '../lib/db/schema.ts';
import { kytProviderFromEnv } from '../lib/compliance/kyt.ts';
import { decodeMessageV2, MESSAGE_RECEIVED_TOPIC, messageTransmitterV2, readBurn, readEvmMint } from '../lib/payments/cctp-receipts.ts';
import { moveDeliveryOf, ownershipProofMessage, parseWalletRecipient, RecipientInputError } from '../lib/recipients/wallet-recipients.ts';
import {
  CctpUnavailable,
  irisClientFromEnv,
  mintReaderFromEnv,
  openCrossChainTransfer,
  readCrossChainTransfer,
  recordCrossChainBurn,
  recordCrossChainMint,
  refreshCrossChainAttestation,
} from '../lib/server/cross-chain-transfers.ts';
import { dbOwnershipGate } from '../lib/server/ownership-proofs.ts';
import { listRecipients } from '../lib/server/repository/recipients.ts';
import {
  createWalletRecipient,
  readOwnershipChallenge,
  requestOwnershipProof,
  revokeRecipientOwnership,
  submitOwnershipProof,
  walletDeliveryGate,
} from '../lib/server/wallet-recipients.ts';

import { migratedDb } from './helpers/store-db.mjs';

const T0 = new Date('2026-10-25T08:00:00Z');
const HOUR = 3_600_000;
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

async function world() {
  const { db, client } = await migratedDb();
  await client.exec(`UPDATE organizations SET legal_name = 'Acme Trading Sdn Bhd' WHERE id = 'acme'`);
  let now = T0;
  const deps = (orgId = 'acme', kyt = kytProviderFromEnv({ NODE_ENV: 'test' }, { now: () => now })) => ({ db, orgId, now: () => now, kyt });
  return { db, client, deps, setNow: (d) => { now = d; }, now: () => now };
}

/* 1 ── The kinds and their fields ─────────────────────────────────────── */

test("each kind's fields are checked for that kind", () => {
  const bad = (body, code) => {
    assert.throws(() => parseWalletRecipient({ ...supplier, ...body }), (e) => e instanceof RecipientInputError && e.code === code, `${JSON.stringify(body)} → ${code}`);
  };
  bad({ deliveryKind: 'PAYPAL' }, 'bad_delivery_kind');
  bad({ deliveryKind: 'EXCHANGE', exchange: 'binance', depositAddress: sui('66') }, 'bad_exchange');
  bad({ deliveryKind: 'EXCHANGE', exchange: 'pdax', network: 'ETHEREUM', depositAddress: sui('66') }, 'network_unsupported');
  bad({ deliveryKind: 'EXCHANGE', exchange: 'pdax', depositAddress: '0x209693bc6afc0c5328ba36faf03c514ef312287c' }, 'bad_address');
  bad({ deliveryKind: 'EXCHANGE', exchange: 'pdax', depositAddress: sui('00') }, 'bad_address');
  bad({ deliveryKind: 'SELF_CUSTODY', walletLabel: 'PHANTOM', address: sui('77') }, 'bad_wallet_label');
  bad({ deliveryKind: 'SELF_CUSTODY', address: '0x77' }, 'bad_address');
  bad({ deliveryKind: 'SELF_CUSTODY', address: sui('77'), asset: 'USDT' }, 'usdc_only');
  bad({ deliveryKind: 'SELF_CUSTODY', address: sui('77'), legalName: '' }, 'supplier_details_missing');
  bad({ deliveryKind: 'SELF_CUSTODY', address: sui('77'), registrationNumber: undefined }, 'supplier_details_missing');
  bad({ deliveryKind: 'SELF_CUSTODY', address: sui('77'), country: 'Philippines' }, 'bad_country');
  bad({ deliveryKind: 'CROSS_CHAIN', chain: 'SUI', address: sui('77') }, 'wrong_chain');
  bad({ deliveryKind: 'CROSS_CHAIN', chain: 'STELLAR', address: 'G' }, 'chain_unsupported');
  bad({ deliveryKind: 'CROSS_CHAIN', chain: 'BASE', address: sui('77') }, 'bad_address');
  // EIP-55: a mixed-case address with a broken checksum is refused.
  bad({ deliveryKind: 'CROSS_CHAIN', chain: 'BASE', address: '0x52908400098527886E0F7030069857D2E4169EE7'.replace('E7', 'e7') }, 'bad_address');
  bad({ deliveryKind: 'CROSS_CHAIN', chain: 'SOLANA', address: '4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T' }, 'solana_token_account_needed');
  bad({ deliveryKind: 'CROSS_CHAIN', chain: 'BASE', address: '0x52908400098527886E0F7030069857D2E4169EE7', asset: 'USDT' }, 'usdc_only');

  const ex = parseWalletRecipient({ ...supplier, deliveryKind: 'EXCHANGE', exchange: 'PDAX', depositAddress: sui('66') });
  assert.deepEqual([ex.exchange, ex.network, ex.depositAddress], ['pdax', 'SUI', sui('66')]);
  const own = parseWalletRecipient({ ...supplier, deliveryKind: 'SELF_CUSTODY', walletLabel: 'slush', address: sui('77').toUpperCase().replace('0X', '0x') });
  assert.deepEqual([own.walletLabel, own.address], ['SLUSH', sui('77')]);
  const evm = parseWalletRecipient({ ...supplier, deliveryKind: 'CROSS_CHAIN', chain: 'base', address: '0x52908400098527886E0F7030069857D2E4169EE7' });
  assert.deepEqual([evm.chain, evm.domain, evm.address, evm.mintRecipient], ['BASE', 6, '0x52908400098527886e0f7030069857d2e4169ee7', `0x${'0'.repeat(24)}52908400098527886e0f7030069857d2e4169ee7`]);
  const sol = parseWalletRecipient({ ...supplier, deliveryKind: 'CROSS_CHAIN', chain: 'SOLANA', address: '4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T', addressIsUsdcTokenAccount: true });
  assert.deepEqual([sol.domain, sol.mintRecipient.length], [5, 66]);

  // What the Move side is given.
  assert.deepEqual(moveDeliveryOf({ deliveryKind: 'EXCHANGE', walletAddress: sui('66'), exchangeId: 'pdax' }), { kind: 2, recipient: sui('66'), policyTag: 2, exchange: 'pdax', ownersOnly: false });
  assert.deepEqual(moveDeliveryOf({ deliveryKind: 'SELF_CUSTODY', walletAddress: sui('77') }), { kind: 1, recipient: sui('77'), policyTag: 1, ownersOnly: false });
  assert.deepEqual(moveDeliveryOf({ deliveryKind: 'CROSS_CHAIN', destinationChain: 'BASE', destinationDomain: 6, mintRecipient: evm.mintRecipient }), { kind: 3, destinationDomain: 6, mintRecipient: evm.mintRecipient, chain: 'BASE', policyTag: null, ownersOnly: true });
  assert.equal(moveDeliveryOf({ deliveryKind: 'CROSS_CHAIN', destinationChain: 'BASE', destinationDomain: 0, mintRecipient: evm.mintRecipient }), null, 'a domain that is not the chain’s');
});

test('the ownership message names the address, both businesses, the nonce and the expiry', () => {
  const nonce = 'ab'.repeat(32);
  const m = ownershipProofMessage({ address: '0x77', supplierName: 'Dela Cruz\nTrading', payingBusiness: 'Acme', nonce, expiresAt: new Date(T0.getTime() + HOUR) });
  assert.match(m, /^Splash wallet ownership proof\n/);
  for (const part of [`Address: 0x${'0'.repeat(62)}77`, 'Business that holds this wallet: Dela Cruz Trading', 'Business that will pay it: Acme', `Nonce: ${nonce}`, `Expires: ${new Date(T0.getTime() + HOUR).toISOString()}`]) {
    assert.ok(m.includes(part), part);
  }
  assert.throws(() => ownershipProofMessage({ address: '0x77', supplierName: 'x', payingBusiness: 'y', nonce: 'short', expiresAt: T0 }), RecipientInputError);
});

/* 2 ── Saving ─────────────────────────────────────────────────────────── */

test('a recipient is screened before it is saved, a BLOCK is never saved, and each business sees its own', async () => {
  const w = await world();
  const ex = await createWalletRecipient(w.deps(), { body: { ...supplier, deliveryKind: 'EXCHANGE', exchange: 'pdax', depositAddress: sui('66') }, requestedBy: 'u-owner', requestedRole: 'OWNER' });
  assert.equal(ex.ok, true, JSON.stringify(ex));
  assert.deepEqual([ex.recipient.deliveryKind, ex.recipient.exchange.id, ex.recipient.exchange.network, ex.recipient.move.kind, ex.screening.verdict], ['EXCHANGE', 'pdax', 'SUI', 2, 'CLEAR']);
  assert.equal(ex.recipient.supplier.registrationNumber, 'CS201912345');
  const [screened] = await w.db.select().from(schema.kytScreenings);
  assert.deepEqual([screened.orgId, screened.subjectKind, screened.chain, screened.address], ['acme', 'exchange_recipient', 'SUI', sui('66')]);

  // One address, one recipient, whatever the kind.
  const again = await createWalletRecipient(w.deps(), { body: { ...supplier, deliveryKind: 'SELF_CUSTODY', address: sui('66') }, requestedBy: 'u-owner', requestedRole: 'OWNER' });
  assert.deepEqual([again.status, again.code], [409, 'recipient_exists']);
  // Another business may save the same address for itself; neither sees the other's.
  const theirs = await createWalletRecipient(w.deps('northwind'), { body: { ...supplier, deliveryKind: 'EXCHANGE', exchange: 'bitkub', depositAddress: sui('66') }, requestedBy: 'u-nw', requestedRole: 'OWNER' });
  assert.equal(theirs.ok, true);
  assert.deepEqual((await listRecipients(w.db, 'acme')).map((r) => r.delivery.exchangeId), ['pdax']);
  assert.deepEqual((await listRecipients(w.db, 'northwind')).map((r) => r.delivery.exchangeId), ['bitkub']);

  // The sandbox lists an address ending in dead: refused, and nothing saved.
  const dead = `0x${'55'.repeat(30)}dead`;
  const blocked = await createWalletRecipient(w.deps(), { body: { ...supplier, deliveryKind: 'SELF_CUSTODY', address: dead }, requestedBy: 'u-owner', requestedRole: 'OWNER' });
  assert.deepEqual([blocked.status, blocked.code], [403, 'recipient_blocked']);
  assert.equal((await listRecipients(w.db, 'acme')).some((r) => r.walletAddress === dead), false);

  // A cross-chain recipient: USDC over CCTP, its mint recipient kept, once per business.
  const cc = await createWalletRecipient(w.deps(), { body: { ...supplier, deliveryKind: 'CROSS_CHAIN', chain: 'BASE', address: '0x52908400098527886E0F7030069857D2E4169EE7' }, requestedBy: 'u-owner', requestedRole: 'OWNER' });
  assert.equal(cc.ok, true, JSON.stringify(cc));
  assert.deepEqual([cc.recipient.crossChain.chain, cc.recipient.crossChain.domain, cc.recipient.crossChain.asset, cc.recipient.move.ownersOnly, cc.recipient.move.policyTag], ['BASE', 6, 'USDC', true, null]);
  const [ccScreen] = (await w.db.select().from(schema.kytScreenings)).filter((r) => r.chain === 'BASE');
  assert.deepEqual([ccScreen.subjectKind, ccScreen.address], ['cross_chain_recipient', '0x52908400098527886e0f7030069857d2e4169ee7']);
  assert.equal((await createWalletRecipient(w.deps(), { body: { ...supplier, deliveryKind: 'CROSS_CHAIN', chain: 'BASE', address: '0x52908400098527886E0F7030069857D2E4169EE7' }, requestedBy: 'u-owner', requestedRole: 'OWNER' })).code, 'recipient_exists');
  await w.client.close();
});

test('in production with no screening provider a recipient is saved unscreened and cannot be paid', async () => {
  const w = await world();
  const kyt = kytProviderFromEnv({ NODE_ENV: 'production' });
  const r = await createWalletRecipient(w.deps('acme', kyt), { body: { ...supplier, deliveryKind: 'EXCHANGE', exchange: 'hata', depositAddress: sui('68') }, requestedBy: 'u-owner', requestedRole: 'OWNER' });
  assert.equal(r.ok, true);
  assert.deepEqual([r.screening.verdict, r.screening.provider], [null, 'none'], 'no verdict is made up');
  const { recipientScreeningGate } = await import('../lib/server/kyt-screenings.ts');
  assert.equal((await recipientScreeningGate({ db: w.db, orgId: 'acme', now: T0, requestedBy: 'u' }, sui('68'))).code, 'recipient_not_screened');
  await w.client.close();
});

test('the table keeps each kind to its own fields, and refuses a NULL that would slip a check', async () => {
  const w = await world();
  const insert = (values) => w.db.insert(schema.suppliers).values({ id: `s_${randomUUID()}`, orgId: 'acme', name: 'x', country: 'PH', ...values });
  const check = (e) => /check constraint/i.test(`${e?.message} ${e?.cause?.message}`);
  await assert.rejects(() => insert({ payoutMethod: 'WALLET', walletAddress: sui('61'), deliveryKind: 'EXCHANGE', depositNetwork: 'SUI' }), check, 'an exchange account without its exchange');
  await assert.rejects(() => insert({ payoutMethod: 'WALLET', walletAddress: sui('61'), deliveryKind: 'EXCHANGE', exchangeId: 'binance', depositNetwork: 'SUI' }), check);
  await assert.rejects(() => insert({ payoutMethod: 'WALLET', walletAddress: sui('61'), walletProvider: 'SLUSH', deliveryKind: 'SELF_CUSTODY' }), check, 'a wallet without its proof state');
  await assert.rejects(() => insert({ payoutMethod: 'WALLET', walletAddress: sui('61'), walletProvider: 'PHANTOM', deliveryKind: 'SELF_CUSTODY', ownershipStatus: 'unproven' }), check, 'Phantom ended Sui support');
  await assert.rejects(() => insert({ payoutMethod: 'CROSS_CHAIN', deliveryKind: 'CROSS_CHAIN', destinationChain: 'BASE', destinationDomain: 6, destinationAddress: '0xab' }), check, 'no mint recipient');
  await assert.rejects(() => insert({ payoutMethod: 'CROSS_CHAIN', deliveryKind: 'BANK' }), check);
  await assert.rejects(() => insert({ payoutMethod: 'BANK', deliveryKind: 'BANK', exchangeId: 'pdax' }), check);
  await insert({ payoutMethod: 'WALLET', walletAddress: sui('61'), deliveryKind: 'EXCHANGE', exchangeId: 'pdax', depositNetwork: 'SUI' });
  await w.client.close();
});

/* 3 ── The ownership proof ─────────────────────────────────────────────── */

const verifySignature = async (message, signature, address) => {
  try {
    await verifyPersonalMessageSignature(message, signature, { address });
    return true;
  } catch {
    return false;
  }
};

async function selfCustody(w, keypair, orgId = 'acme') {
  const r = await createWalletRecipient(w.deps(orgId), { body: { ...supplier, deliveryKind: 'SELF_CUSTODY', walletLabel: 'SLUSH', address: keypair.toSuiAddress() }, requestedBy: 'u-owner', requestedRole: 'OWNER' });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.recipient.id;
}

const proofDeps = (w, orgId = 'acme', sent = []) => ({ ...w.deps(orgId), appUrl: 'https://app.splash.test/', sendEmail: async (m) => { sent.push(m); } });
const tokenOf = (link) => link.split('/wallet-proof/')[1];
const sign = async (keypair, message) => (await keypair.signPersonalMessage(new TextEncoder().encode(message))).signature;

test('a wallet the supplier holds is paid only after it signs the fixed message with that wallet, once', async () => {
  const w = await world();
  const key = Ed25519Keypair.generate();
  const id = await selfCustody(w, key);
  const address = key.toSuiAddress();
  assert.deepEqual(await walletDeliveryGate(w.db, 'acme', address, 1), { status: 409, code: 'ownership_not_proven', error: 'The supplier has not proven it holds this wallet yet. Send the ownership link and wait for the signature.' });

  const sent = [];
  const link = await requestOwnershipProof(proofDeps(w, 'acme', sent), { recipientId: id, requestedBy: 'u-owner', revealLink: true });
  assert.equal(link.ok, true, JSON.stringify(link));
  assert.match(link.link, /^https:\/\/app\.splash\.test\/wallet-proof\/[A-Za-z0-9_-]{43}$/);
  assert.equal(new Date(link.expiresAt).getTime(), T0.getTime() + 72 * HOUR);
  assert.ok(link.message.includes(`Address: ${address}`) && link.message.includes('Business that will pay it: Acme Trading Sdn Bhd') && link.message.includes('Business that holds this wallet: Dela Cruz Trading Corp'));
  assert.deepEqual([sent.length, sent[0].to, sent[0].link, link.emailedTo], [1, 'ap@delacruz.test', link.link, 'ap@delacruz.test']);
  // The token is not kept, only its hash.
  const [row] = await w.db.select().from(schema.recipientOwnershipChallenges);
  const token = tokenOf(link.link);
  assert.equal(row.tokenSha256, createHash('sha256').update(token).digest('hex'));
  assert.equal(JSON.stringify(row).includes(token), false);

  const page = await readOwnershipChallenge(w.db, token, T0);
  assert.deepEqual([page.state, page.address, page.message], ['open', address, link.message]);

  // Another key's signature proves nothing, and uses the link up.
  const stranger = Ed25519Keypair.generate();
  const wrong = await submitOwnershipProof({ db: w.db, now: () => T0, verifySignature }, { token, signature: await sign(stranger, link.message) });
  assert.deepEqual([wrong.status, wrong.code], [400, 'bad_signature']);
  const reuse = await submitOwnershipProof({ db: w.db, now: () => T0, verifySignature }, { token, signature: await sign(key, link.message) });
  assert.deepEqual([reuse.status, reuse.code], [409, 'link_used']);
  assert.equal((await readOwnershipChallenge(w.db, token, T0)).state, 'used');

  // A new link; the old one cannot be used; a signature of another message proves nothing.
  const second = await requestOwnershipProof(proofDeps(w), { recipientId: id, requestedBy: 'u-owner', revealLink: true });
  const third = await requestOwnershipProof(proofDeps(w), { recipientId: id, requestedBy: 'u-owner', revealLink: true });
  assert.equal((await submitOwnershipProof({ db: w.db, now: () => T0, verifySignature }, { token: tokenOf(second.link), signature: await sign(key, second.message) })).code, 'link_used', 'replaced by a newer link');
  assert.equal((await submitOwnershipProof({ db: w.db, now: () => T0, verifySignature }, { token: tokenOf(third.link), signature: await sign(key, second.message) })).code, 'bad_signature', "a signature of another link's message");

  // Expired.
  const fourth = await requestOwnershipProof(proofDeps(w), { recipientId: id, requestedBy: 'u-owner', revealLink: true });
  const late = await submitOwnershipProof({ db: w.db, now: () => new Date(T0.getTime() + 73 * HOUR), verifySignature }, { token: tokenOf(fourth.link), signature: await sign(key, fourth.message) });
  assert.deepEqual([late.status, late.code], [410, 'link_expired']);

  // The wallet's own signature of the current message.
  const fifth = await requestOwnershipProof(proofDeps(w), { recipientId: id, requestedBy: 'u-owner', revealLink: true });
  const ok = await submitOwnershipProof({ db: w.db, now: () => T0, verifySignature }, { token: tokenOf(fifth.link), signature: await sign(key, fifth.message) });
  assert.deepEqual([ok.ok, ok.address], [true, address]);
  assert.equal(await walletDeliveryGate(w.db, 'acme', address, 1), null);
  assert.deepEqual(await dbOwnershipGate(w.db).provenAddresses('acme', [address]), [address], 'the WALLET tag may now be given');
  assert.deepEqual(await dbOwnershipGate(w.db).provenAddresses('northwind', [address]), [], "not another business's");
  assert.equal((await requestOwnershipProof(proofDeps(w), { recipientId: id, requestedBy: 'u-owner', revealLink: true })).code, 'already_proven');
  // Each nonce once, for ever.
  const nonces = (await w.db.select().from(schema.recipientOwnershipChallenges)).map((r) => r.nonce);
  assert.equal(new Set(nonces).size, nonces.length);

  // Withdrawn: no payment until proven again.
  assert.deepEqual(await revokeRecipientOwnership({ db: w.db, orgId: 'acme', now: () => T0 }, { recipientId: id }), { ok: true });
  assert.equal((await walletDeliveryGate(w.db, 'acme', address, 1)).code, 'ownership_not_proven');
  assert.deepEqual(await dbOwnershipGate(w.db).provenAddresses('acme', [address]), []);
  await w.client.close();
});

test("one business cannot ask for, read or withdraw another's proof, and a link names no business id", async () => {
  const w = await world();
  const key = Ed25519Keypair.generate();
  const id = await selfCustody(w, key);
  assert.equal((await requestOwnershipProof(proofDeps(w, 'northwind'), { recipientId: id, requestedBy: 'u-nw', revealLink: true })).code, 'not_found');
  assert.equal((await revokeRecipientOwnership({ db: w.db, orgId: 'northwind', now: () => T0 }, { recipientId: id })).code, 'not_found');
  const link = await requestOwnershipProof(proofDeps(w), { recipientId: id, requestedBy: 'u-owner', revealLink: true });
  const page = await readOwnershipChallenge(w.db, tokenOf(link.link), T0);
  assert.deepEqual(Object.keys(page).sort(), ['address', 'expiresAt', 'message', 'ok', 'state']);
  assert.equal((await readOwnershipChallenge(w.db, 'A'.repeat(43), T0)).code, 'not_found');
  assert.equal((await submitOwnershipProof({ db: w.db, now: () => T0, verifySignature }, { token: '../etc', signature: 'x' })).code, 'not_found');
  // An exchange account needs no proof link.
  const ex = await createWalletRecipient(w.deps(), { body: { ...supplier, deliveryKind: 'EXCHANGE', exchange: 'pdax', depositAddress: sui('66') }, requestedBy: 'u-owner', requestedRole: 'OWNER' });
  assert.equal((await requestOwnershipProof(proofDeps(w), { recipientId: ex.recipient.id, requestedBy: 'u-owner', revealLink: true })).code, 'not_self_custody');
  await w.client.close();
});

test('a proof is not recorded for a recipient whose address changed after the link was made', async () => {
  const w = await world();
  const key = Ed25519Keypair.generate();
  const id = await selfCustody(w, key);
  const link = await requestOwnershipProof(proofDeps(w), { recipientId: id, requestedBy: 'u-owner', revealLink: true });
  await w.db.update(schema.suppliers).set({ walletAddress: sui('7a') }).where(eq(schema.suppliers.id, id));
  const r = await submitOwnershipProof({ db: w.db, now: () => T0, verifySignature }, { token: tokenOf(link.link), signature: await sign(key, link.message) });
  assert.equal(r.code, 'recipient_changed');
  assert.equal((await w.db.select().from(schema.walletOwnershipProofs)).length, 0);
  await w.client.close();
});

/* 4 ── The gate a payment passes ──────────────────────────────────────── */

test('a wallet payment goes only to a proven wallet, an exchange payment only to a saved exchange account', async () => {
  const w = await world();
  const key = Ed25519Keypair.generate();
  await selfCustody(w, key);
  const wallet = key.toSuiAddress();
  await createWalletRecipient(w.deps(), { body: { ...supplier, deliveryKind: 'EXCHANGE', exchange: 'pdax', depositAddress: sui('66') }, requestedBy: 'u-owner', requestedRole: 'OWNER' });
  const gate = (address, kind, orgId = 'acme') => walletDeliveryGate(w.db, orgId, address, kind);
  // Opened, yes (its Travel Rule message is sent from the payment); signed only once the exchange confirmed the account.
  assert.equal(await walletDeliveryGate(w.db, 'acme', sui('66'), 2, { stage: 'open' }), null);
  assert.equal((await gate(sui('66'), 2)).code, 'exchange_unconfirmed');
  assert.equal((await gate(sui('66'), 1)).code, 'kind_mismatch', 'an exchange account sent as a wallet payment');
  assert.equal((await gate(wallet, 2)).code, 'kind_mismatch', 'a wallet sent as an exchange payment');
  assert.equal((await gate(wallet, 1)).code, 'ownership_not_proven');
  assert.equal((await gate(sui('69'), 1)).code, 'recipient_not_saved');
  assert.equal((await gate(sui('66'), 2, 'northwind')).code, 'recipient_not_saved', "another business's recipient");
  assert.equal((await gate(sui('66'), 3)).code, 'wrong_pay_path', 'cross-chain is never a payment on Sui');
  assert.equal((await gate(sui('66'), null)).code, 'bad_kind');
  assert.equal(await gate(sui('66'), 0), null, 'a business wallet: the chain checks it');
  assert.equal(await gate(sui('66'), 4), null, 'a bank payout: the payout route checks it');
  await w.client.close();
});

test('a cross-chain payment is the owners’ multisig path only', async () => {
  const [spend, asks, move, builders] = await Promise.all([
    readFile(new URL('../lib/server/spend-rules.ts', import.meta.url), 'utf8'),
    readFile(new URL('../lib/server/payment-approval-asks.ts', import.meta.url), 'utf8'),
    readFile(new URL('../move/splash_spend/sources/splash_spend.move', import.meta.url), 'utf8'),
    readFile(new URL('../lib/server/sui-v2-builders.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(spend, /intent\.kind === V2_KIND\.CROSS_CHAIN\) return refuse\(400, 'wrong_pay_path'/, 'a rule payment refuses it');
  assert.match(asks, /kind === V2_KIND\.CROSS_CHAIN\) return fail\(400, 'cross_chain_not_built'/, 'a staff ask refuses it');
  assert.equal((move.match(/kind_cross_chain\(\), E_WRONG_PAY_PATH/g) ?? []).length, 3, 'splash_spend refuses it on every path');
  assert.match(builders, /cross_chain_not_built/, 'no PTB is built until a bridge adapter is registered');
});

/* 5 ── The cross-chain receipt ────────────────────────────────────────── */

const MINT_RECIPIENT = `0x${'0'.repeat(24)}52908400098527886e0f7030069857d2e4169ee7`;
const NONCE = `0x${'4e'.repeat(32)}`;
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const u32 = (n) => n.toString(16).padStart(8, '0');
function cctpMessage({ source = 8, dest = 6, nonce = NONCE, mintRecipient = MINT_RECIPIENT, amount = 1_000_000_000n, maxFee = 0n, fee = 0n, caller = '0'.repeat(64) } = {}) {
  const body = u32(1) + '11'.repeat(32) + mintRecipient.slice(2) + word(amount) + '22'.repeat(32) + word(maxFee) + word(fee) + word(0);
  return `0x${u32(1)}${u32(source)}${u32(dest)}${nonce.slice(2)}${'33'.repeat(32)}${'44'.repeat(32)}${caller}${u32(2000)}${u32(2000)}${body}`;
}

test('Circle’s message is this payment’s only if it mints exactly this payment', () => {
  const msg = decodeMessageV2(cctpMessage());
  assert.deepEqual([msg.sourceDomain, msg.destinationDomain, msg.nonce, msg.minFinalityThreshold], [8, 6, NONCE, 2000]);
  const expected = { destinationDomain: 6, mintRecipient: MINT_RECIPIENT, amountMinor: 1_000_000_000n, maxBridgeFeeMinor: 0n };
  const complete = (o) => [{ message: cctpMessage(o), attestation: '0xa77e', status: 'complete' }];
  assert.deepEqual(readBurn([{ message: '0x', attestation: 'PENDING', status: 'pending_confirmations' }], expected), { state: 'pending' });
  const ok = readBurn(complete(), expected);
  assert.deepEqual([ok.state, ok.nonce, ok.attestation, ok.mintsMinor], ['complete', NONCE, '0xa77e', 1_000_000_000n]);
  assert.equal(readBurn(complete({ amount: 999n }), expected).state, 'mismatch');
  assert.equal(readBurn(complete({ dest: 0 }), expected).state, 'mismatch');
  assert.equal(readBurn(complete({ source: 0 }), expected).state, 'mismatch');
  assert.equal(readBurn(complete({ maxFee: 5n }), expected).state, 'mismatch');
  assert.equal(readBurn(complete({ caller: 'ab'.repeat(32) }), expected).state, 'mismatch');
  assert.equal(readBurn(complete({ nonce: `0x${'0'.repeat(64)}` }), expected).state, 'mismatch');
  assert.equal(readBurn(complete({ mintRecipient: `0x${'9'.repeat(64)}` }), expected).state, 'mismatch', 'no message to this recipient');
  assert.equal(decodeMessageV2('0x1234'), null);
});

function mintReceipt({ transmitter = messageTransmitterV2('BASE', 'mainnet'), nonce = NONCE, source = 8, status = '0x1', message = cctpMessage() } = {}) {
  const body = decodeMessageV2(message).body;
  const data = `0x${word(source)}${'33'.repeat(32)}${word(96)}${word(body.length)}${toHex(body).padEnd(Math.ceil(body.length / 32) * 64, '0')}`;
  return { status, logs: [{ address: transmitter, topics: [MESSAGE_RECEIVED_TOPIC, `0x${'0'.repeat(64)}`, nonce, word(2000)], data }] };
}

test('a mint is believed only from the destination chain’s receipt of Circle’s MessageReceived for this nonce', () => {
  const expected = { transmitter: messageTransmitterV2('BASE', 'mainnet'), nonce: NONCE, message: cctpMessage() };
  assert.deepEqual(readEvmMint(mintReceipt(), expected), { ok: true, mintedMinor: 1_000_000_000n });
  assert.equal(readEvmMint(null, expected).ok, false);
  assert.equal(readEvmMint(mintReceipt({ status: '0x0' }), expected).ok, false);
  assert.equal(readEvmMint(mintReceipt({ transmitter: `0x${'12'.repeat(20)}` }), expected).ok, false, 'not Circle’s contract');
  assert.equal(readEvmMint(mintReceipt({ nonce: `0x${'5e'.repeat(32)}` }), expected).ok, false, 'another message');
  assert.equal(readEvmMint(mintReceipt({ source: 0 }), expected).ok, false, 'not from Sui');
  assert.equal(readEvmMint(mintReceipt({ message: cctpMessage({ amount: 5n }) }), expected).ok, false, 'another body');
  assert.equal(messageTransmitterV2('BASE', 'testnet'), '0xe737e5cebeeba77efe34d4aa090756590b1ce275');
  assert.equal(messageTransmitterV2('EDGE', 'mainnet'), '0x5b61381fc9e58e70efc13a4a97516997019198ee');
});

const CORE = sui('c0');
const INTENT = sui('a1');
const WALLET = sui('b2');
const BURN = 'Fq3nXdigest1111111111111111111111111111111';

async function crossChainWorld() {
  const w = await world();
  await w.client.exec(`INSERT INTO users (id, email, name) VALUES ('u-owner', 'owner@acme.test', 'Owner')`);
  const cc = await createWalletRecipient(w.deps(), { body: { ...supplier, deliveryKind: 'CROSS_CHAIN', chain: 'BASE', address: '0x52908400098527886E0F7030069857D2E4169EE7' }, requestedBy: 'u-owner', requestedRole: 'OWNER' });
  const self = Ed25519Keypair.generate();
  const own = await selfCustody(w, self);
  const request = async ({ orgId = 'acme', signerKind = 'multisig', digest = BURN, status = 'executed' } = {}) => {
    const id = `wsr_${randomUUID()}`;
    await w.db.insert(schema.walletSigningRequests).values({
      id, orgId, purpose: 'wallet_payment', dedupeKey: id, senderAddress: WALLET, signerKind, multisigPublicKey: signerKind === 'multisig' ? 'msig-pk' : null, threshold: signerKind === 'multisig' ? 2 : 1, gasMode: 'sponsored',
      txBytes: 'AAAA', txDigest: `digest-${id}`, bytesHash: 'h'.repeat(64), summary: {}, status, requestedBy: 'u-owner', expiresAt: new Date(T0.getTime() + HOUR), executedDigest: digest, createdAt: T0,
    });
  };
  const tx = (o = {}) => ({ success: true, sender: WALLET, events: [{ eventType: `${CORE}::payment_intent::IntentConfirmed`, json: { intent_id: INTENT } }], ...o });
  const burnDeps = (readTransaction = async () => tx(), orgId = 'acme') => ({ db: w.db, orgId, now: () => T0, readTransaction, corePackageOriginalId: CORE });
  return { ...w, recipientId: cc.recipient.id, selfCustodyId: own, request, tx, burnDeps };
}

test('the receipt is opened once per payment for a saved cross-chain recipient of this business', async () => {
  const w = await crossChainWorld();
  const base = { db: w.db, orgId: 'acme', now: () => T0 };
  const open = (o = {}) => openCrossChainTransfer({ ...base, ...(o.orgId ? { orgId: o.orgId } : {}) }, { paymentRef: INTENT, recipientId: w.recipientId, amountMinor: 1_000_000_000n, maxBridgeFeeMinor: 0n, ...o });
  const first = await open();
  assert.deepEqual([first.ok, first.created, first.transfer.status, first.transfer.mintRecipient, first.transfer.destinationDomain], [true, true, 'awaiting_burn', MINT_RECIPIENT, 6]);
  const again = await open();
  assert.deepEqual([again.ok, again.created, again.transfer.id], [true, false, first.transfer.id], 'a retry answers the same receipt');
  assert.equal((await open({ amountMinor: 2n })).code, 'cross_chain_conflict');
  assert.equal((await open({ orgId: 'northwind' })).code, 'not_found', "another business's recipient");
  assert.equal((await open({ recipientId: w.selfCustodyId, paymentRef: sui('a2') })).code, 'not_cross_chain');
  assert.equal((await open({ paymentRef: sui('a3'), maxBridgeFeeMinor: 1_000_000_000n })).code, 'bad_fee');
  assert.equal(await readCrossChainTransfer(w.db, 'northwind', INTENT), null);
  await w.client.close();
});

test('the burn is recorded only from this business’s own multisig transaction that confirmed the intent', async () => {
  const w = await crossChainWorld();
  await openCrossChainTransfer({ db: w.db, orgId: 'acme', now: () => T0 }, { paymentRef: INTENT, recipientId: w.recipientId, amountMinor: 1_000_000_000n, maxBridgeFeeMinor: 0n });
  const burn = (deps, digest = BURN) => recordCrossChainBurn(deps, { paymentRef: INTENT, burnDigest: digest });
  assert.equal((await burn(w.burnDeps())).code, 'not_this_business', 'no request of this business has that digest');
  await w.request({ orgId: 'northwind' });
  assert.equal((await burn(w.burnDeps())).code, 'not_this_business', "another business's request");
  await w.request({ signerKind: 'single', digest: 'Fq3nXdigest2222222222222222222222222222222' });
  assert.equal((await burn(w.burnDeps(), 'Fq3nXdigest2222222222222222222222222222222')).code, 'not_this_business', 'a single passkey (a rule payment) is not the owners’ multisig');
  await w.request();
  assert.equal((await burn(w.burnDeps(async () => null))).code, 'no_such_transaction');
  assert.equal((await burn(w.burnDeps(async () => w.tx({ success: false })))).code, 'burn_failed');
  assert.equal((await burn(w.burnDeps(async () => w.tx({ sender: sui('b3') })))).code, 'not_this_business');
  assert.equal((await burn(w.burnDeps(async () => w.tx({ events: [{ eventType: `${sui('c1')}::payment_intent::IntentConfirmed`, json: { intent_id: INTENT } }] })))).code, 'not_this_payment', 'an event from another package');
  assert.equal((await burn(w.burnDeps(async () => w.tx({ events: [{ eventType: `${CORE}::payment_intent::IntentConfirmed`, json: { intent_id: sui('a9') } }] })))).code, 'not_this_payment');
  assert.equal((await burn(w.burnDeps(), 'not a digest')).code, 'bad_digest');
  const ok = await burn(w.burnDeps());
  assert.deepEqual([ok.ok, ok.transfer.status, ok.transfer.burnDigest], [true, 'burned', BURN]);
  assert.equal((await burn(w.burnDeps())).ok, true, 'the same burn again is the same answer');
  assert.equal((await burn(w.burnDeps(), 'Fq3nXdigest2222222222222222222222222222222')).code, 'burn_recorded', 'never replaced');
  assert.equal((await burn(w.burnDeps(undefined, 'northwind'))).code, 'not_found');
  await w.client.close();
});

test('the attestation and the mint are recorded once each, forward only, from their own sources', async () => {
  const w = await crossChainWorld();
  const base = { db: w.db, orgId: 'acme', now: () => T0 };
  await openCrossChainTransfer(base, { paymentRef: INTENT, recipientId: w.recipientId, amountMinor: 1_000_000_000n, maxBridgeFeeMinor: 0n });
  let answer = [{ message: '0x', attestation: 'PENDING', status: 'pending_confirmations' }];
  const asked = [];
  const iris = { sandbox: false, async messagesForSuiBurn(d) { asked.push(d); return answer; } };
  assert.equal((await refreshCrossChainAttestation({ ...base, iris }, { paymentRef: INTENT })).code, 'not_burned');
  await w.request();
  await recordCrossChainBurn(w.burnDeps(), { paymentRef: INTENT, burnDigest: BURN });
  const pending = await refreshCrossChainAttestation({ ...base, iris }, { paymentRef: INTENT });
  assert.deepEqual([pending.ok, pending.pending, pending.transfer.status, asked], [true, true, 'burned', [BURN]]);
  answer = [{ message: cctpMessage({ amount: 7n }), attestation: '0xa77e', status: 'complete' }];
  assert.equal((await refreshCrossChainAttestation({ ...base, iris }, { paymentRef: INTENT })).code, 'burn_mismatch');
  answer = [{ message: cctpMessage(), attestation: '0xa77e', status: 'complete' }];
  const attested = await refreshCrossChainAttestation({ ...base, iris }, { paymentRef: INTENT });
  assert.deepEqual([attested.transfer.status, attested.transfer.messageNonce, attested.transfer.attestation], ['attested', NONCE, '0xa77e']);

  const reader = (receipt) => ({ async receipt() { return { blockNumber: '0x64', ...receipt }; }, async finalizedBlock() { return 100n; } });
  const mint = (mints, hash = `0x${'de'.repeat(32)}`) => recordCrossChainMint({ ...base, mints, network: 'mainnet' }, { paymentRef: INTENT, mintTxHash: hash });
  assert.equal((await mint(reader(mintReceipt()), 'nope')).code, 'bad_tx_hash');
  assert.equal((await mint(reader(mintReceipt({ nonce: `0x${'5e'.repeat(32)}` })))).code, 'not_the_mint');
  assert.equal((await mint(reader(mintReceipt({ transmitter: messageTransmitterV2('BASE', 'testnet') })))).code, 'not_the_mint', 'a testnet contract on mainnet');
  assert.equal((await mint(mintReaderFromEnv({}))).code, 'mint_check_not_configured', 'no RPC: nothing is recorded');
  const minted = await mint(reader(mintReceipt()));
  assert.deepEqual([minted.ok, minted.transfer.status, minted.transfer.mintTxHash, minted.transfer.mintedAmountMinor], [true, 'minted', `0x${'de'.repeat(32)}`, 1_000_000_000n]);
  assert.equal((await mint(reader(mintReceipt()))).ok, true, 'the same mint again');
  assert.equal((await mint(reader(mintReceipt()), `0x${'df'.repeat(32)}`)).code, 'mint_recorded');

  // The table refuses a step back, a replaced burn, and a delete.
  await assert.rejects(() => w.client.exec(`UPDATE cross_chain_transfers SET status = 'burned', attestation = NULL, mint_tx_hash = NULL, minted_at = NULL`), /forward only|check/i);
  await assert.rejects(() => w.client.exec(`UPDATE cross_chain_transfers SET burn_digest = 'other'`), /never replaced/);
  await assert.rejects(() => w.client.exec(`DELETE FROM cross_chain_transfers`), /keeps every receipt/);
  const [row] = await w.db.select().from(schema.crossChainTransfers);
  assert.equal(row.status, 'minted');
  await w.client.close();
});

test('a Solana mint is not read yet, so its payment stays attested', async () => {
  const w = await world();
  const solana = { async check() { return { ok: true, tokenOwner: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM' }; } };
  const cc = await createWalletRecipient({ ...w.deps(), solana }, { body: { ...supplier, deliveryKind: 'CROSS_CHAIN', chain: 'SOLANA', address: '4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T', addressIsUsdcTokenAccount: true }, requestedBy: 'u-owner', requestedRole: 'OWNER' });
  assert.equal(cc.ok, true, JSON.stringify(cc));
  const base = { db: w.db, orgId: 'acme', now: () => T0 };
  const opened = await openCrossChainTransfer(base, { paymentRef: INTENT, recipientId: cc.recipient.id, amountMinor: 1_000_000_000n, maxBridgeFeeMinor: 0n });
  await w.client.exec(`UPDATE cross_chain_transfers SET status = 'burned', burn_digest = '${BURN}', burned_at = now()`);
  const iris = { sandbox: false, async messagesForSuiBurn() { return [{ message: cctpMessage({ dest: 5, mintRecipient: opened.transfer.mintRecipient }), attestation: '0xa77e', status: 'complete' }]; } };
  assert.equal((await refreshCrossChainAttestation({ ...base, iris }, { paymentRef: INTENT })).transfer.status, 'attested');
  const r = await recordCrossChainMint({ ...base, mints: { async receipt() { throw new Error('not asked'); } }, network: 'mainnet' }, { paymentRef: INTENT, mintTxHash: 'x' });
  assert.deepEqual([r.status, r.code], [501, 'mint_check_not_built']);
  await w.client.close();
});

test("production asks Circle only at its configured service, and never the sandbox", async () => {
  assert.throws(() => irisClientFromEnv({ NODE_ENV: 'production' }), (e) => e instanceof CctpUnavailable && e.code === 'cctp_not_configured');
  assert.throws(() => irisClientFromEnv({ NODE_ENV: 'production', USE_MOCK_APIS: 'true' }), (e) => e instanceof CctpUnavailable, 'mock flags do not bring the sandbox back');
  assert.throws(() => irisClientFromEnv({ NODE_ENV: 'production', CCTP_IRIS_API_URL: 'https://iris-api-sandbox.circle.com/' }), (e) => e instanceof CctpUnavailable);
  const calls = [];
  const fetcher = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ messages: [{ message: '0x', attestation: 'PENDING', status: 'pending_confirmations' }] }), { status: 200 });
  };
  const live = irisClientFromEnv({ NODE_ENV: 'production', CCTP_IRIS_API_URL: 'https://iris-api.circle.com' }, fetcher);
  assert.equal(live.sandbox, false);
  assert.deepEqual(await live.messagesForSuiBurn(BURN), [{ message: '0x', attestation: 'PENDING', status: 'pending_confirmations' }]);
  assert.deepEqual(calls, [`https://iris-api.circle.com/v2/messages/8?transactionHash=${BURN}`]);
  const dev = irisClientFromEnv({ NODE_ENV: 'development' }, fetcher);
  assert.equal(dev.sandbox, true, 'development reads Circle’s own sandbox, labelled');
  const failing = irisClientFromEnv({ NODE_ENV: 'production', CCTP_IRIS_API_URL: 'https://iris-api.circle.com' }, async () => new Response('no', { status: 500 }));
  await assert.rejects(() => failing.messagesForSuiBurn(BURN), CctpUnavailable);
  // A mint RPC must be https and configured per chain.
  await assert.rejects(() => mintReaderFromEnv({ CCTP_MINT_RPC_URLS_JSON: '{"BASE":"http://insecure"}' }).receipt('BASE', `0x${'de'.repeat(32)}`), CctpUnavailable);
});

/* 6 ── The routes ────────────────────────────────────────────────────── */

test('every new route takes the business from the session, and the proof link is the only public one', async () => {
  const read = (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8');
  const deps = await read('lib/server/wallet-recipients-deps.ts');
  assert.match(deps, /requireSessionAccount\(auth\.session\)/);
  assert.match(deps, /orgId: account\.account\.orgId/);
  assert.match(deps, /canAskForWithdrawal\(authority\.role\)/, 'owners and staff, not viewers');
  for (const p of ['app/api/recipients/[id]/ownership-proof/route.ts']) {
    const src = await read(p);
    assert.match(src, /recipientRoute\(request\)/, p);
    assert.doesNotMatch(src, /body\.orgId|searchParams\.get\('orgId'\)/, p);
  }
  const cc = await read('app/api/wallet/payments/[ref]/cross-chain/route.ts');
  assert.match(cc, /walletRoute\(request\)/);
  assert.match(cc, /requirePayoutReader/);
  const pub = await read('app/api/ownership-proofs/[token]/route.ts');
  assert.match(pub, /RATE_LIMITS\.ownershipProofIp/);
  assert.doesNotMatch(pub, /orgId/);
  const recipients = await read('app/api/recipients/route.ts');
  assert.match(recipients, /createWalletRecipient\(walletRecipientDeps\(route\.db, route\.orgId\)/);
  const del = await read('app/api/recipients/[id]/route.ts');
  assert.match(del, /revokeRecipientOwnership/, 'removing a wallet takes its proof with it');
});
