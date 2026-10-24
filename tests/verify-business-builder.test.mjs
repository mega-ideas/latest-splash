/**
 * verify_business enters an account's business wallet in Splash's address
 * Registry (A1 §2.3: free between Splash businesses, and only verified ones
 * are inside the network), so it takes the Registry after the account. The
 * two builders that call it, the KYB approval (lib/server/sui-settlement.ts)
 * and the testnet proof (experiments/v2-phase1/testnet-e2e.mjs), pass it
 * there; one that did not would fail on chain with an arity error.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const MOVE = readFileSync('move/splash_core/sources/business_account.move', 'utf8');

test('the Move functions that change who is inside the network take the address Registry', () => {
  assert.match(MOVE, /public fun verify_business\(_: &AdminCap, account: &mut BusinessAccount, registry: &mut Registry, risk_score: u8\)/);
  assert.match(MOVE, /public fun revoke_verification\(_: &AdminCap, account: &mut BusinessAccount, registry: &mut Registry, ctx: &TxContext\)/);
  assert.match(MOVE, /public fun admin_freeze\(_: &AdminCap, account: &mut BusinessAccount, registry: &mut Registry, ctx: &TxContext\)/);
  assert.match(MOVE, /public fun admin_unfreeze\(_: &AdminCap, account: &mut BusinessAccount, registry: &mut Registry, ctx: &TxContext\)/);
});

test('the KYB approval passes the address Registry to verify_business', () => {
  const src = readFileSync('lib/server/sui-settlement.ts', 'utf8');
  const call = src.slice(src.indexOf('::business_account::verify_business'));
  assert.match(call, /arguments: \[\s*tx\.object\(adminCapId\),\s*tx\.object\(businessAccountId\),\s*tx\.object\(registryId\),\s*tx\.pure\.u8\(riskScore\),\s*\]/);
  assert.match(src, /SPLASH_ADDRESS_REGISTRY_ID is not configured/);
});

test('the testnet proof passes the address Registry to verify_business', () => {
  const src = readFileSync('experiments/v2-phase1/testnet-e2e.mjs', 'utf8');
  assert.match(src, /business_account::verify_business`,\s*arguments: \[tx\.object\(results\.steps\.publishCore\.adminCap\), tx\.object\(ACCOUNT\), tx\.object\(ADDRESS_REGISTRY\), tx\.pure\.u8\(20\)\]/);
});
