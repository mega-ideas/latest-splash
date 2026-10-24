#!/usr/bin/env node
/**
 * Update the on-chain ComplianceConfig risk parameters (ComplianceCap-gated).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️  THESE ARE REAL RISK CONTROLS. Read before changing anything.
 *
 * `max_slippage_bps` defines the price band used by
 * `liquidity_guard::assert_deepbook_liquidity` (splash_custody, testnet only):
 * settlement only clears if DeepBook
 * holds at least `min_depth_base_units` of BID depth within
 * [mid*(1 - slippage), mid].
 *
 * WHY THIS TOOL EXISTS: on Sui **testnet** the SUI/DBUSDC book is thin — the
 * measured spread was ~43 bps (mid 0.691, best bid 0.688). A mainnet-grade
 * 30 bps tolerance therefore captures ZERO bids, so every batch aborts with
 * 304 E_INSUFFICIENT_DEPTH no matter how well funded the pool is. Widening the
 * band on testnet is a deliberate, documented environment decision.
 *
 * ON MAINNET: keep the band tight (30 bps or tighter). Do NOT copy the testnet
 * value forward — a wide band means a batch can clear at a materially worse
 * price than mid, which is exactly the loss this control exists to prevent.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Run (values are explicit — nothing is silently defaulted):
 *   node --use-system-ca --env-file=.env.local scripts/set-compliance-config.mjs \
 *     --slippage-bps 150 --min-depth 1000000 --deviation-ppm 3000 --staleness-ms 60000
 *
 * DeepBook venue whitelist (audit S-12) — these are separate transactions from
 * the threshold update, on purpose, so each venue change lands as its own
 * auditable event:
 *   ... scripts/set-compliance-config.mjs --allow-pool 0x1c19362c…
 *   ... scripts/set-compliance-config.mjs --disallow-pool 0x1c19362c…
 * The last remaining venue cannot be removed; add the replacement first. To halt
 * settlement entirely use the pause switch, not an empty whitelist.
 */
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Secp256k1Keypair } from '@mysten/sui/keypairs/secp256k1';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';

const env = (k) => (process.env[k] ?? '').trim();
const NETWORK = env('SUI_NETWORK') === 'mainnet' ? 'mainnet' : 'testnet';
const client = new SuiGrpcClient({
  network: NETWORK,
  baseUrl: env('SUI_RPC_URL') || `https://fullnode.${NETWORK}.sui.io:443`,
});

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1];
}

const PACKAGE = env('SPLASH_PACKAGE_ID');
const CONFIG = env('SPLASH_COMPLIANCE_CONFIG_ID');
const CAP = env('SPLASH_COMPLIANCE_CAP_ID');
// Phase 7: every use of the compliance cap is checked against the shared
// registry, so a revoked cap is refused on chain (abort 210) rather than by
// convention off it.
const REGISTRY = env('SPLASH_CAP_REGISTRY_ID');
if (!PACKAGE || !CONFIG || !CAP || !REGISTRY) {
  throw new Error(
    'SPLASH_PACKAGE_ID, SPLASH_COMPLIANCE_CONFIG_ID, SPLASH_COMPLIANCE_CAP_ID and ' +
      'SPLASH_CAP_REGISTRY_ID are required.',
  );
}

async function readConfig() {
  const res = await client.core.getObject({ objectId: CONFIG, include: { json: true } });
  return (res.object ?? res).json;
}

function operatorKeypair() {
  const encoded = env('OPERATOR_SUI_PRIVATE_KEY') || env('SUI_SPONSOR_PRIVATE_KEY');
  if (!encoded) throw new Error('OPERATOR_SUI_PRIVATE_KEY is required.');
  const { scheme, secretKey } = decodeSuiPrivateKey(encoded);
  return scheme === 'Secp256k1'
    ? Secp256k1Keypair.fromSecretKey(secretKey)
    : Ed25519Keypair.fromSecretKey(secretKey);
}

async function submit(tx, label) {
  const result = await client.signAndExecuteTransaction({
    signer: operatorKeypair(),
    transaction: tx,
    include: { effects: true },
  });
  const executed = result.Transaction ?? result.FailedTransaction;
  if (result.$kind !== 'Transaction' || !executed.status.success) {
    throw new Error(`${label} failed: ${JSON.stringify(executed?.status?.error)}`);
  }
  await client.waitForTransaction({ digest: executed.digest }).catch(() => {});
  console.log(`${label} digest:`, executed.digest);
  return executed.digest;
}

const current = await readConfig();
console.log('current on-chain config:', current);

// ─── DeepBook venue whitelist (S-12) ────────────────────────────────────────
// Handled first and as its own transaction: a venue change is a security event
// and should never be buried inside a routine threshold tweak.
const allowPool = arg('allow-pool');
const disallowPool = arg('disallow-pool');
if (allowPool || disallowPool) {
  if (current.allowed_deepbook_pools === undefined) {
    throw new Error(
      'The deployed package predates the DeepBook whitelist (audit S-12). Republish before managing venues.',
    );
  }
  const poolId = (allowPool ?? disallowPool).trim();
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(poolId)) {
    throw new Error(`--${allowPool ? 'allow' : 'disallow'}-pool expects a 0x object id, got: ${poolId}`);
  }
  // Prove the id is a live DeepBook pool before whitelisting it — a typo here
  // would either brick settlement or, worse, authorize the wrong venue.
  if (allowPool) {
    const probe = await client.core.getObject({ objectId: poolId, include: { json: true } }).catch(() => null);
    const type = probe?.object?.type ?? probe?.type ?? '';
    if (!String(type).includes('::pool::Pool<')) {
      throw new Error(`${poolId} does not look like a DeepBook Pool (type: ${type || 'unreadable'}). Refusing to whitelist it.`);
    }
    console.log(`verified ${poolId} is ${type}`);
  }

  // Phase 6: adding a venue is AdminCap (the cold multisig), removing one is
  // ComplianceCap. S-12 is the attack where someone stands up their own pool
  // and satisfies the depth and slippage guards trivially, so naming a venue
  // is not a compliance-key power.
  const ADMIN_CAP = env('SPLASH_ADMIN_CAP_ID');
  if (allowPool && !ADMIN_CAP) {
    throw new Error(
      'Adding a DeepBook venue requires the AdminCap (SPLASH_ADMIN_CAP_ID), which lives on the ' +
        'cold multisig. Removing one only needs the ComplianceCap. See docs/KEY-CEREMONY-RUNBOOK.md.',
    );
  }
  const poolTx = new Transaction();
  poolTx.setGasBudget('20000000');
  poolTx.moveCall({
    target: `${PACKAGE}::compliance_config::${allowPool ? 'admin_allow_pool' : 'disallow_pool'}`,
    arguments: allowPool
      ? [poolTx.object(ADMIN_CAP), poolTx.object(CONFIG), poolTx.pure.id(poolId)]
      : [poolTx.object(CONFIG), poolTx.object(CAP), poolTx.object(REGISTRY), poolTx.pure.id(poolId)],
  });
  await submit(poolTx, allowPool ? 'admin_allow_pool' : 'disallow_pool');
  console.log('whitelist now:', (await readConfig()).allowed_deepbook_pools);

  // Venue management is a standalone operation. Only fall through to the
  // threshold update if the caller also passed threshold flags.
  const thresholdFlags = ['deviation-ppm', 'staleness-ms', 'slippage-bps', 'min-depth', 'min-settlement'];
  if (!thresholdFlags.some((flag) => arg(flag) !== null)) process.exit(0);
}

const next = {
  deviationPpm: Number(arg('deviation-ppm') ?? current.max_deviation_ppm),
  stalenessMs: Number(arg('staleness-ms') ?? current.max_staleness_ms),
  slippageBps: Number(arg('slippage-bps') ?? current.max_slippage_bps),
  minDepth: Number(arg('min-depth') ?? current.min_depth_base_units),
};

// Mirror the on-chain assert_valid bounds so a bad value fails here, loudly,
// rather than as an opaque MoveAbort.
if (!(next.deviationPpm > 0 && next.deviationPpm <= 10_000)) throw new Error('deviation-ppm must be 1..10000');
if (!(next.stalenessMs > 0 && next.stalenessMs <= 600_000)) throw new Error('staleness-ms must be 1..600000');
if (!(next.slippageBps > 0 && next.slippageBps <= 1_000)) throw new Error('slippage-bps must be 1..1000');
if (!(next.minDepth > 0)) throw new Error('min-depth must be > 0');

if (NETWORK === 'mainnet' && next.slippageBps > 50) {
  throw new Error(`Refusing to set ${next.slippageBps} bps slippage on MAINNET. Tight bands are the point of this control.`);
}

console.log('applying:', next);

// ABI straddle: the package deployed today has a 4-parameter `update`. The
// republished package adds `min_settlement_amount`. On v2 it is the bank-payout
// floor: payment_intent holds every bank payout to max(99 USDC, this value).
// Detect which one we are talking to from the config object itself rather than
// guessing, so this script keeps working across the publish.
const hasMinSettlement = current.min_settlement_amount !== undefined;
next.minSettlement = Number(arg('min-settlement') ?? current.min_settlement_amount ?? 0);
if (hasMinSettlement && !(next.minSettlement > 0)) {
  throw new Error('min-settlement must be > 0 (a zero floor would disable the minimum)');
}
console.log(hasMinSettlement
  ? `contract supports min_settlement_amount -> setting ${next.minSettlement} (minor units)`
  : 'deployed contract predates min_settlement_amount — using the legacy 4-arg update');

// `tighten` aborts on any argument that loosens a control (E_NOT_A_TIGHTENING,
// 356). Check here so the operator gets a sentence instead of an abort code,
// and name the AdminCap path they need instead.
const loosenings = [];
if (next.deviationPpm > Number(current.max_deviation_ppm)) loosenings.push('deviation-ppm');
if (next.stalenessMs > Number(current.max_staleness_ms)) loosenings.push('staleness-ms');
if (next.slippageBps > Number(current.max_slippage_bps)) loosenings.push('slippage-bps');
if (next.minDepth < Number(current.min_depth_base_units)) loosenings.push('min-depth');
if (hasMinSettlement && next.minSettlement < Number(current.min_settlement_amount)) {
  loosenings.push('min-settlement');
}
if (loosenings.length > 0) {
  throw new Error(
    `ComplianceCap is subtractive: it cannot loosen ${loosenings.join(', ')}. ` +
      'Relaxations run from the cold multisig as compliance_config::admin_set_parameters ' +
      '(&AdminCap first, then the config).',
  );
}

const tx = new Transaction();
tx.setGasBudget('20000000');
tx.moveCall({
  target: `${PACKAGE}::compliance_config::tighten`,
  arguments: [
    tx.object(CONFIG),
    tx.object(CAP),
    tx.object(REGISTRY),
    tx.pure.u64(next.deviationPpm),
    tx.pure.u64(next.stalenessMs),
    tx.pure.u64(next.slippageBps),
    tx.pure.u64(next.minDepth),
    ...(hasMinSettlement ? [tx.pure.u64(next.minSettlement)] : []),
  ],
});

await submit(tx, 'update');
console.log('new on-chain config:', await readConfig());
