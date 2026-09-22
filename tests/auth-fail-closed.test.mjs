import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';

import * as schema from '../lib/db/schema.ts';
import { createAccount, markEmailVerified, verifyAccountPassword, AccountExistsError } from '../lib/auth/accounts.ts';
import {
  UnauthorizedError,
  grantMembership,
  resolveAuthorityFromDb,
} from '../lib/auth/authority.ts';
import {
  EMAIL_LIMIT,
  IP_LIMIT,
  checkLoginRateLimit,
  clearLoginFailures,
  clientIp,
  recordFailedLogin,
} from '../lib/auth/login-rate-limit.ts';
import { hashPassword, needsRehash, verifyPassword, PasswordError } from '../lib/auth/password.ts';

/**
 * The bypass this file exists to keep closed:
 *
 *   POST /api/auth/signup (any email, password never stored)
 *     → createSignupSession → a valid session cookie
 *     → resolveAuthorityForSession → UnauthorizedError → caught
 *     → provisionOperatorMembership('checker') → mapDbRole → APPROVER
 *     → APPROVAL_ROLES.has('APPROVER') → approves payments
 */

async function migratedDb() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  const dir = new URL('../drizzle', import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sqlText = await readFile(new URL(`../drizzle/${file}`, import.meta.url), 'utf8');
    for (const statement of sqlText.split('--> statement-breakpoint')) {
      const trimmed = statement.trim();
      if (trimmed) await client.exec(trimmed);
    }
  }
  return { client, db };
}


/**
 * Source with comments removed.
 *
 * Every assertion below is about what the code DOES, so it must not see what
 * the code SAYS. The modules under test deliberately document the bypass they
 * closed — naming provisionOperatorMembership, createSignupSession and
 * FALLBACK_CUSTOMER_PASSWORD in prose — and an assertion that greps raw source
 * cannot tell an explanation from a call. Keeping the history and keeping the
 * guard both require stripping first.
 */
function code(source) {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, ' ');
  return withoutBlocks
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

const PASSWORD = 'correct-horse-battery-staple-9';

/* ── The end-to-end property the brief names ───────────────────────────── */

test('a new account can sign up, log in, and approve nothing', async () => {
  const { client, db } = await migratedDb();
  const email = 'stranger@example.com';

  // Sign up.
  const account = await createAccount(db, { email, password: PASSWORD, name: 'Stranger Ltd' });
  assert.equal(account.email, email);

  // Log in: the password verifies, which proves identity.
  assert.ok(await verifyAccountPassword(db, { email, password: PASSWORD }));

  // And that is all it proves. No membership exists, so authority resolution
  // fails closed rather than provisioning one.
  await assert.rejects(() => resolveAuthorityFromDb(db, email), UnauthorizedError);

  await client.close();
});

test('an account with no membership is not an approver by any role mapping', async () => {
  const { client, db } = await migratedDb();
  await createAccount(db, { email: 'nobody@example.com', password: PASSWORD });
  await assert.rejects(() => resolveAuthorityFromDb(db, 'nobody@example.com'), UnauthorizedError);

  await client.close();
});

test('authority appears only when a membership is granted, and follows the grant', async () => {
  const { client, db } = await migratedDb();
  const email = 'ops@example.com';
  await createAccount(db, { email, password: PASSWORD });
  await assert.rejects(() => resolveAuthorityFromDb(db, email), UnauthorizedError);

  // A grant requires a proven mailbox (WS1, X5); the link stands in here.
  await markEmailVerified(db, email);
  await grantMembership(db, { email, orgId: 'demo-business', role: 'maker' });
  const asMaker = await resolveAuthorityFromDb(db, email);
  assert.equal(asMaker.role, 'MAKER');

  await db
    .update(schema.memberships)
    .set({ role: 'checker' })
    .where(eq(schema.memberships.userId, asMaker.userId));
  const asChecker = await resolveAuthorityFromDb(db, email);
  assert.equal(asChecker.role, 'APPROVER', 'the role is re-read per request, never cached');

  await client.close();
});

/* ── The grep the brief specifies, as an assertion ─────────────────────── */

test('no module under the auth path provisions a membership', async () => {
  // "grep -rn provisionOperatorMembership lib app returns only its definition"
  // — the function is gone entirely, and its replacement is administrative.
  const offenders = [];
  const grantCallers = [];

  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name)) {
        const text = code(await readFile(full, 'utf8'));
        const rel = full.replaceAll('\\', '/');
        if (/\bprovisionOperatorMembership\b/.test(text)) offenders.push(rel);
        // grantMembership may exist, but not on a login or session path.
        if (/\bgrantMembership\s*\(/.test(text) && rel !== 'lib/auth/authority.ts') {
          grantCallers.push(rel);
        }
      }
    }
  }
  await walk('lib');
  await walk('app');

  assert.deepEqual(offenders, [], 'provisionOperatorMembership must not exist');

  for (const caller of grantCallers) {
    assert.doesNotMatch(
      caller,
      /auth\/(login|signup|session)|customer-auth|authority-resolver/,
      `${caller} grants membership on an auth path`,
    );
  }
});

test('resolveAuthorityForSession has no catch that provisions, and no DB-less default', async () => {
  const source = code(await readFile(new URL('../lib/auth/authority.ts', import.meta.url), 'utf8'));
  // The old shape: try { resolve } catch { provision; resolve }.
  assert.doesNotMatch(source, /catch[\s\S]{0,200}provision/i);
  // The DB-less path used to return OXWAL_OPERATOR_ROLE ?? 'APPROVER'.
  assert.doesNotMatch(source, /OXWAL_OPERATOR_ROLE/);
  assert.doesNotMatch(source, /resolveAuthorityLocal/);
  // Without a database there is no membership to read, so there is no answer.
  assert.match(source, /DATABASE_URL[\s\S]{0,200}UnauthorizedError/);
});

test('signup issues no session and grants no authority', async () => {
  const source = code(await readFile(new URL('../app/api/auth/signup/route.ts', import.meta.url), 'utf8'));
  assert.doesNotMatch(source, /createSignupSession/);
  assert.doesNotMatch(source, /setCustomerSessionCookie/);
  assert.match(source, /createAccount/);
  assert.match(source, /authority: 'none'/);
});

test('the env credential pair is gone from the auth path', async () => {
  const auth = code(await readFile(new URL('../lib/server/customer-auth.ts', import.meta.url), 'utf8'));
  const session = code(await readFile(new URL('../lib/auth/customer-session.ts', import.meta.url), 'utf8'));
  const login = code(await readFile(new URL('../app/api/auth/login/route.ts', import.meta.url), 'utf8'));
  for (const [name, text] of [['customer-auth', auth], ['customer-session', session], ['login route', login]]) {
    assert.doesNotMatch(text, /process\.env\.CUSTOMER_PASSWORD/, `${name} still reads CUSTOMER_PASSWORD`);
    assert.doesNotMatch(text, /FALLBACK_CUSTOMER_PASSWORD/, `${name} still has a fallback password`);
  }
  assert.doesNotMatch(auth, /validateCustomerCredentials/);
  assert.doesNotMatch(auth, /createSignupSession/);
});

/* ── Passwords ─────────────────────────────────────────────────────────── */

test('passwords are hashed with scrypt, never stored or compared in the clear', async () => {
  const hash = await hashPassword(PASSWORD);
  assert.match(hash, /^scrypt\$\d+\$\d+\$\d+\$[\w-]+\$[\w-]+$/);
  assert.doesNotMatch(hash, new RegExp(PASSWORD), 'the password must not appear in its own hash');
  assert.ok(await verifyPassword(PASSWORD, hash));
  assert.equal(await verifyPassword('wrong', hash), false);
  // Two hashes of the same password differ: the salt is random.
  assert.notEqual(hash, await hashPassword(PASSWORD));
});

test('a weak password is refused before anything is written', async () => {
  await assert.rejects(() => hashPassword('short1'), PasswordError);
  await assert.rejects(() => hashPassword('nodigitsinthisone'), PasswordError);
  await assert.rejects(() => hashPassword('123456789012345'), PasswordError);
});

test('a malformed or tampered stored hash verifies false rather than throwing', async () => {
  for (const bad of ['', 'not-a-hash', 'scrypt$0$8$1$aa$bb', 'md5$1$1$1$aa$bb', 'scrypt$3$8$1$aa$bb']) {
    assert.equal(await verifyPassword(PASSWORD, bad), false, `"${bad}" should verify false`);
  }
});

test('needsRehash reports a hash weaker than current policy', async () => {
  assert.equal(needsRehash(await hashPassword(PASSWORD)), false);
  assert.equal(needsRehash('scrypt$16384$8$1$YWJj$ZGVm'), true, 'a lower cost is upgradeable');
  assert.equal(needsRehash('garbage'), true);
});

test('an unknown email and a wrong password are the same answer', async () => {
  const { client, db } = await migratedDb();
  await createAccount(db, { email: 'known@example.com', password: PASSWORD });
  assert.equal(await verifyAccountPassword(db, { email: 'known@example.com', password: 'wrong-password-1' }), null);
  assert.equal(await verifyAccountPassword(db, { email: 'unknown@example.com', password: PASSWORD }), null);
  await client.close();
});

test('a duplicate signup is refused rather than overwriting the account', async () => {
  const { client, db } = await migratedDb();
  await createAccount(db, { email: 'dupe@example.com', password: PASSWORD });
  await assert.rejects(
    () => createAccount(db, { email: 'dupe@example.com', password: 'a-different-password-2' }),
    AccountExistsError,
  );
  // The original password still works: nothing was overwritten.
  assert.ok(await verifyAccountPassword(db, { email: 'dupe@example.com', password: PASSWORD }));
  await client.close();
});

/* ── Rate limiting ─────────────────────────────────────────────────────── */

test('five failures for one email closes that window', async () => {
  const { client, db } = await migratedDb();
  const email = 'target@example.com';
  for (let i = 0; i < EMAIL_LIMIT; i++) {
    assert.equal((await checkLoginRateLimit(db, { email, ip: `10.0.0.${i}` })).allowed, true);
    await recordFailedLogin(db, { email, ip: `10.0.0.${i}` });
  }
  const verdict = await checkLoginRateLimit(db, { email, ip: '10.0.0.99' });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.scope, 'email');
  assert.ok(verdict.retryAfterSeconds > 0 && verdict.retryAfterSeconds <= 15 * 60);
  await client.close();
});

test('a successful login clears that email’s failures', async () => {
  const { client, db } = await migratedDb();
  const email = 'recovers@example.com';
  for (let i = 0; i < EMAIL_LIMIT; i++) await recordFailedLogin(db, { email, ip: '10.0.0.1' });
  assert.equal((await checkLoginRateLimit(db, { email, ip: '10.0.0.1' })).allowed, false);
  await clearLoginFailures(db, email);
  assert.equal((await checkLoginRateLimit(db, { email, ip: '10.0.0.1' })).allowed, true);
  await client.close();
});

test('one IP spraying many accounts is stopped, which the per-email limit never sees', async () => {
  const { client, db } = await migratedDb();
  const ip = '203.0.113.7';
  // Four failures each against distinct accounts: every account stays under
  // its own limit of five, so only the IP window can catch this.
  for (let i = 0; i < IP_LIMIT; i++) {
    const email = `victim${Math.floor(i / 4)}@example.com`;
    assert.equal((await checkLoginRateLimit(db, { email, ip })).allowed, true);
    await recordFailedLogin(db, { email, ip });
  }
  const verdict = await checkLoginRateLimit(db, { email: 'fresh@example.com', ip });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.scope, 'ip');
  await client.close();
});

test('attempts outside the window stop counting', async () => {
  const { client, db } = await migratedDb();
  const email = 'aged@example.com';
  const old = new Date(Date.now() - 20 * 60 * 1000);
  for (let i = 0; i < EMAIL_LIMIT; i++) await recordFailedLogin(db, { email, ip: '10.0.0.1', now: old });
  assert.equal((await checkLoginRateLimit(db, { email, ip: '10.0.0.1' })).allowed, true);
  await client.close();
});

test('an unknown client address shares one bucket rather than trusting a header it cannot verify', () => {
  const withHeader = new Request('https://example.com', { headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' } });
  assert.equal(clientIp(withHeader), '1.2.3.4');
  assert.equal(clientIp(new Request('https://example.com')), 'unknown');
});
