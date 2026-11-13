import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import test, { after as afterAll, before, beforeEach } from 'node:test';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

import * as schema from '../lib/db/schema.ts';

/**
 * The customer login's failed-attempt limit holds against requests sent
 * together, not only against requests sent one after another.
 *
 * Found while reviewing C5 (pre-audit fix, 13 Nov 2026): the limiter read the
 * count, the route checked the password, and only then was the failure
 * recorded. Every request in flight read the same stale count, so a client
 * sending its guesses in parallel had every one of them checked. The staff
 * route shares the limiter; tests/admin-login-limit.test.mjs covers it.
 *
 * This file drives the real route on PGlite with the repository's migrations.
 * The only stand-in is `cookies()` from next/headers, which exists only inside
 * a Next request; here it records the session cookie the route sets.
 */

process.env.DATABASE_URL = 'postgres://pglite.invalid/customer-login-limit';
process.env.CUSTOMER_SESSION_SECRET = 'customer-login-limit-session-secret-0123456789abcdef012345';
delete process.env.TRUSTED_PROXY_HOPS;
delete process.env.CLIENT_IP_HEADER;

const EMAIL = 'finance@customer.test';
const PASSWORD = 'correct-horse-battery-staple-9';

const scope = { cookiesSet: [] };
globalThis.__customerLoginLimitScope = scope;

const NEXT_HEADERS = `data:text/javascript,${encodeURIComponent(`
  export async function cookies() {
    const jar = globalThis.__customerLoginLimitScope;
    return {
      get: () => undefined,
      getAll: () => [],
      has: () => false,
      set: (name) => { jar.cookiesSet.push(name); },
      delete: () => {},
    };
  }
  export async function headers() {
    return new Headers();
  }
`)}`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'next/headers') return { url: NEXT_HEADERS, shortCircuit: true };
    if (specifier === 'next/server') return nextResolve('next/server.js', context);
    return nextResolve(specifier, context);
  },
});

let client;
let POST;
let limiter;

before(async () => {
  client = new PGlite();
  const files = (await readdir(new URL('../drizzle', import.meta.url))).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sqlText = await readFile(new URL(`../drizzle/${file}`, import.meta.url), 'utf8');
    for (const statement of sqlText.split('--> statement-breakpoint')) {
      const trimmed = statement.trim();
      if (trimmed) await client.exec(trimmed);
    }
  }
  const db = drizzle(client, { schema });
  globalThis.splashDb = { pool: { end: async () => {} }, db };
  const { createAccount } = await import('../lib/auth/accounts.ts');
  await createAccount(db, { email: EMAIL, password: PASSWORD });
  ({ POST } = await import('../app/api/auth/login/route.ts'));
  limiter = await import('../lib/auth/login-rate-limit.ts');
});

afterAll(async () => {
  delete globalThis.splashDb;
  await client?.close();
});

beforeEach(async () => {
  await client.exec('DELETE FROM rate_limit_hits');
  scope.cookiesSet.length = 0;
});

function logIn(email, password, ip) {
  return POST(
    new Request('https://splash.test/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify({ email, password }),
    }),
  );
}

function tally(responses) {
  const counts = {};
  for (const response of responses) counts[response.status] = (counts[response.status] ?? 0) + 1;
  return counts;
}

test('the right password signs in, and five wrong ones one by one close the account', async () => {
  assert.equal((await logIn(EMAIL, PASSWORD, '198.51.100.1')).status, 200);
  assert.deepEqual(scope.cookiesSet, ['splash_customer_session']);
  for (let i = 0; i < limiter.EMAIL_LIMIT; i++) {
    assert.equal((await logIn(EMAIL, `wrong-password-${i}`, `192.0.2.${i + 1}`)).status, 401);
  }
  assert.equal((await logIn(EMAIL, PASSWORD, '192.0.2.99')).status, 429);
});

test('a burst of guesses sent together is answered no more often than five sent one by one', async () => {
  const burst = 30;
  const responses = await Promise.all(
    Array.from({ length: burst }, (_, i) => logIn(EMAIL, `wrong-password-${i}`, `192.0.2.${i + 1}`)),
  );
  const counts = tally(responses);
  assert.ok((counts[401] ?? 0) <= limiter.EMAIL_LIMIT, `at most ${limiter.EMAIL_LIMIT} passwords checked, got ${JSON.stringify(counts)}`);
  assert.equal((counts[401] ?? 0) + (counts[429] ?? 0), burst, `every other guess is refused, got ${JSON.stringify(counts)}`);

  // A refused guess is not counted, so what the burst left unanswered is still
  // there to be used one by one, and not a guess more: five in all.
  let answered = counts[401] ?? 0;
  for (let i = 0; i <= limiter.EMAIL_LIMIT; i++) {
    const status = (await logIn(EMAIL, `after-${i}`, `192.0.2.${150 + i}`)).status;
    if (status === 429) break;
    assert.equal(status, 401);
    answered += 1;
  }
  assert.equal(answered, limiter.EMAIL_LIMIT, 'five passwords checked across the burst and after it');
  assert.equal((await logIn(EMAIL, PASSWORD, '192.0.2.200')).status, 429, 'and then the right one waits too');
});

test('a burst hiding the right password among wrong ones does not reach it past the limit', async () => {
  const wrong = 29;
  const responses = await Promise.all([
    ...Array.from({ length: wrong }, (_, i) => logIn(EMAIL, `wrong-password-${i}`, `192.0.2.${i + 1}`)),
    logIn(EMAIL, PASSWORD, '192.0.2.100'),
  ]);
  const counts = tally(responses);
  const answered = (counts[401] ?? 0) + (counts[200] ?? 0);
  assert.ok(answered <= limiter.EMAIL_LIMIT, `at most ${limiter.EMAIL_LIMIT} passwords checked, got ${JSON.stringify(counts)}`);
});
