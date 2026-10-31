/**
 * v2 Phase 3, scheduled batches: the routes.
 *
 *   the cron      protected by a bearer secret read from the environment; with
 *                 none set nobody is authorised, in every environment, and in
 *                 production a missing secret is also refused at boot
 *   the routes    every one goes through scheduleRoute (a signed-in customer,
 *                 the business from the SESSION, their own membership, the
 *                 business's own wallet context); none reads a business, a user
 *                 or a role from the request; every POST that makes or changes a
 *                 payment instruction asks for the accepted terms first
 *   the words     no copy that the product refuses
 *
 * The service is tested in tests/scheduled-schedules.test.mjs and the runner in
 * tests/scheduled-runner-*.test.mjs against a real database.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import test from 'node:test';

import { parseEnv, EnvValidationError } from '../lib/env.ts';

// Plain Node cannot resolve the extensionless `next/server`; point it at the file, as the other cron-route tests do.
registerHooks({
  resolve: (specifier, context, nextResolve) => nextResolve(['next/server', 'next/headers', 'next/navigation', 'next/cache'].includes(specifier) ? `${specifier}.js` : specifier, context),
});

const read = (file) => readFileSync(file, 'utf8');
const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full.replace(/\\/g, '/')];
  });

const routes = walk('app/api/wallet/schedules').filter((f) => f.endsWith('route.ts'));

test('there is a route for the list, one schedule, its actions, the runs, the kill switch and the allowance', () => {
  assert.deepEqual(
    routes.sort(),
    [
      'app/api/wallet/schedules/[id]/[action]/route.ts',
      'app/api/wallet/schedules/[id]/route.ts',
      'app/api/wallet/schedules/automatic/allowance/route.ts',
      'app/api/wallet/schedules/automatic/route.ts',
      'app/api/wallet/schedules/route.ts',
      'app/api/wallet/schedules/runs/[id]/route.ts',
      'app/api/wallet/schedules/runs/route.ts',
    ].sort(),
  );
});

test('every route goes through the session gate and none reads a business, a user or a role from the request', () => {
  for (const file of routes) {
    const src = read(file);
    assert.match(src, /scheduleRoute\(request\)/, `${file} must use the gate`);
    assert.ok(!/body\.(orgId|org|userId|user|role|actor|createdBy|financeLead|owner)\b/.test(src), `${file} reads an identity from the body`);
    assert.ok(!/searchParams|nextUrl/.test(src), `${file} reads the query`);
    assert.ok(!/headers\.get\((?!'idempotency-key')/.test(src), `${file} reads a header it should not`);
    assert.ok(!/process\.env/.test(src), `${file} reads the environment`);
  }
});

test('every POST and PATCH that makes or changes an instruction asks for the accepted terms first', () => {
  for (const file of ['app/api/wallet/schedules/route.ts', 'app/api/wallet/schedules/[id]/route.ts', 'app/api/wallet/schedules/automatic/allowance/route.ts']) {
    const src = read(file);
    const handler = src.slice(src.search(/export async function (POST|PATCH)/));
    assert.match(handler, /requireTermsAccepted\(/, `${file} must gate on the terms`);
    assert.ok(handler.indexOf('requireTermsAccepted(') < handler.indexOf('readJsonBody('), `${file}: the terms are asked first`);
  }
});

test('reading the list is limited to those who can read payouts, and the automatic settings to owners', () => {
  assert.match(read('app/api/wallet/schedules/route.ts'), /requirePayoutReader\(/);
  assert.match(read('app/api/wallet/schedules/runs/route.ts'), /requirePayoutReader\(/);
  assert.match(read('app/api/wallet/schedules/runs/[id]/route.ts'), /requirePayoutReader\(/);
  assert.match(read('app/api/wallet/schedules/automatic/route.ts'), /requireOwner\(/);
});

test('only the five actions exist: skip, stop and resume are one click, and anything else is a 404', () => {
  const src = read('app/api/wallet/schedules/[id]/[action]/route.ts');
  for (const a of ["'skip'", "'stop'", "'resume'"]) assert.ok(src.includes(a), a);
  assert.match(src, /status: 404/);
  assert.ok(!/requireTermsAccepted/.test(src), 'stopping and skipping are never held back by a gate: they only make fewer payments');
});

test('the allowance can be asked for and taken back only by an owner, through the signed request flow', () => {
  const svc = read('lib/server/scheduled-payments.ts');
  assert.match(svc, /issueSpendingRule\(/);
  assert.match(svc, /changeSpendingRule\(/);
  assert.match(svc, /revokeSpendingRule\(/);
  // It builds nothing itself: the same builders, shape checks and quorum as any spending rule.
  assert.ok(!/spendRuleTx|openSigningRequest\(/.test(svc.replace(/\/\*[\s\S]*?\*\//g, '')), 'the service opens requests only through the spending-rule functions');
});

test('the cron refuses without CRON_SECRET, in every environment', async () => {
  const saved = {};
  for (const key of ['CRON_SECRET', 'DATABASE_URL']) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  try {
    const route = await import('@/app/api/cron/scheduled-payments/route');
    const call = (headers = {}) => new Request('http://localhost/api/cron/scheduled-payments', { headers });
    assert.equal((await route.GET(call())).status, 401, 'no secret configured: nobody is authorised');
    assert.equal((await route.GET(call({ authorization: 'Bearer ' }))).status, 401, 'not even a bearer of nothing');
    assert.equal((await route.POST(call({ authorization: 'Bearer anything' }))).status, 401);

    process.env.CRON_SECRET = 'scheduled-cron-secret-0123456789';
    assert.equal((await route.GET(call())).status, 401, 'no header');
    assert.equal((await route.GET(call({ authorization: 'Bearer wrong-secret-0123456789abcdef' }))).status, 401, 'a wrong secret');
    assert.equal((await route.GET(call({ authorization: 'Bearer scheduled-cron-secret-012345678' }))).status, 401, 'a prefix of the secret');
    const nodb = await route.GET(call({ authorization: `Bearer ${process.env.CRON_SECRET}` }));
    assert.equal(nodb.status, 502, 'with the right secret and no database it does not pretend to have run');
    assert.equal((await nodb.json()).success, false);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('the cron works each business with its own context and nothing else', () => {
  const src = read('app/api/cron/scheduled-payments/route.ts');
  assert.match(src, /timingSafeEqual/);
  assert.match(src, /scheduleDepsForOrg\(orgId\)/);
  assert.match(src, /status: 502/);
  assert.ok(!/maxDuration\s*=\s*\d{4,}/.test(src));
  const deps = read('lib/server/scheduled-payments-deps.ts');
  assert.match(deps, /liveWalletContext\(orgId\)/, 'a business’s context is built from its own id');
  assert.match(deps, /live\.status === 409\) return null/, 'a business with no account is skipped, not an error');
});

test('production refuses to boot without CRON_SECRET, which is what keeps every cron route closed', () => {
  const OBJ = '0x' + 'ab'.repeat(32);
  const prod = { NODE_ENV: 'production', CUSTOMER_SESSION_SECRET: 's'.repeat(32), ADMIN_SESSION_SECRET: 'a'.repeat(32), DATABASE_URL: 'postgresql://user:pw@db.example/splash?sslmode=require', SPLASH_PACKAGE_ID: OBJ, NEXT_PUBLIC_APP_URL: 'https://v1.splashz.xyz', USDC_TYPE: `${OBJ}::usdc::USDC`, ADMIN_PASSWORD: 'not-the-demo-value-either', USE_MOCK_APIS: 'true', NEXT_PUBLIC_DEMO_MODE: 'true', SUI_SETTLEMENT_MODE: 'simulate', EMAIL_TRANSPORT: 'resend', EMAIL_API_KEY: 're_test_key', EMAIL_FROM: 'no-reply@splash.example' };
  assert.throws(() => parseEnv(prod), (e) => e instanceof EnvValidationError && e.issues.some((i) => i.key === 'CRON_SECRET'));
});

test('no schedule route or page says what the product refuses to say', () => {
  const files = [...routes, 'lib/schedule/rules.ts', 'lib/schedule/notice.ts', 'lib/schedule/auto-check.ts', 'lib/server/scheduled-payments.ts', 'lib/server/scheduled-runner.ts'];
  for (const file of files) {
    const src = read(file);
    assert.ok(!/E39774|coral/i.test(src), `${file}: no coral`);
    assert.ok(!/\bDemo\b|\bDEMO\b|Coming soon/.test(src), `${file}: no Demo or Coming soon`);
    assert.ok(!/non-custodial|licensed|zero fees|same-day/i.test(src.replace(/not licensed|unlicensed/gi, '')), `${file}: no claim the copy rules refuse`);
  }
});
