#!/usr/bin/env node
/**
 * e2e-testnet — check a splash_core publish against the chain.
 *
 * The verify step of docs/KEY-CEREMONY-RUNBOOK.md §3.8. It builds the same
 * transactions as lib/server/sui-settlement.ts, on the Phase 0 core package
 * only (splash_custody publishes with the licence, not before), and checks
 * that the configured ids, the AnchorCap and the CapRegistry work together:
 *
 *   ids      every configured object exists and belongs to this package; the
 *            AnchorCap is held by the operator address.
 *   abi      every function called takes the parameters the current source
 *            declares, so a package published from older source is named.
 *   peg      peg_monitor::update_peg on the AnchorCap and CapRegistry
 *            → PegUpdated.
 *   anchor   audit_anchor::anchor_audit_hash on its own → AuditAnchored.
 *   intent   payment_intent::create_payment_intent<SUI> → IntentCreated.
 *   confirm  confirm_payment_intent<SUI>, audit_anchor::anchor on its receipt,
 *            audit_anchor::anchor_audit_hash on the AnchorCap
 *            → IntentConfirmed, SettlementAnchored, AuditAnchored.
 *            No TreasuryDeposited: the treasury is a custody module.
 *
 * By default every transaction is SIMULATED: the node runs it as the operator
 * address would and reports what it would do. Nothing is signed or sent, no
 * coin moves, no object is written and no gas is spent, so this is safe on any
 * network, mainnet included. It runs as OPERATOR_SUI_ADDRESS and never reads
 * the private key. The network and node come from lib/sui.ts, as in the app.
 *
 * --execute signs and sends the intent and the confirm with
 * OPERATOR_SUI_PRIVATE_KEY, as two transactions, the shape the app uses.
 * Testnet only: the node's chain id decides, not SUI_NETWORK alone. The payment
 * goes back to the operator unless SPLASH_TEST_RECIPIENT_ADDRESS is set. The
 * peg call stays simulated: this script has no attested reading to write, and
 * the app writes only attested ones (lib/server/peg-attestation.ts).
 *
 * Run:
 *   node --use-system-ca --experimental-strip-types --env-file=.env.local scripts/e2e-testnet.mjs
 *   node --use-system-ca --experimental-strip-types --env-file=.env.local scripts/e2e-testnet.mjs --execute
 */
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Secp256k1Keypair } from '@mysten/sui/keypairs/secp256k1';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { fromBase58, isValidSuiAddress, isValidSuiObjectId, normalizeSuiAddress } from '@mysten/sui/utils';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { DOMAIN_TAGS, newSalt, paymentCommitment, toHex } from '../lib/evidence/commitment.ts';
import { SUI_NETWORK, SUI_RPC_URL } from '../lib/sui.ts';
import { SPLASH_CORE_ABI } from './splash-core-abi.mjs';

const env = (k) => (process.env[k] ?? '').trim();

/** A refusal while the configuration is read, before anything touches the chain. */
function stop(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

/**
 * A refusal once the chain has been asked something. Past that point this
 * script never calls process.exit: on Windows with Node 24 it then reports 127
 * whatever code it is given (measured 2026-09-26), so a passing verify would
 * read as a failure. It sets process.exitCode and lets Node finish.
 */
class Refused extends Error {}
function refuse(message) {
  console.error(`\n✗ ${message}\n`);
  throw new Refused(message);
}

const args = process.argv.slice(2);
for (const arg of args) {
  if (arg !== '--execute') stop(`Unknown argument ${arg}. The only option is --execute.`);
}
const EXECUTE = args.includes('--execute');

// The app's own resolution, so this asks the node the app asks.
const NETWORK = SUI_NETWORK;
const BASE_URL = SUI_RPC_URL;
if (!BASE_URL) stop('SUI_RPC_URL is set but empty. Unset it for the default node, or name one.');
const client = new SuiGrpcClient({ network: NETWORK, baseUrl: BASE_URL });

/** First four bytes of the genesis checkpoint digest, as Published.toml and
 *  Move.toml write chain ids. */
const CHAIN_IDS = { testnet: '4c78adac', mainnet: '35834a8a' };

const SUI = '0x2::sui::SUI';
const CLOCK = '0x6';
// 0.001 SUI. Enough to prove a coin moves; in --execute it comes back to the
// operator unless a test recipient is set.
const PAYMENT_MIST = 1_000_000;
const FX_RATE_SCALED = 56_420_000; // PHP per USD, scaled 1e6

function objectIdFromEnv(key, { required }) {
  const value = env(key);
  if (!value) {
    if (required) stop(`${key} is required.`);
    return '';
  }
  if (!isValidSuiObjectId(normalizeSuiAddress(value))) stop(`${key} is not a Sui object id: ${value}`);
  return normalizeSuiAddress(value);
}

// The core package, as corePackageIdOrThrow resolves it: SPLASH_CORE_PACKAGE_ID,
// or the legacy SPLASH_PACKAGE_ID alias.
const CORE_FROM_ENV = env('SPLASH_CORE_PACKAGE_ID');
const PACKAGE = CORE_FROM_ENV
  ? objectIdFromEnv('SPLASH_CORE_PACKAGE_ID', { required: true })
  : objectIdFromEnv('SPLASH_PACKAGE_ID', { required: false });
if (!PACKAGE) stop('Set SPLASH_CORE_PACKAGE_ID to the splash_core package id.');
// No fallback to the AdminCap, as in anchorCapObjectId / capRegistryObjectId.
const ANCHOR_CAP = objectIdFromEnv('SPLASH_ANCHOR_CAP_ID', { required: true });
const CAP_REGISTRY = objectIdFromEnv('SPLASH_CAP_REGISTRY_ID', { required: true });
const PEG_STATE = objectIdFromEnv('SPLASH_PEG_STATE_ID', { required: false });
const BUSINESS = objectIdFromEnv('SPLASH_BUSINESS_ACCOUNT_ID', { required: false });
const ADMIN_CAP = objectIdFromEnv('SPLASH_ADMIN_CAP_ID', { required: false });

/** Read only for --execute. A malformed key is reported without its text. */
function operatorSigner() {
  const encoded = env('OPERATOR_SUI_PRIVATE_KEY');
  if (!encoded) stop('--execute signs with OPERATOR_SUI_PRIVATE_KEY, which is not set.');
  let decoded;
  try {
    decoded = decodeSuiPrivateKey(encoded);
  } catch {
    stop('OPERATOR_SUI_PRIVATE_KEY is not a valid suiprivkey string.');
  }
  const { scheme, secretKey } = decoded;
  if (scheme === 'Secp256k1') return Secp256k1Keypair.fromSecretKey(secretKey);
  if (scheme === 'ED25519') return Ed25519Keypair.fromSecretKey(secretKey);
  stop(`OPERATOR_SUI_PRIVATE_KEY is a ${scheme} key. The app signs with Ed25519 or Secp256k1.`);
}

// No signer exists without --execute, so nothing in a simulation can sign.
const signer = EXECUTE ? operatorSigner() : null;
const addressFromEnv = env('OPERATOR_SUI_ADDRESS');
if (addressFromEnv && !isValidSuiAddress(normalizeSuiAddress(addressFromEnv))) {
  stop(`OPERATOR_SUI_ADDRESS is not a Sui address: ${addressFromEnv}`);
}
const SENDER = signer ? signer.toSuiAddress() : addressFromEnv ? normalizeSuiAddress(addressFromEnv) : '';
if (!SENDER) stop('Set OPERATOR_SUI_ADDRESS. A simulation runs as that address and never reads the key.');
if (signer && addressFromEnv && normalizeSuiAddress(addressFromEnv) !== SENDER) {
  stop(`OPERATOR_SUI_ADDRESS is ${addressFromEnv}, but OPERATOR_SUI_PRIVATE_KEY belongs to ${SENDER}.`);
}
const recipientFromEnv = env('SPLASH_TEST_RECIPIENT_ADDRESS');
if (recipientFromEnv && !isValidSuiAddress(normalizeSuiAddress(recipientFromEnv))) {
  stop(`SPLASH_TEST_RECIPIENT_ADDRESS is not a Sui address: ${recipientFromEnv}`);
}
const RECIPIENT = recipientFromEnv ? normalizeSuiAddress(recipientFromEnv) : SENDER;

// ── Results ───────────────────────────────────────────────────────────────────

const results = [];
function record(check, status, detail) {
  results.push({ check, status, detail });
  const mark = { PASS: '✔', FAIL: '✗', WARN: '!', SKIP: '-' }[status];
  console.log(`${mark} ${check.padEnd(28)} ${detail}`);
}

// ── Chain helpers ─────────────────────────────────────────────────────────────

/** `0x2::sui::SUI` and `0x000…002::sui::SUI` name the same type. */
function normalizeType(type) {
  const [address, ...rest] = type.split('::');
  return rest.length ? [normalizeSuiAddress(address), ...rest].join('::') : type;
}

function typeIn(name) {
  return `${PACKAGE}::${name}`;
}

function eventsOf(t) {
  return (t.events ?? []).map((e) => ({ type: normalizeType(e.eventType), data: e.json ?? {} }));
}

function findEvent(events, name) {
  return events.find((e) => e.type === typeIn(name)) ?? null;
}

function eventNames(events) {
  return events.map((e) => e.type.split('::').slice(-1)[0]).join(', ') || 'none';
}

/**
 * Why a Move call aborted, in the terms the ceremony uses. Applied in run(),
 * so it also reaches aborts the node reports while resolving the transaction
 * in tx.build, before any simulation result exists.
 */
function explain(message) {
  if (/\b210\b/.test(message) && /cap_registry/.test(message)) {
    // A cap or registry from another publish never gets this far: it is the
    // wrong type, which the id checks name.
    return `${message} — the AnchorCap was revoked: a break-glass execute moved its generation on. Use the AnchorCap that execute_break_glass_anchor_cap minted.`;
  }
  return message;
}

async function simulate(label, tx) {
  tx.setSender(SENDER);
  const bytes = await tx.build({ client });
  const res = await client.core.simulateTransaction({ transaction: bytes, include: { effects: true, events: true } });
  const t = res.$kind === 'Transaction' ? res.Transaction : res.FailedTransaction;
  if (!t.status.success) throw new Error(`${label} would abort: ${t.status.error?.message ?? 'no reason given'}`);
  return { digest: null, events: eventsOf(t) };
}

async function execute(label, tx) {
  const res = await client.signAndExecuteTransaction({
    signer,
    transaction: tx,
    include: { effects: true, events: true },
  });
  const t = res.$kind === 'Transaction' ? res.Transaction : res.FailedTransaction;
  if (!t.status.success) {
    throw new Error(`${label} failed: ${t.status.error?.message ?? 'no reason given'}. Digest ${t.digest}`);
  }
  await client.waitForTransaction({ digest: t.digest }).catch(() => {});
  return { digest: t.digest, events: eventsOf(t) };
}

// ── The calls, as the current source declares them ───────────────────────────

const ABI = SPLASH_CORE_ABI;

/** Functions whose on-chain parameters differ from ABI, or that are missing. */
const drifted = new Set();

function describeBody(body) {
  switch (body.$kind) {
    case 'vector':
      return `vector<${describeBody(body.vector)}>`;
    case 'datatype': {
      const name = body.datatype.typeName.split('::').slice(1).join('::');
      const params = body.datatype.typeParameters ?? [];
      return params.length ? `${name}<${params.map(describeBody).join(', ')}>` : name;
    }
    case 'typeParameter':
      return `T${body.index}`;
    default:
      return body.$kind;
  }
}

function describeParameters(parameters) {
  const described = parameters.map((p) => {
    const prefix = p.reference === 'mutable' ? '&mut ' : p.reference === 'immutable' ? '&' : '';
    return prefix + describeBody(p.body);
  });
  if (/^&(mut )?tx_context::TxContext$/.test(described.at(-1) ?? '')) described.pop();
  return described.join(', ');
}

async function checkAbi() {
  const problems = [];
  for (const [fn, expected] of Object.entries(ABI)) {
    const [moduleName, name] = fn.split('::');
    try {
      const { function: onChain } = await client.core.getMoveFunction({ packageId: PACKAGE, moduleName, name });
      const actual = describeParameters(onChain.parameters);
      if (actual !== expected) {
        drifted.add(fn);
        problems.push(`${fn} takes (${actual}) on chain; the source declares (${expected})`);
      }
    } catch {
      drifted.add(fn);
      problems.push(`${fn} is not in the package on chain`);
    }
  }
  if (problems.length) {
    record(
      'Function signatures',
      'FAIL',
      `the package was published from different source. Publish the current splash_core (runbook §3.2). ${problems.join('; ')}.`,
    );
  } else {
    record('Function signatures', 'PASS', `all ${Object.keys(ABI).length} match the source.`);
  }
}

/** A check whose calls differ on chain would fail with the node's unnamed
 *  error; it reports the mismatch instead. */
function blockedBy(functions) {
  const hit = functions.filter((fn) => drifted.has(fn));
  return hit.length ? `not run: ${hit.join(', ')} differ on chain (see Function signatures).` : null;
}

// ── Checks ────────────────────────────────────────────────────────────────────

async function checkChain() {
  const { chainIdentifier } = await client.core.getChainIdentifier();
  const chainId = Buffer.from(fromBase58(chainIdentifier).subarray(0, 4)).toString('hex');
  if (chainId !== CHAIN_IDS[NETWORK]) {
    refuse(`SUI_NETWORK is ${NETWORK} (chain ${CHAIN_IDS[NETWORK]}), but ${BASE_URL} serves chain ${chainId}.`);
  }
  if (EXECUTE && chainId !== CHAIN_IDS.testnet) {
    refuse('--execute runs on testnet only. On mainnet, run without it: the simulation checks the same calls.');
  }
  return chainId;
}

/** Published.toml records the package this source tree last published on each
 *  chain. Runbook §3.7 commits it after the publish, so a different id here
 *  means the environment or the file is stale. */
function checkPublishedToml(chainId) {
  const path = new URL('../move/splash_core/Published.toml', import.meta.url);
  if (!existsSync(path)) {
    record('Published.toml', 'WARN', 'move/splash_core/Published.toml is missing.');
    return;
  }
  const sections = readFileSync(path, 'utf8').split(/^\[/m);
  const section = sections.find((s) => new RegExp(`^\\s*chain-id\\s*=\\s*"${chainId}"`, 'm').test(s));
  const recorded = section?.match(/^\s*published-at\s*=\s*"(0x[0-9a-fA-F]+)"/m)?.[1];
  if (!recorded) {
    record('Published.toml', 'WARN', `no splash_core publish recorded for chain ${chainId}.`);
  } else if (normalizeSuiAddress(recorded) !== PACKAGE) {
    record(
      'Published.toml',
      'FAIL',
      `records ${recorded} for this chain, but the environment names ${PACKAGE}. Fix the id, or commit the regenerated Published.toml (runbook §3.7).`,
    );
  } else {
    record('Published.toml', 'PASS', `matches the configured package (chain ${chainId}).`);
  }
}

function ownerAddress(owner) {
  if (owner?.$kind === 'AddressOwner') return normalizeSuiAddress(owner.AddressOwner);
  return null;
}

async function fetchObject(id) {
  try {
    return (await client.core.getObject({ objectId: id })).object;
  } catch {
    return null;
  }
}

async function checkObject(label, envKey, id, expectedType, { shared }) {
  if (!id) {
    record(label, 'FAIL', `${envKey} is not set.`);
    return null;
  }
  const object = await fetchObject(id);
  if (!object) {
    record(label, 'FAIL', `${envKey} ${id} does not exist on this chain.`);
    return null;
  }
  if (normalizeType(object.type) !== expectedType) {
    record(label, 'FAIL', `${envKey} is a ${object.type}, not a ${expectedType}.`);
    return null;
  }
  if (shared && object.owner?.$kind !== 'Shared') {
    record(label, 'FAIL', `${envKey} is not a shared object.`);
    return null;
  }
  return object;
}

async function checkIds() {
  const pkg = await fetchObject(PACKAGE);
  if (!pkg || pkg.type !== 'package') {
    record('Core package', 'FAIL', `${PACKAGE} is not a package on this chain.`);
  } else {
    record('Core package', 'PASS', CORE_FROM_ENV ? PACKAGE : `${PACKAGE} (from the legacy SPLASH_PACKAGE_ID; set SPLASH_CORE_PACKAGE_ID too)`);
  }

  const anchorCap = await checkObject('AnchorCap', 'SPLASH_ANCHOR_CAP_ID', ANCHOR_CAP, typeIn('business_account::AnchorCap'), { shared: false });
  if (anchorCap) {
    const holder = ownerAddress(anchorCap.owner);
    if (holder === SENDER) {
      record('AnchorCap', 'PASS', `held by the operator ${SENDER}.`);
    } else {
      record('AnchorCap', 'FAIL', `held by ${holder ?? 'no address'}, not the operator ${SENDER}. Move it with rotate_anchor_cap (runbook §3.4).`);
    }
  }

  if (await checkObject('CapRegistry', 'SPLASH_CAP_REGISTRY_ID', CAP_REGISTRY, typeIn('cap_registry::CapRegistry'), { shared: true })) {
    record('CapRegistry', 'PASS', CAP_REGISTRY);
  }
  if (await checkObject('PegState', 'SPLASH_PEG_STATE_ID', PEG_STATE, typeIn('peg_monitor::PegState'), { shared: true })) {
    record('PegState', 'PASS', PEG_STATE);
  }
  if (await checkObject('BusinessAccount', 'SPLASH_BUSINESS_ACCOUNT_ID', BUSINESS, typeIn('business_account::BusinessAccount'), { shared: true })) {
    record('BusinessAccount', 'PASS', BUSINESS);
  }

  // The authority the hot key must NOT hold, read from what the operator owns,
  // so it is checked whether or not the ids are configured. The AdminCap and
  // the TreasuryCap go to the cold multisig (runbook §3.6) and have no
  // break-glass; the UpgradeCap is burned, or held by the multisig (§3.2).
  await checkNotHeld('AdminCap custody', 'business_account::AdminCap', typeIn('business_account::AdminCap'), 'Move it to the cold multisig (runbook §3.6).');
  await checkNotHeld('TreasuryCap custody', 'business_account::TreasuryCap', typeIn('business_account::TreasuryCap'), 'Move it to the cold multisig (runbook §3.6).');
  await checkNotHeld(
    'UpgradeCap custody',
    'UpgradeCap for this package',
    '0x2::package::UpgradeCap',
    'Burn it, or move it to the cold multisig (runbook §3.2).',
    (o) => typeof o.json?.package === 'string' && normalizeSuiAddress(o.json.package) === PACKAGE,
  );
  if (ADMIN_CAP && (await checkObject('AdminCap', 'SPLASH_ADMIN_CAP_ID', ADMIN_CAP, typeIn('business_account::AdminCap'), { shared: false }))) {
    record('AdminCap', 'PASS', ADMIN_CAP);
  }
}

/** Everything of `type` the operator owns, every page. */
async function ownedByOperator(type) {
  const objects = [];
  let cursor = null;
  do {
    const page = await client.core.listOwnedObjects({ owner: SENDER, type, cursor, limit: 50, include: { json: true } });
    objects.push(...page.objects);
    cursor = page.hasNextPage ? page.cursor : null;
  } while (cursor);
  return objects;
}

async function checkNotHeld(check, what, type, remedy, matches = () => true) {
  try {
    const held = (await ownedByOperator(type)).filter(matches);
    if (held.length) {
      record(
        check,
        NETWORK === 'mainnet' ? 'FAIL' : 'WARN',
        `the operator holds ${held.map((o) => o.objectId).join(', ')}. ${remedy}`,
      );
    } else {
      record(check, 'PASS', `the operator holds no ${what}.`);
    }
  } catch (e) {
    record(check, 'FAIL', `could not list the operator's objects: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function checkPeg() {
  if (!PEG_STATE) {
    record('Peg refresh (simulated)', 'FAIL', 'needs SPLASH_PEG_STATE_ID.');
    return;
  }
  const tx = new Transaction();
  tx.setGasBudget(10_000_000);
  tx.moveCall({
    target: `${PACKAGE}::peg_monitor::update_peg`,
    arguments: [
      tx.object(PEG_STATE),
      tx.object(ANCHOR_CAP),
      tx.object(CAP_REGISTRY),
      tx.pure.u64(0),
      tx.pure.u64(0),
      tx.object(CLOCK),
    ],
  });
  const { events } = await simulate('update_peg', tx);
  if (!findEvent(events, 'peg_monitor::PegUpdated')) throw new Error(`update_peg emitted ${eventNames(events)}, not PegUpdated.`);
  record('Peg refresh (simulated)', 'PASS', 'PegUpdated, on the AnchorCap and CapRegistry.');
}

function newCommitment() {
  // WS5. The chain gets a 32-byte commitment, never the payment itself.
  const salt = newSalt();
  const payload = {
    sender: SENDER,
    recipient: RECIPIENT,
    beneficiaryRef: '',
    amount: PAYMENT_MIST,
    currency: SUI,
    corridor: '',
    targetCurrency: 'PHP',
    fxRateUsdLocal: FX_RATE_SCALED,
  };
  return { salt, payload, commitment: paymentCommitment(payload, salt) };
}

function auditValues(commitment) {
  const auditHash = createHash('sha256').update(`e2e:${toHex(commitment)}`).digest('hex');
  return { auditHash, anchorId: `e2e:${Date.now().toString(36)}`, blobId: `e2e-no-blob:${auditHash.slice(0, 24)}` };
}

/** audit_anchor::anchor_audit_hash, as anchorAuditHashOnSui builds it. */
function addAuditAnchor(tx, { auditHash, anchorId, blobId }) {
  tx.moveCall({
    target: `${PACKAGE}::audit_anchor::anchor_audit_hash`,
    arguments: [
      tx.object(ANCHOR_CAP),
      tx.object(CAP_REGISTRY),
      tx.pure.string(auditHash),
      tx.pure.string(anchorId),
      tx.pure.string(blobId),
      tx.pure.address(BUSINESS),
      tx.object(CLOCK),
    ],
  });
}

/** Two anchors per settlement, as in confirmComposedPaymentOnSui: the receipt
 *  anchor (SettlementAnchored) and the audit-hash anchor (AuditAnchored). */
function addAnchors(tx, receipt, commitment) {
  const values = auditValues(commitment);
  tx.moveCall({
    target: `${PACKAGE}::audit_anchor::anchor`,
    arguments: [
      receipt,
      tx.pure.vector('u8', Array.from(Buffer.from(values.auditHash, 'utf8'))),
      tx.pure.vector('u8', Array.from(Buffer.from(values.blobId, 'utf8'))),
      tx.object(CLOCK),
    ],
  });
  addAuditAnchor(tx, values);
}

/** The AnchorCap and CapRegistry on their own: the ceremony's hand-over of
 *  anchor authority, without a payment around it. */
async function checkAuditAnchorSimulated() {
  const { commitment } = newCommitment();
  const tx = new Transaction();
  tx.setGasBudget(20_000_000);
  addAuditAnchor(tx, auditValues(commitment));
  const { events } = await simulate('anchor_audit_hash', tx);
  if (!findEvent(events, 'audit_anchor::AuditAnchored')) {
    throw new Error(`anchor_audit_hash emitted ${eventNames(events)}, not AuditAnchored.`);
  }
  record('Audit anchor (simulated)', 'PASS', 'AuditAnchored, on the AnchorCap and CapRegistry.');
}

function confirmProof(events) {
  const expected = ['payment_intent::IntentConfirmed', 'audit_anchor::SettlementAnchored', 'audit_anchor::AuditAnchored'];
  const missing = expected.filter((name) => !findEvent(events, name));
  if (missing.length) throw new Error(`missing ${missing.join(', ')}; emitted ${eventNames(events)}.`);
  if (events.some((e) => e.type.endsWith('::smart_treasury::TreasuryDeposited'))) {
    throw new Error('TreasuryDeposited was emitted. Phase 0 publishes no treasury.');
  }
}

function openIntent(tx, commitment) {
  tx.moveCall({
    target: `${PACKAGE}::payment_intent::create_payment_intent`,
    typeArguments: [SUI],
    arguments: [
      tx.pure.address(RECIPIENT),
      tx.pure.u64(PAYMENT_MIST),
      tx.pure.string('PHP'),
      tx.pure.u64(FX_RATE_SCALED),
      tx.pure.vector('u8', Array.from(commitment)),
      tx.object(CLOCK),
    ],
  });
}

async function checkIntentSimulated() {
  const { commitment } = newCommitment();
  const tx = new Transaction();
  tx.setGasBudget(30_000_000);
  openIntent(tx, commitment);
  const { events } = await simulate('create_payment_intent', tx);
  if (!findEvent(events, 'payment_intent::IntentCreated')) {
    throw new Error(`create_payment_intent emitted ${eventNames(events)}, not IntentCreated.`);
  }
  record('Payment intent (simulated)', 'PASS', 'IntentCreated.');
}

/**
 * The confirm, simulated in one transaction. A simulation cannot confirm an
 * intent opened by another simulation, so this opens one with `create<SUI>`,
 * which returns it instead of sharing it, confirms it through the same
 * `confirm_payment_intent<SUI>` the app calls on the shared object, anchors
 * both ways, and deletes the confirmed intent.
 */
async function checkConfirmSimulated() {
  const { commitment } = newCommitment();
  const tx = new Transaction();
  tx.setGasBudget(30_000_000);
  const [intent] = tx.moveCall({
    target: `${PACKAGE}::payment_intent::create`,
    typeArguments: [SUI],
    arguments: [
      tx.pure.address(RECIPIENT),
      tx.pure.vector('u8', Array.from(Buffer.from('e2e', 'utf8'))),
      tx.pure.u64(PAYMENT_MIST),
      tx.pure.vector('u8', Array.from(Buffer.from(SUI, 'utf8'))),
      tx.pure.vector('u8', Array.from(Buffer.from('USD-PHP', 'utf8'))),
      tx.pure.string('PHP'),
      tx.pure.u64(FX_RATE_SCALED),
      tx.pure.vector('u8', Array.from(commitment)),
      tx.object(CLOCK),
    ],
  });
  const [payment] = tx.splitCoins(tx.gas, [PAYMENT_MIST]);
  const [receipt] = tx.moveCall({
    target: `${PACKAGE}::payment_intent::confirm_payment_intent`,
    typeArguments: [SUI],
    arguments: [intent, payment, tx.object(CLOCK)],
  });
  addAnchors(tx, receipt, commitment);
  tx.moveCall({ target: `${PACKAGE}::payment_intent::delete_finalized`, arguments: [intent] });
  const { events } = await simulate('confirm', tx);
  confirmProof(events);
  record('Confirm + anchors (simulated)', 'PASS', 'IntentConfirmed, SettlementAnchored, AuditAnchored.');
}

/** --execute: the app's two transactions, for real, on testnet. */
async function checkPaymentExecuted() {
  const { salt, payload, commitment } = newCommitment();
  const open = new Transaction();
  open.setGasBudget(30_000_000);
  openIntent(open, commitment);
  const opened = await execute('create_payment_intent', open);
  const created = findEvent(opened.events, 'payment_intent::IntentCreated');
  const intentId = typeof created?.data.intent_id === 'string' ? created.data.intent_id : '';
  if (!intentId) throw new Error(`IntentCreated missing intent_id. Digest ${opened.digest}`);
  record('Payment intent (executed)', 'PASS', `${opened.digest}  intent ${intentId}`);

  // The salt and payload go to a plaintext bundle under .tmp/, and the events
  // of both transactions next to it, so this testnet settlement can be checked
  // with scripts/verify-commitment.mjs. A real payment keeps the salt and
  // payload only inside the Seal bundle.
  mkdirSync('.tmp', { recursive: true });
  const bundlePath = '.tmp/e2e-commitment-bundle.json';
  writeFileSync(
    bundlePath,
    JSON.stringify(
      {
        schema: 'splash.settlement-evidence.v2',
        settlement: {
          paymentIntentId: intentId,
          commitment: { tag: DOMAIN_TAGS.payment, commitmentHex: toHex(commitment), saltHex: toHex(salt), payload },
        },
      },
      null,
      2,
    ),
  );

  const confirm = new Transaction();
  confirm.setGasBudget(30_000_000);
  const [payment] = confirm.splitCoins(confirm.gas, [PAYMENT_MIST]);
  const [receipt] = confirm.moveCall({
    target: `${PACKAGE}::payment_intent::confirm_payment_intent`,
    typeArguments: [SUI],
    arguments: [confirm.object(intentId), payment, confirm.object(CLOCK)],
  });
  addAnchors(confirm, receipt, commitment);
  const confirmed = await execute('confirm', confirm);
  confirmProof(confirmed.events);
  record('Confirm + anchors (executed)', 'PASS', confirmed.digest);

  // IntentCreated is in the first transaction; IntentConfirmed and
  // SettlementAnchored in the second. One file carries all three, in the
  // `{ type, parsedJson }` shape verify-commitment reads.
  const eventsPath = '.tmp/e2e-events.json';
  writeFileSync(
    eventsPath,
    JSON.stringify([...opened.events, ...confirmed.events].map((e) => ({ type: e.type, parsedJson: e.data })), null, 2),
  );
  console.log(
    `  verify the commitment: node --experimental-strip-types scripts/verify-commitment.mjs --bundle ${bundlePath} --events ${eventsPath}`,
  );
}

async function run(check, fn) {
  try {
    await fn();
  } catch (e) {
    record(check, 'FAIL', explain(e instanceof Error ? e.message : String(e)));
  }
}

async function gated(check, functions, fn) {
  const blocked = blockedBy(functions);
  if (blocked) {
    record(check, 'FAIL', blocked);
    return;
  }
  await run(check, fn);
}

const CONFIRM_CALLS = [
  'payment_intent::create',
  'payment_intent::confirm_payment_intent',
  'audit_anchor::anchor',
  'audit_anchor::anchor_audit_hash',
  'payment_intent::delete_finalized',
];

async function main() {
  console.log(`\nsplash_core verify — ${EXECUTE ? 'EXECUTE (testnet, real transactions)' : 'simulation, nothing is sent'}`);
  console.log(`network=${NETWORK} rpc=${BASE_URL}`);
  const chainId = await checkChain();
  console.log(`chain=${chainId} package=${PACKAGE}`);
  console.log(`operator=${SENDER} recipient=${RECIPIENT === SENDER ? 'the operator' : RECIPIENT}`);
  if (existsSync(new URL('../data/contract-config.json', import.meta.url))) {
    console.log('note: data/contract-config.json exists. The app lets it override these ids; this script reads the environment only.');
  }
  console.log('');

  checkPublishedToml(chainId);
  await checkIds();
  await checkAbi();
  await gated('Peg refresh (simulated)', ['peg_monitor::update_peg'], checkPeg);
  if (BUSINESS) {
    await gated('Audit anchor (simulated)', ['audit_anchor::anchor_audit_hash'], checkAuditAnchorSimulated);
  } else {
    record('Anchors', 'FAIL', 'needs SPLASH_BUSINESS_ACCOUNT_ID, which the app passes to anchor_audit_hash.');
  }
  await gated('Payment intent (simulated)', ['payment_intent::create_payment_intent'], checkIntentSimulated);
  if (BUSINESS) await gated('Confirm + anchors (simulated)', CONFIRM_CALLS, checkConfirmSimulated);
  if (EXECUTE) {
    // Real transactions only after a clean simulation: gas spent on a
    // transaction the simulation already refused proves nothing.
    if (results.some((r) => r.status === 'FAIL')) {
      console.log('- --execute skipped: fix the failures above first.');
    } else {
      await run('Payment (executed)', checkPaymentExecuted);
    }
  }

  const failed = results.filter((r) => r.status === 'FAIL');
  const warned = results.filter((r) => r.status === 'WARN');
  console.log(
    `\n${failed.length ? `✗ ${failed.length} failed` : '✔ every check passed'}${warned.length ? `, ${warned.length} warning(s)` : ''}\n`,
  );
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((e) => {
  if (!(e instanceof Refused)) console.error('FATAL', e);
  process.exitCode = 1;
});
