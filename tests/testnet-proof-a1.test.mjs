/**
 * The testnet proof (experiments/v2-phase1/testnet-e2e.mjs) proves A1's
 * packages, not the ones before them, and proves Splash's fee charged, not
 * only fees off.
 *
 * The script is idempotent: it skips every step its results file records. A
 * results file from packages published before Amendment A1 (no FeeConfig,
 * FeeAdminCap, address Registry or OpsCap) would make a rerun skip the
 * publish and call A1's argument lists against the old packages. So the
 * committed results file, if any, must be an A1 run, and the script must
 * refuse to resume one that is not. And with fees off at publish (Sky's
 * FIXUP 1) a run that never applies a fee recipient proves no fee leg: the
 * script proposes a 2-of-3 recipient, applies it after the 24 hours, and
 * pays a wallet and a bank payout with the fee on, recording FeeCharged.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const SCRIPT = readFileSync('experiments/v2-phase1/testnet-e2e.mjs', 'utf8');
const RESULTS = 'experiments/v2-phase1/testnet-e2e-results.json';
const A1_OBJECTS = ['feeConfig', 'feeAdminCap', 'addressRegistry', 'opsCap'];

test('a committed testnet results file is an A1 run', () => {
  if (!existsSync(RESULTS)) return;
  const results = JSON.parse(readFileSync(RESULTS, 'utf8'));
  const publish = results.steps?.publishCore ?? {};
  for (const key of A1_OBJECTS) assert.ok(publish[key], `publishCore records no ${key}: the run predates Amendment A1`);
});

test('the script refuses to resume a run recorded before A1', () => {
  assert.match(SCRIPT, /function assertA1Results\(/);
  for (const key of A1_OBJECTS) assert.ok(SCRIPT.includes(`'${key}'`), `the resume check names ${key}`);
  assert.match(SCRIPT, /assertA1Results\(results\);/);
});

test('the script turns the fees on through the 24-hour path and pays a wallet and a bank payout with them', () => {
  assert.match(SCRIPT, /::fee_config::propose_fee_recipient`/);
  assert.match(SCRIPT, /::fee_config::apply_fee_recipient`/);
  assert.match(SCRIPT, /::address_registry::add_partner_address`/);
  assert.match(SCRIPT, /walletPays\('feesOnWalletPays', KIND_WALLET,/);
  assert.match(SCRIPT, /walletPays\('feesOnBankPays', KIND_BANK_PAYOUT,/);
  assert.match(SCRIPT, /'::fee_config::FeeCharged'/);
  // The recipient is a multisig no one member signs for alone (Sky's FIXUP 2).
  assert.match(SCRIPT, /const FINANCE = multisigOf\(financeKeys\)/);
});
