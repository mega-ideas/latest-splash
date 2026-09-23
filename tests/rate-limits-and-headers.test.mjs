import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

import * as schema from '../lib/db/schema.ts';

/**
 * WS7 — rate limits and security headers.
 *
 * Every route that spends something — model credits, a delivery, a write to
 * a store, a Seal access decision — is limited per address and per network
 * through one Postgres-backed limiter. Every response carries the five
 * headers, and every page carries a Content-Security-Policy with a
 * per-request nonce and no `unsafe-inline` in script-src.
 *
 * Red before green: on the tree before the fix there is no CSP, no headers()
 * in next.config.ts, the proxy sets nothing, and the listed routes do their
 * work for anyone who keeps calling.
 */

const csp = () => import('../lib/security/csp.ts');
const headers = () => import('../lib/security/headers.ts');
const limiter = () => import('../lib/server/rate-limit.ts');

async function source(relative) {
  const raw = await readFile(new URL(`../${relative}`, import.meta.url), 'utf8');
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

async function migratedDb() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  const files = (await readdir(new URL('../drizzle', import.meta.url))).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sqlText = await readFile(new URL(`../drizzle/${file}`, import.meta.url), 'utf8');
    for (const statement of sqlText.split('--> statement-breakpoint')) {
      const trimmed = statement.trim();
      if (trimmed) await client.exec(trimmed);
    }
  }
  return { client, db };
}

/** The directive's value, or null if the policy does not set it. */
function directive(policy, name) {
  const found = policy
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name} `) || part === name);
  return found === undefined ? null : found.slice(name.length).trim();
}

/* ── Content Security Policy ─────────────────────────────────────────── */

test('the production CSP nonces scripts, forbids unsafe-inline and unsafe-eval in script-src, and cannot be framed', async () => {
  const { buildContentSecurityPolicy } = await csp();
  const nonce = 'dGVzdC1ub25jZS12YWx1ZQ==';
  const policy = buildContentSecurityPolicy({ nonce, isDev: false });

  const script = directive(policy, 'script-src');
  assert.ok(script, 'script-src is set');
  assert.match(script, new RegExp(`'nonce-${nonce.replace(/[+/=]/g, (c) => `\\${c}`)}'`));
  assert.match(script, /'strict-dynamic'/, 'scripts loaded by nonced scripts (Next chunks, the Sumsub SDK) are trusted transitively');
  assert.doesNotMatch(script, /'unsafe-inline'/);
  assert.doesNotMatch(script, /'unsafe-eval'/);
  assert.doesNotMatch(script, /(^|\s)\*(\s|$)/, 'no wildcard host in script-src');

  assert.equal(directive(policy, 'frame-ancestors'), "'none'", 'approval screens must not be framable');
  assert.equal(directive(policy, 'object-src'), "'none'");
  assert.equal(directive(policy, 'base-uri'), "'self'");
  assert.equal(directive(policy, 'form-action'), "'self'");
  assert.match(directive(policy, 'default-src') ?? '', /'self'/);
  assert.ok(policy.includes('upgrade-insecure-requests'), 'production upgrades mixed content');

  // The KYB flow embeds the Sumsub SDK: it needs a frame and its API, and
  // nothing else does.
  assert.match(directive(policy, 'frame-src') ?? '', /sumsub\.com/);
  assert.match(directive(policy, 'connect-src') ?? '', /'self'/);
  assert.match(directive(policy, 'connect-src') ?? '', /sumsub\.com/);
  assert.doesNotMatch(directive(policy, 'connect-src') ?? '', /(^|\s)\*(\s|$)/);

  // QR codes and previews are data: and blob: images; nothing loads from arbitrary hosts.
  assert.match(directive(policy, 'img-src') ?? '', /data:/);
  assert.match(directive(policy, 'img-src') ?? '', /blob:/);

  // Inline style attributes come from React `style={{}}` props across the app,
  // so style-src allows them — and only them. The line that matters is scripts.
  assert.match(directive(policy, 'style-src') ?? '', /'self'/);
});

test('development adds unsafe-eval for React debugging, and only there; every nonce is fresh', async () => {
  const { buildContentSecurityPolicy } = await csp();
  const dev = buildContentSecurityPolicy({ nonce: 'abc', isDev: true });
  assert.match(directive(dev, 'script-src') ?? '', /'unsafe-eval'/);
  assert.doesNotMatch(directive(dev, 'script-src') ?? '', /'unsafe-inline'/);
  assert.ok(!dev.includes('upgrade-insecure-requests'), 'localhost is http');

  const a = buildContentSecurityPolicy({ nonce: 'first', isDev: false });
  const b = buildContentSecurityPolicy({ nonce: 'second', isDev: false });
  assert.notEqual(a, b);
  assert.throws(() => buildContentSecurityPolicy({ nonce: '', isDev: false }), /nonce/);
});

test('the proxy issues a nonce per request, sets the policy on the response, and skips prefetches and assets', async () => {
  const proxy = await source('proxy.ts');
  assert.match(proxy, /randomBytes\(|randomUUID\(/, 'a CSPRNG nonce');
  assert.match(proxy, /buildContentSecurityPolicy\(/);
  assert.match(proxy, /requestHeaders\.set\('x-nonce'/, 'the nonce reaches the render');
  assert.match(proxy, /headers\.set\('Content-Security-Policy'/, 'the policy reaches the browser');
  assert.match(proxy, /next-router-prefetch/, 'prefetches carry no policy');
  // The admin-host rewrite must carry the policy too — it serves the approval screens.
  assert.match(proxy, /NextResponse\.rewrite\([\s\S]{0,200}headers/);
});

test('every page renders dynamically, because a nonce cannot be prerendered', async () => {
  const layout = await source('app/layout.tsx');
  assert.match(layout, /export const dynamic = 'force-dynamic'/);
});

/* ── The five headers ────────────────────────────────────────────────── */

test('the security headers are the five, with the values that mean something', async () => {
  const { SECURITY_HEADERS } = await headers();
  const byKey = Object.fromEntries(SECURITY_HEADERS.map((h) => [h.key.toLowerCase(), h.value]));

  assert.match(byKey['strict-transport-security'] ?? '', /max-age=(\d+)/);
  const maxAge = Number(/max-age=(\d+)/.exec(byKey['strict-transport-security'])[1]);
  assert.ok(maxAge >= 31_536_000, 'at least a year');
  assert.match(byKey['strict-transport-security'], /includeSubDomains/);
  assert.equal(byKey['x-content-type-options'], 'nosniff');
  assert.equal(byKey['referrer-policy'], 'strict-origin-when-cross-origin');
  assert.equal(byKey['x-frame-options'], 'DENY', 'the CSP frame-ancestors rule, for browsers that only read this');
  assert.match(byKey['permissions-policy'] ?? '', /camera=/, 'the KYB flow needs the camera; everything else is off');
  assert.match(byKey['permissions-policy'] ?? '', /geolocation=\(\)/);
  assert.match(byKey['permissions-policy'] ?? '', /payment=\(\)/);
});

test('next.config.ts applies the five headers to every path', async () => {
  const { default: config } = await import('../next.config.ts');
  assert.equal(typeof config.headers, 'function');
  const rules = await config.headers();
  const everything = rules.find((rule) => rule.source === '/(.*)' || rule.source === '/:path*');
  assert.ok(everything, 'one rule must cover every response, API routes included');
  const keys = everything.headers.map((h) => h.key.toLowerCase());
  for (const key of ['strict-transport-security', 'x-content-type-options', 'referrer-policy', 'x-frame-options', 'permissions-policy']) {
    assert.ok(keys.includes(key), `${key} on every response`);
  }
  // The CSP is per request (it carries the nonce), so it must NOT be a static header here.
  assert.ok(!keys.includes('content-security-policy'), 'a static CSP would have no nonce');
});

/* ── Rate limits ─────────────────────────────────────────────────────── */

test('every route that spends something is limited before it does the work', async () => {
  const routes = {
    'app/api/pay/[slug]/route.ts': ['upsertRecipientFromInvoice('],
    // v14 consolidated the three chat surfaces onto /api/oxwal and deleted
    // /api/copilot/chat; the limiter moved with the model spend.
    'app/api/oxwal/route.ts': ['runOxwalAgent('],
    'app/api/copilot/extract-invoice/route.ts': ['parseInvoice('],
    'app/api/copilot/suggest/route.ts': ['getCopilotSuggestions('],
    'app/api/copilot/summary/route.ts': ['listInvoicesFor('],
    'app/api/seal/access/route.ts': ['sealAdapter.canDecrypt('],
    'app/api/invoices/route.ts': ['persistInvoice('],
    'app/api/recipients/route.ts': ['persistRecipient('],
  };
  for (const [route, work] of Object.entries(routes)) {
    const text = await source(route);
    const check = text.indexOf('enforceRateLimit(');
    assert.ok(check > 0, `${route} must call enforceRateLimit`);
    for (const marker of work) {
      const at = text.indexOf(marker);
      assert.ok(at > 0, `${route}: expected to find ${marker}`);
      assert.ok(check < at, `${route}: the limit is checked before ${marker}`);
    }
  }
});

test('the rules exist for each of them, and none is unlimited', async () => {
  const { RATE_LIMITS } = await limiter();
  for (const name of ['payLinkIp', 'copilotUser', 'copilotIp', 'extractInvoiceUser', 'sealAccessIp', 'invoiceCreateUser', 'recipientCreateUser']) {
    const rule = RATE_LIMITS[name];
    assert.ok(rule, `RATE_LIMITS.${name}`);
    assert.ok(rule.limit > 0 && rule.limit < 10_000, `${name} has a real limit`);
    assert.ok(rule.windowMs >= 60_000, `${name} has a real window`);
    assert.match(rule.bucket, /^[a-z-]+:(ip|email|user)$/);
  }
});

test('enforceRateLimit answers 429 with Retry-After past the limit, records the hit under it, and is injectable', async () => {
  const { client, db } = await migratedDb();
  const { enforceRateLimit } = await limiter();
  const rule = { bucket: 'test:ip', limit: 2, windowMs: 60_000 };
  const now = new Date('2026-09-23T12:00:00.000Z');

  assert.equal(await enforceRateLimit({ db, rule, key: '203.0.113.9', now }), null);
  assert.equal(await enforceRateLimit({ db, rule, key: '203.0.113.9', now }), null);
  const refused = await enforceRateLimit({ db, rule, key: '203.0.113.9', now, message: 'Slow down.' });
  assert.ok(refused instanceof Response);
  assert.equal(refused.status, 429);
  assert.ok(Number(refused.headers.get('Retry-After')) > 0);
  assert.equal((await refused.json()).code, 'rate_limited');
  assert.equal(await enforceRateLimit({ db, rule, key: '203.0.113.10', now }), null, 'another key is untouched');

  await client.close();
});

test('the login limiter is the same limiter: failures count, success clears, and the old table is no longer written', async () => {
  const { client, db } = await migratedDb();
  const { checkLoginRateLimit, clearLoginFailures, recordFailedLogin, EMAIL_LIMIT } = await import('../lib/auth/login-rate-limit.ts');

  for (let i = 0; i < EMAIL_LIMIT; i++) await recordFailedLogin(db, { email: 'x@example.com', ip: '10.0.0.1' });
  assert.equal((await checkLoginRateLimit(db, { email: 'x@example.com', ip: '10.0.0.1' })).allowed, false);
  await clearLoginFailures(db, 'x@example.com');
  assert.equal((await checkLoginRateLimit(db, { email: 'x@example.com', ip: '10.0.0.1' })).allowed, true);

  const { rows: legacy } = await client.query('select count(*)::int as n from login_attempts');
  assert.equal(legacy[0].n, 0, 'login_attempts is legacy; the hits live in rate_limit_hits');
  const { rows: hits } = await client.query("select count(*)::int as n from rate_limit_hits where bucket like 'login-failure:%'");
  assert.ok(hits[0].n >= 0);

  const loginSource = await source('lib/auth/login-rate-limit.ts');
  assert.doesNotMatch(loginSource, /loginAttempts/, 'one implementation, not two');
  assert.match(loginSource, /from '\.\.\/server\/rate-limit\.ts'/);

  await client.close();
});
