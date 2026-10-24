#!/usr/bin/env node
/**
 * v2 Phase 1 on TESTNET ONLY: publish the three packages and drive every money
 * path through real transactions.
 *
 *   node experiments/v2-phase1/testnet-e2e.mjs
 *
 * Idempotent: each step records its result in testnet-e2e-results.json and is
 * skipped on the next run. Some steps cannot run on day one, because
 * activating the settlement-app registry and applying Splash's fee recipient
 * each give 24 hours' notice on testnet exactly as on mainnet; rerun after the
 * notice and the spending-rule and fees-on steps complete. A results file
 * recorded on packages published before Amendment A1 is refused, not resumed
 * (`assertA1Results`); the pre-A1 day-one run is kept beside this script as
 * testnet-e2e-results-pre-a1.json.
 *
 * Fees are off at publish (FeeConfig has no recipient until the first change
 * is applied), so day one proves fees off. On day one governance also
 * proposes a 2-of-3 finance multisig as the fee recipient, and on day two,
 * once applied, a wallet payment and a bank payout run with the fee on:
 * FeeCharged, the fee leg to the finance multisig, the unused max_fee back to
 * the business wallet. The bank payout meets the 99 USDC floor, so the funder
 * needs about 100 testnet USDC for it (faucet.circle.com).
 *
 * It publishes from a SCRATCH COPY of move/, so the repository's
 * Published.toml files stay untouched until the Move change is reviewed.
 *
 * Signers (all throwaway, testnet only; secrets only in
 * ~/splash-testnet-proof-key.json, outside the repository, never printed):
 *   - the Phase 0 funder key: publisher and gas;
 *   - governance: the Phase 0 2-of-3 software-passkey multisig;
 *   - the business: three new software passkeys. Passkey 1 is the founder, all
 *     three are owners, and their 2-of-3 is the business wallet;
 *   - a staff spender and the "KMS operator" executor: two new Ed25519 keys;
 *   - Splash's finance multisig, the fee recipient: a 2-of-3 of three new
 *     Ed25519 keys; and a payout partner's deposit address, one more.
 *
 * Passkeys are SOFTWARE WebAuthn authenticators (P-256), as in Phase 0
 * (docs/mainnet-checks-2026-10.md, check 3). The script refuses to run against
 * anything but testnet.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { PasskeyKeypair } from '@mysten/sui/keypairs/passkey';
import { MultiSigPublicKey } from '@mysten/sui/multisig';
import { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress, toHex } from '@mysten/sui/utils';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const KEY_FILE = path.join(os.homedir(), 'splash-testnet-proof-key.json');
const RESULTS = path.join(HERE, 'testnet-e2e-results.json');
const SUI_CLI = path.join(os.homedir(), '.sui-cli', 'mainnet-v1.82.3', 'sui.exe');
const SCRATCH = path.join(os.tmpdir(), 'splash-v2-testnet-publish');

const NETWORK = 'testnet';
const TESTNET_CHAIN = '69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD';
const TESTNET_CHAIN_SHORT = '4c78adac';
const USDC = '0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC';
const CLOCK = '0x6';
const RP_ID = 'localhost';
const ORIGIN = 'http://localhost:3000';
const DAY_MS = 86_400_000;
const REGISTRY_SETTLEMENT_APP = 2;
// Amendment A1's kinds (fee_config::KIND_*).
const KIND_SPLASH_BUSINESS = 0;
const KIND_WALLET = 1;
const KIND_BANK_PAYOUT = 4;
/** The bank-payout floor: business_account::min_transfer_minor, 99 USDC. */
const BANK_AMOUNT = 99_000_000;
const SUI_DOMAIN = 8;
const ROLE_STAFF = 1;
const ROLE_EXECUTOR = 2;

const client = new SuiGrpcClient({ network: NETWORK, baseUrl: 'https://fullnode.testnet.sui.io:443' });

// ── Secrets and results ──────────────────────────────────────────────────────

const secrets = JSON.parse(readFileSync(KEY_FILE, 'utf8'));
if (secrets.network !== 'testnet') throw new Error('The key file is not a testnet key file. Refusing.');
const funder = Ed25519Keypair.fromSecretKey(secrets.secretKey);
if (funder.toSuiAddress() !== secrets.address) throw new Error('Key file address does not match its key.');

const results = existsSync(RESULTS) ? JSON.parse(readFileSync(RESULTS, 'utf8')) : { network: NETWORK, steps: {} };

/**
 * A results file from a splash_core published before Amendment A1 has no
 * FeeConfig, FeeAdminCap, address Registry or OpsCap. Resuming it would skip
 * the publish and call A1's argument lists against the old packages, so it is
 * refused; move it aside for a fresh run.
 */
function assertA1Results(r) {
  const publish = r.steps?.publishCore;
  if (!publish) return;
  const missing = ['feeConfig', 'feeAdminCap', 'addressRegistry', 'opsCap'].filter((key) => !publish[key]);
  if (missing.length > 0) {
    throw new Error(
      `${RESULTS} was recorded on a splash_core published before Amendment A1 (its publishCore has no ${missing.join(', ')}). ` +
        "Resuming it would call A1's functions on the old packages. Move it aside and run again for a fresh publish. Refusing.",
    );
  }
}
assertA1Results(results);
const save = () => writeFileSync(RESULTS, `${JSON.stringify(results, null, 2)}\n`);
const log = (...a) => console.log(...a);
const done = (name) => Boolean(results.steps[name]);

function saveSecrets() {
  writeFileSync(KEY_FILE, JSON.stringify(secrets, null, 2), { mode: 0o600 });
}

// ── Software WebAuthn passkeys (as Phase 0) ──────────────────────────────────

const SPKI_P256_PREFIX = Uint8Array.from(Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex'));
const b64url = (bytes) => Buffer.from(bytes).toString('base64url');
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

function softwarePasskeyProvider(secretKeyHex, credentialIdHex) {
  const sk = Uint8Array.from(Buffer.from(secretKeyHex, 'hex'));
  const credentialId = Uint8Array.from(Buffer.from(credentialIdHex, 'hex'));
  const spki = concat(SPKI_P256_PREFIX, p256.getPublicKey(sk, false));
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
      const authenticatorData = concat(rpIdHash, Uint8Array.of(0x05), counter);
      const clientDataJSON = new TextEncoder().encode(
        JSON.stringify({ type: 'webauthn.get', challenge: b64url(challenge), origin: ORIGIN, crossOrigin: false }),
      );
      const der = p256.Signature.fromBytes(p256.sign(concat(authenticatorData, sha256(clientDataJSON)), sk), 'compact').toBytes('der');
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

const newPasskeySecret = () => ({
  secretKeyHex: toHex(p256.utils.randomSecretKey()),
  credentialIdHex: toHex(crypto.getRandomValues(new Uint8Array(16))),
});

async function passkeySet(field) {
  if (!secrets[field]) {
    secrets[field] = [newPasskeySecret(), newPasskeySecret(), newPasskeySecret()];
    saveSecrets();
  }
  return Promise.all(secrets[field].map((p) => PasskeyKeypair.getPasskeyInstance(softwarePasskeyProvider(p.secretKeyHex, p.credentialIdHex))));
}

function ed25519(field) {
  if (!secrets[field]) {
    secrets[field] = Ed25519Keypair.generate().getSecretKey();
    saveSecrets();
  }
  return Ed25519Keypair.fromSecretKey(secrets[field]);
}

function multisigOf(keys) {
  return MultiSigPublicKey.fromPublicKeys({ threshold: 2, publicKeys: keys.map((k) => ({ publicKey: k.getPublicKey(), weight: 1 })) });
}

/** The members as Move takes them: flag || public key, in member order. */
const memberBytes = (keys) => keys.map((k) => Array.from(k.getPublicKey().toSuiBytes()));

// ── Chain helpers ────────────────────────────────────────────────────────────

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

const resultOf = (res) => (res.$kind === 'Transaction' ? res.Transaction : res.FailedTransaction);
const INCLUDE = { effects: true, events: true, objectTypes: true, balanceChanges: true };

function created(t, typeIncludes) {
  const types = t.objectTypes ?? {};
  return (t.effects?.changedObjects ?? [])
    .filter((o) => o.idOperation === 'Created')
    .map((o) => ({ id: o.objectId, type: types[o.objectId] ?? '', owner: o.outputOwner }))
    .filter((o) => !typeIncludes || o.type.includes(typeIncludes));
}
const one = (t, typeIncludes) => {
  const found = created(t, typeIncludes);
  if (found.length !== 1) throw new Error(`expected one created ${typeIncludes}, found ${found.length}`);
  return found[0].id;
};
const eventsOf = (t, suffix) => (t.events ?? []).filter((e) => (e.eventType ?? e.type ?? '').endsWith(suffix));

async function finish(label, res) {
  const t = resultOf(res);
  if (!t.status.success) throw new Error(`${label} failed: ${t.status.error?.message}. Digest ${t.digest}`);
  await client.waitForTransaction({ digest: t.digest });
  log(`  ✔ ${label}: ${t.digest}`);
  return t;
}

async function runAs(label, signer, tx) {
  tx.setSender(signer.toSuiAddress());
  return finish(label, await client.signAndExecuteTransaction({ signer, transaction: tx, include: INCLUDE }));
}

/** Gas from the funder, so no test key needs SUI of its own. */
async function runSponsored(label, signers, sender, tx) {
  tx.setSender(sender);
  tx.setGasOwner(funder.toSuiAddress());
  const bytes = await tx.build({ client });
  const signatures = [];
  for (const s of signers) signatures.push(typeof s === 'function' ? await s(bytes) : (await s.signTransaction(bytes)).signature);
  signatures.push((await funder.signTransaction(bytes)).signature);
  return finish(label, await client.executeTransaction({ transaction: bytes, signatures, include: INCLUDE }));
}

/** A 2-of-3 multisig signs with two of its passkeys; the funder sponsors gas. */
async function runMultisig(label, ms, pair, tx) {
  const sign = async (bytes) => {
    const partials = [];
    for (const k of pair) partials.push((await k.signTransaction(bytes)).signature);
    return ms.combinePartialSignatures(partials);
  };
  return runSponsored(label, [sign], ms.toSuiAddress(), tx);
}

/** Dry run: expect an abort, and say which. */
async function expectAbort(label, sender, tx) {
  tx.setSender(sender);
  tx.setGasOwner(funder.toSuiAddress());
  let why;
  try {
    // The SDK simulates while it resolves the transaction, so a Move abort can
    // surface here, at build time, before any explicit simulation.
    const bytes = await tx.build({ client });
    const sim = await client.simulateTransaction({ transaction: bytes, include: { effects: true } });
    const t = resultOf(sim);
    if (t?.status?.success) throw new Error(`${label}: expected an abort, the dry run succeeded`);
    why = String(t?.status?.error?.message ?? JSON.stringify(t?.status?.error));
  } catch (error) {
    if (String(error.message).includes('expected an abort')) throw error;
    if (!error.executionError) throw error;
    why = String(error.executionError.message ?? error.message);
  }
  why = why.slice(0, 300);
  log(`  ✔ ${label}: refused (${why})`);
  return why;
}

function noRateLimit(tx) {
  const [none] = tx.moveCall({ target: '0x1::option::none', typeArguments: ['0x2::allowance::RateLimit'] });
  return none;
}

const ref32 = (label) => Array.from(sha256(new TextEncoder().encode(`splash-v2-testnet:${label}`)));

// ── Publishing from a scratch copy ───────────────────────────────────────────

function scratchCopy() {
  if (!existsSync(SCRATCH)) {
    mkdirSync(SCRATCH, { recursive: true });
    cpSync(path.join(REPO, 'move'), path.join(SCRATCH, 'move'), {
      recursive: true,
      filter: (src) => !src.includes(`${path.sep}build`),
    });
    // The copy publishes core FRESH: the v1 testnet record must not be read as this package's address.
    rmSync(path.join(SCRATCH, 'move', 'splash_core', 'Published.toml'), { force: true });
  }
  return path.join(SCRATCH, 'move');
}

function bytecode(pkgDir) {
  const out = execFileSync(SUI_CLI, ['move', 'build', '--dump-bytecode-as-base64', '--path', pkgDir, '-e', 'testnet'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(out.slice(out.indexOf('{')));
}

function recordPublished(pkgDir, packageId, upgradeCap) {
  writeFileSync(
    path.join(pkgDir, 'Published.toml'),
    [
      '# Generated by experiments/v2-phase1/testnet-e2e.mjs in a scratch copy, for dependency resolution only.',
      '',
      '[published.testnet]',
      `chain-id = "${TESTNET_CHAIN_SHORT}"`,
      `published-at = "${packageId}"`,
      `original-id = "${packageId}"`,
      'version = 1',
      'toolchain-version = "1.82.3"',
      'build-config = { flavor = "sui", edition = "2024" }',
      ...(upgradeCap ? [`upgrade-capability = "${upgradeCap}"`] : []),
      '',
    ].join('\n'),
  );
}

// ── The run ──────────────────────────────────────────────────────────────────

await assertTestnet();
const move = scratchCopy();
const govKeys = await passkeySet('passkeys'); // Phase 0's three
const bizKeys = await passkeySet('v2BusinessPasskeys');
const staff = ed25519('v2StaffSecretKey');
const executor = ed25519('v2ExecutorSecretKey');
const financeKeys = [ed25519('v2FinanceSecretKey1'), ed25519('v2FinanceSecretKey2'), ed25519('v2FinanceSecretKey3')];
const PARTNER = ed25519('v2PartnerSecretKey').toSuiAddress();
const G = multisigOf(govKeys);
const FINANCE = multisigOf(financeKeys);
const W = multisigOf(bizKeys);
const OWNERS = bizKeys.map((k) => k.getPublicKey().toSuiAddress());
const RECIPIENT = staff.toSuiAddress(); // a wallet the business pays; any address would do
results.signers = {
  funder: funder.toSuiAddress(),
  governance: G.toSuiAddress(),
  businessWallet: W.toSuiAddress(),
  owners: OWNERS,
  staff: staff.toSuiAddress(),
  executor: executor.toSuiAddress(),
  finance: FINANCE.toSuiAddress(),
  partner: PARTNER,
};
save();
log('Governance multisig', G.toSuiAddress());
log('Business wallet    ', W.toSuiAddress());

// 1. splash_core, fresh.
if (!done('publishCore')) {
  const { modules, dependencies } = bytecode(path.join(move, 'splash_core'));
  const tx = new Transaction();
  const [cap] = tx.publish({ modules, dependencies });
  tx.transferObjects([cap], funder.toSuiAddress());
  const t = await runAs('publish splash_core', funder, tx);
  const pkg = (t.effects.changedObjects ?? []).find((o) => o.outputState === 'PackageWrite').objectId;
  results.steps.publishCore = {
    digest: t.digest,
    packageId: pkg,
    upgradeCap: one(t, '::package::UpgradeCap'),
    adminCap: one(t, '::business_account::AdminCap'),
    anchorCap: one(t, '::business_account::AnchorCap'),
    capRegistry: one(t, '::cap_registry::CapRegistry'),
    configTicket: one(t, '::compliance_config::ConfigTicket'),
    // Amendment A1: the fee config and its cap, and the address registry
    // (business wallets and partner deposit addresses) and Splash's ops cap.
    feeConfig: one(t, '::fee_config::FeeConfig'),
    feeAdminCap: one(t, '::fee_config::FeeAdminCap'),
    addressRegistry: one(t, '::address_registry::Registry'),
    opsCap: one(t, '::address_registry::OpsCap'),
  };
  save();
}
const CORE = results.steps.publishCore.packageId;
const ADDRESS_REGISTRY = results.steps.publishCore.addressRegistry;
const FEE_CONFIG = results.steps.publishCore.feeConfig;
/** The payer's bound on Splash's fee (A1 §2.6): the 100 bps ceiling, which no fee can exceed. */
const maxFeeOf = (amount) => Math.floor(amount / 100);
recordPublished(path.join(move, 'splash_core'), CORE, results.steps.publishCore.upgradeCap);

// 2. splash_spend and splash_upgrade_delay, each made immutable in its publish transaction.
for (const [step, dir, module] of [
  ['publishSpend', 'splash_spend', 'spend_policy'],
  ['publishDelay', 'splash_upgrade_delay', 'upgrade_delay'],
]) {
  if (!done(step)) {
    const { modules, dependencies } = bytecode(path.join(move, dir));
    const tx = new Transaction();
    const [cap] = tx.publish({ modules, dependencies });
    tx.moveCall({ target: '0x2::package::make_immutable', arguments: [cap] });
    const t = await runAs(`publish ${dir} (immutable)`, funder, tx);
    const pkg = (t.effects.changedObjects ?? []).find((o) => o.outputState === 'PackageWrite').objectId;
    results.steps[step] = { digest: t.digest, packageId: pkg, upgradeCapCreated: created(t, '::package::UpgradeCap').length };
    if (module === 'spend_policy') results.steps[step].policyRegistry = one(t, '::spend_policy::PolicyRegistry');
    save();
  }
}
const SPEND = results.steps.publishSpend.packageId;
const DELAY = results.steps.publishDelay.packageId;
const SETTLE_WITNESS = `${SPEND}::splash_spend::SettleWitness`;

// 3. The one ComplianceConfig, accepting testnet USDC.
if (!done('createConfig')) {
  const s = results.steps.publishCore;
  const tx = new Transaction();
  tx.moveCall({
    target: `${CORE}::compliance_config::create`,
    typeArguments: [USDC],
    arguments: [
      tx.object(s.configTicket),
      tx.object(s.adminCap),
      tx.object(s.capRegistry),
      tx.pure.u64(5_000),
      tx.pure.u64(60_000),
      tx.pure.u64(50),
      tx.pure.u64(1_000_000),
      tx.pure.u64(1_000_000),
      tx.pure.vector('id', [s.capRegistry]), // a placeholder venue id; no custody path reads it on v2
    ],
  });
  const t = await runAs('compliance_config::create<USDC> (consumes the ticket)', funder, tx);
  results.steps.createConfig = { digest: t.digest, config: one(t, '::compliance_config::ComplianceConfig'), complianceCap: one(t, '::compliance_config::ComplianceCap') };
  save();
}
const CONFIG = results.steps.createConfig.config;

// 4. Governance takes AdminCap, the core UpgradeCap and (A1 §2.5) the FeeAdminCap; it wraps the
// upgrade cap itself. The OpsCap stays with the funder, standing in for Splash ops.
if (!done('handToGovernance')) {
  const s = results.steps.publishCore;
  const tx = new Transaction();
  tx.transferObjects([tx.object(s.adminCap), tx.object(s.upgradeCap), tx.object(s.feeAdminCap)], G.toSuiAddress());
  const t = await runAs('transfer AdminCap, UpgradeCap and FeeAdminCap to the governance multisig', funder, tx);
  results.steps.handToGovernance = { digest: t.digest };
  save();
}
if (!done('wrap')) {
  const tx = new Transaction();
  tx.moveCall({
    target: `${DELAY}::upgrade_delay::wrap`,
    arguments: [
      tx.object(results.steps.publishCore.upgradeCap),
      tx.pure.vector('vector<u8>', memberBytes(govKeys)),
      tx.pure.vector('u8', [1, 1, 1]),
      tx.pure.u16(2),
    ],
  });
  const t = await runMultisig('upgrade_delay::wrap, signed by governance (passkeys 1+2)', G, [govKeys[0], govKeys[1]], tx);
  results.steps.wrap = { digest: t.digest, wrapper: one(t, '::upgrade_delay::DelayedUpgradeCap'), event: eventsOf(t, '::upgrade_delay::CapWrapped')[0]?.json ?? null };
  save();
}

// 4b. Governance proposes Splash's finance multisig as the fee recipient (A1
// §2.5). Fees stay off until it is applied, 24 hours from now. The recipient
// is proven a multisig no one member signs for alone (Sky's FIXUP 2).
if (!done('proposeFeeRecipient')) {
  const tx = new Transaction();
  tx.moveCall({
    target: `${CORE}::fee_config::propose_fee_recipient`,
    arguments: [
      tx.object(results.steps.publishCore.feeAdminCap), tx.object(FEE_CONFIG),
      tx.pure.vector('vector<u8>', memberBytes(financeKeys)), tx.pure.vector('u8', [1, 1, 1]), tx.pure.u16(2), tx.object(CLOCK),
    ],
  });
  const t = await runMultisig('fee_config::propose_fee_recipient (the finance 2-of-3), signed by governance (passkeys 1+3)', G, [govKeys[0], govKeys[2]], tx);
  const ev = eventsOf(t, '::fee_config::FeeRecipientProposed')[0]?.json ?? null;
  if (!ev || normalizeSuiAddress(ev.recipient) !== normalizeSuiAddress(FINANCE.toSuiAddress())) {
    throw new Error(`FeeRecipientProposed names ${ev?.recipient}, not the finance multisig ${FINANCE.toSuiAddress()}`);
  }
  results.steps.proposeFeeRecipient = { digest: t.digest, event: ev };
  save();
}

// 4c. Splash ops registers a payout partner's deposit address (A1 §2.3): a
// payment to it is a bank payout, whatever it declares.
if (!done('addPartner')) {
  const tx = new Transaction();
  tx.moveCall({
    target: `${CORE}::address_registry::add_partner_address`,
    arguments: [tx.object(results.steps.publishCore.opsCap), tx.object(ADDRESS_REGISTRY), tx.pure.address(PARTNER)],
  });
  const t = await runAs('address_registry::add_partner_address, with the OpsCap', funder, tx);
  results.steps.addPartner = { digest: t.digest, event: eventsOf(t, '::address_registry::PartnerAddressAdded')[0]?.json ?? null };
  save();
}

// 5. Governance announces SettleWitness as a settlement app. 24 hours' notice.
if (!done('proposeWitness')) {
  const tx = new Transaction();
  tx.moveCall({
    target: `${CORE}::compliance_config::propose_addition`,
    typeArguments: [SETTLE_WITNESS],
    arguments: [
      tx.object(results.steps.publishCore.adminCap),
      tx.object(CONFIG),
      tx.pure.u8(REGISTRY_SETTLEMENT_APP),
      tx.pure.vector('vector<u8>', memberBytes(govKeys)),
      tx.pure.vector('u8', [1, 1, 1]),
      tx.pure.u16(2),
      tx.object(CLOCK),
    ],
  });
  const t = await runMultisig('propose_addition<SettleWitness>, signed by governance (passkeys 2+3)', G, [govKeys[1], govKeys[2]], tx);
  const ev = eventsOf(t, '::compliance_config::RegistryAdditionProposed')[0];
  results.steps.proposeWitness = { digest: t.digest, event: ev?.json ?? null };
  save();
}

// 6. The business: founder applies, governance verifies, owners join, the wallet registers.
const founder = bizKeys[0];
if (!done('apply')) {
  const tx = new Transaction();
  tx.moveCall({
    target: `${CORE}::business_account::submit_application`,
    arguments: [tx.pure.string('SSM-TESTNET-V2'), tx.pure.string('bafy-testnet-kyb'), tx.object(CLOCK)],
  });
  const t = await runSponsored('submit_application, signed by the founder passkey', [founder], OWNERS[0], tx);
  results.steps.apply = { digest: t.digest, account: one(t, '::business_account::BusinessAccount') };
  save();
}
const ACCOUNT = results.steps.apply.account;
if (!done('verify')) {
  const tx = new Transaction();
  tx.moveCall({
    target: `${CORE}::business_account::verify_business`,
    arguments: [tx.object(results.steps.publishCore.adminCap), tx.object(ACCOUNT), tx.object(ADDRESS_REGISTRY), tx.pure.u8(20)],
  });
  const t = await runMultisig('verify_business, signed by governance (passkeys 1+3)', G, [govKeys[0], govKeys[2]], tx);
  results.steps.verify = { digest: t.digest };
  save();
}
if (!done('owners')) {
  const tx = new Transaction();
  for (const o of OWNERS.slice(1)) tx.moveCall({ target: `${CORE}::business_account::add_owner`, arguments: [tx.object(ACCOUNT), tx.pure.address(o)] });
  tx.moveCall({ target: `${CORE}::business_account::nominate_wallet`, arguments: [tx.object(ACCOUNT), tx.pure.address(W.toSuiAddress()), tx.pure.bool(false)] });
  const t = await runSponsored('add owners 2 and 3, nominate the wallet: the founder', [founder], OWNERS[0], tx);
  results.steps.owners = { digest: t.digest };
  save();
}
if (!done('register')) {
  const tx = new Transaction();
  tx.moveCall({
    target: `${CORE}::business_account::register_wallet`,
    arguments: [tx.object(ACCOUNT), tx.object(ADDRESS_REGISTRY), tx.pure.vector('vector<u8>', memberBytes(bizKeys)), tx.pure.vector('u8', [1, 1, 1]), tx.pure.u16(2), tx.pure.bool(false)],
  });
  const t = await runMultisig('register_wallet, signed by the business wallet (passkeys 1+2)', W, [bizKeys[0], bizKeys[1]], tx);
  results.steps.register = { digest: t.digest, event: eventsOf(t, '::business_account::WalletRegistered')[0]?.json ?? null };
  save();
}

// 7. USDC into the wallet's address balance.
if (!done('fundWallet')) {
  const tx = new Transaction();
  const coin = tx.coin({ type: USDC, balance: 3_000_000 });
  tx.moveCall({ target: '0x2::coin::send_funds', typeArguments: [USDC], arguments: [coin, tx.pure.address(W.toSuiAddress())] });
  const t = await runAs('coin::send_funds: 3 USDC into the business wallet', funder, tx);
  results.steps.fundWallet = { digest: t.digest };
  save();
}

/**
 * A wallet-path payment: withdrawal → redeem → create_for_wallet → confirm_balance → anchor → delete, one PTB.
 * The withdrawal covers the payment and the most its fee can be; core charges the derived kind's fee and
 * returns the rest to the wallet's address balance. A bank payout names its beneficiary. With
 * `feesOn`, the payment must emit FeeCharged with a fee above zero paid to the finance multisig.
 */
async function walletPays(step, kind, to, amount, pair, { beneficiary = [], feesOn = false } = {}) {
  if (done(step)) return;
  const bank = kind === KIND_BANK_PAYOUT;
  const tx = new Transaction();
  const maxFee = maxFeeOf(amount);
  const withdrawal = tx.withdrawal({ amount: amount + maxFee, type: USDC });
  const [balance] = tx.moveCall({ target: '0x2::balance::redeem_funds', typeArguments: [USDC], arguments: [withdrawal] });
  const now = Date.now();
  const [intent] = tx.moveCall({
    target: `${CORE}::payment_intent::create_for_wallet`,
    typeArguments: [USDC],
    arguments: [
      tx.object(ACCOUNT), tx.object(CONFIG), tx.pure.vector('u8', ref32(step)), tx.pure.address(to), tx.pure.vector('u8', beneficiary),
      tx.pure.u64(amount), tx.pure.string(bank ? 'PHP' : 'USDC'), tx.pure.u64(bank ? 56_000_000 : 1_000_000), tx.pure.vector('u8', ref32(`${step}:commitment`)),
      tx.pure.u8(kind), tx.pure.vector('u8', ref32(`${step}:rail`)), tx.pure.u64(now + 3_600_000), tx.object(CLOCK),
    ],
  });
  const [receipt] = tx.moveCall({
    target: `${CORE}::payment_intent::confirm_from_business_wallet_balance`,
    typeArguments: [USDC],
    arguments: [
      intent, tx.object(ACCOUNT), tx.object(CONFIG), tx.object(FEE_CONFIG), tx.object(ADDRESS_REGISTRY), balance,
      tx.pure.u64(maxFee), tx.pure.u64(now + 1_800_000), tx.object(CLOCK),
    ],
  });
  tx.moveCall({ target: `${CORE}::audit_anchor::anchor`, arguments: [receipt, tx.pure.vector('u8', ref32(`${step}:hash`)), tx.pure.vector('u8', Array.from(new TextEncoder().encode('walrus-testnet'))), tx.object(CLOCK)] });
  tx.moveCall({ target: `${CORE}::payment_intent::delete_finalized`, arguments: [intent] });
  const t = await runMultisig(`${step}: the wallet pays from its address balance (create, confirm, anchor, delete in one PTB)`, W, pair, tx);
  const feeCharged = eventsOf(t, '::fee_config::FeeCharged')[0]?.json ?? null;
  if (feesOn && (!feeCharged || BigInt(feeCharged.fee) <= 0n || normalizeSuiAddress(feeCharged.fee_recipient) !== normalizeSuiAddress(FINANCE.toSuiAddress()))) {
    throw new Error(`${step}: expected FeeCharged with a fee to the finance multisig, got ${JSON.stringify(feeCharged)}. Digest ${t.digest}`);
  }
  if (!feesOn && feeCharged) throw new Error(`${step}: fees are off, yet FeeCharged was emitted. Digest ${t.digest}`);
  results.steps[step] = {
    digest: t.digest,
    maxFee: String(maxFee),
    confirmed: eventsOf(t, '::payment_intent::IntentConfirmed')[0]?.json ?? null,
    feeCharged,
    balanceChanges: (t.balanceChanges ?? []).map((b) => ({ owner: b.address ?? b.owner, coinType: b.coinType, amount: String(b.amount) })),
  };
  save();
}
await walletPays('walletPaysWallet', KIND_WALLET, RECIPIENT, 250_000, [bizKeys[1], bizKeys[2]]);
// A1 §2.3: a Splash-business payment must go to a registered business wallet,
// or it aborts with E_KIND_MISMATCH. The business wallet is the only one this
// run registers, so it pays itself: delivered to its own address balance, free.
await walletPays('walletPaysSplashBusiness', KIND_SPLASH_BUSINESS, W.toSuiAddress(), 150_000, [bizKeys[0], bizKeys[2]]);

// 8. A second create with the same payment reference is refused for ever.
if (!done('duplicateRefRefused')) {
  const tx = new Transaction();
  const now = Date.now();
  const [intent] = tx.moveCall({
    target: `${CORE}::payment_intent::create_for_wallet`,
    typeArguments: [USDC],
    arguments: [
      tx.object(ACCOUNT), tx.object(CONFIG), tx.pure.vector('u8', ref32('walletPaysWallet')), tx.pure.address(RECIPIENT), tx.pure.vector('u8', []),
      tx.pure.u64(1), tx.pure.string('USDC'), tx.pure.u64(1_000_000), tx.pure.vector('u8', ref32('dup')),
      tx.pure.u8(KIND_WALLET), tx.pure.vector('u8', ref32('dup:rail')), tx.pure.u64(now + 3_600_000), tx.object(CLOCK),
    ],
  });
  tx.moveCall({ target: `${CORE}::payment_intent::share_intent`, arguments: [intent] });
  results.steps.duplicateRefRefused = { refused: await expectAbort('the same payment_ref again (dry run)', W.toSuiAddress(), tx) };
  save();
}

// 9. The spending rule: policy, spenders, a verified recipient, a low threshold so a second approval is exercised.
if (!done('policy')) {
  const tx = new Transaction();
  const [policyId] = tx.moveCall({
    target: `${SPEND}::spend_policy::create_policy`,
    typeArguments: [USDC],
    arguments: [
      tx.object(results.steps.publishSpend.policyRegistry), tx.object(ACCOUNT), tx.object(CONFIG),
      // The policy pins Splash's FeeConfig and address Registry, as it pins the config.
      tx.object(FEE_CONFIG), tx.object(ADDRESS_REGISTRY),
      tx.pure.vector('vector<u8>', memberBytes(bizKeys)), tx.pure.vector('u8', [1, 1, 1]), tx.pure.u16(2), tx.pure.u64(2_000_000),
    ],
  });
  void policyId;
  const t = await runMultisig('spend_policy::create_policy, signed by the business wallet', W, [bizKeys[0], bizKeys[1]], tx);
  results.steps.policy = { digest: t.digest, policy: one(t, '::spend_policy::SpendPolicy') };
  save();
}
const POLICY = results.steps.policy.policy;
if (!done('policyRules')) {
  const tx = new Transaction();
  tx.moveCall({ target: `${SPEND}::spend_policy::add_spender`, arguments: [tx.object(POLICY), tx.object(ACCOUNT), tx.pure.address(staff.toSuiAddress()), tx.pure.u8(ROLE_STAFF), tx.pure.u64(1_000_000)] });
  tx.moveCall({ target: `${SPEND}::spend_policy::add_spender`, arguments: [tx.object(POLICY), tx.object(ACCOUNT), tx.pure.address(executor.toSuiAddress()), tx.pure.u8(ROLE_EXECUTOR), tx.pure.u64(1_000_000)] });
  // Verified with its delivery kind: OWNERS[2] is paid as a wallet, by Coin (kind 1).
  tx.moveCall({ target: `${SPEND}::spend_policy::verify_recipient`, arguments: [tx.object(POLICY), tx.object(ACCOUNT), tx.pure.u32(SUI_DOMAIN), tx.pure.address(OWNERS[2]), tx.pure.u8(KIND_WALLET)] });
  // 0.5 USDC: a payment above it needs a second approval, so the approval path runs on chain with test amounts.
  tx.moveCall({ target: `${SPEND}::spend_policy::set_limits`, arguments: [tx.object(POLICY), tx.object(ACCOUNT), tx.pure.u64(2_000_000), tx.pure.u64(500_000)] });
  const t = await runMultisig('policy rules: staff, executor, a verified recipient, a 0.5 USDC approval threshold', W, [bizKeys[1], bizKeys[2]], tx);
  results.steps.policyRules = { digest: t.digest };
  save();
}

/** The wallet proposes an app-bound allowance to `spender` and splash_spend accepts it, one PTB. */
async function allowanceFor(step, spender, cap) {
  if (done(step)) return;
  const tx = new Transaction();
  const [proposal] = tx.moveCall({
    target: '0x2::allowance::propose_for_app',
    typeArguments: [`0x2::balance::Balance<${USDC}>`, `${SPEND}::splash_spend::SPLASH_SPEND`],
    arguments: [
      // splash_spend binds each allowance to its policy by name: `splash-policy:` + the policy id in hex.
      tx.pure.string(`splash-policy:${POLICY.replace(/^0x/, '').toLowerCase().padStart(64, '0')}`),
      tx.pure.address(spender), tx.pure.option('u256', BigInt(cap)),
      tx.pure.option('u64', null), tx.pure.option('u64', BigInt(Date.now() + 14 * DAY_MS)), noRateLimit(tx),
    ],
  });
  tx.moveCall({ target: `${SPEND}::splash_spend::accept`, typeArguments: [USDC], arguments: [proposal, tx.object(POLICY), tx.object(ACCOUNT)] });
  const t = await runMultisig(`${step}: propose_for_app + splash_spend::accept`, W, [bizKeys[0], bizKeys[2]], tx);
  results.steps[step] = { digest: t.digest, allowance: one(t, '::allowance::Allowance<'), cap: one(t, '::allowance::AllowanceCap<') };
  save();
}
await allowanceFor('staffAllowance', staff.toSuiAddress(), 1_500_000);
await allowanceFor('executorAllowance', executor.toSuiAddress(), 1_000_000);

// 10. Before SettleWitness is activated, the spending rule cannot settle anything.
if (!done('spendBeforeActivationRefused')) {
  const tx = new Transaction();
  const now = Date.now();
  const [intent] = tx.moveCall({
    target: `${SPEND}::splash_spend::create_intent`,
    typeArguments: [USDC],
    arguments: [
      tx.object(POLICY), tx.object(ACCOUNT), tx.object(CONFIG), tx.pure.vector('u8', ref32('early')), tx.pure.address(OWNERS[2]), tx.pure.vector('u8', []),
      tx.pure.u64(200_000), tx.pure.string('USDC'), tx.pure.u64(1_000_000), tx.pure.vector('u8', ref32('early:c')), tx.pure.u8(KIND_WALLET),
      tx.pure.vector('u8', ref32('early:r')), tx.pure.u64(now + 3_600_000), tx.object(CLOCK),
    ],
  });
  tx.moveCall({ target: `${CORE}::payment_intent::share_intent`, arguments: [intent] });
  results.steps.spendBeforeActivationRefused = { refused: await expectAbort('staff create_intent before SettleWitness is registered (dry run)', staff.toSuiAddress(), tx) };
  save();
}

// 11. Day two: activate, then staff, owner-approved and executor payments.
const eta = Number(results.steps.proposeWitness.event?.eta_ms ?? 0);
if (Date.now() < eta) {
  log(`\nSettleWitness becomes eligible at ${new Date(eta).toISOString()} (24 hours after it was announced).`);
  log('Rerun this script after that to activate it and run the spending-rule payments.');
  results.waitingUntil = new Date(eta).toISOString();
  save();
  process.exit(0);
}
log('\nThe 24-hour notice has run. Day two:');

if (!done('activateWitness')) {
  const tx = new Transaction();
  tx.moveCall({
    target: `${CORE}::compliance_config::activate_addition`,
    typeArguments: [SETTLE_WITNESS],
    arguments: [
      tx.object(results.steps.publishCore.adminCap), tx.object(CONFIG), tx.pure.u8(REGISTRY_SETTLEMENT_APP),
      tx.pure.vector('vector<u8>', memberBytes(govKeys)), tx.pure.vector('u8', [1, 1, 1]), tx.pure.u16(2), tx.object(CLOCK),
    ],
  });
  const t = await runMultisig('activate_addition<SettleWitness>, signed by governance (passkeys 1+2)', G, [govKeys[0], govKeys[1]], tx);
  results.steps.activateWitness = { digest: t.digest, event: eventsOf(t, '::compliance_config::RegistryAdditionActivated')[0]?.json ?? null };
  save();
}

const APPROVAL_TYPE = `${SPEND}::splash_spend::PayoutApproval`;
/** Intents live six hours here; an approval's quote deadline is two hours
 *  after it is given, and a payment's settle_by is thirty minutes, so every
 *  payment below settles inside the deadline its approval names. */
const INTENT_LIFETIME_MS = 6 * 3_600_000;
const APPROVAL_WINDOW_MS = 2 * 3_600_000;

/** A staff-made intent to the verified recipient, created in `tx`. */
function staffIntent(tx, step, amount) {
  const [intent] = tx.moveCall({
    target: `${SPEND}::splash_spend::create_intent`,
    typeArguments: [USDC],
    arguments: [
      tx.object(POLICY), tx.object(ACCOUNT), tx.object(CONFIG), tx.pure.vector('u8', ref32(step)), tx.pure.address(OWNERS[2]), tx.pure.vector('u8', []),
      tx.pure.u64(amount), tx.pure.string('USDC'), tx.pure.u64(1_000_000), tx.pure.vector('u8', ref32(`${step}:c`)), tx.pure.u8(KIND_WALLET),
      tx.pure.vector('u8', ref32(`${step}:r`)), tx.pure.u64(Date.now() + INTENT_LIFETIME_MS), tx.object(CLOCK),
    ],
  });
  return intent;
}

/** pay_intent, then anchor and delete, in `tx`. `approval` is an Option<PayoutApproval> argument. */
function payAndClose(tx, step, intent, allowanceId, amount, approval) {
  // A1 §2.6: the allowance draws the principal and max_fee; core returns the unused part to the wallet.
  const maxFee = maxFeeOf(amount);
  const w = tx.withdrawal({ amount: amount + maxFee, type: USDC, from: 'allowance', allowance: allowanceId, funder: W.toSuiAddress() });
  const [receipt] = tx.moveCall({
    target: `${SPEND}::splash_spend::pay_intent`,
    typeArguments: [USDC],
    arguments: [
      tx.object(allowanceId), w, intent, tx.object(ACCOUNT), tx.object(POLICY), tx.object(CONFIG),
      tx.object(FEE_CONFIG), tx.object(ADDRESS_REGISTRY), approval, tx.pure.u64(maxFee),
      tx.pure.u64(Date.now() + 1_800_000), tx.object(CLOCK),
    ],
  });
  tx.moveCall({ target: `${CORE}::audit_anchor::anchor`, arguments: [receipt, tx.pure.vector('u8', ref32(`${step}:hash`)), tx.pure.vector('u8', Array.from(new TextEncoder().encode('walrus-testnet'))), tx.object(CLOCK)] });
  tx.moveCall({ target: `${CORE}::payment_intent::delete_finalized`, arguments: [intent] });
}

const none = (tx) => tx.moveCall({ target: '0x1::option::none', typeArguments: [APPROVAL_TYPE] })[0];
const some = (tx, objectId) => tx.moveCall({ target: '0x1::option::some', typeArguments: [APPROVAL_TYPE], arguments: [tx.object(objectId)] })[0];

// 12. Staff pays alone, below the threshold: create, pay, anchor, delete in one PTB.
if (!done('staffPays')) {
  const tx = new Transaction();
  const intent = staffIntent(tx, 'staffPays', 300_000);
  payAndClose(tx, 'staffPays', intent, results.steps.staffAllowance.allowance, 300_000, none(tx));
  const t = await runSponsored('staff: create_intent + pay_intent + anchor + delete (0.3 USDC, no approval)', [staff], staff.toSuiAddress(), tx);
  results.steps.staffPays = { digest: t.digest, ruleSpend: eventsOf(t, '::splash_spend::RuleSpend')[0]?.json ?? null };
  save();
}

// 13. Above the threshold: an owner's second approval, passed on chain as Option<PayoutApproval>.
if (!done('approvedIntent')) {
  const tx = new Transaction();
  tx.moveCall({ target: `${CORE}::payment_intent::share_intent`, arguments: [staffIntent(tx, 'approved', 700_000)] });
  const t = await runSponsored('staff opens a 0.7 USDC intent (above the 0.5 threshold) and shares it', [staff], staff.toSuiAddress(), tx);
  results.steps.approvedIntent = { digest: t.digest, intent: one(t, '::payment_intent::PaymentIntent') };
  save();
}
if (!done('approvedWithoutApprovalRefused')) {
  const tx = new Transaction();
  payAndClose(tx, 'approvedNoApproval', tx.object(results.steps.approvedIntent.intent), results.steps.staffAllowance.allowance, 700_000, none(tx));
  results.steps.approvedWithoutApprovalRefused = { refused: await expectAbort('the same payment with no approval (dry run)', staff.toSuiAddress(), tx) };
  save();
}
if (!done('ownerApproves')) {
  const tx = new Transaction();
  tx.moveCall({
    target: `${SPEND}::splash_spend::approve_payout`,
    // A1 §2.6: max_total is the principal and the most Splash's fee may be, as the owner was shown.
    arguments: [tx.object(POLICY), tx.object(ACCOUNT), tx.object(results.steps.approvedIntent.intent), tx.pure.address(staff.toSuiAddress()), tx.pure.u64(700_000 + maxFeeOf(700_000)), tx.pure.u64(Date.now() + APPROVAL_WINDOW_MS), tx.object(CLOCK)],
  });
  const t = await runSponsored('owner 2 approves, alone, with their own passkey', [bizKeys[1]], OWNERS[1], tx);
  results.steps.ownerApproves = { digest: t.digest, approval: one(t, '::splash_spend::PayoutApproval') };
  save();
}
if (!done('approvedPays')) {
  const tx = new Transaction();
  payAndClose(tx, 'approvedPays', tx.object(results.steps.approvedIntent.intent), results.steps.staffAllowance.allowance, 700_000, some(tx, results.steps.ownerApproves.approval));
  const t = await runSponsored('staff pays with option::some(approval): approval consumed', [staff], staff.toSuiAddress(), tx);
  results.steps.approvedPays = { digest: t.digest, consumed: eventsOf(t, '::splash_spend::SpendApprovalConsumed')[0]?.json ?? null };
  save();
}

// 14. The KMS operator runs only what the owners approved. A staff member
//     cannot hand a payment to it (v2 review: that would let staff spend past
//     their own rule on the operator's allowance); the wallet can, for an
//     intent the wallet itself opened.
if (!done('staffDelegationRefused')) {
  const tx = new Transaction();
  const intent = staffIntent(tx, 'staffDelegates', 200_000);
  tx.moveCall({
    target: `${SPEND}::splash_spend::delegate_execution`,
    arguments: [tx.object(POLICY), tx.object(ACCOUNT), intent, tx.pure.address(executor.toSuiAddress()), tx.pure.u64(200_000 + maxFeeOf(200_000)), tx.pure.u64(Date.now() + APPROVAL_WINDOW_MS), tx.object(CLOCK)],
  });
  tx.moveCall({ target: `${CORE}::payment_intent::share_intent`, arguments: [intent] });
  results.steps.staffDelegationRefused = { refused: await expectAbort('staff delegating a payment to the operator (dry run)', staff.toSuiAddress(), tx) };
  save();
}
if (!done('delegatedIntent')) {
  const tx = new Transaction();
  const [intent] = tx.moveCall({
    target: `${CORE}::payment_intent::create_for_wallet`,
    typeArguments: [USDC],
    arguments: [
      tx.object(ACCOUNT), tx.object(CONFIG), tx.pure.vector('u8', ref32('delegated')), tx.pure.address(OWNERS[2]), tx.pure.vector('u8', []),
      tx.pure.u64(200_000), tx.pure.string('USDC'), tx.pure.u64(1_000_000), tx.pure.vector('u8', ref32('delegated:c')), tx.pure.u8(KIND_WALLET),
      tx.pure.vector('u8', ref32('delegated:r')), tx.pure.u64(Date.now() + INTENT_LIFETIME_MS), tx.object(CLOCK),
    ],
  });
  tx.moveCall({ target: `${CORE}::payment_intent::share_intent`, arguments: [intent] });
  const t = await runMultisig('the wallet opens a 0.2 USDC intent for the operator to run', W, [bizKeys[0], bizKeys[1]], tx);
  results.steps.delegatedIntent = { digest: t.digest, intent: one(t, '::payment_intent::PaymentIntent') };
  save();
}
if (!done('executorWithoutApprovalRefused')) {
  const tx = new Transaction();
  payAndClose(tx, 'execNoApproval', tx.object(results.steps.delegatedIntent.intent), results.steps.executorAllowance.allowance, 200_000, none(tx));
  results.steps.executorWithoutApprovalRefused = { refused: await expectAbort('the operator paying without an approval (dry run)', executor.toSuiAddress(), tx) };
  save();
}
if (!done('delegate')) {
  const tx = new Transaction();
  tx.moveCall({
    target: `${SPEND}::splash_spend::delegate_execution`,
    arguments: [tx.object(POLICY), tx.object(ACCOUNT), tx.object(results.steps.delegatedIntent.intent), tx.pure.address(executor.toSuiAddress()), tx.pure.u64(200_000 + maxFeeOf(200_000)), tx.pure.u64(Date.now() + APPROVAL_WINDOW_MS), tx.object(CLOCK)],
  });
  const t = await runMultisig('the wallet delegates execution to the operator, with a quote deadline', W, [bizKeys[1], bizKeys[2]], tx);
  results.steps.delegate = { digest: t.digest, approval: one(t, '::splash_spend::PayoutApproval') };
  save();
}
if (!done('executorPays')) {
  const tx = new Transaction();
  payAndClose(tx, 'executorPays', tx.object(results.steps.delegatedIntent.intent), results.steps.executorAllowance.allowance, 200_000, some(tx, results.steps.delegate.approval));
  const t = await runSponsored("the operator pays under its own allowance, with the wallet's delegation", [executor], executor.toSuiAddress(), tx);
  results.steps.executorPays = { digest: t.digest };
  save();
}

// 15. Fees on: the finance multisig's 24-hour notice has run; governance
//     applies it, and a wallet payment and a bank payout pay Splash's fee.
const feeEta = Number(results.steps.proposeFeeRecipient.event?.eta ?? 0);
if (Date.now() < feeEta) {
  log(`\nThe fee recipient can be applied at ${new Date(feeEta).toISOString()} (24 hours after it was proposed).`);
  log('Rerun this script after that to turn the fees on and run the fees-on payments.');
  results.waitingUntil = new Date(feeEta).toISOString();
  save();
  process.exit(0);
}
// fee_config::FEE_APPLY_WINDOW_MS: a proposal lapses seven days after its eta.
const FEE_APPLY_WINDOW_MS = 604_800_000;
if (!done('applyFeeRecipient') && Date.now() >= feeEta + FEE_APPLY_WINDOW_MS) {
  throw new Error(
    `The fee recipient proposal lapsed at ${new Date(feeEta + FEE_APPLY_WINDOW_MS).toISOString()}, seven days after its notice ran ` +
      `(fee_config::E_FEE_PROPOSAL_LAPSED). Remove steps.proposeFeeRecipient from ${RESULTS} and rerun to propose it again.`,
  );
}
if (!done('applyFeeRecipient')) {
  const tx = new Transaction();
  tx.moveCall({
    target: `${CORE}::fee_config::apply_fee_recipient`,
    arguments: [tx.object(results.steps.publishCore.feeAdminCap), tx.object(FEE_CONFIG), tx.object(CLOCK)],
  });
  const t = await runMultisig('fee_config::apply_fee_recipient: fees on, signed by governance (passkeys 2+3)', G, [govKeys[1], govKeys[2]], tx);
  results.steps.applyFeeRecipient = { digest: t.digest, event: eventsOf(t, '::fee_config::FeeRecipientApplied')[0]?.json ?? null };
  save();
}
// A wallet payment under the WALLET schedule: 0.5 USDC pays the 1% ceiling, 0.005.
await walletPays('feesOnWalletPays', KIND_WALLET, RECIPIENT, 500_000, [bizKeys[0], bizKeys[1]], { feesOn: true });
// A bank payout to the partner's deposit address, at the 99 USDC floor: 0.30%,
// 0.297 USDC; the rest of the 0.99 max_fee goes back to the business wallet.
if (!done('fundBankLeg')) {
  const tx = new Transaction();
  const coin = tx.coin({ type: USDC, balance: BANK_AMOUNT + maxFeeOf(BANK_AMOUNT) });
  tx.moveCall({ target: '0x2::coin::send_funds', typeArguments: [USDC], arguments: [coin, tx.pure.address(W.toSuiAddress())] });
  let t;
  try {
    t = await runAs('coin::send_funds: the bank leg (99.99 USDC) into the business wallet', funder, tx);
  } catch (error) {
    throw new Error(`The funder ${funder.toSuiAddress()} needs ${(BANK_AMOUNT + maxFeeOf(BANK_AMOUNT)) / 1e6} testnet USDC for the bank-payout leg (faucet.circle.com), then rerun: ${error.message}`);
  }
  results.steps.fundBankLeg = { digest: t.digest };
  save();
}
await walletPays('feesOnBankPays', KIND_BANK_PAYOUT, PARTNER, BANK_AMOUNT, [bizKeys[1], bizKeys[2]], { beneficiary: ref32('feesOnBankPays:beneficiary'), feesOn: true });

log('\nEvery v2 path ran on testnet, with the fees off and then on. Results:', RESULTS);
