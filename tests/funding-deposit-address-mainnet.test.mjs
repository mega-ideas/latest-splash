import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { before } from 'node:test';

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

import { attachDb, migratedDb } from './helpers/store-db.mjs';

/**
 * D1: Splash has no key to a business's funds. D3: Splash never owns an
 * account that receives client money.
 *
 * A funding session hands the customer a deposit address. On the Sui rail it
 * was Ed25519Keypair.fromSecretKey(HMAC-SHA256(FUNDING_DEPOSIT_DERIVATION_SECRET,
 * {businessAccountId, selection})): whoever holds the server secret can rebuild
 * the private key and move the USDC. Without the secret, outside production or
 * in the demo posture, the HMAC key was a constant in this repository, so
 * anyone could. On the CCTP rail it was whatever address the operator put in
 * FUNDING_CCTP_DEPOSIT_ADDRESSES_JSON, an account between the business and its
 * own wallet whose owner nothing establishes.
 *
 * On mainnet none of that may happen: no session is opened for a deposit, no
 * route returns a deposit address, and the payment sources say so. Testnet
 * keeps today's behaviour. Funding into the business's own registered wallet
 * is Phase 2 work and is not tested here.
 *
 * Red before green: on the tree before the fix every mainnet case below gets
 * a deposit address, and the derived ones match the keypair rebuilt from the
 * secret (or from the public constant).
 */

delete process.env.DATABASE_URL;
delete process.env.LAUNCH_SCOPE;
delete process.env.SPLASH_BUSINESS_ACCOUNT_ID;
delete process.env.FUNDING_DEPOSIT_DERIVATION_SECRET;
delete process.env.FUNDING_CCTP_DEPOSIT_ADDRESSES_JSON;
delete process.env.NEXT_PUBLIC_SUI_NETWORK;
process.env.CUSTOMER_SESSION_SECRET = 'funding-deposit-address-mainnet-secret-0123456789abcdef0123';
process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';
process.env.SPLASH_DATA_DIR = path.join(os.tmpdir(), 'splash-funding-deposit-address-mainnet-no-data');

const MAINNET_USDC = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';
const DEMO_CONSTANT = 'splash-demo-deposit-derivation-only';
const REFUSED = 'no_deposit_address_on_mainnet';

/** Production, mocks and demo off: a live mainnet deployment. */
const LIVE_MAINNET = { NODE_ENV: 'production', SUI_NETWORK: 'mainnet', USDC_TYPE: MAINNET_USDC };
const SUI_NATIVE = { source: 'USDC', type: 'stablecoin', asset: 'USDC', rail: 'SUI_NATIVE', feeTier: 'DISCOUNT' };
const CCTP_ETHEREUM = { source: 'USDC', type: 'stablecoin', asset: 'USDC', rail: 'CCTP', sourceChain: 'ETHEREUM', feeTier: 'DISCOUNT' };
const ACCOUNT = '0x' + 'cd'.repeat(32);

/** What anyone holding `secret` can do: rebuild the deposit address's keypair. */
function addressFromSecret(secret, businessAccountId, selection) {
  const context = JSON.stringify({ businessAccountId, selection });
  return Ed25519Keypair.fromSecretKey(createHmac('sha256', secret).update(context).digest()).toSuiAddress();
}

const store = await import('../lib/server/funding-sessions.ts');

function open(selection, env, businessAccountId = ACCOUNT) {
  return store.createFundingSession({ orgId: 'acme', businessAccountId, selection, amountExpectedMicro: 1_000_000_000 }, env);
}

async function refusedWithoutStoring(selection, env, label) {
  const before = (await store.listFundingSessions()).length;
  await assert.rejects(open(selection, env), (error) => {
    assert.equal(error.code, REFUSED, `${label}: refused with the code, not ${error.message}`);
    assert.match(error.message, /deposit address/, `${label}: the message says what was refused`);
    return true;
  }, `${label}: no deposit address on mainnet`);
  assert.equal((await store.listFundingSessions()).length, before, `${label}: nothing was stored`);
}

// ─── The session itself ─────────────────────────────────────────────────────

test('live mainnet: a Sui deposit session is refused, so no address whose key the server secret derives is handed out', async () => {
  const secret = 'production-derivation-secret-held-by-splash';
  const env = { ...LIVE_MAINNET, FUNDING_DEPOSIT_DERIVATION_SECRET: secret };
  // Shown, not only asserted: the attack the refusal closes.
  let leaked;
  try {
    leaked = (await open(SUI_NATIVE, env)).depositAddress;
  } catch {
    leaked = undefined;
  }
  assert.notEqual(leaked, addressFromSecret(secret, ACCOUNT, SUI_NATIVE), 'Splash could rebuild the private key of this deposit address');
  await refusedWithoutStoring(SUI_NATIVE, env, 'live mainnet, secret set');
  await refusedWithoutStoring(SUI_NATIVE, LIVE_MAINNET, 'live mainnet, no secret');
});

test('mainnet in the demo posture or in development is refused too: its fallback key is a constant in this repository', async () => {
  for (const [label, env] of [
    ['production, mocks on', { ...LIVE_MAINNET, USE_MOCK_APIS: 'true' }],
    ['production, demo mode', { ...LIVE_MAINNET, NEXT_PUBLIC_DEMO_MODE: 'true' }],
    ['development', { NODE_ENV: 'development', SUI_NETWORK: 'mainnet' }],
    ['the client told it is mainnet', { NODE_ENV: 'development', NEXT_PUBLIC_SUI_NETWORK: 'mainnet' }],
  ]) {
    let leaked;
    try {
      leaked = (await open(SUI_NATIVE, env, 'dashboard-primary')).depositAddress;
    } catch {
      leaked = undefined;
    }
    assert.notEqual(leaked, addressFromSecret(DEMO_CONSTANT, 'dashboard-primary', SUI_NATIVE), `${label}: anyone reading the repository could rebuild this deposit key`);
    await refusedWithoutStoring(SUI_NATIVE, env, label);
  }
});

test('mainnet: a CCTP deposit session is refused, whether the operator configured an address or not', async () => {
  const operatorAddress = '0x' + '22'.repeat(20);
  const configured = { ...LIVE_MAINNET, FUNDING_CCTP_DEPOSIT_ADDRESSES_JSON: JSON.stringify({ [ACCOUNT]: { ETHEREUM: operatorAddress } }) };
  await refusedWithoutStoring(CCTP_ETHEREUM, configured, 'live mainnet, configured CCTP address');
  await refusedWithoutStoring(CCTP_ETHEREUM, { ...LIVE_MAINNET, USE_MOCK_APIS: 'true' }, 'mainnet demo posture, made-up CCTP address');
  await refusedWithoutStoring(CCTP_ETHEREUM, { NODE_ENV: 'development', SUI_NETWORK: 'mainnet' }, 'mainnet development');
});

test('mainnet: a bank funding session, which carries no deposit address, is not what this refuses', async () => {
  const session = await open({ source: 'BANK_USD', type: 'fiat', provider: 'STRIPE', feeTier: 'STANDARD' }, { NODE_ENV: 'development', SUI_NETWORK: 'mainnet' });
  assert.equal(session.status, 'AWAITING_DEPOSIT');
  assert.equal(session.depositAddress, undefined);
  assert.equal(session.depositUri, undefined);
});

test('testnet keeps today’s behaviour: derived Sui deposit addresses and configured CCTP ones', async () => {
  const dev = await open(SUI_NATIVE, { NODE_ENV: 'development', SUI_NETWORK: 'testnet' }, 'dashboard-primary');
  assert.equal(dev.depositAddress, addressFromSecret(DEMO_CONSTANT, 'dashboard-primary', SUI_NATIVE));
  assert.match(dev.depositUri, /^sui:0x[0-9a-f]{64}\?asset=USDC&amount=1000\.000000$/);

  const secret = 'testnet-derivation-secret';
  const prod = await open(SUI_NATIVE, { NODE_ENV: 'production', SUI_NETWORK: 'testnet', USDC_TYPE: MAINNET_USDC, FUNDING_DEPOSIT_DERIVATION_SECRET: secret });
  assert.equal(prod.depositAddress, addressFromSecret(secret, ACCOUNT, SUI_NATIVE));

  const operatorAddress = '0x' + '33'.repeat(20);
  const cctp = await open(CCTP_ETHEREUM, {
    NODE_ENV: 'production',
    USDC_TYPE: MAINNET_USDC,
    FUNDING_CCTP_DEPOSIT_ADDRESSES_JSON: JSON.stringify({ [ACCOUNT]: { ETHEREUM: operatorAddress } }),
  });
  assert.equal(cctp.depositAddress, operatorAddress, 'SUI_NETWORK unset is testnet');
});

// ─── The routes a customer reaches ──────────────────────────────────────────

const scope = { cookies: new Map() };
globalThis.__fundingDepositAddressMainnet = scope;
const stubModule = (source) => `data:text/javascript,${encodeURIComponent(source)}`;
const NEXT_HEADERS = stubModule(`
  const jar = () => globalThis.__fundingDepositAddressMainnet.cookies;
  export async function cookies() {
    return {
      get: (name) => (jar().has(name) ? { name, value: jar().get(name) } : undefined),
      getAll: () => [...jar()].map(([name, value]) => ({ name, value })),
      has: (name) => jar().has(name),
      set: () => {},
      delete: () => {},
    };
  }
  export async function headers() { return new Headers(); }
`);
// Plain Node resolves the package's file, not Next's extensionless subpath.
const NEXT_SERVER = stubModule(`export * from 'next/server.js';`);
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'next/headers') return { url: NEXT_HEADERS, shortCircuit: true };
    if (specifier === 'next/server') return { url: NEXT_SERVER, shortCircuit: true };
    if (context.parentURL?.startsWith('data:')) return nextResolve(specifier, { ...context, parentURL: import.meta.url });
    return nextResolve(specifier, context);
  },
});

const ORIGIN = 'http://localhost:3000';

before(async () => {
  const session = await import('@/lib/auth/customer-session');
  const s = session.createCustomerSessionFromIdentity({ email: 'ana@acme.example', credentialVersion: 1 });
  scope.cookies = new Map([[session.CUSTOMER_SESSION_COOKIE, session.createCustomerSessionToken(s, process.env.CUSTOMER_SESSION_SECRET)]]);
});

/** A signed-in member of acme, on a migrated database, on `network`. */
async function asMember(network, run) {
  const { client, db } = await migratedDb();
  await client.exec(`
    INSERT INTO users (id, email, name, email_verified_at) VALUES ('u_ana', 'ana@acme.example', 'Ana Cruz', now());
    INSERT INTO memberships (id, user_id, org_id, role) VALUES ('m_ana', 'u_ana', 'acme', 'admin');
  `);
  const undo = attachDb(db);
  const previous = process.env.SUI_NETWORK;
  process.env.SUI_NETWORK = network;
  try {
    await run({ setNetwork: (next) => { process.env.SUI_NETWORK = next; } });
  } finally {
    if (previous === undefined) delete process.env.SUI_NETWORK;
    else process.env.SUI_NETWORK = previous;
    undo();
    await client.close();
  }
}

const post = (url, body) =>
  new Request(`${ORIGIN}${url}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify(body) });
const get = (url) => new Request(`${ORIGIN}${url}`, { headers: { origin: ORIGIN } });

test('POST /api/funding/sessions on mainnet answers 403 with the code and shows the customer no address', async () => {
  const route = await import('@/app/api/funding/sessions/route');
  await asMember('mainnet', async () => {
    for (const selection of [SUI_NATIVE, CCTP_ETHEREUM]) {
      const res = await route.POST(post('/api/funding/sessions', { amountUsd: 1000, selection }));
      const body = await res.json();
      assert.equal(res.status, 403, `${selection.rail}: answered ${res.status}${body.session ? ` with deposit address ${body.session.depositAddress}` : ''}`);
      assert.equal(body.code, REFUSED, selection.rail);
      assert.match(body.error, /deposit address/);
      assert.doesNotMatch(body.error, /coming soon|demo/i, 'D14, D16: never "Coming soon", never "Demo"');
      assert.equal(body.session, undefined, `${selection.rail}: no session`);
      assert.equal(body.qrDataUrl, undefined, `${selection.rail}: no QR code`);
    }
  });
});

test('POST /api/funding/sessions on testnet still opens a Sui deposit session with its address and QR code', async () => {
  const route = await import('@/app/api/funding/sessions/route');
  await asMember('testnet', async () => {
    const res = await route.POST(post('/api/funding/sessions', { amountUsd: 1000, selection: SUI_NATIVE }));
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.match(body.session.depositAddress, /^0x[0-9a-f]{64}$/);
    assert.match(body.qrDataUrl, /^data:image\/png;base64,/);
  });
});

test('GET /api/funding/options on mainnet offers no USDC deposit, and says why', async () => {
  const route = await import('@/app/api/funding/options/route');
  await asMember('mainnet', async () => {
    const res = await route.GET(get('/api/funding/options?amountUsd=100'));
    assert.equal(res.status, 200);
    const body = await res.json();
    const deposits = body.sources.filter((source) => source.type === 'stablecoin');
    assert.ok(deposits.length > 0, 'the USDC deposit source is still listed, so the reason can be shown');
    for (const source of deposits) {
      assert.equal(source.enabled, false, `${source.id} is not offered`);
      assert.match(source.unavailableReason, /deposit address/i, `${source.id}: the reason is shown`);
      assert.doesNotMatch(source.unavailableReason, /coming soon|demo/i);
    }
    assert.notEqual(body.defaultSelection?.type, 'stablecoin', 'never the default either');
    assert.ok(body.sources.some((source) => source.id === 'BANK_USD' && source.enabled), 'bank funding is untouched');
  });
  await asMember('testnet', async () => {
    const body = await (await route.GET(get('/api/funding/options?amountUsd=100'))).json();
    assert.equal(body.sources.find((source) => source.id === 'USDC')?.enabled, true, 'testnet keeps the USDC deposit');
  });
});

test('GET /api/funding/sessions/[id] on mainnet does not repeat a stored deposit address', async () => {
  const route = await import('@/app/api/funding/sessions/[id]/route');
  await asMember('testnet', async ({ setNetwork }) => {
    // A session opened before the network was mainnet, or by older code.
    const session = await store.createFundingSession({ orgId: 'acme', businessAccountId: 'dashboard-primary', selection: SUI_NATIVE, amountExpectedMicro: 1_000_000_000 });
    assert.match(session.depositAddress, /^0x/);
    const params = Promise.resolve({ id: session.id });

    const onTestnet = await (await route.GET(get(`/api/funding/sessions/${session.id}`), { params })).json();
    assert.equal(onTestnet.session.depositAddress, session.depositAddress, 'testnet keeps today’s behaviour');

    setNetwork('mainnet');
    const res = await route.GET(get(`/api/funding/sessions/${session.id}`), { params: Promise.resolve({ id: session.id }) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.session.id, session.id);
    assert.equal(body.session.status, 'AWAITING_DEPOSIT');
    assert.equal(body.session.depositAddress, undefined, 'no deposit address on mainnet');
    assert.equal(body.session.depositUri, undefined, 'and no deposit URI that carries it');
  });
});
