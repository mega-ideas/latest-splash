import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { after as afterAll, before, beforeEach } from 'node:test';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

import * as schema from '../lib/db/schema.ts';

/**
 * C5 (pre-audit fix, 13 Nov 2026): staff sign-in is limited like customer
 * sign-in.
 *
 * The staff console approves KYB, which verifies a business on chain, and
 * /api/admin/login used to answer every guess at the one configured staff
 * password for as long as anyone kept asking. It now goes through the same
 * failed-attempt limiter as the customer login (lib/auth/login-rate-limit.ts:
 * five per email per 15 minutes, twenty per network per hour), consulted
 * BEFORE the password is checked, under an email key of its own.
 *
 * This file drives the real route on PGlite with the repository's migrations.
 * The only stand-in is `cookies()` from next/headers, which exists only inside
 * a Next request; here it records the session cookie the route sets.
 */

process.env.DATABASE_URL = 'postgres://pglite.invalid/admin-login-limit';
process.env.ADMIN_EMAIL = 'staff@splash.test';
process.env.ADMIN_PASSWORD = 'correct-staff-password-for-tests';
process.env.ADMIN_SESSION_SECRET = 'admin-login-limit-session-secret-0123456789abcdef0123456789';
// The revocation epoch file is read from here; keep it out of the repo.
process.env.SPLASH_DATA_DIR = path.join(os.tmpdir(), 'splash-admin-login-limit-no-data');
// One proxy in front (nginx): the client is the last X-Forwarded-For entry.
delete process.env.TRUSTED_PROXY_HOPS;
delete process.env.CLIENT_IP_HEADER;

const STAFF = process.env.ADMIN_EMAIL;
const PASSWORD = process.env.ADMIN_PASSWORD;

// ── A request scope outside Next ────────────────────────────────────────────

const scope = { cookiesSet: [] };
globalThis.__adminLoginLimitScope = scope;

const NEXT_HEADERS = `data:text/javascript,${encodeURIComponent(`
  export async function cookies() {
    const jar = globalThis.__adminLoginLimitScope;
    return {
      get: () => undefined,
      getAll: () => [],
      has: () => false,
      set: (name, value) => { jar.cookiesSet.push(name); },
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
    // A route imports 'next/server', which plain Node resolves only with its extension.
    if (specifier === 'next/server') return nextResolve('next/server.js', context);
    return nextResolve(specifier, context);
  },
});

let client;
let db;
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
  db = drizzle(client, { schema });
  globalThis.splashDb = { pool: { end: async () => {} }, db };
  ({ POST } = await import('../app/api/admin/login/route.ts'));
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

/** One sign-in attempt from `ip`, as nginx would forward it. */
function signIn(email, password, ip = '198.51.100.1') {
  return POST(
    new Request('https://splash.test/api/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify({ email, password }),
    }),
  );
}

/** Run `fn` with the environment changed, and put it back afterwards. */
async function withEnv(changes, fn) {
  const saved = Object.fromEntries(Object.keys(changes).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// ── The limit ───────────────────────────────────────────────────────────────

test('five wrong passwords close the staff sign-in, and the right one is then refused before it is checked', async () => {
  for (let i = 0; i < limiter.EMAIL_LIMIT; i++) {
    assert.equal((await signIn(STAFF, `wrong-${i}`)).status, 401, `guess ${i + 1} is answered`);
  }

  const refused = await signIn(STAFF, PASSWORD);
  assert.equal(refused.status, 429, 'the limit is consulted before the password, so even the right one waits');
  const retryAfter = Number(refused.headers.get('Retry-After'));
  assert.ok(retryAfter > 0 && retryAfter <= 15 * 60, `Retry-After is inside the 15-minute window (got ${retryAfter})`);
  assert.equal((await refused.json()).session, undefined);
  assert.deepEqual(scope.cookiesSet, [], 'no staff session is minted while the limit holds');
});

test('changing the case or padding of the email does not open a fresh bucket', async () => {
  // Every one of these signs in with the right password: the credential check
  // trims and lowercases. So each must count against the same staff address,
  // or an attacker gets five more guesses per spelling.
  const spellings = ['STAFF@SPLASH.TEST', ' staff@splash.test', '\tStaff@Splash.Test', 'staff@splash.test  ', '  STAFF@splash.test\n'];
  assert.equal((await signIn(spellings[1], PASSWORD)).status, 200, 'a padded spelling is a real sign-in');

  for (const spelling of spellings) {
    assert.equal((await signIn(spelling, 'wrong')).status, 401);
  }
  assert.equal((await signIn(STAFF, PASSWORD)).status, 429, 'five failures across spellings close the one address');
});

test('the refusal says nothing about whether the email is the staff address', async () => {
  for (let i = 0; i < limiter.EMAIL_LIMIT; i++) {
    await signIn(STAFF, 'wrong', '198.51.100.10');
    await signIn('nobody@splash.test', 'wrong', '198.51.100.11');
  }
  const staff = await signIn(STAFF, 'wrong', '198.51.100.10');
  const nobody = await signIn('nobody@splash.test', 'wrong', '198.51.100.11');
  assert.equal(staff.status, 429);
  assert.equal(nobody.status, 429);
  assert.deepEqual(await staff.json(), await nobody.json(), 'the same refusal for the staff address and any other');

  // And below the limit, the same failure for a wrong password and an unknown
  // address. Start clean: the staff address is closed from above.
  await client.exec('DELETE FROM rate_limit_hits');
  const wrongPassword = await signIn(STAFF, 'wrong', '198.51.100.12');
  const unknownEmail = await signIn('nobody-else@splash.test', 'wrong', '198.51.100.13');
  assert.equal(wrongPassword.status, 401);
  assert.equal(unknownEmail.status, 401);
  assert.deepEqual(await wrongPassword.json(), await unknownEmail.json(), 'the same failure for both');
});

test('a failure counts against the network too: one source spraying addresses is stopped', async () => {
  const ip = '203.0.113.7';
  // Four guesses each at distinct addresses: every address stays under its own
  // limit of five, so only the per-network count can catch this.
  for (let i = 0; i < limiter.IP_LIMIT; i++) {
    assert.equal((await signIn(`guess${Math.floor(i / 4)}@splash.test`, 'wrong', ip)).status, 401);
  }
  assert.equal((await signIn(STAFF, PASSWORD, ip)).status, 429, 'the network is closed, staff address included');
  assert.equal((await signIn(STAFF, PASSWORD, '203.0.113.8')).status, 200, 'another network is not');
});

test('staff and customer failures never share an email bucket', async () => {
  // A customer account with the same address as the staff login fails five
  // times (from other networks, so only the email bucket is in play).
  for (let i = 0; i < limiter.EMAIL_LIMIT; i++) {
    await limiter.recordFailedLogin(db, { email: STAFF, ip: `192.0.2.${i}` });
  }
  assert.equal((await limiter.checkLoginRateLimit(db, { email: STAFF, ip: '192.0.2.99' })).allowed, false);
  assert.equal((await signIn(STAFF, PASSWORD)).status, 200, 'customer failures do not lock the staff console');

  await client.exec('DELETE FROM rate_limit_hits');
  for (let i = 0; i < limiter.EMAIL_LIMIT; i++) {
    await signIn(STAFF, 'wrong', `192.0.2.${i}`);
  }
  assert.equal((await signIn(STAFF, PASSWORD, '192.0.2.99')).status, 429);
  assert.equal(
    (await limiter.checkLoginRateLimit(db, { email: STAFF, ip: '192.0.2.99' })).allowed,
    true,
    'staff failures do not lock the customer account with the same address',
  );
});

test('no address a customer can type reaches the staff address bucket', async () => {
  // The customer route takes any string of up to 254 characters as the
  // address. When the staff bucket was the customer one with keys spelled
  // `staff:<address>`, a customer sign-in naming `staff:<ADMIN_EMAIL>` wrote
  // into it, and five of those closed the console. Through the real customer
  // route, from networks of their own, so only the address bucket is in play.
  const { POST: customerPOST } = await import('../app/api/auth/login/route.ts');
  const customerSignIn = (email, ip) =>
    customerPOST(
      new Request('https://splash.test/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
        body: JSON.stringify({ email, password: 'wrong' }),
      }),
    );

  for (let i = 0; i < limiter.EMAIL_LIMIT; i++) {
    assert.equal((await customerSignIn(`staff:${STAFF}`, `192.0.2.${i + 1}`)).status, 401, `customer guess ${i + 1} is answered`);
  }
  assert.equal(
    (await customerSignIn(`staff:${STAFF}`, '192.0.2.99')).status,
    429,
    'the customer address bucket for that string is closed, so the failures were counted',
  );
  assert.equal((await signIn(STAFF, PASSWORD, '192.0.2.200')).status, 200, 'and the staff console is still open');
});

test('a successful staff sign-in clears that address’s failures', async () => {
  for (let i = 0; i < limiter.EMAIL_LIMIT - 1; i++) await signIn(STAFF, 'wrong');
  const ok = await signIn(STAFF, PASSWORD);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).session.email, STAFF);
  assert.deepEqual(scope.cookiesSet, ['splash_admin_session']);

  // Without the clear these would be failures six to nine, and refused.
  for (let i = 0; i < limiter.EMAIL_LIMIT - 1; i++) {
    assert.equal((await signIn(STAFF, 'wrong')).status, 401);
  }
  assert.equal((await signIn(STAFF, PASSWORD)).status, 200);
});

// ── Requests in flight together ─────────────────────────────────────────────

/** How many of the responses came back with each status. */
function tally(responses) {
  const counts = {};
  for (const response of responses) counts[response.status] = (counts[response.status] ?? 0) + 1;
  return counts;
}

test('a burst of guesses sent together is answered no more often than five sent one by one', async () => {
  // Reading the count, checking the password and then recording the failure
  // lets every request in flight read the same stale count: a parallel client
  // got its password checked as often as it liked. From networks of their
  // own, so only the address bucket is in play.
  const burst = 30;
  const responses = await Promise.all(
    Array.from({ length: burst }, (_, i) => signIn(STAFF, `wrong-${i}`, `192.0.2.${i + 1}`)),
  );
  const counts = tally(responses);
  assert.ok((counts[401] ?? 0) <= limiter.EMAIL_LIMIT, `at most ${limiter.EMAIL_LIMIT} passwords checked, got ${JSON.stringify(counts)}`);
  assert.equal((counts[401] ?? 0) + (counts[429] ?? 0), burst, `every other guess is refused, got ${JSON.stringify(counts)}`);

  // A refused guess is not counted, so what the burst left unanswered is still
  // there to be used one by one, and not a guess more: five in all.
  let answered = counts[401] ?? 0;
  for (let i = 0; i <= limiter.EMAIL_LIMIT; i++) {
    const status = (await signIn(STAFF, `after-${i}`, `192.0.2.${150 + i}`)).status;
    if (status === 429) break;
    assert.equal(status, 401);
    answered += 1;
  }
  assert.equal(answered, limiter.EMAIL_LIMIT, 'five passwords checked across the burst and after it');
  assert.equal((await signIn(STAFF, PASSWORD, '192.0.2.200')).status, 429, 'and then the right one waits too');
});

test('a burst hiding the right password among wrong ones does not reach it past the limit', async () => {
  const wrong = 29;
  const responses = await Promise.all([
    ...Array.from({ length: wrong }, (_, i) => signIn(STAFF, `wrong-${i}`, `192.0.2.${i + 1}`)),
    signIn(STAFF, PASSWORD, '192.0.2.100'),
  ]);
  const counts = tally(responses);
  const answered = (counts[401] ?? 0) + (counts[200] ?? 0);
  assert.ok(answered <= limiter.EMAIL_LIMIT, `at most ${limiter.EMAIL_LIMIT} passwords checked, got ${JSON.stringify(counts)}`);
});

test('a burst from one network spraying addresses is answered no more often than the network limit', async () => {
  const burst = 60;
  const ip = '203.0.113.50';
  const responses = await Promise.all(
    Array.from({ length: burst }, (_, i) => signIn(`spray${i}@splash.test`, 'wrong', ip)),
  );
  const counts = tally(responses);
  assert.ok((counts[401] ?? 0) <= limiter.IP_LIMIT, `at most ${limiter.IP_LIMIT} passwords checked, got ${JSON.stringify(counts)}`);
  assert.equal((counts[401] ?? 0) + (counts[429] ?? 0), burst, `every other guess is refused, got ${JSON.stringify(counts)}`);
});

// ── Input the limiter cannot store ─────────────────────────────────────────

test('an address too long to be one is refused like any wrong pair, not with a server error', async () => {
  // The address bucket's key goes into a btree index, which refuses a row of
  // more than 2704 bytes: an unbounded address made the route throw. The
  // customer route caps the address at 254 characters (RFC 5321) and so does
  // this one, before the limiter is touched.
  // Random characters, because a repeated one compresses under the limit.
  for (const length of [255, 3000, 100_000]) {
    const local = randomBytes(length).toString('hex').slice(0, length - '@splash.test'.length);
    const email = `${local}@splash.test`;
    const response = await signIn(email, 'wrong');
    assert.equal(response.status, 401, `a ${length}-character address is a wrong pair`);
    assert.deepEqual(await response.json(), { error: 'Invalid staff credentials' }, 'with the same answer as any other');
  }
  const ok = await signIn(STAFF, PASSWORD);
  assert.equal(ok.status, 200, 'and the staff address still signs in');
});

// ── Without a database ──────────────────────────────────────────────────────

test('production without a database refuses staff sign-in rather than run unlimited', async () => {
  const response = await withEnv({ DATABASE_URL: undefined, NODE_ENV: 'production' }, () => signIn(STAFF, PASSWORD));
  assert.equal(response.status, 401);
  assert.equal((await response.json()).session, undefined);
  assert.deepEqual(scope.cookiesSet, [], 'no staff session without somewhere to count failures');
});

test('a development machine without a database signs staff in as before', async () => {
  await withEnv({ DATABASE_URL: undefined }, async () => {
    for (let i = 0; i < limiter.EMAIL_LIMIT * 2; i++) {
      assert.equal((await signIn(STAFF, 'wrong')).status, 401);
    }
    const ok = await signIn(STAFF, PASSWORD);
    assert.equal(ok.status, 200, 'no limit is enforced where there is nowhere to count');
    assert.equal((await ok.json()).session.email, STAFF);
  });
  const { rows } = await client.query('select count(*)::int as n from rate_limit_hits');
  assert.equal(rows[0].n, 0, 'nothing was written to the database the route was told it does not have');
});
