import assert from 'node:assert/strict';
import test from 'node:test';

import { EnvValidationError, ENV_KEYS, parseEnv } from '../lib/env.ts';

/* parseEnv is pure — it takes the raw object and never touches process.env —
   so every case here is a literal environment, and nothing on this machine
   leaks into the assertions. */

const OBJ = '0x' + 'ab'.repeat(32);
const KEY = 'suiprivkey1' + 'q'.repeat(58);

/** A production environment that passes. Cases below remove one thing. */
const PROD_OK = {
  NODE_ENV: 'production',
  CUSTOMER_SESSION_SECRET: 's'.repeat(32),
  ADMIN_SESSION_SECRET: 'a'.repeat(32),
  CRON_SECRET: 'c'.repeat(32),
  DATABASE_URL: 'postgresql://user:pw@db.example/splash?sslmode=require',
  SPLASH_PACKAGE_ID: OBJ,
  NEXT_PUBLIC_APP_URL: 'https://v1.splashz.xyz',
  USDC_TYPE: `${OBJ}::usdc::USDC`,
  ADMIN_PASSWORD: 'not-the-demo-value-either',
  // Sandbox posture: mocks on, demo on, so no vendor key is demanded.
  USE_MOCK_APIS: 'true',
  NEXT_PUBLIC_DEMO_MODE: 'true',
  SUI_SETTLEMENT_MODE: 'simulate',
  // Verification links need a real transport in production (WS1, X5).
  EMAIL_TRANSPORT: 'resend',
  EMAIL_API_KEY: 're_test_key',
  EMAIL_FROM: 'no-reply@splash.example',
};

const keysOf = (fn) => {
  try { fn(); } catch (e) {
    assert.ok(e instanceof EnvValidationError, `expected EnvValidationError, got ${e?.constructor?.name}: ${e?.message}`);
    return e.issues.map((i) => i.key);
  }
  assert.fail('expected parseEnv to throw');
};

test('development: an empty environment boots on the documented defaults', () => {
  const env = parseEnv({ NODE_ENV: 'development' });
  assert.equal(env.SUI_NETWORK, 'testnet');
  assert.equal(env.SUI_SETTLEMENT_MODE, 'auto');
  assert.equal(env.NEXT_PUBLIC_APP_URL, 'http://localhost:3000');
  assert.equal(env.QUOTE_TTL_SECONDS, 30);
  // Defaults match what the read sites actually do, not what .env.example
  // suggests: registry.ts enables these rails unless told otherwise.
  assert.equal(env.FUNDING_RAIL_SUI_NATIVE_ENABLED, true);
  assert.equal(env.FUNDING_ASSET_USDT_ENABLED, false);
  assert.equal(env.SWEEP_ACCOUNT_ENABLED, true);
  assert.equal(env.USE_MOCK_APIS, false);
});

test('a blank value counts as unset, which is how .env.example ships every key', () => {
  const env = parseEnv({ NODE_ENV: 'development', SPLASH_PACKAGE_ID: '', QUOTE_TTL_SECONDS: '', SUI_NETWORK: '' });
  assert.equal(env.SPLASH_PACKAGE_ID, undefined);
  assert.equal(env.QUOTE_TTL_SECONDS, 30);
  assert.equal(env.SUI_NETWORK, 'testnet');
});

test('production: an empty environment refuses to start and names every missing key at once', () => {
  const keys = keysOf(() => parseEnv({ NODE_ENV: 'production' }));
  for (const k of ['CUSTOMER_SESSION_SECRET', 'ADMIN_SESSION_SECRET', 'CRON_SECRET', 'DATABASE_URL', 'SPLASH_PACKAGE_ID', 'NEXT_PUBLIC_APP_URL']) {
    assert.ok(keys.includes(k), `${k} should be named; got ${keys.join(', ')}`);
  }
});

test('a credential key removed with the single-credential login is refused if still set', () => {
  // Accounts are rows in `users` now. A password left in .env.local governs
  // nothing, so leaving it there silently would misrepresent a control.
  const keys = keysOf(() => parseEnv({ NODE_ENV: 'development', CUSTOMER_PASSWORD: 'anything' }));
  assert.deepEqual(keys, ['CUSTOMER_PASSWORD']);
  assert.doesNotThrow(() => parseEnv({ NODE_ENV: 'development', CUSTOMER_PASSWORD: '' }));
});

test('production: a complete sandbox environment passes', () => {
  const env = parseEnv(PROD_OK);
  assert.equal(env.NODE_ENV, 'production');
  assert.equal(env.SPLASH_PACKAGE_ID, OBJ);
});

test('production: live settlement requires the signer; simulate does not', () => {
  const live = keysOf(() => parseEnv({ ...PROD_OK, SUI_SETTLEMENT_MODE: 'live' }));
  assert.ok(live.includes('OPERATOR_SUI_PRIVATE_KEY'));
  assert.ok(live.includes('OPERATOR_SUI_ADDRESS'));
  assert.ok(live.includes('SPLASH_TREASURY_ID'));

  // auto with mocks off resolves to live at runtime, so it is live here too.
  const auto = keysOf(() => parseEnv({ ...PROD_OK, SUI_SETTLEMENT_MODE: 'auto', USE_MOCK_APIS: 'false' }));
  assert.ok(auto.includes('OPERATOR_SUI_PRIVATE_KEY'));

  const withSigner = parseEnv({ ...PROD_OK, SUI_SETTLEMENT_MODE: 'live', OPERATOR_SUI_PRIVATE_KEY: KEY, OPERATOR_SUI_ADDRESS: OBJ, SPLASH_TREASURY_ID: OBJ });
  assert.equal(withSigner.SUI_SETTLEMENT_MODE, 'live');
});

test('production: vendor keys are demanded only when mocks and demo mode are both off', () => {
  const keys = keysOf(() => parseEnv({ ...PROD_OK, USE_MOCK_APIS: 'false', NEXT_PUBLIC_DEMO_MODE: 'false', SUI_SETTLEMENT_MODE: 'simulate' }));
  for (const k of ['PDAX_API_KEY', 'WALRUS_PUBLISHER_URL', 'ENOKI_API_KEY', 'AIRWALLEX_API_KEY', 'STRIPE_SECRET_KEY']) {
    assert.ok(keys.includes(k), `${k} should be named once vendors are live`);
  }
});

test('production: FEATURE_ZKLOGIN=true requires the client id and the salt', () => {
  const keys = keysOf(() => parseEnv({ ...PROD_OK, FEATURE_ZKLOGIN: 'true' }));
  assert.deepEqual(keys.sort(), ['ZKLOGIN_GOOGLE_CLIENT_ID', 'ZKLOGIN_USER_SALT']);
});

test('a Seal key that moved into config/ is refused by name if still set, in any mode', () => {
  const dev = keysOf(() => parseEnv({ NODE_ENV: 'development', SEAL_THRESHOLD: '2', SEAL_KEY_SERVER_ENDPOINTS: '[]' }));
  assert.deepEqual(dev.sort(), ['SEAL_KEY_SERVER_ENDPOINTS', 'SEAL_THRESHOLD']);
  // blank is unset, which is how .env.example ships it — not an error
  assert.doesNotThrow(() => parseEnv({ NODE_ENV: 'development', SEAL_THRESHOLD: '' }));
});

test('a malformed object id is rejected with the shape it needs, in any mode', () => {
  const dev = keysOf(() => parseEnv({ NODE_ENV: 'development', SPLASH_PACKAGE_ID: '0x123' }));
  assert.deepEqual(dev, ['SPLASH_PACKAGE_ID']);
  const prod = keysOf(() => parseEnv({ ...PROD_OK, SPLASH_PACKAGE_ID: 'not-an-id' }));
  assert.ok(prod.includes('SPLASH_PACKAGE_ID'));
});

test('the error message names the mode, the count, and every key, so a fresh clone can act on it', () => {
  try {
    parseEnv({ NODE_ENV: 'production' });
    assert.fail('should throw');
  } catch (e) {
    assert.match(e.message, /NODE_ENV=production/);
    assert.match(e.message, /\d+ problems?:/);
    assert.match(e.message, /DATABASE_URL: required in production/);
    assert.match(e.message, /npm run doctor/);
  }
});

test('the schema declares every key the guard will look for', () => {
  assert.ok(ENV_KEYS.length >= 150, `expected the full inventory, got ${ENV_KEYS.length}`);
  assert.ok(ENV_KEYS.includes('SEAL_KEY_SERVER_ENDPOINTS'));
  assert.ok(ENV_KEYS.includes('FEATURE_DUAL_FUNDING'));
});
