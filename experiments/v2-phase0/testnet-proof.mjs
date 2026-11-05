#!/usr/bin/env node
/**
 * v2 Phase 0 gate, checks 2 and 3, on TESTNET ONLY.
 *
 *   node experiments/v2-phase0/testnet-proof.mjs
 *
 * Proves, with real testnet transactions:
 *  - a 2-of-3 Sui multisig whose members are passkey (secp256r1/WebAuthn)
 *    keys signs `0x2::allowance::new` and an app-bound `propose_for_app`, and
 *    an app module accepts the proposal in the same PTB;
 *  - USDC moves into an address balance (`coin::send_funds`), out of one
 *    through a funds-withdrawal input (`balance::redeem_funds`), and out of
 *    one through an app-bound allowance (`app_balance_spend`);
 *  - one passkey signature alone is refused, and spending over the cap aborts.
 *
 * Passkeys here are SOFTWARE WebAuthn authenticators: P-256 keys that answer
 * `navigator.credentials` exactly as a browser authenticator does (DER SPKI on
 * create; authenticator data, client data JSON and a DER signature on get).
 * The chain verifies them as passkey signatures. They are not hardware-bound.
 *
 * Secrets (the funder key and the three passkey keys) live only in
 * ~/splash-testnet-proof-key.json, outside the repository. This script writes
 * addresses, object IDs and digests to testnet-proof-results.json and never
 * prints a secret. It refuses to run against anything but testnet.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { p256 } from '@noble/curves/nist.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { PasskeyKeypair } from '@mysten/sui/keypairs/passkey';
import { MultiSigPublicKey } from '@mysten/sui/multisig';
import { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress, toHex } from '@mysten/sui/utils';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KEY_FILE = path.join(os.homedir(), 'splash-testnet-proof-key.json');
const RESULTS = path.join(HERE, 'testnet-proof-results.json');
const PROBE_DIR = path.join(HERE, 'allowance_probe');
const SUI_CLI = path.join(os.homedir(), '.sui-cli', 'mainnet-v1.82.3', 'sui.exe');

const NETWORK = 'testnet';
const TESTNET_CHAIN = '69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD';
const USDC = '0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC';
const CLOCK = '0x6';
const RP_ID = 'localhost';
const ORIGIN = 'http://localhost:3000';

const client = new SuiGrpcClient({ network: NETWORK, baseUrl: 'https://fullnode.testnet.sui.io:443' });

// ── Secrets and results ──────────────────────────────────────────────────────

const secrets = JSON.parse(readFileSync(KEY_FILE, 'utf8'));
if (secrets.network !== 'testnet') throw new Error('The key file is not a testnet key file. Refusing.');
const funder = Ed25519Keypair.fromSecretKey(secrets.secretKey);
if (funder.toSuiAddress() !== secrets.address) throw new Error('Key file address does not match its key.');

const results = existsSync(RESULTS) ? JSON.parse(readFileSync(RESULTS, 'utf8')) : { network: NETWORK, steps: {} };
const save = () => writeFileSync(RESULTS, `${JSON.stringify(results, null, 2)}\n`);
const log = (...a) => console.log(...a);

// ── Software WebAuthn passkeys ───────────────────────────────────────────────

const SPKI_P256_PREFIX = Uint8Array.from(Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex'));
const b64url = (bytes) => Buffer.from(bytes).toString('base64url');
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

/** A PasskeyProvider backed by one P-256 secret key, answering as a WebAuthn authenticator. */
function softwarePasskeyProvider(secretKeyHex, credentialIdHex) {
  const sk = Uint8Array.from(Buffer.from(secretKeyHex, 'hex'));
  const credentialId = Uint8Array.from(Buffer.from(credentialIdHex, 'hex'));
  const uncompressed = p256.getPublicKey(sk, false);
  const spki = concat(SPKI_P256_PREFIX, uncompressed);
  const rpIdHash = sha256(new TextEncoder().encode(RP_ID));
  let signCount = 0;
  return {
    async create() {
      return { rawId: credentialId.buffer.slice(0), response: { getPublicKey: () => spki.buffer.slice(0) } };
    },
    async get(challenge) {
      signCount += 1;
      const counter = new Uint8Array(4);
      new DataView(counter.buffer).setUint32(0, signCount, false);
      // flags: user present (0x01) | user verified (0x04)
      const authenticatorData = concat(rpIdHash, Uint8Array.of(0x05), counter);
      const clientDataJSON = new TextEncoder().encode(
        JSON.stringify({ type: 'webauthn.get', challenge: b64url(challenge), origin: ORIGIN, crossOrigin: false }),
      );
      const signed = concat(authenticatorData, sha256(clientDataJSON));
      const compact = p256.sign(signed, sk); // ECDSA P-256 over SHA-256(signed), as WebAuthn ES256
      const der = p256.Signature.fromBytes(compact, 'compact').toBytes('der');
      return {
        rawId: credentialId.buffer.slice(0),
        response: {
          authenticatorData: authenticatorData.buffer.slice(0),
          clientDataJSON: clientDataJSON.buffer.slice(0),
          signature: der.buffer.slice(0),
        },
      };
    },
  };
}

async function passkeys() {
  if (!secrets.passkeys) {
    secrets.passkeys = [1, 2, 3].map(() => ({
      secretKeyHex: toHex(p256.utils.randomSecretKey()),
      credentialIdHex: toHex(crypto.getRandomValues(new Uint8Array(16))),
    }));
    writeFileSync(KEY_FILE, JSON.stringify(secrets, null, 2), { mode: 0o600 });
  }
  return Promise.all(
    secrets.passkeys.map((p) => PasskeyKeypair.getPasskeyInstance(softwarePasskeyProvider(p.secretKeyHex, p.credentialIdHex))),
  );
}

// ── Chain helpers ────────────────────────────────────────────────────────────

/**
 * Refuse unless BOTH the client that executes transactions and the GraphQL
 * endpoint used for reads report the testnet chain identifier.
 */
async function assertTestnet() {
  const viaClient = (await client.core.getChainIdentifier()).chainIdentifier;
  if (viaClient !== TESTNET_CHAIN) throw new Error(`Executing client is not on testnet (chain ${viaClient}). Refusing.`);
  const res = await fetch('https://graphql.testnet.sui.io/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: '{ chainIdentifier }' }),
  });
  const id = (await res.json()).data.chainIdentifier;
  if (id !== TESTNET_CHAIN) throw new Error(`Read endpoint is not testnet (chain ${id}). Refusing.`);
}

function resultOf(res) {
  const t = res.$kind === 'Transaction' ? res.Transaction : res.FailedTransaction;
  return t;
}

function created(t, typeIncludes) {
  const types = t.objectTypes ?? {};
  return (t.effects?.changedObjects ?? [])
    .filter((o) => o.idOperation === 'Created')
    .map((o) => ({ id: o.objectId, type: types[o.objectId] ?? '', owner: o.outputOwner }))
    .filter((o) => !typeIncludes || o.type.includes(typeIncludes));
}

async function runAsFunder(label, tx) {
  tx.setSender(funder.toSuiAddress());
  const res = await client.signAndExecuteTransaction({
    signer: funder,
    transaction: tx,
    include: { effects: true, events: true, objectTypes: true, balanceChanges: true },
  });
  const t = resultOf(res);
  if (!t.status.success) throw new Error(`${label} failed: ${t.status.error?.message}. Digest ${t.digest}`);
  await client.waitForTransaction({ digest: t.digest });
  log(`  ✔ ${label}: ${t.digest}`);
  return t;
}

/** Build as the multisig, sign with the given passkeys, combine, execute. */
async function runAsMultisig(label, tx, multisig, signers, { expectFailure = false } = {}) {
  tx.setSender(multisig.toSuiAddress());
  const bytes = await tx.build({ client });
  const partials = [];
  for (const s of signers) partials.push((await s.signTransaction(bytes)).signature);
  const signature = multisig.combinePartialSignatures(partials);
  try {
    const res = await client.executeTransaction({
      transaction: bytes,
      signatures: [signature],
      include: { effects: true, events: true, objectTypes: true, balanceChanges: true },
    });
    const t = resultOf(res);
    if (expectFailure) throw new Error(`${label} was expected to be refused but executed: ${t.digest}`);
    if (!t.status.success) throw new Error(`${label} failed: ${t.status.error?.message}. Digest ${t.digest}`);
    await client.waitForTransaction({ digest: t.digest });
    log(`  ✔ ${label}: ${t.digest}`);
    return t;
  } catch (error) {
    if (expectFailure && !String(error.message).includes('was expected to be refused')) {
      log(`  ✔ ${label}: refused as expected (${String(error.message).slice(0, 160)})`);
      return { refused: String(error.message).slice(0, 400) };
    }
    throw error;
  }
}

async function usdcBalance(owner) {
  const res = await fetch('https://graphql.testnet.sui.io/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `{ address(address:"${owner}") { balance(coinType:"${USDC}") { totalBalance addressBalance coinBalance } } }`,
    }),
  });
  const j = await res.json();
  if (j.errors) {
    // Older schemas expose only totalBalance.
    const r2 = await fetch('https://graphql.testnet.sui.io/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: `{ address(address:"${owner}") { balance(coinType:"${USDC}") { totalBalance } } }` }),
    });
    return (await r2.json()).data?.address?.balance ?? null;
  }
  return j.data?.address?.balance ?? null;
}

/** `Option<RateLimit>` none. RateLimit is a Move enum, so it cannot be a pure input. */
function noRateLimit(tx) {
  const [none] = tx.moveCall({ target: '0x1::option::none', typeArguments: ['0x2::allowance::RateLimit'] });
  return none;
}

// ── The proof ────────────────────────────────────────────────────────────────

await assertTestnet();
log(`testnet confirmed; funder ${funder.toSuiAddress()}`);

// 1. Publish the probe package.
if (!results.steps.publish) {
  log('1. publish allowance_probe');
  const out = execFileSync(SUI_CLI, ['move', 'build', '--dump-bytecode-as-base64', '--path', PROBE_DIR], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const { modules, dependencies } = JSON.parse(out.slice(out.indexOf('{')));
  const tx = new Transaction();
  const [upgradeCap] = tx.publish({ modules, dependencies });
  tx.transferObjects([upgradeCap], funder.toSuiAddress());
  const t = await runAsFunder('publish', tx);
  const pkg = (t.effects.changedObjects ?? []).find((o) => o.outputState === 'PackageWrite');
  results.steps.publish = { digest: t.digest, packageId: pkg.objectId };
  save();
}
const PROBE = results.steps.publish.packageId;
const PROBE_APP = `${PROBE}::probe::PROBE`;

// 2. Passkeys and the 2-of-3 multisig.
const pks = await passkeys();
const multisig = MultiSigPublicKey.fromPublicKeys({
  threshold: 2,
  publicKeys: pks.map((k) => ({ publicKey: k.getPublicKey(), weight: 1 })),
});
const M = multisig.toSuiAddress();
{
  // Sui's documented derivation: blake2b256(0x03 || threshold u16 LE || for each member: flag || pubkey || weight u8).
  const parts = [Uint8Array.of(0x03), Uint8Array.of(2, 0)];
  for (const k of pks) parts.push(k.getPublicKey().toSuiBytes(), Uint8Array.of(1));
  const manual = normalizeSuiAddress(toHex(blake2b(concat(...parts), { dkLen: 32 })));
  if (manual !== M) throw new Error(`multisig address mismatch: SDK ${M} vs manual ${manual}`);
  results.multisig = {
    address: M,
    threshold: 2,
    members: pks.map((k) => ({
      scheme: 'Passkey',
      // 34 bytes: the passkey flag 0x06 FOLLOWED BY the 33-byte compressed P-256 key. Do not prepend the flag again.
      flagAndCompressedPubkeyHex: toHex(k.getPublicKey().toSuiBytes()),
      weight: 1,
    })),
    layout: 'address = blake2b256( 0x03 || threshold u16 LE || for each member: flagAndCompressedPubkey (34 bytes) || weight u8 )',
    expectedAddress: M,
  };
  save();
  log(`2. multisig ${M} (2-of-3 passkeys), derivation matches`);
}

// 3. Fund the multisig: SUI for gas, USDC into its address balance.
if (!results.steps.fundMultisig) {
  log('3. fund the multisig');
  const tx = new Transaction();
  const [gas] = tx.splitCoins(tx.gas, [300_000_000]);
  tx.transferObjects([gas], M);
  const usdc = tx.coin({ type: USDC, balance: 5_000_000 });
  tx.moveCall({ target: '0x2::coin::send_funds', typeArguments: [USDC], arguments: [usdc, tx.pure.address(M)] });
  const t = await runAsFunder('fund multisig (0.3 SUI coin, 5 USDC via coin::send_funds)', tx);
  results.steps.fundMultisig = { digest: t.digest, balanceChanges: t.balanceChanges };
  save();
}
results.balances = { afterFunding: await usdcBalance(M) };
save();

// 4. Multisig signs allowance::new for USDC (plain allowance, spender = funder).
if (!results.steps.allowanceNew) {
  log('4. multisig signs allowance::new');
  const tx = new Transaction();
  const now = Date.now();
  tx.moveCall({
    target: '0x2::allowance::new',
    typeArguments: [`0x2::balance::Balance<${USDC}>`],
    arguments: [
      tx.pure.string('phase0 plain'),
      tx.pure.address(funder.toSuiAddress()),
      tx.pure.option('u256', 1_000_000n),
      tx.pure.option('u64', null),
      tx.pure.option('u64', BigInt(now + 3_600_000)),
      noRateLimit(tx),
    ],
  });
  const t = await runAsMultisig('allowance::new signed by 2 of 3 passkeys', tx, multisig, [pks[0], pks[1]]);
  results.steps.allowanceNew = {
    digest: t.digest,
    allowance: created(t, '::allowance::Allowance<')[0],
    cap: created(t, '::allowance::AllowanceCap<')[0],
  };
  save();
}

// 5. Multisig signs propose_for_app<PROBE>; the probe accepts it in the same PTB.
if (!results.steps.proposeForApp) {
  log('5. multisig signs propose_for_app + probe::accept');
  const tx = new Transaction();
  const [proposal] = tx.moveCall({
    target: '0x2::allowance::propose_for_app',
    typeArguments: [`0x2::balance::Balance<${USDC}>`, PROBE_APP],
    arguments: [
      tx.pure.string('phase0 app'),
      tx.pure.address(funder.toSuiAddress()),
      tx.pure.option('u256', 1_000_000n),
      tx.pure.option('u64', null),
      tx.pure.option('u64', BigInt(Date.now() + 3_600_000)),
      noRateLimit(tx),
    ],
  });
  tx.moveCall({ target: `${PROBE}::probe::accept`, typeArguments: [`0x2::balance::Balance<${USDC}>`], arguments: [proposal] });
  const t = await runAsMultisig('propose_for_app + accept signed by passkeys 2 and 3', tx, multisig, [pks[1], pks[2]]);
  results.steps.proposeForApp = {
    digest: t.digest,
    allowance: created(t, '::allowance::Allowance<')[0],
    cap: created(t, '::allowance::AllowanceCap<')[0],
  };
  save();
}

// 6. Spender (the funder address) spends 0.25 USDC through the app-bound allowance.
if (!results.steps.appSpend) {
  log('6. spender spends through the app-bound allowance');
  const allowanceId = results.steps.proposeForApp.allowance.id;
  const tx = new Transaction();
  const w = tx.withdrawal({ amount: 250_000, type: USDC, from: 'allowance', allowance: allowanceId, funder: M });
  tx.moveCall({
    target: `${PROBE}::probe::spend_to`,
    typeArguments: [USDC],
    arguments: [tx.object(allowanceId), w, tx.pure.address(funder.toSuiAddress()), tx.object(CLOCK)],
  });
  const t = await runAsFunder('app_balance_spend 0.25 USDC from the multisig address balance', tx);
  results.steps.appSpend = { digest: t.digest, balanceChanges: t.balanceChanges };
  save();
}

// 7. Multisig withdraws from its own address balance (funds-withdrawal input + redeem_funds).
if (!results.steps.redeem) {
  log('7. multisig redeems from its own address balance');
  const tx = new Transaction();
  const w = tx.withdrawal({ amount: 100_000, type: USDC });
  const [bal] = tx.moveCall({ target: '0x2::balance::redeem_funds', typeArguments: [USDC], arguments: [w] });
  tx.moveCall({ target: '0x2::balance::send_funds', typeArguments: [USDC], arguments: [bal, tx.pure.address(funder.toSuiAddress())] });
  const t = await runAsMultisig('withdrawal input + balance::redeem_funds + send_funds (0.1 USDC)', tx, multisig, [pks[0], pks[2]]);
  results.steps.redeem = { digest: t.digest, balanceChanges: t.balanceChanges };
  save();
}

// 8a. One passkey alone must be refused (threshold 2).
if (!results.steps.singleSignerRefused) {
  log('8a. one passkey signature alone');
  const tx = new Transaction();
  const [c] = tx.splitCoins(tx.gas, [1]);
  tx.transferObjects([c], M);
  const r = await runAsMultisig('a transfer signed by one passkey only', tx, multisig, [pks[0]], { expectFailure: true });
  results.steps.singleSignerRefused = r;
  save();
}

// 8b. Spending over the app allowance's lifetime cap must abort (simulated, no gas).
if (!results.steps.overCapAborts) {
  log('8b. spend above the lifetime cap (simulated)');
  const allowanceId = results.steps.proposeForApp.allowance.id;
  const tx = new Transaction();
  tx.setSender(funder.toSuiAddress());
  const w = tx.withdrawal({ amount: 2_000_000, type: USDC, from: 'allowance', allowance: allowanceId, funder: M });
  tx.moveCall({
    target: `${PROBE}::probe::spend_to`,
    typeArguments: [USDC],
    arguments: [tx.object(allowanceId), w, tx.pure.address(funder.toSuiAddress()), tx.object(CLOCK)],
  });
  let outcome;
  try {
    const bytes = await tx.build({ client });
    const t = resultOf(await client.core.simulateTransaction({ transaction: bytes, include: { effects: true } }));
    outcome = t.status.success ? 'EXECUTED (unexpected)' : `aborted: ${t.status.error?.message ?? JSON.stringify(t.status.error)}`;
  } catch (error) {
    outcome = `refused before execution: ${String(error.message).slice(0, 300)}`;
  }
  log(`  ${outcome.startsWith('EXECUTED') ? '✗' : '✔'} over-cap spend ${outcome.slice(0, 160)}`);
  results.steps.overCapAborts = { outcome };
  save();
}

// 9. Multisig revokes the plain allowance.
if (!results.steps.revoke) {
  log('9. multisig revokes the plain allowance');
  const { allowance, cap } = results.steps.allowanceNew;
  const tx = new Transaction();
  tx.moveCall({
    target: '0x2::allowance::revoke',
    typeArguments: [`0x2::balance::Balance<${USDC}>`],
    arguments: [tx.object(cap.id), tx.object(allowance.id)],
  });
  const t = await runAsMultisig('allowance::revoke signed by passkeys 1 and 2', tx, multisig, [pks[0], pks[1]]);
  results.steps.revoke = { digest: t.digest };
  save();
}

// 10. coin::redeem_funds: address balance → a Coin<USDC> (the path a CCTP burn needs).
if (!results.steps.coinRedeem) {
  log('10. multisig redeems a Coin<USDC> with coin::redeem_funds');
  const tx = new Transaction();
  const w = tx.withdrawal({ amount: 50_000, type: USDC });
  const [coin] = tx.moveCall({ target: '0x2::coin::redeem_funds', typeArguments: [USDC], arguments: [w] });
  tx.moveCall({ target: '0x2::coin::send_funds', typeArguments: [USDC], arguments: [coin, tx.pure.address(funder.toSuiAddress())] });
  const t = await runAsMultisig('withdrawal input + coin::redeem_funds + coin::send_funds (0.05 USDC)', tx, multisig, [pks[1], pks[2]]);
  results.steps.coinRedeem = { digest: t.digest, balanceChanges: t.balanceChanges };
  save();
}

// 11. A staff spender with no SUI: a second app-bound allowance, spender = a fresh key.
if (!secrets.staffSecretKey) {
  const staffKp = new Ed25519Keypair();
  secrets.staffSecretKey = staffKp.getSecretKey();
  secrets.staffAddress = staffKp.toSuiAddress();
  writeFileSync(KEY_FILE, JSON.stringify(secrets, null, 2), { mode: 0o600 });
}
const staff = Ed25519Keypair.fromSecretKey(secrets.staffSecretKey);
results.staffAddress = staff.toSuiAddress();
if (!results.steps.staffAllowance) {
  log('11. multisig makes an app-bound allowance for a staff spender with no SUI');
  const tx = new Transaction();
  const [proposal] = tx.moveCall({
    target: '0x2::allowance::propose_for_app',
    typeArguments: [`0x2::balance::Balance<${USDC}>`, PROBE_APP],
    arguments: [
      tx.pure.string('phase0 staff'),
      tx.pure.address(staff.toSuiAddress()),
      tx.pure.option('u256', 500_000n),
      tx.pure.option('u64', null),
      tx.pure.option('u64', BigInt(Date.now() + 3_600_000)),
      noRateLimit(tx),
    ],
  });
  tx.moveCall({ target: `${PROBE}::probe::accept`, typeArguments: [`0x2::balance::Balance<${USDC}>`], arguments: [proposal] });
  const t = await runAsMultisig('propose_for_app (spender = staff) + accept', tx, multisig, [pks[0], pks[2]]);
  results.steps.staffAllowance = {
    digest: t.digest,
    allowance: created(t, '::allowance::Allowance<')[0],
    cap: created(t, '::allowance::AllowanceCap<')[0],
  };
  save();
}

// 12. The staff key spends with gas sponsored by the funder (the staff key holds no SUI).
if (!results.steps.sponsoredSpend) {
  log('12. sponsored app spend: staff signs, funder pays gas');
  const allowanceId = results.steps.staffAllowance.allowance.id;
  const tx = new Transaction();
  tx.setSender(staff.toSuiAddress());
  tx.setGasOwner(funder.toSuiAddress());
  const w = tx.withdrawal({ amount: 100_000, type: USDC, from: 'allowance', allowance: allowanceId, funder: M });
  tx.moveCall({
    target: `${PROBE}::probe::spend_to`,
    typeArguments: [USDC],
    arguments: [tx.object(allowanceId), w, tx.pure.address(funder.toSuiAddress()), tx.object(CLOCK)],
  });
  const bytes = await tx.build({ client });
  const staffSig = (await staff.signTransaction(bytes)).signature;
  const sponsorSig = (await funder.signTransaction(bytes)).signature;
  const t = resultOf(await client.executeTransaction({
    transaction: bytes,
    signatures: [staffSig, sponsorSig],
    include: { effects: true, objectTypes: true, balanceChanges: true },
  }));
  if (!t.status.success) throw new Error(`sponsored spend failed: ${t.status.error?.message}. Digest ${t.digest}`);
  await client.waitForTransaction({ digest: t.digest });
  log(`  ✔ sponsored app_balance_spend 0.1 USDC: ${t.digest}`);
  results.steps.sponsoredSpend = { digest: t.digest, balanceChanges: t.balanceChanges };
  save();
}

// 13. Simulations (no gas): the cap is cumulative, and only the spender may spend.
if (!results.steps.simulations) {
  log('13. simulations: cumulative cap, non-spender');
  const appAllowance = results.steps.proposeForApp.allowance.id; // 250,000 of 1,000,000 already spent
  const sim = async (label, sender, amount) => {
    const tx = new Transaction();
    tx.setSender(sender);
    const w = tx.withdrawal({ amount, type: USDC, from: 'allowance', allowance: appAllowance, funder: M });
    tx.moveCall({
      target: `${PROBE}::probe::spend_to`,
      typeArguments: [USDC],
      arguments: [tx.object(appAllowance), w, tx.pure.address(funder.toSuiAddress()), tx.object(CLOCK)],
    });
    try {
      const bytes = await tx.build({ client });
      const t = resultOf(await client.core.simulateTransaction({ transaction: bytes, include: { effects: true } }));
      return t.status.success ? 'would succeed' : `would abort: ${t.status.error?.message ?? JSON.stringify(t.status.error)}`;
    } catch (error) {
      return `refused: ${String(error.message).slice(0, 240)}`;
    }
  };
  const out = {
    exactlyAtCap: await sim('750,000 more (reaches the 1,000,000 cap)', funder.toSuiAddress(), 750_000),
    oneOverCap: await sim('750,001 more (one unit over)', funder.toSuiAddress(), 750_001),
    nonSpender: await sim('spent by the staff key, which is not this allowance\'s spender', staff.toSuiAddress(), 1),
  };
  for (const [k, v] of Object.entries(out)) log(`  ${k}: ${v.slice(0, 150)}`);
  results.steps.simulations = out;
  save();
}

// 14. Make the probe package immutable, as splash_spend will be.
if (!results.steps.makeImmutable) {
  log('14. make the probe package immutable');
  const pub = resultOf(await client.core.getTransaction({ digest: results.steps.publish.digest, include: { effects: true, objectTypes: true } }));
  const capId = created(pub, '::package::UpgradeCap')[0]?.id;
  if (!capId) throw new Error('UpgradeCap not found in the publish effects');
  const tx = new Transaction();
  tx.moveCall({ target: '0x2::package::make_immutable', arguments: [tx.object(capId)] });
  const t = await runAsFunder('package::make_immutable(UpgradeCap)', tx);
  results.steps.makeImmutable = { digest: t.digest, upgradeCap: capId };
  save();
}

results.balances.final = await usdcBalance(M);
results.finishedAt = new Date().toISOString();
save();
log('done; results in', path.relative(process.cwd(), RESULTS));
