import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

/**
 * v2 (D11, brief §3.7): splash_custody and splash_meter are retired from the
 * mainnet path. lib/env.ts refuses SPLASH_CUSTODY_PACKAGE_ID and
 * SPLASH_PAYOUT_DELEGATION_ID at boot on mainnet, but that is not the only
 * way in: data/contract-config.json overrides the environment at runtime, and
 * the admin console writes it. A staff member who saved a custody package id
 * there would switch the custody phase back on (lib/server/custody-phase.ts)
 * and reopen the pooled settlement and delegated batch paths, on a network
 * where they no longer exist by design.
 *
 * So the rule holds where every reader reads: getContractConfig(). On mainnet
 * both ids read as unset, whatever the file or the environment says, and
 * validateContractConfig() refuses a save that sets one. Testnet keeps them.
 *
 * Red before green: on the tree before the fix getContractConfig() returns the
 * file's values on mainnet and validateContractConfig() accepts them.
 */

const CUSTODY = '0x' + 'cd'.repeat(32);
const DELEGATION = '0x' + 'de'.repeat(32);

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'splash-custody-retired-'));
const CONFIG_FILE = path.join(dataDir, 'contract-config.json');
const FILE_CONFIG = JSON.stringify({ custodyPackageId: CUSTODY, payoutDelegationId: DELEGATION });
await writeFile(CONFIG_FILE, FILE_CONFIG);
// contract-config.ts resolves its data directory once, at import.
process.env.SPLASH_DATA_DIR = dataDir;
const config = await import('../lib/server/contract-config.ts');
const phase = await import('../lib/server/custody-phase.ts');

function onNetwork(network, fn) {
  const before = process.env.SUI_NETWORK;
  process.env.SUI_NETWORK = network;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.SUI_NETWORK;
    else process.env.SUI_NETWORK = before;
  }
}

test('on mainnet a custody package or payout delegation in contract-config.json reads as unset', () => {
  onNetwork('mainnet', () => {
    const cfg = config.getContractConfig();
    assert.equal(cfg.custodyPackageId, '', 'custodyPackageId');
    assert.equal(cfg.payoutDelegationId, '', 'payoutDelegationId');
    assert.equal(phase.custodyPhaseEnabled(), false, 'the custody phase stays off');
    assert.equal(phase.currentCustodyPhase(), 'PHASE_0_PAYOUT_ONLY');
    assert.equal(phase.deliveryTierAllowed('SWEEP_ACCOUNT'), false, 'SWEEP_ACCOUNT stays closed');
  });
});

test('on mainnet the environment cannot set them either, behind the boot refusal', async () => {
  // The file says nothing here, so only the environment could set them.
  await writeFile(CONFIG_FILE, '{}');
  try {
    onNetwork('mainnet', () => {
      process.env.SPLASH_CUSTODY_PACKAGE_ID = CUSTODY;
      process.env.SPLASH_PAYOUT_DELEGATION_ID = DELEGATION;
      try {
        const cfg = config.getContractConfig();
        assert.equal(cfg.custodyPackageId, '');
        assert.equal(cfg.payoutDelegationId, '');
      } finally {
        delete process.env.SPLASH_CUSTODY_PACKAGE_ID;
        delete process.env.SPLASH_PAYOUT_DELEGATION_ID;
      }
    });
  } finally {
    await writeFile(CONFIG_FILE, FILE_CONFIG);
  }
});

test('on mainnet the admin console cannot save them', () => {
  onNetwork('mainnet', () => {
    const result = config.validateContractConfig({ custodyPackageId: CUSTODY, payoutDelegationId: DELEGATION });
    assert.equal(result.ok, false);
    assert.match(result.errors.custodyPackageId, /retired on mainnet/i);
    assert.match(result.errors.payoutDelegationId, /retired on mainnet/i);
    assert.deepEqual(config.validateContractConfig({ custodyPackageId: '', payoutDelegationId: '' }), { ok: true }, 'empty is fine');
  });
});

test('testnet keeps the code path: the same file still configures custody there', () => {
  onNetwork('testnet', () => {
    const cfg = config.getContractConfig();
    assert.equal(cfg.custodyPackageId, CUSTODY);
    assert.equal(cfg.payoutDelegationId, DELEGATION);
    assert.equal(phase.custodyPhaseEnabled(), true);
    assert.deepEqual(config.validateContractConfig({ custodyPackageId: CUSTODY, payoutDelegationId: DELEGATION }), { ok: true });
  });
});
