import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

/**
 * v2 (D11): splash_custody and splash_meter are retired from the mainnet
 * path. tests/custody-retired-mainnet.test.mjs pins that their ids read as
 * unset there. This file pins that the settlement code paths built on them
 * fail closed on mainnet too, in every SUI_SETTLEMENT_MODE.
 *
 * Two holes it closes:
 *
 * - simulate. recordBatchSettlementOnSui and recordSingleTransferOnSui took
 *   the simulate branch before anything asked for the custody package, so on
 *   mainnet with SUI_SETTLEMENT_MODE=simulate, or SUI_BATCH_SETTLEMENT_MODE=
 *   simulate beside live settlement, the retired batch path returned a SIM_
 *   digest and the batch route marked the run SETTLED for a payout that never
 *   happened.
 * - the legacy fallback. custodyPackageIdOrThrow returned SPLASH_PACKAGE_ID as
 *   "the custody package" whenever SPLASH_CORE_PACKAGE_ID was unset, which
 *   production on mainnet allows, so custody calls were built against the v2
 *   core package instead of stopping at a named refusal.
 *
 * Testnet keeps both paths, simulate included.
 *
 * Red before green: on the tree before the fix the mainnet simulate cases
 * resolve with a SIM_ digest, and the live case fails on a missing treasury
 * id after taking the legacy package as the custody package.
 */

const LEGACY_PACKAGE = '0x' + 'ab'.repeat(32);
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'splash-custody-retired-settlement-'));
// The legacy single package id and no core package id, which production on
// mainnet allows. In the file, because getContractConfig() caches by the
// file's mtime and would not see a later change to the environment.
await writeFile(path.join(dataDir, 'contract-config.json'), JSON.stringify({ packageId: LEGACY_PACKAGE }));
// contract-config.ts resolves its data directory once, at import.
process.env.SPLASH_DATA_DIR = dataDir;
delete process.env.DATABASE_URL;
for (const key of [
  'SUI_NETWORK', 'SUI_SETTLEMENT_MODE', 'SUI_BATCH_SETTLEMENT_MODE', 'USE_MOCK_APIS', 'SPLASH_PACKAGE_ID',
  'SPLASH_CORE_PACKAGE_ID', 'SPLASH_CUSTODY_PACKAGE_ID', 'SPLASH_PAYOUT_DELEGATION_ID', 'SPLASH_TREASURY_ID',
  'OPERATOR_SUI_PRIVATE_KEY', 'SUI_SPONSOR_PRIVATE_KEY', 'OPERATOR_KMS_KEY_ID', 'OPERATOR_SUI_ADDRESS',
  'SPLASH_TEST_RECIPIENT_ADDRESS',
]) delete process.env[key];

const settlement = await import('../lib/server/sui-settlement.ts');

/** Run `fn` with these variables set, then put the environment back. */
async function withEnv(vars, fn) {
  const before = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const ROW = { address: '0x' + '12'.repeat(32), amount: '25.00', name: 'Ana Cruz' };
const batch = () => settlement.recordBatchSettlementOnSui({ batchId: 'batch_retired', rows: [ROW], totalUsd: 25, targetCurrency: 'PHP' });
const single = () => settlement.recordSingleTransferOnSui({
  transferId: 'tx_retired',
  recipient: ROW.address,
  amountUsd: 25,
  stablecoinAmountMicro: 25_000_000,
  targetCurrency: 'PHP',
});
const RETIRED = /retired from the mainnet path/;

const SIMULATE_MODES = [
  ['SUI_SETTLEMENT_MODE=simulate', { SUI_SETTLEMENT_MODE: 'simulate' }],
  ['SUI_BATCH_SETTLEMENT_MODE=simulate beside live settlement', { SUI_SETTLEMENT_MODE: 'live', SUI_BATCH_SETTLEMENT_MODE: 'simulate' }],
];

test('on mainnet the delegated batch path fails closed in simulate mode instead of reporting a SIM_ settlement', async () => {
  for (const [label, modes] of SIMULATE_MODES) {
    await withEnv({ SUI_NETWORK: 'mainnet', ...modes }, async () => {
      const outcome = await batch().then((result) => ({ result }), (error) => ({ error }));
      assert.ok(outcome.error, `${label}: a batch on mainnet must not "settle", but returned ${outcome.result?.digest}`);
      assert.match(outcome.error.message, RETIRED, label);
    });
  }
});

test('on mainnet the custody single-transfer path fails closed in simulate mode too', async () => {
  await withEnv({ SUI_NETWORK: 'mainnet', SUI_SETTLEMENT_MODE: 'simulate' }, async () => {
    await assert.rejects(single(), RETIRED);
  });
});

test('on mainnet the legacy package is never taken for the custody package, even with live signing configured', async () => {
  // A development signer, so execution resolves to the SDK without the
  // network or a KMS key. The contract file names only the legacy package.
  await withEnv({
    SUI_NETWORK: 'mainnet',
    SUI_SETTLEMENT_MODE: 'live',
    OPERATOR_SUI_PRIVATE_KEY: Ed25519Keypair.generate().getSecretKey(),
  }, async () => {
    await assert.rejects(single(), (error) => {
      assert.match(error.message, RETIRED, `refused for the right reason, not: ${error.message}`);
      return true;
    });
  });
});

test('testnet keeps the paths: simulate still records a labelled SIM_ settlement', async () => {
  for (const [label, modes] of SIMULATE_MODES) {
    await withEnv({ SUI_NETWORK: 'testnet', ...modes }, async () => {
      const result = await batch();
      assert.match(result.digest, /^SIM_/, label);
      assert.equal(result.simulated, true, label);
    });
  }
  await withEnv({ SUI_NETWORK: 'testnet', SUI_SETTLEMENT_MODE: 'simulate' }, async () => {
    assert.match((await single()).digest, /^SIM_/);
  });
});
