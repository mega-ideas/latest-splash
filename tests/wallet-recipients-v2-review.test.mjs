/**
 * Review of v2 §4.7 (wallet recipients), the findings that were real.
 *
 * What must hold:
 *   - a cross-chain payment is opened only for a recipient an owner approved
 *     (a staff member's save waits), with the supplier's details, and not at
 *     an address Splash controls, the owner of a Solana token account
 *     included, checked again when the payment is opened;
 *   - Splash's cross-chain addresses that cannot be read (a malformed value;
 *     none at all in production) refuse the recipient, as the Sui ones do;
 *   - the operator outflow monitor's list holds only recipients an owner
 *     approved;
 *   - a signature that could not be checked (the chain was unreadable) does
 *     not use up the supplier's single-use link; one that was checked and is
 *     wrong does;
 *   - a Solana payment waits for a manual relay (its mint is not read), so
 *     it is listed apart from the payments that are stuck;
 *   - the receipt route is limited per person and answers a malformed
 *     reference with 400.
 *
 * PGlite with every migration; nothing reaches a network.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

import { kytProviderFromEnv } from '../lib/compliance/kyt.ts';
import { listApprovedWalletAddressesForStaff } from '../lib/server/repository/recipients.ts';
import { openCrossChainTransfer, sweepCrossChainTransfers } from '../lib/server/cross-chain-transfers.ts';
import { SplashAddressesUnavailable, splashCrossChainAddresses } from '../lib/server/splash-addresses.ts';
import { approveWalletRecipient, createWalletRecipient, requestOwnershipProof, submitOwnershipProof } from '../lib/server/wallet-recipients.ts';

import { migratedDb } from './helpers/store-db.mjs';

const T0 = new Date('2026-10-25T08:00:00Z');
const HOUR = 3_600_000;
const sui = (b) => `0x${b.repeat(32)}`;
const INTENT = sui('a1');
const EVM = '0x52908400098527886E0F7030069857D2E4169EE7';
const supplier = {
  name: 'Dela Cruz',
  legalName: 'Dela Cruz Trading Corp',
  registrationNumber: 'CS201912345',
  country: 'PH',
  addressLine1: '1 Ayala Ave',
  addressCity: 'Makati',
  email: 'ap@delacruz.test',
};
const show = (v) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));

async function world() {
  const { db, client } = await migratedDb();
  await client.exec(`UPDATE organizations SET legal_name = 'Acme Trading Sdn Bhd' WHERE id = 'acme'`);
  await client.exec(`INSERT INTO users (id, email, name) VALUES ('u-owner', 'owner@acme.test', 'Owner'), ('u-owner2', 'owner2@acme.test', 'Owner Two'), ('u-staff', 'staff@acme.test', 'Staff')`);
  const kyt = kytProviderFromEnv({ NODE_ENV: 'test' }, { now: () => T0 });
  const deps = (extra = {}) => ({ db, orgId: 'acme', now: () => T0, kyt, ...extra });
  const save = (body, who = 'OWNER', extra = {}) =>
    createWalletRecipient(deps(extra), { body: { ...supplier, ...body }, requestedBy: who === 'OWNER' ? 'u-owner' : 'u-staff', requestedRole: who });
  return { db, client, deps, save };
}

/* 1 ── A cross-chain payment is opened for an approved recipient only ──── */

test('a payment is not opened for a cross-chain recipient a staff member saved, until an owner approves it', async () => {
  const w = await world();
  const saved = await w.save({ deliveryKind: 'CROSS_CHAIN', chain: 'BASE', address: EVM }, 'STAFF');
  assert.equal(saved.ok, true, show(saved));
  const open = () => openCrossChainTransfer({ db: w.db, orgId: 'acme', now: () => T0 }, { paymentRef: INTENT, recipientId: saved.recipient.id, amountMinor: 1_000_000_000n, maxBridgeFeeMinor: 0n });
  const before = await open();
  assert.deepEqual([before.ok, before.code, before.status], [false, 'recipient_not_approved', 409], show(before));
  assert.equal((await w.client.query('SELECT count(*)::int AS n FROM cross_chain_transfers')).rows[0].n, 0, 'nothing was opened');
  assert.equal((await approveWalletRecipient({ db: w.db, orgId: 'acme', now: () => T0 }, { recipientId: saved.recipient.id, approvedBy: 'u-staff', role: 'STAFF' })).ok, false, 'staff cannot approve');
  assert.equal((await approveWalletRecipient({ db: w.db, orgId: 'acme', now: () => T0 }, { recipientId: saved.recipient.id, approvedBy: 'u-owner', role: 'OWNER' })).ok, true);
  const after = await open();
  assert.deepEqual([after.ok, after.created], [true, true], show(after));
  await w.client.close();
});

test('a payment is not opened for a cross-chain recipient without the supplier’s details', async () => {
  const w = await world();
  const saved = await w.save({ deliveryKind: 'CROSS_CHAIN', chain: 'BASE', address: EVM });
  assert.equal(saved.ok, true, show(saved));
  await w.client.exec(`UPDATE suppliers SET registration_number = '' WHERE id = '${saved.recipient.id}'`);
  const r = await openCrossChainTransfer({ db: w.db, orgId: 'acme', now: () => T0 }, { paymentRef: INTENT, recipientId: saved.recipient.id, amountMinor: 1_000_000_000n, maxBridgeFeeMinor: 0n });
  assert.deepEqual([r.ok, r.code], [false, 'supplier_details_missing'], show(r));
  await w.client.close();
});

test('an address Splash took after the recipient was saved is refused when the payment is opened', async () => {
  const w = await world();
  const saved = await w.save({ deliveryKind: 'CROSS_CHAIN', chain: 'BASE', address: EVM });
  assert.equal(saved.ok, true);
  const env = { NODE_ENV: 'test', FUNDING_CCTP_DEPOSIT_ADDRESSES_JSON: JSON.stringify({ BASE: EVM }) };
  const r = await openCrossChainTransfer({ db: w.db, orgId: 'acme', now: () => T0, env }, { paymentRef: INTENT, recipientId: saved.recipient.id, amountMinor: 1_000_000_000n, maxBridgeFeeMinor: 0n });
  assert.deepEqual([r.ok, r.code], [false, 'splash_controlled_address'], show(r));
  const unreadable = await openCrossChainTransfer({ db: w.db, orgId: 'acme', now: () => T0, env: { NODE_ENV: 'test', FUNDING_CCTP_DEPOSIT_ADDRESSES_JSON: '{bad' } }, { paymentRef: INTENT, recipientId: saved.recipient.id, amountMinor: 1_000_000_000n, maxBridgeFeeMinor: 0n });
  assert.deepEqual([unreadable.ok, unreadable.code], [false, 'splash_addresses_unreadable'], show(unreadable));
  await w.client.close();
});

/* 2 ── Splash's cross-chain addresses fail closed ─────────────────────── */

test("Splash's cross-chain addresses that cannot be read refuse, and none at all in production", async () => {
  assert.throws(() => splashCrossChainAddresses({ NODE_ENV: 'test', FUNDING_CCTP_DEPOSIT_ADDRESSES_JSON: '{bad' }), SplashAddressesUnavailable);
  assert.throws(() => splashCrossChainAddresses({ NODE_ENV: 'production' }, { requireConfigured: true }), SplashAddressesUnavailable);
  assert.deepEqual(splashCrossChainAddresses({ NODE_ENV: 'test' }), [], 'development has none to name');
  assert.deepEqual(splashCrossChainAddresses({ NODE_ENV: 'production', FUNDING_CCTP_DEPOSIT_ADDRESSES_JSON: JSON.stringify({ BASE: EVM }) }, { requireConfigured: true }), [EVM.toLowerCase()]);

  const w = await world();
  const bad = await w.save({ deliveryKind: 'CROSS_CHAIN', chain: 'BASE', address: EVM }, 'OWNER', { splashCrossChain: () => splashCrossChainAddresses({ NODE_ENV: 'test', FUNDING_CCTP_DEPOSIT_ADDRESSES_JSON: '{bad' }) });
  assert.deepEqual([bad.ok, bad.code, bad.status], [false, 'splash_addresses_unreadable', 503], show(bad));
  await w.client.close();
});

test('a Solana token account owned by a Splash wallet is refused', async () => {
  const w = await world();
  const owner = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
  const solana = { async check() { return { ok: true, tokenOwner: owner }; } };
  const r = await w.save({ deliveryKind: 'CROSS_CHAIN', chain: 'SOLANA', address: '4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T', addressIsUsdcTokenAccount: true }, 'OWNER', { solana, splashCrossChain: [owner] });
  assert.deepEqual([r.ok, r.code], [false, 'splash_controlled_address'], show(r));
  await w.client.close();
});

/* 3 ── The operator monitor's list ────────────────────────────────────── */

test('the operator monitor lists only recipients an owner approved, and never a Splash or own address', async () => {
  const w = await world();
  const ex = await w.save({ deliveryKind: 'EXCHANGE', exchange: 'pdax', depositAddress: sui('66') }, 'STAFF');
  const ok = await w.save({ deliveryKind: 'EXCHANGE', exchange: 'pdax', depositAddress: sui('67') }, 'OWNER');
  assert.equal(ex.ok && ok.ok, true, show([ex, ok]));
  const listed = await listApprovedWalletAddressesForStaff(w.db);
  assert.equal(listed.includes(sui('66')), false, 'staff-saved, not yet approved');
  assert.equal(listed.includes(sui('67')), true);
  await w.client.exec(`UPDATE suppliers SET approved_by = 'u-owner2', approved_at = now() WHERE id = '${ex.recipient.id}'`);
  assert.equal((await listApprovedWalletAddressesForStaff(w.db)).includes(sui('66')), true, 'once approved');
  await w.client.close();
});

/* 4 ── A proof link survives an unreadable chain ──────────────────────── */

test('a signature that could not be checked does not use up the link', async () => {
  const w = await world();
  const key = Ed25519Keypair.generate();
  const saved = await w.save({ deliveryKind: 'SELF_CUSTODY', walletLabel: 'SLUSH', address: key.toSuiAddress() });
  assert.equal(saved.ok, true, show(saved));
  const link = await requestOwnershipProof({ ...w.deps(), appUrl: 'https://app.splash.test/', sendEmail: async () => {} }, { recipientId: saved.recipient.id, requestedBy: 'u-owner', revealLink: true });
  assert.equal(link.ok, true, show(link));
  const token = link.link.split('/wallet-proof/')[1];
  const signature = (await key.signPersonalMessage(new TextEncoder().encode(link.message))).signature;
  const down = await submitOwnershipProof({ db: w.db, now: () => T0, verifySignature: async () => { throw new Error('RPC timed out'); } }, { token, signature });
  assert.deepEqual([down.ok, down.status, down.code], [false, 503, 'verification_unavailable'], show(down));
  const { verifyPersonalMessageSignature } = await import('@mysten/sui/verify');
  const verifySignature = async (message, sig, address) => {
    try {
      await verifyPersonalMessageSignature(message, sig, { address });
      return true;
    } catch {
      return false;
    }
  };
  const again = await submitOwnershipProof({ db: w.db, now: () => T0, verifySignature }, { token, signature });
  assert.equal(again.ok, true, `the same link still works: ${show(again)}`);
  // A wrong signature, checked, still uses the link up.
  const second = await requestOwnershipProof({ ...w.deps(), appUrl: 'https://app.splash.test/', sendEmail: async () => {} }, { recipientId: saved.recipient.id, requestedBy: 'u-owner', revealLink: true });
  const wrong = await submitOwnershipProof({ db: w.db, now: () => T0, verifySignature: async () => false }, { token: second.link.split('/wallet-proof/')[1], signature });
  assert.equal(wrong.code, 'bad_signature');
  const reuse = await submitOwnershipProof({ db: w.db, now: () => T0, verifySignature }, { token: second.link.split('/wallet-proof/')[1], signature });
  assert.equal(reuse.code, 'link_used');
  await w.client.close();
});

/* 5 ── Solana payments wait for a manual relay ────────────────────────── */

test('a Solana payment attested for hours is listed for a manual relay, not as stuck', async () => {
  const w = await world();
  const solana = { async check() { return { ok: true, tokenOwner: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM' }; } };
  const sol = await w.save({ deliveryKind: 'CROSS_CHAIN', chain: 'SOLANA', address: '4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T', addressIsUsdcTokenAccount: true }, 'OWNER', { solana });
  const base = await w.save({ deliveryKind: 'CROSS_CHAIN', chain: 'BASE', address: EVM });
  assert.equal(sol.ok && base.ok, true, show([sol, base]));
  const open = (ref, id) => openCrossChainTransfer({ db: w.db, orgId: 'acme', now: () => T0 }, { paymentRef: ref, recipientId: id, amountMinor: 1_000_000_000n, maxBridgeFeeMinor: 0n });
  assert.equal((await open(INTENT, sol.recipient.id)).ok, true);
  assert.equal((await open(sui('a2'), base.recipient.id)).ok, true);
  await w.client.exec(`UPDATE cross_chain_transfers SET status = 'burned', burn_digest = 'burn-' || payment_ref, burned_at = '${T0.toISOString()}'`);
  await w.client.exec(`UPDATE cross_chain_transfers SET status = 'attested', message = '0x00', message_nonce = '0x${'4e'.repeat(32)}', attestation = '0xa77e', attested_at = now() WHERE destination_chain = 'SOLANA'`);
  const iris = { sandbox: false, async messagesForSuiBurn() { return []; } };
  const out = await sweepCrossChainTransfers({ db: w.db, now: () => new Date(T0.getTime() + 7 * HOUR), iris });
  const stuck = out.stuck.map((s) => s.paymentRef);
  assert.deepEqual(stuck, [sui('a2')], 'the Base payment is stuck');
  assert.deepEqual(out.manualRelay?.map((s) => s.paymentRef), [INTENT], 'the attested Solana payment is a manual relay');
  await w.client.close();
});

/* 6 ── The receipt route ──────────────────────────────────────────────── */

test('the receipt route is limited per person and answers a malformed reference with 400', () => {
  const src = readFileSync(new URL('../app/api/wallet/payments/[ref]/cross-chain/route.ts', import.meta.url), 'utf8');
  assert.match(src, /limitWalletRequests\(gate\.route\)/, 'the POST is rate limited');
  assert.match(src, /try\s*\{\s*return decodeURIComponent/, 'a malformed reference is caught');
  assert.equal(/\bdecodeURIComponent\(ref\)/.test(src), false, 'no bare decode');
});
