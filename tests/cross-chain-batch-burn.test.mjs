/**
 * Cross-chain receipts when one Sui transaction pays several cross-chain
 * payments (v2 §4.7, D5c; a batch is one multisig signature for one PTB,
 * §5.6), and which of Circle's contracts a mint is checked against.
 *
 * What must hold:
 *   - one owners' transaction that confirmed two intents is the burn of
 *     each of them: both receipts record it, and a digest is still never
 *     the burn of a payment it did not confirm;
 *   - when Circle holds one message per burn in that transaction, each
 *     receipt takes its own message and nonce, never one already another
 *     receipt's; a payment whose own message is not attested yet stays
 *     pending, never a server error;
 *   - payments of different amounts in one transaction each take the
 *     message that mints exactly their amount;
 *   - a mint is checked against Circle's contract on the network the
 *     attestation came from: a production (non-sandbox) attestation only
 *     against the mainnet MessageTransmitterV2, a sandbox one only against
 *     the testnet one, whatever the server's Sui network says.
 *
 * PGlite with every migration; nothing reaches a network.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { toHex } from '@mysten/sui/utils';

import * as schema from '../lib/db/schema.ts';
import { kytProviderFromEnv } from '../lib/compliance/kyt.ts';
import { decodeMessageV2, MESSAGE_RECEIVED_TOPIC, messageTransmitterV2 } from '../lib/payments/cctp-receipts.ts';
import {
  openCrossChainTransfer,
  readCrossChainTransfer,
  recordCrossChainBurn,
  recordCrossChainMint,
  refreshCrossChainAttestation,
  sweepCrossChainTransfers,
} from '../lib/server/cross-chain-transfers.ts';
import { createWalletRecipient } from '../lib/server/wallet-recipients.ts';

import { migratedDb } from './helpers/store-db.mjs';

const T0 = new Date('2026-10-25T08:00:00Z');
const HOUR = 3_600_000;
const sui = (b) => `0x${b.repeat(32)}`;
const CORE = sui('c0');
const WALLET = sui('b2');
const A = sui('a1');
const B = sui('a2');
const C = sui('a3');
const BURN = 'Fq3nXbatch111111111111111111111111111111111';
const MINT_RECIPIENT = `0x${'0'.repeat(24)}52908400098527886e0f7030069857d2e4169ee7`;
const N1 = `0x${'4e'.repeat(32)}`;
const N2 = `0x${'4f'.repeat(32)}`;
const N3 = `0x${'50'.repeat(32)}`;

const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const u32 = (n) => n.toString(16).padStart(8, '0');
function cctpMessage({ nonce, amount = 1_000_000_000n, dest = 6 }) {
  const body = u32(1) + '11'.repeat(32) + MINT_RECIPIENT.slice(2) + word(amount) + '22'.repeat(32) + word(0) + word(0) + word(0);
  return `0x${u32(1)}${u32(8)}${u32(dest)}${nonce.slice(2)}${'33'.repeat(32)}${'44'.repeat(32)}${'0'.repeat(64)}${u32(2000)}${u32(2000)}${body}`;
}
const complete = (o) => ({ message: cctpMessage(o), attestation: `0xa77e${o.nonce.slice(2, 6)}`, status: 'complete' });
function mintReceipt({ transmitter, nonce, message }) {
  const body = decodeMessageV2(message).body;
  const data = `0x${word(8)}${'33'.repeat(32)}${word(96)}${word(body.length)}${toHex(body).padEnd(Math.ceil(body.length / 32) * 64, '0')}`;
  return { status: '0x1', logs: [{ address: transmitter, topics: [MESSAGE_RECEIVED_TOPIC, `0x${'0'.repeat(64)}`, nonce, word(2000)], data }] };
}

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
  await client.exec(`INSERT INTO users (id, email, name) VALUES ('u-owner', 'owner@acme.test', 'Owner')`);
  const kyt = kytProviderFromEnv({ NODE_ENV: 'test' }, { now: () => T0 });
  const cc = await createWalletRecipient({ db, orgId: 'acme', now: () => T0, kyt }, {
    body: { ...supplier, deliveryKind: 'CROSS_CHAIN', chain: 'BASE', address: '0x52908400098527886E0F7030069857D2E4169EE7' },
    requestedBy: 'u-owner',
    requestedRole: 'OWNER',
  });
  assert.equal(cc.ok, true, JSON.stringify(cc));
  const base = { db, orgId: 'acme', now: () => T0 };
  const open = (paymentRef, amountMinor = 1_000_000_000n) => openCrossChainTransfer(base, { paymentRef, recipientId: cc.recipient.id, amountMinor, maxBridgeFeeMinor: 0n });
  // The owners' one multisig transaction that paid the batch.
  const id = `wsr_${randomUUID()}`;
  await db.insert(schema.walletSigningRequests).values({
    id, orgId: 'acme', purpose: 'wallet_payment', dedupeKey: id, senderAddress: WALLET, signerKind: 'multisig', multisigPublicKey: 'msig-pk', threshold: 2, gasMode: 'sponsored',
    txBytes: 'AAAA', txDigest: `digest-${id}`, bytesHash: 'h'.repeat(64), summary: {}, status: 'executed', requestedBy: 'u-owner', expiresAt: new Date(T0.getTime() + HOUR), executedDigest: BURN, createdAt: T0,
  });
  const confirmed = (intents) => async () => ({
    success: true,
    sender: WALLET,
    events: intents.map((intent_id) => ({ eventType: `${CORE}::payment_intent::IntentConfirmed`, json: { intent_id } })),
  });
  const burn = (paymentRef, intents = [A, B]) => recordCrossChainBurn({ ...base, readTransaction: confirmed(intents), corePackageOriginalId: CORE }, { paymentRef, burnDigest: BURN });
  return { db, client, base, open, burn };
}

test('one owners’ transaction that confirmed two intents is the burn of each', async () => {
  const w = await world();
  assert.equal((await w.open(A)).ok, true);
  assert.equal((await w.open(B)).ok, true);
  assert.equal((await w.open(C)).ok, true);
  const a = await w.burn(A);
  assert.deepEqual([a.ok, a.transfer?.status], [true, 'burned'], JSON.stringify(a));
  const b = await w.burn(B);
  assert.deepEqual([b.ok, b.transfer?.status, b.transfer?.burnDigest], [true, 'burned', BURN], JSON.stringify(b));
  const c = await w.burn(C);
  assert.equal(c.code, 'not_this_payment', 'a payment the transaction did not confirm');
  assert.equal((await readCrossChainTransfer(w.db, 'acme', C)).status, 'awaiting_burn');
  await w.client.close();
});

test('each receipt takes its own message of the burn, never another receipt’s', async () => {
  const w = await world();
  await w.open(A);
  await w.open(B);
  await w.burn(A);
  await w.burn(B);
  let answer = [complete({ nonce: N1 }), { message: '0x', attestation: 'PENDING', status: 'pending_confirmations' }];
  const iris = { sandbox: false, async messagesForSuiBurn() { return answer; } };
  const a = await refreshCrossChainAttestation({ ...w.base, iris }, { paymentRef: A });
  assert.deepEqual([a.ok, a.transfer.status, a.transfer.messageNonce], [true, 'attested', N1]);
  const pending = await refreshCrossChainAttestation({ ...w.base, iris }, { paymentRef: B });
  assert.deepEqual([pending.ok, pending.pending, pending.transfer?.status], [true, true, 'burned'], `B's own message is not attested yet: ${JSON.stringify(pending)}`);
  answer = [complete({ nonce: N1 }), complete({ nonce: N2 })];
  const b = await refreshCrossChainAttestation({ ...w.base, iris }, { paymentRef: B });
  assert.deepEqual([b.ok, b.transfer?.status, b.transfer?.messageNonce], [true, 'attested', N2], JSON.stringify(b));
  await w.client.close();
});

test('the sweep attests every payment of one burn, each with its own message', async () => {
  const w = await world();
  await w.open(A);
  await w.open(B);
  await w.burn(A);
  await w.burn(B);
  const iris = { sandbox: false, async messagesForSuiBurn() { return [complete({ nonce: N1 }), complete({ nonce: N2 })]; } };
  const out = await sweepCrossChainTransfers({ db: w.db, now: () => T0, iris });
  assert.deepEqual([out.asked, out.attested, out.errors], [2, 2, 0]);
  const nonces = [(await readCrossChainTransfer(w.db, 'acme', A)).messageNonce, (await readCrossChainTransfer(w.db, 'acme', B)).messageNonce].sort();
  assert.deepEqual(nonces, [N1, N2].sort());
  await w.client.close();
});

test('payments of different amounts in one burn each take the message that mints their amount', async () => {
  const w = await world();
  await w.open(A, 1_000_000_000n);
  await w.open(B, 250_000_000n);
  await w.burn(A);
  await w.burn(B);
  const iris = { sandbox: false, async messagesForSuiBurn() { return [complete({ nonce: N1, amount: 250_000_000n }), complete({ nonce: N2, amount: 1_000_000_000n })]; } };
  const a = await refreshCrossChainAttestation({ ...w.base, iris }, { paymentRef: A });
  const b = await refreshCrossChainAttestation({ ...w.base, iris }, { paymentRef: B });
  assert.deepEqual([a.ok, a.transfer?.messageNonce, a.transfer?.mintedAmountMinor], [true, N2, 1_000_000_000n], JSON.stringify(a));
  assert.deepEqual([b.ok, b.transfer?.messageNonce, b.transfer?.mintedAmountMinor], [true, N1, 250_000_000n], JSON.stringify(b));
  await w.client.close();
});

test('a mint is checked against Circle’s contract on the network its attestation came from', async () => {
  const w = await world();
  await w.open(A);
  await w.open(B);
  await w.burn(A);
  await w.burn(B);
  await refreshCrossChainAttestation({ ...w.base, iris: { sandbox: false, async messagesForSuiBurn() { return [complete({ nonce: N1 })]; } } }, { paymentRef: A });
  await refreshCrossChainAttestation({ ...w.base, iris: { sandbox: true, async messagesForSuiBurn() { return [complete({ nonce: N1 }), complete({ nonce: N3 })]; } } }, { paymentRef: B });
  const reader = (receipt) => ({ async receipt() { return receipt; } });
  const mainnet = messageTransmitterV2('BASE', 'mainnet');
  const testnet = messageTransmitterV2('BASE', 'testnet');
  const mint = (paymentRef, receipt, network, hash) => recordCrossChainMint({ ...w.base, mints: reader(receipt), ...(network ? { network } : {}) }, { paymentRef, mintTxHash: hash });

  // A production attestation: a testnet contract is never its mint, even on a server that says testnet.
  const msgA = cctpMessage({ nonce: N1 });
  assert.equal((await mint(A, mintReceipt({ transmitter: testnet, nonce: N1, message: msgA }), 'testnet', `0x${'d1'.repeat(32)}`)).code, 'not_the_mint');
  const a = await mint(A, mintReceipt({ transmitter: mainnet, nonce: N1, message: msgA }), 'testnet', `0x${'d2'.repeat(32)}`);
  assert.deepEqual([a.ok, a.transfer?.status], [true, 'minted'], JSON.stringify(a));

  // A sandbox attestation: only the testnet contract, even on a server that says mainnet.
  const msgB = cctpMessage({ nonce: N3 });
  assert.equal((await readCrossChainTransfer(w.db, 'acme', B)).messageNonce, N3);
  assert.equal((await mint(B, mintReceipt({ transmitter: mainnet, nonce: N3, message: msgB }), 'mainnet', `0x${'d3'.repeat(32)}`)).code, 'not_the_mint');
  const b = await mint(B, mintReceipt({ transmitter: testnet, nonce: N3, message: msgB }), undefined, `0x${'d4'.repeat(32)}`);
  assert.deepEqual([b.ok, b.transfer?.status], [true, 'minted'], JSON.stringify(b));
  await w.client.close();
});
