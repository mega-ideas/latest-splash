#!/usr/bin/env node
/**
 * e2e-testnet — check a splash_core publish against the chain.
 *
 * The verify step of docs/KEY-CEREMONY-RUNBOOK.md §3.8. It checks the v2 core
 * package (splash_custody is not on the mainnet path), that the configured
 * ids, the AnchorCap, the CapRegistry and the ComplianceConfig work together,
 * and D11's end state around it:
 *
 *   ids      every configured object exists and belongs to this package; the
 *            AnchorCap is held by the operator address.
 *   end      D11, read from the chain by scripts/v2-end-state.mjs:
 *            splash_spend (SPLASH_SPEND_PACKAGE_ID) and splash_upgrade_delay
 *            (SPLASH_UPGRADE_DELAY_PACKAGE_ID) are version 1 with no later
 *            version, and were published and made immutable in one
 *            transaction, so no UpgradeCap for them ever outlived the
 *            publish; core's UpgradeCap is in SPLASH_UPGRADE_WRAPPER_ID, a
 *            DelayedUpgradeCap of that splash_upgrade_delay, policy additive
 *            (128), held by SPLASH_GOVERNANCE_ADDRESS. Amendment A1:
 *            FeeAdminCap (SPLASH_FEE_ADMIN_CAP_ID) is held by the
 *            governance multisig, OpsCap (SPLASH_OPS_CAP_ID) by the ops
 *            multisig (SPLASH_OPS_ADDRESS, else governance), the operator
 *            holds neither, and the FeeConfig (SPLASH_FEE_CONFIG_ID) pays
 *            no one until the ceremony applies the finance multisig
 *            (SPLASH_FINANCE_ADDRESS), then only it. Each id is optional:
 *            unset, its check is reported skipped, never passed.
 *   abi      every function called takes the parameters the current source
 *            declares, so a package published from older source is named.
 *   peg      peg_monitor::update_peg on the AnchorCap and CapRegistry
 *            → PegUpdated.
 *   anchor   audit_anchor::anchor_audit_hash on its own → AuditAnchored.
 *   payment  one transaction, as a business account's registered wallet with
 *            the operator paying gas: the wallet's address balance redeemed,
 *            payment_intent::create_for_wallet<USDC>,
 *            confirm_from_business_wallet_balance<USDC>, audit_anchor::anchor
 *            on its receipt, delete_finalized → IntentCreated,
 *            IntentConfirmed, SettlementAnchored. No TreasuryDeposited: the
 *            treasury is a custody module. Needs
 *            SPLASH_VERIFY_BUSINESS_ACCOUNT_ID; without it the check is
 *            skipped and says so.
 *   refusal  the same create_for_wallet as the operator must abort with
 *            business_account::E_NOT_THE_WALLET: in v2 the operator key cannot
 *            open, or pay, a business's intent.
 *
 * Every transaction is SIMULATED: the node runs it as the named sender would
 * and reports what it would do. Nothing is signed or sent, no coin moves, no
 * object is written and no gas is spent, so this is safe on any network,
 * mainnet included. The script holds no key and cannot sign. A simulation
 * checks no signatures, which is how it runs as the business wallet (a
 * multisig address) and the operator at once. The network and node come from
 * lib/sui.ts, as in the app.
 *
 * Executed payments are proved on testnet by experiments/v2-phase1/testnet-e2e.mjs,
 * which signs with test keys of its own. v2 has no operator-signed payment to
 * execute here: the old --execute (the operator opening and confirming an
 * intent) is exactly what v2 removed.
 *
 * Run:
 *   node --use-system-ca --experimental-strip-types --env-file=.env.local scripts/e2e-testnet.mjs
 */
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Transaction } from '@mysten/sui/transactions';
import { fromBase58, isValidSuiAddress, isValidSuiObjectId, normalizeSuiAddress } from '@mysten/sui/utils';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import { newSalt, paymentCommitment, paymentRefCommitment, railCommitment, toHex } from '../lib/evidence/commitment.ts';
import { SUI_USDC_COIN_TYPE } from '../lib/payments/stablecoin-lane.ts';
import { SUI_NETWORK, SUI_RPC_URL } from '../lib/sui.ts';
import { SPLASH_CORE_ABI } from './splash-core-abi.mjs';
import { checkCapHolder, checkFeeRecipient, checkImmutablePackage, checkUpgradeWrapper, isUpgradeCapFor } from './v2-end-state.mjs';

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
  stop(
    `Unknown argument ${arg}. This script takes none: it only simulates. Executed v2 payments are proved on testnet by experiments/v2-phase1/testnet-e2e.mjs.`,
  );
}

// The app's own resolution, so this asks the node the app asks.
const NETWORK = SUI_NETWORK;
const BASE_URL = SUI_RPC_URL;
if (!BASE_URL) stop('SUI_RPC_URL is set but empty. Unset it for the default node, or name one.');
const client = new SuiGrpcClient({ network: NETWORK, baseUrl: BASE_URL });

/** First four bytes of the genesis checkpoint digest, as Published.toml and
 *  Move.toml write chain ids. */
const CHAIN_IDS = { testnet: '4c78adac', mainnet: '35834a8a' };

const CLOCK = '0x6';
// 0.01 USDC. Enough to prove the wallet can pay; a simulation moves nothing.
const PAYMENT_MINOR = 10_000;
// The payer's bound on Splash's fee (A1 §2.6): fee_config's 100 bps ceiling
// of the payment, which no fee can exceed. Core charges the fee the derived
// kind's schedule gives (0 to the wallet's own address, a Splash business)
// and returns the unused part to the wallet's address balance.
const MAX_FEE_MINOR = PAYMENT_MINOR / 100;
// A wallet payment in USDC pays USDC: one to one, scaled 1e6.
const FX_RATE_SCALED = 1_000_000;
// fee_config::KIND_WALLET, and business_account::E_NOT_THE_WALLET.
// tests/e2e-verify-abi.test.mjs holds both to the source.
const KIND_WALLET = 1;
const E_NOT_THE_WALLET = 50;
const INTENT_LIFETIME_MS = 3_600_000;
const SETTLE_WINDOW_MS = 1_800_000;

function objectIdFromEnv(key, { required }) {
  const value = env(key);
  if (!value) {
    if (required) stop(`${key} is required.`);
    return '';
  }
  if (!isValidSuiObjectId(normalizeSuiAddress(value))) stop(`${key} is not a Sui object id: ${value}`);
  return normalizeSuiAddress(value);
}

/** An optional Sui address from the environment, normalized; '' when unset. */
function addressFromEnv(key) {
  const value = env(key);
  if (!value) return '';
  if (!isValidSuiAddress(normalizeSuiAddress(value))) stop(`${key} is not a Sui address: ${value}`);
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
const COMPLIANCE_CONFIG = objectIdFromEnv('SPLASH_COMPLIANCE_CONFIG_ID', { required: false });
// Amendment A1: the fee config and the address registry the settle paths read.
const FEE_CONFIG = objectIdFromEnv('SPLASH_FEE_CONFIG_ID', { required: false });
const ADDRESS_REGISTRY = objectIdFromEnv('SPLASH_ADDRESS_REGISTRY_ID', { required: false });
const BUSINESS = objectIdFromEnv('SPLASH_BUSINESS_ACCOUNT_ID', { required: false });
const ADMIN_CAP = objectIdFromEnv('SPLASH_ADMIN_CAP_ID', { required: false });
// A business account with a registered wallet that holds USDC in its address
// balance. Only the payment check uses it; it is never the app's own account.
const VERIFY_ACCOUNT = objectIdFromEnv('SPLASH_VERIFY_BUSINESS_ACCOUNT_ID', { required: false });

const operatorFromEnv = env('OPERATOR_SUI_ADDRESS');
if (operatorFromEnv && !isValidSuiAddress(normalizeSuiAddress(operatorFromEnv))) {
  stop(`OPERATOR_SUI_ADDRESS is not a Sui address: ${operatorFromEnv}`);
}
const OPERATOR = operatorFromEnv ? normalizeSuiAddress(operatorFromEnv) : '';
if (!OPERATOR) stop('Set OPERATOR_SUI_ADDRESS. The simulations run as that address, or with it paying gas.');
const recipientFromEnv = env('SPLASH_TEST_RECIPIENT_ADDRESS');
if (recipientFromEnv && !isValidSuiAddress(normalizeSuiAddress(recipientFromEnv))) {
  stop(`SPLASH_TEST_RECIPIENT_ADDRESS is not a Sui address: ${recipientFromEnv}`);
}
// Without one, the simulated payment goes back to the wallet that makes it.
const RECIPIENT_FROM_ENV = recipientFromEnv ? normalizeSuiAddress(recipientFromEnv) : '';

// D11's end state. Each is optional: unset, its check is reported skipped,
// never passed. SPLASH_CORE_PACKAGE_ID above is the core's ORIGINAL id, which
// the wrapper records.
const SPEND_PACKAGE = objectIdFromEnv('SPLASH_SPEND_PACKAGE_ID', { required: false });
const DELAY_PACKAGE = objectIdFromEnv('SPLASH_UPGRADE_DELAY_PACKAGE_ID', { required: false });
const UPGRADE_WRAPPER = objectIdFromEnv('SPLASH_UPGRADE_WRAPPER_ID', { required: false });
const governanceFromEnv = env('SPLASH_GOVERNANCE_ADDRESS');
if (governanceFromEnv && !isValidSuiAddress(normalizeSuiAddress(governanceFromEnv))) {
  stop(`SPLASH_GOVERNANCE_ADDRESS is not a Sui address: ${governanceFromEnv}`);
}
// The governance multisig that must hold the wrapper.
const GOVERNANCE = governanceFromEnv ? normalizeSuiAddress(governanceFromEnv) : '';

// Amendment A1's end state (the A1 review), each optional like the above:
// FeeAdminCap held by the governance multisig, OpsCap by the ops multisig
// (SPLASH_OPS_ADDRESS, else the governance multisig), and the FeeConfig
// (SPLASH_FEE_CONFIG_ID) paying no one until the ceremony applies the finance
// multisig (SPLASH_FINANCE_ADDRESS), then only it.
const FEE_ADMIN_CAP = objectIdFromEnv('SPLASH_FEE_ADMIN_CAP_ID', { required: false });
const OPS_CAP = objectIdFromEnv('SPLASH_OPS_CAP_ID', { required: false });
const OPS = addressFromEnv('SPLASH_OPS_ADDRESS');
const FINANCE = addressFromEnv('SPLASH_FINANCE_ADDRESS');

// The coin the app settles in (USDC_TYPE), or Circle's USDC on this network
// when USDC_TYPE is unset or the development stand-in.
const usdcFromEnv = env('USDC_TYPE');
const USDC = usdcFromEnv && usdcFromEnv !== '0x2::sui::SUI' ? usdcFromEnv : SUI_USDC_COIN_TYPE[NETWORK];

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

/** The abort a refusal reports: its code, and where in this package. */
function abortOf(message) {
  const m = /abort code: (\d+), in '(0x[0-9a-fA-F]+)::(\w+)::(\w+)'/.exec(message);
  if (!m) return null;
  return { code: Number(m[1]), package: normalizeSuiAddress(m[2]), module: m[3], fn: m[4] };
}

/**
 * Simulate `tx` as `sender`, with `gasOwner` paying gas when it is someone
 * else. Throws with the node's reason when it would abort, whether the node
 * says so while tx.build resolves the transaction or in the simulation.
 */
async function simulate(label, tx, { sender = OPERATOR, gasOwner = null } = {}) {
  tx.setSender(sender);
  if (gasOwner) tx.setGasOwner(gasOwner);
  let t;
  try {
    const bytes = await tx.build({ client });
    const res = await client.core.simulateTransaction({ transaction: bytes, include: { effects: true, events: true } });
    t = res.$kind === 'Transaction' ? res.Transaction : res.FailedTransaction;
  } catch (e) {
    const reason = e?.executionError?.message ?? (e instanceof Error ? e.message : String(e));
    throw new Error(`${label} would abort: ${reason}`);
  }
  if (!t.status.success) throw new Error(`${label} would abort: ${t.status.error?.message ?? 'no reason given'}`);
  return { events: eventsOf(t) };
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

async function fetchObject(id, include) {
  try {
    return (await client.core.getObject({ objectId: id, include })).object;
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
    if (holder === OPERATOR) {
      record('AnchorCap', 'PASS', `held by the operator ${OPERATOR}.`);
    } else {
      record('AnchorCap', 'FAIL', `held by ${holder ?? 'no address'}, not the operator ${OPERATOR}. Move it with rotate_anchor_cap (runbook §3.4).`);
    }
  }

  if (await checkObject('CapRegistry', 'SPLASH_CAP_REGISTRY_ID', CAP_REGISTRY, typeIn('cap_registry::CapRegistry'), { shared: true })) {
    record('CapRegistry', 'PASS', CAP_REGISTRY);
  }
  if (await checkObject('PegState', 'SPLASH_PEG_STATE_ID', PEG_STATE, typeIn('peg_monitor::PegState'), { shared: true })) {
    record('PegState', 'PASS', PEG_STATE);
  }
  if (
    await checkObject('ComplianceConfig', 'SPLASH_COMPLIANCE_CONFIG_ID', COMPLIANCE_CONFIG, typeIn('compliance_config::ComplianceConfig'), {
      shared: true,
    })
  ) {
    record('ComplianceConfig', 'PASS', COMPLIANCE_CONFIG);
  }
  if (await checkObject('FeeConfig', 'SPLASH_FEE_CONFIG_ID', FEE_CONFIG, typeIn('fee_config::FeeConfig'), { shared: true })) {
    record('FeeConfig', 'PASS', FEE_CONFIG);
  }
  if (
    await checkObject('Registry', 'SPLASH_ADDRESS_REGISTRY_ID', ADDRESS_REGISTRY, typeIn('address_registry::Registry'), {
      shared: true,
    })
  ) {
    record('Registry', 'PASS', ADDRESS_REGISTRY);
  }
  if (await checkObject('BusinessAccount', 'SPLASH_BUSINESS_ACCOUNT_ID', BUSINESS, typeIn('business_account::BusinessAccount'), { shared: true })) {
    record('BusinessAccount', 'PASS', BUSINESS);
  }

  // The authority the hot key must NOT hold, read from what the operator owns,
  // so it is checked whether or not the ids are configured. The AdminCap and
  // the TreasuryCap go to the cold multisig (runbook §3.6) and have no
  // break-glass; in v2 the UpgradeCap goes into the splash_upgrade_delay
  // wrapper (docs/UPGRADE-POLICY.md), which checkEndState reads. An
  // UpgradeCap whose package the node does not return counts as core's.
  await checkNotHeld('AdminCap custody', 'business_account::AdminCap', typeIn('business_account::AdminCap'), 'Move it to the cold multisig (runbook §3.6).');
  await checkNotHeld('TreasuryCap custody', 'business_account::TreasuryCap', typeIn('business_account::TreasuryCap'), 'Move it to the cold multisig (runbook §3.6).');
  await checkNotHeld(
    'UpgradeCap custody',
    'UpgradeCap for this package',
    '0x2::package::UpgradeCap',
    'Wrap it in splash_upgrade_delay under the governance multisig (docs/UPGRADE-POLICY.md).',
    (o) => isUpgradeCapFor(o, PACKAGE),
  );
  // Amendment A1's two capabilities, minted to the publisher: the hot key
  // must hold neither (checkEndState checks who does).
  await checkNotHeld(
    'FeeAdminCap custody',
    'fee_config::FeeAdminCap',
    typeIn('fee_config::FeeAdminCap'),
    'Move it to the governance multisig: with it one key sets any discount at once and proposes any fee schedule or recipient.',
  );
  await checkNotHeld(
    'OpsCap custody',
    'address_registry::OpsCap',
    typeIn('address_registry::OpsCap'),
    'Move it to the ops multisig (or the governance multisig): with it one key adds or removes partner deposit addresses at once.',
  );
  if (ADMIN_CAP && (await checkObject('AdminCap', 'SPLASH_ADMIN_CAP_ID', ADMIN_CAP, typeIn('business_account::AdminCap'), { shared: false }))) {
    record('AdminCap', 'PASS', ADMIN_CAP);
  }
}

/**
 * D11's end state (scripts/v2-end-state.mjs): splash_spend and
 * splash_upgrade_delay can never be upgraded, and core's UpgradeCap is in the
 * canonical wrapper, additive, held by the governance multisig. Reads only.
 */
async function checkEndState() {
  const records = [
    await checkImmutablePackage(client, { label: 'splash_spend immutable', envKey: 'SPLASH_SPEND_PACKAGE_ID', packageId: SPEND_PACKAGE }),
    await checkImmutablePackage(client, {
      label: 'upgrade_delay immutable',
      envKey: 'SPLASH_UPGRADE_DELAY_PACKAGE_ID',
      packageId: DELAY_PACKAGE,
    }),
    ...(await checkUpgradeWrapper(client, {
      wrapperId: UPGRADE_WRAPPER,
      delayPackageId: DELAY_PACKAGE,
      corePackageId: PACKAGE,
      governance: GOVERNANCE,
      operator: OPERATOR,
    })),
    // Amendment A1 (the A1 review).
    await checkCapHolder(client, {
      check: 'FeeAdminCap holder',
      envKey: 'SPLASH_FEE_ADMIN_CAP_ID',
      capId: FEE_ADMIN_CAP,
      capType: 'fee_config::FeeAdminCap',
      corePackageId: PACKAGE,
      holder: GOVERNANCE,
      holderKey: 'SPLASH_GOVERNANCE_ADDRESS',
      holderName: 'the governance multisig',
      power: 'it could set any discount at once and propose any fee schedule or recipient alone',
      operator: OPERATOR,
    }),
    await checkCapHolder(client, {
      check: 'OpsCap holder',
      envKey: 'SPLASH_OPS_CAP_ID',
      capId: OPS_CAP,
      capType: 'address_registry::OpsCap',
      corePackageId: PACKAGE,
      holder: OPS || GOVERNANCE,
      holderKey: OPS ? 'SPLASH_OPS_ADDRESS' : 'SPLASH_OPS_ADDRESS (or SPLASH_GOVERNANCE_ADDRESS)',
      holderName: OPS ? 'the ops multisig' : 'the governance multisig',
      power: 'it could add or remove a partner deposit address alone, at once',
      operator: OPERATOR,
    }),
    await checkFeeRecipient(client, { feeConfigId: FEE_CONFIG, corePackageId: PACKAGE, finance: FINANCE }),
  ];
  for (const r of records) record(r.check, r.status, r.detail);
}

/** Everything of `type` the operator owns, every page. */
async function ownedByOperator(type) {
  const objects = [];
  let cursor = null;
  do {
    const page = await client.core.listOwnedObjects({ owner: OPERATOR, type, cursor, limit: 50, include: { json: true } });
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

function auditValues(seed) {
  const auditHash = createHash('sha256').update(`e2e:${toHex(seed)}`).digest('hex');
  return { auditHash, anchorId: `e2e:${Date.now().toString(36)}`, blobId: `e2e-no-blob:${auditHash.slice(0, 24)}` };
}

/** audit_anchor::anchor_audit_hash, as anchorAuditHashOnSui builds it. The
 *  operator's own transaction: the AnchorCap is the operator's owned object,
 *  so it cannot be an input to a transaction the business wallet sends. */
async function checkAuditAnchorSimulated() {
  const { auditHash, anchorId, blobId } = auditValues(newSalt());
  const tx = new Transaction();
  tx.setGasBudget(20_000_000);
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
  const { events } = await simulate('anchor_audit_hash', tx);
  if (!findEvent(events, 'audit_anchor::AuditAnchored')) {
    throw new Error(`anchor_audit_hash emitted ${eventNames(events)}, not AuditAnchored.`);
  }
  record('Audit anchor (simulated)', 'PASS', 'AuditAnchored, on the AnchorCap and CapRegistry.');
}

/** The verify account's registered wallet, read from the chain. */
async function verifyWallet() {
  const account = await fetchObject(VERIFY_ACCOUNT, { json: true });
  if (!account) throw new Error(`SPLASH_VERIFY_BUSINESS_ACCOUNT_ID ${VERIFY_ACCOUNT} does not exist on this chain.`);
  if (normalizeType(account.type) !== typeIn('business_account::BusinessAccount')) {
    throw new Error(`SPLASH_VERIFY_BUSINESS_ACCOUNT_ID is a ${account.type}, not a BusinessAccount of this package.`);
  }
  const wallet = account.json?.wallet;
  if (typeof wallet !== 'string' || !isValidSuiAddress(normalizeSuiAddress(wallet))) {
    throw new Error('SPLASH_VERIFY_BUSINESS_ACCOUNT_ID has no registered wallet. Register one (business_account::register_wallet) first.');
  }
  return normalizeSuiAddress(wallet);
}

/**
 * The 32-byte values an intent carries, built as the app builds them
 * (lib/evidence/commitment.ts): the payment and rail commitments, and a
 * payment reference no earlier intent has claimed.
 */
function intentValues(wallet, recipient) {
  const salt = newSalt();
  const commitment = paymentCommitment(
    {
      sender: wallet,
      recipient,
      beneficiaryRef: '',
      amount: PAYMENT_MINOR,
      currency: USDC,
      corridor: '',
      targetCurrency: 'USDC',
      fxRateUsdLocal: FX_RATE_SCALED,
    },
    salt,
  );
  const rail = railCommitment({ rail: 'sui', partnerReference: '' }, salt);
  const paymentRef = paymentRefCommitment({ businessAccountId: VERIFY_ACCOUNT, paymentId: `e2e:${Date.now().toString(36)}` }, newSalt());
  return { commitment, rail, paymentRef };
}

/** payment_intent::create_for_wallet<USDC>, a kind-1 (wallet) intent. */
function openForWallet(tx, { recipient, commitment, rail, paymentRef }) {
  const now = Date.now();
  const [intent] = tx.moveCall({
    target: `${PACKAGE}::payment_intent::create_for_wallet`,
    typeArguments: [USDC],
    arguments: [
      tx.object(VERIFY_ACCOUNT),
      tx.object(COMPLIANCE_CONFIG),
      tx.pure.vector('u8', Array.from(paymentRef)),
      tx.pure.address(recipient),
      tx.pure.vector('u8', []),
      tx.pure.u64(PAYMENT_MINOR),
      tx.pure.string('USDC'),
      tx.pure.u64(FX_RATE_SCALED),
      tx.pure.vector('u8', Array.from(commitment)),
      tx.pure.u8(KIND_WALLET),
      tx.pure.vector('u8', Array.from(rail)),
      tx.pure.u64(now + INTENT_LIFETIME_MS),
      tx.object(CLOCK),
    ],
  });
  return intent;
}

/**
 * The v2 wallet path in one transaction, as the business wallet with the
 * operator paying gas: redeem the wallet's address balance, open the intent,
 * pay it from that balance, anchor the receipt and delete the confirmed
 * intent. A simulation cannot pay an intent another simulation opened, so
 * the intent is opened and paid in the same transaction, as the app does.
 */
async function checkWalletPaymentSimulated() {
  if (!COMPLIANCE_CONFIG || !FEE_CONFIG || !ADDRESS_REGISTRY) {
    record('Wallet payment (simulated)', 'FAIL', 'needs SPLASH_COMPLIANCE_CONFIG_ID, SPLASH_FEE_CONFIG_ID and SPLASH_ADDRESS_REGISTRY_ID.');
    return;
  }
  const wallet = await verifyWallet();
  const recipient = RECIPIENT_FROM_ENV || wallet;
  const { balance } = await client.core.getBalance({ owner: wallet, coinType: USDC });
  if (BigInt(balance.addressBalance ?? 0) < BigInt(PAYMENT_MINOR + MAX_FEE_MINOR)) {
    throw new Error(
      `the wallet ${wallet} has ${balance.addressBalance ?? 0} of ${USDC} in its address balance; the check draws ${PAYMENT_MINOR + MAX_FEE_MINOR} (the payment and the most its fee can be). Send it some with coin::send_funds.`,
    );
  }

  const values = intentValues(wallet, recipient);
  const { auditHash, blobId } = auditValues(values.commitment);
  const tx = new Transaction();
  tx.setGasBudget(50_000_000);
  const withdrawal = tx.withdrawal({ amount: PAYMENT_MINOR + MAX_FEE_MINOR, type: USDC });
  const [payment] = tx.moveCall({ target: '0x2::balance::redeem_funds', typeArguments: [USDC], arguments: [withdrawal] });
  const intent = openForWallet(tx, { recipient, ...values });
  const [receipt] = tx.moveCall({
    target: `${PACKAGE}::payment_intent::confirm_from_business_wallet_balance`,
    typeArguments: [USDC],
    arguments: [
      intent,
      tx.object(VERIFY_ACCOUNT),
      tx.object(COMPLIANCE_CONFIG),
      tx.object(FEE_CONFIG),
      tx.object(ADDRESS_REGISTRY),
      payment,
      tx.pure.u64(MAX_FEE_MINOR),
      tx.pure.u64(Date.now() + SETTLE_WINDOW_MS),
      tx.object(CLOCK),
    ],
  });
  tx.moveCall({
    target: `${PACKAGE}::audit_anchor::anchor`,
    arguments: [
      receipt,
      tx.pure.vector('u8', Array.from(Buffer.from(auditHash, 'utf8'))),
      tx.pure.vector('u8', Array.from(Buffer.from(blobId, 'utf8'))),
      tx.object(CLOCK),
    ],
  });
  tx.moveCall({ target: `${PACKAGE}::payment_intent::delete_finalized`, arguments: [intent] });

  const { events } = await simulate('the wallet payment', tx, { sender: wallet, gasOwner: OPERATOR });
  const expected = ['payment_intent::IntentCreated', 'payment_intent::IntentConfirmed', 'audit_anchor::SettlementAnchored'];
  const missing = expected.filter((name) => !findEvent(events, name));
  if (missing.length) throw new Error(`missing ${missing.join(', ')}; emitted ${eventNames(events)}.`);
  if (events.some((e) => e.type.endsWith('::smart_treasury::TreasuryDeposited'))) {
    throw new Error('TreasuryDeposited was emitted. The mainnet path has no treasury.');
  }
  record(
    'Wallet payment (simulated)',
    'PASS',
    `IntentCreated, IntentConfirmed, SettlementAnchored, as the wallet ${wallet} with the operator paying gas.`,
  );
}

/** The v2 property the payment check cannot show: the operator alone cannot
 *  open a business's intent, so it cannot pay one either. */
async function checkOperatorRefused() {
  if (!COMPLIANCE_CONFIG) {
    record('Operator refused (simulated)', 'FAIL', 'needs SPLASH_COMPLIANCE_CONFIG_ID.');
    return;
  }
  const wallet = await verifyWallet();
  const tx = new Transaction();
  tx.setGasBudget(50_000_000);
  const intent = openForWallet(tx, { recipient: OPERATOR, ...intentValues(wallet, OPERATOR) });
  tx.moveCall({ target: `${PACKAGE}::payment_intent::share_intent`, arguments: [intent] });
  let reason;
  try {
    await simulate('create_for_wallet as the operator', tx);
  } catch (e) {
    reason = e instanceof Error ? e.message : String(e);
  }
  if (reason === undefined) {
    throw new Error('create_for_wallet as the operator would succeed. The operator must not be able to open a business intent.');
  }
  const abort = abortOf(reason);
  if (!abort || abort.package !== PACKAGE || abort.module !== 'business_account' || abort.code !== E_NOT_THE_WALLET) {
    throw new Error(`expected business_account abort ${E_NOT_THE_WALLET} (E_NOT_THE_WALLET); ${reason}`);
  }
  record('Operator refused (simulated)', 'PASS', `create_for_wallet as the operator aborts ${E_NOT_THE_WALLET} (E_NOT_THE_WALLET) in business_account::${abort.fn}.`);
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

const PAYMENT_CALLS = [
  'payment_intent::create_for_wallet',
  'payment_intent::confirm_from_business_wallet_balance',
  'audit_anchor::anchor',
  'payment_intent::delete_finalized',
];
const REFUSAL_CALLS = ['payment_intent::create_for_wallet', 'payment_intent::share_intent'];

async function main() {
  console.log('\nsplash_core verify — simulation, nothing is signed or sent');
  console.log(`network=${NETWORK} rpc=${BASE_URL}`);
  const chainId = await checkChain();
  console.log(`chain=${chainId} package=${PACKAGE}`);
  console.log(`operator=${OPERATOR} settlement asset=${USDC}`);
  if (existsSync(new URL('../data/contract-config.json', import.meta.url))) {
    console.log('note: data/contract-config.json exists. The app lets it override these ids; this script reads the environment only.');
  }
  console.log('');

  checkPublishedToml(chainId);
  await checkIds();
  await checkEndState();
  await checkAbi();
  await gated('Peg refresh (simulated)', ['peg_monitor::update_peg'], checkPeg);
  if (BUSINESS) {
    await gated('Audit anchor (simulated)', ['audit_anchor::anchor_audit_hash'], checkAuditAnchorSimulated);
  } else {
    record('Audit anchor (simulated)', 'FAIL', 'needs SPLASH_BUSINESS_ACCOUNT_ID, which the app passes to anchor_audit_hash.');
  }
  if (VERIFY_ACCOUNT) {
    await gated('Wallet payment (simulated)', PAYMENT_CALLS, checkWalletPaymentSimulated);
    await gated('Operator refused (simulated)', REFUSAL_CALLS, checkOperatorRefused);
  } else {
    const why = 'skipped: set SPLASH_VERIFY_BUSINESS_ACCOUNT_ID to a business account whose registered wallet holds USDC in its address balance.';
    record('Wallet payment (simulated)', 'SKIP', why);
    record('Operator refused (simulated)', 'SKIP', why);
  }

  const failed = results.filter((r) => r.status === 'FAIL');
  const warned = results.filter((r) => r.status === 'WARN');
  const skipped = results.filter((r) => r.status === 'SKIP');
  console.log(
    `\n${failed.length ? `✗ ${failed.length} failed` : '✔ every check that ran passed'}${warned.length ? `, ${warned.length} warning(s)` : ''}${skipped.length ? `, ${skipped.length} skipped` : ''}\n`,
  );
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((e) => {
  if (!(e instanceof Refused)) console.error('FATAL', e);
  process.exitCode = 1;
});
