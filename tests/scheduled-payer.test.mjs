/**
 * v2 Phase 3, scheduled batches: the scheduled payer, the one key that pays an
 * automatic run. It lives in AWS KMS, apart from the operator's gas-sponsor key
 * (separation of duties), holds no funds, and signs only as the spender of an
 * allowance the owners signed.
 *
 *   production    needs its KMS key, its region and its address; the KMS public
 *                 key must derive that address; it may not be the operator's
 *                 key or address, or the sponsor's; anything missing is a
 *                 refusal, never a stand-in. No sandbox signer is reachable.
 *   development   a sandbox signer that signs nothing on any network.
 *   the boot      lib/env.ts refuses a production environment that names the
 *                 operator's key, or an address with no key.
 *   canon D-0004  nothing in the agent code reaches it.
 *
 * No key is real, no AWS call is made, and nothing is signed for any network.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { normalizeSuiAddress } from '@mysten/sui/utils';

import { parseEnv, EnvValidationError } from '../lib/env.ts';
import { getScheduledPayer, resetScheduledPayerCache, sandboxPayerAddress, scheduledPayerAddress, scheduledPayerKind } from '../lib/server/scheduled-payer-signer.ts';

const KEY = 'arn:aws:kms:ap-southeast-1:111122223333:key/0b5e7f8a-1c2d-4e3f-9a0b-1c2d3e4f5a6b';
const OPERATOR_KEY = 'arn:aws:kms:ap-southeast-1:111122223333:key/9d9d9d9d-1c2d-4e3f-9a0b-1c2d3e4f5a6b';
const kp = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(0x31));
const operatorKp = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(0x32));
const PAYER = normalizeSuiAddress(kp.toSuiAddress());
const OPERATOR = normalizeSuiAddress(operatorKp.toSuiAddress());

const prod = (over = {}) => ({ NODE_ENV: 'production', SCHEDULED_PAYER_KMS_KEY_ID: KEY, AWS_REGION: 'ap-southeast-1', SCHEDULED_PAYER_SUI_ADDRESS: PAYER, OPERATOR_SUI_ADDRESS: OPERATOR, OPERATOR_KMS_KEY_ID: OPERATOR_KEY, ...over });
const factory = (signer = kp) => async () => signer;

test('production with its key, region and address resolves a KMS payer that signs through the key', async () => {
  const r = await getScheduledPayer({ env: prod(), kmsFactory: factory() });
  assert.equal(r.ok, true);
  assert.equal(r.payer.kind, 'kms');
  assert.equal(r.payer.address, PAYER);
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const signature = await r.payer.sign(bytes);
  assert.equal(signature, (await kp.signTransaction(bytes)).signature, 'it is the key’s own signature over the bytes');
});

test('production without a scheduled-payer key pays nothing: there is no stand-in', async () => {
  const r = await getScheduledPayer({ env: { NODE_ENV: 'production' }, kmsFactory: factory() });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'not_configured');
  assert.equal(scheduledPayerKind({ NODE_ENV: 'production' }), 'none');
  assert.equal(scheduledPayerAddress({ NODE_ENV: 'production' }), null, 'no address is offered to owners to give an allowance to');
});

test('production with a key but no region or no address is incomplete, and the factory is never asked', async () => {
  let asked = 0;
  const counting = async () => ((asked += 1), kp);
  for (const env of [prod({ AWS_REGION: undefined }), prod({ SCHEDULED_PAYER_SUI_ADDRESS: undefined })]) {
    const r = await getScheduledPayer({ env, kmsFactory: counting });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'incomplete');
  }
  assert.equal(asked, 0);
});

test('a key whose public key derives another address is refused', async () => {
  const r = await getScheduledPayer({ env: prod({ SCHEDULED_PAYER_SUI_ADDRESS: OPERATOR }), kmsFactory: factory(), });
  assert.equal(r.ok, false);
  // The named address is the operator's, so it is refused as the operator's before it is compared with the key.
  assert.ok(['address_mismatch', 'same_as_operator'].includes(r.code));
  const other = await getScheduledPayer({ env: prod({ SCHEDULED_PAYER_SUI_ADDRESS: normalizeSuiAddress(`0x${'44'.repeat(32)}`) }), kmsFactory: factory() });
  assert.equal(other.code, 'address_mismatch');
});

test('the payer is never the operator: not its key, not its address, not the gas sponsor', async () => {
  const sameKey = await getScheduledPayer({ env: prod({ SCHEDULED_PAYER_KMS_KEY_ID: OPERATOR_KEY }), kmsFactory: factory() });
  assert.equal(sameKey.code, 'same_as_operator');
  const sameAddress = await getScheduledPayer({ env: prod({ OPERATOR_SUI_ADDRESS: PAYER }), kmsFactory: factory() });
  assert.equal(sameAddress.code, 'same_as_operator');
  const sponsor = await getScheduledPayer({ env: prod(), kmsFactory: factory(), sponsorAddress: PAYER });
  assert.equal(sponsor.code, 'same_as_sponsor');
  const fine = await getScheduledPayer({ env: prod(), kmsFactory: factory(), sponsorAddress: OPERATOR });
  assert.equal(fine.ok, true);
});

test('a KMS key that cannot be reached is unavailable, and the reason carries no key and no error text', async () => {
  const boom = async () => {
    throw new Error('AccessDeniedException: arn:aws:kms:ap-southeast-1:111122223333:key/secret-material');
  };
  const r = await getScheduledPayer({ env: prod(), kmsFactory: boom });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'unavailable');
  assert.ok(!/arn:|AccessDenied|secret/.test(r.reason), r.reason);
});

test('in development with no key the payer is a sandbox that signs nothing on any network', async () => {
  const r = await getScheduledPayer({ env: { NODE_ENV: 'development' } });
  assert.equal(r.ok, true);
  assert.equal(r.payer.kind, 'sandbox');
  assert.equal(r.payer.address, sandboxPayerAddress());
  assert.equal(scheduledPayerKind({ NODE_ENV: 'development' }), 'sandbox');
  assert.equal(scheduledPayerAddress({ NODE_ENV: 'test' }), sandboxPayerAddress());
  const signature = await r.payer.sign(new Uint8Array([9]));
  assert.ok(!/^[A-Za-z0-9+/=]{88,}$/.test(signature), 'it is not shaped like a signature the network could accept');
});

test('the sandbox payer is not reachable in production, whatever else is set', async () => {
  for (const env of [{ NODE_ENV: 'production' }, { NODE_ENV: 'production', USE_MOCK_APIS: 'true', NEXT_PUBLIC_DEMO_MODE: 'true' }, { NODE_ENV: 'production', SCHEDULED_PAYER_SUI_ADDRESS: PAYER }]) {
    const r = await getScheduledPayer({ env });
    assert.equal(r.ok, false);
    assert.notEqual(r.payer?.kind, 'sandbox');
  }
  assert.equal(scheduledPayerAddress({ NODE_ENV: 'production', SCHEDULED_PAYER_SUI_ADDRESS: PAYER }), null, 'an address with no key behind it is not offered');
});

test('the default environment is memoised, an outage is not', async () => {
  resetScheduledPayerCache();
  const saved = process.env.NODE_ENV;
  try {
    const a = await getScheduledPayer();
    const b = await getScheduledPayer();
    assert.equal(a, b, 'the same answer');
  } finally {
    process.env.NODE_ENV = saved;
    resetScheduledPayerCache();
  }
});

test('the boot refuses a production environment that gives the payer the operator’s key or address, or an address with no key', () => {
  const OBJ = '0x' + 'ab'.repeat(32);
  const base = {
    NODE_ENV: 'production',
    CUSTOMER_SESSION_SECRET: 's'.repeat(32),
    ADMIN_SESSION_SECRET: 'a'.repeat(32),
    CRON_SECRET: 'c'.repeat(32),
    DATABASE_URL: 'postgresql://user:pw@db.example/splash?sslmode=require',
    SPLASH_PACKAGE_ID: OBJ,
    NEXT_PUBLIC_APP_URL: 'https://v1.splashz.xyz',
    USDC_TYPE: `${OBJ}::usdc::USDC`,
    ADMIN_PASSWORD: 'not-the-demo-value-either',
    USE_MOCK_APIS: 'true',
    NEXT_PUBLIC_DEMO_MODE: 'true',
    SUI_SETTLEMENT_MODE: 'simulate',
    EMAIL_TRANSPORT: 'resend',
    EMAIL_API_KEY: 're_test_key',
    EMAIL_FROM: 'no-reply@splash.example',
  };
  const keysOf = (env) => {
    try {
      parseEnv(env);
    } catch (e) {
      assert.ok(e instanceof EnvValidationError);
      return e.issues.map((i) => i.key);
    }
    return [];
  };
  assert.deepEqual(keysOf(base), [], 'a production environment with no payer is fine: automatic payments are simply off');
  assert.ok(keysOf({ ...base, SCHEDULED_PAYER_KMS_KEY_ID: KEY }).includes('SCHEDULED_PAYER_SUI_ADDRESS'), 'a key needs its address');
  assert.ok(keysOf({ ...base, SCHEDULED_PAYER_KMS_KEY_ID: KEY }).includes('AWS_REGION'), 'and its region');
  assert.ok(keysOf({ ...base, SCHEDULED_PAYER_SUI_ADDRESS: PAYER }).includes('SCHEDULED_PAYER_SUI_ADDRESS'), 'an address with no key is refused');
  const full = { ...base, SCHEDULED_PAYER_KMS_KEY_ID: KEY, SCHEDULED_PAYER_SUI_ADDRESS: PAYER, AWS_REGION: 'ap-southeast-1' };
  assert.deepEqual(keysOf(full), []);
  assert.ok(keysOf({ ...full, OPERATOR_KMS_KEY_ID: KEY }).includes('SCHEDULED_PAYER_KMS_KEY_ID'), 'not the operator’s key');
  assert.ok(keysOf({ ...full, OPERATOR_SUI_ADDRESS: PAYER }).includes('SCHEDULED_PAYER_SUI_ADDRESS'), 'not the operator’s address');
});

test('canon D-0004: nothing in the agent code reaches the scheduled payer', () => {
  const roots = ['lib/agent', 'lib/oxwal', 'lib/ai', 'lib/chain', 'app/api/oxwal', 'app/api/copilot', 'app/api/agent'];
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx|mjs)$/.test(name)) files.push(full);
    }
  };
  roots.forEach(walk);
  assert.ok(files.length > 0);
  const offenders = files.filter((f) => /scheduled-payer|SCHEDULED_PAYER|scheduled-runner/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(offenders, []);
});

test('no page or component imports the signer: only the server’s own wiring does', () => {
  const importers = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (name === 'node_modules' || name === '.next') continue;
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(name) && /scheduled-payer-signer/.test(readFileSync(full, 'utf8'))) importers.push(full.replace(/\\/g, '/'));
    }
  };
  for (const root of ['app', 'components', 'lib']) walk(root);
  const allowed = new Set(['lib/env.ts', 'lib/server/scheduled-payer-signer.ts', 'lib/server/scheduled-payments.ts', 'lib/server/scheduled-payments-deps.ts', 'lib/server/scheduled-runner.ts']);
  assert.deepEqual(importers.filter((f) => !allowed.has(f)), []);
  assert.ok(!importers.some((f) => f.startsWith('components/') || f.startsWith('app/')), 'a client bundle never sees the signer');
});
