#!/usr/bin/env node
/**
 * V1 TESTNET ONLY (whole file). It calls splash_custody's v1 testnet
 * `settlement::deposit`, which neither v2 core nor the current
 * splash_custody sources have; custody is retired from mainnet (D11), and
 * nothing here runs there.
 *
 * Fund the shared SettlementPool<SUI> that batch payouts pay out of.
 *
 * `settlement::settle_sui_batch` splits each recipient's net + fee straight out
 * of `pool.balance`, so an unfunded pool aborts every batch regardless of how
 * healthy the peg and DeepBook depth are. This is the operational step that was
 * missing — the pool was created at bootstrap but never funded.
 *
 * `settlement::deposit<T>(pool, coin)` is permissionless by design (anyone may
 * add liquidity; only the AdminCap can pay it out), so this needs no capability.
 *
 * Run:
 *   node --use-system-ca --env-file=.env.local scripts/fund-settlement-pool.mjs [SUI_AMOUNT]
 *
 * Note: SUI placed in `pool.balance` can only leave via a settle_* payout —
 * there is no pool-balance withdrawal function. Fund deliberately.
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

const PACKAGE = env('SPLASH_PACKAGE_ID');
const POOL = env('SPLASH_TREASURY_ID');
const amountSui = Number.parseFloat(process.argv[2] ?? '0.1');

if (!PACKAGE || !POOL) throw new Error('SPLASH_PACKAGE_ID and SPLASH_TREASURY_ID are required.');
if (!Number.isFinite(amountSui) || amountSui <= 0) throw new Error('Amount must be a positive number of SUI.');

function operatorKeypair() {
  const encoded = env('OPERATOR_SUI_PRIVATE_KEY') || env('SUI_SPONSOR_PRIVATE_KEY');
  if (!encoded) throw new Error('OPERATOR_SUI_PRIVATE_KEY is required.');
  const { scheme, secretKey } = decodeSuiPrivateKey(encoded);
  return scheme === 'Secp256k1'
    ? Secp256k1Keypair.fromSecretKey(secretKey)
    : Ed25519Keypair.fromSecretKey(secretKey);
}

const signer = operatorKeypair();
const mist = Math.round(amountSui * 1_000_000_000);

async function poolBalance() {
  const res = await client.core.getObject({ objectId: POOL, include: { json: true } });
  return BigInt((res.object ?? res).json?.balance ?? 0);
}

const before = await poolBalance();
console.log(`SettlementPool ${POOL.slice(0, 14)}…`);
console.log(`  balance before : ${Number(before) / 1e9} SUI`);
console.log(`  depositing     : ${amountSui} SUI (${mist} MIST)`);

const tx = new Transaction();
tx.setGasBudget('20000000');
const [coin] = tx.splitCoins(tx.gas, [mist]);
tx.moveCall({
  target: `${PACKAGE}::settlement::deposit`,
  typeArguments: ['0x2::sui::SUI'],
  arguments: [tx.object(POOL), coin],
});

const result = await client.signAndExecuteTransaction({
  signer,
  transaction: tx,
  include: { effects: true },
});
const executed = result.Transaction ?? result.FailedTransaction;
if (result.$kind !== 'Transaction' || !executed.status.success) {
  throw new Error(`deposit failed: ${JSON.stringify(executed?.status?.error)}`);
}
await client.waitForTransaction({ digest: executed.digest }).catch(() => {});

const after = await poolBalance();
console.log(`  balance after  : ${Number(after) / 1e9} SUI`);
console.log(`  digest         : ${executed.digest}`);
