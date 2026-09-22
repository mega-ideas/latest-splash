import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';

import * as schema from '../lib/db/schema.ts';
import { AccountExistsError, createAccount, markEmailVerified, verifyAccountPassword } from '../lib/auth/accounts.ts';
import { DEFAULT_ORG_ID, UnauthorizedError, grantMembership, resolveAuthorityFromDb } from '../lib/auth/authority.ts';
import { MembershipAdminError, grantRole } from '../lib/server/memberships.ts';
import {
  createCustomerSessionFromIdentity,
  createCustomerSessionToken,
  readCustomerSessionToken,
} from '../lib/auth/customer-session.ts';
import { EnvValidationError, parseEnv } from '../lib/env.ts';

/**
 * WS1 — account pre-hijacking (X5).
 *
 * The exploit this file exists to close: signup never proves the mailbox, and
 * a grant only requires that an account exists. An attacker registers
 * `cfo@victim.example` first; the victim's administrator later grants that
 * address approver rights; the grant lands on the attacker. The real CFO's own
 * signup returns 201 and changes nothing.
 *
 * Red before green: the first test documents the hole and PASSES on the tree
 * before the fix. Every other test fails until the fix lands. The modules the
 * fix introduces are imported lazily so that, before they exist, each test
 * fails on its own line instead of the whole file refusing to load.
 */

const verification = () => import('../lib/auth/email-verification.ts');
const transport = () => import('../lib/auth/email-transport.ts');
const rateLimit = () => import('../lib/server/rate-limit.ts');

const PASSWORD = 'correct-horse-battery-staple-9';
const ATTACKER_PASSWORD = 'attacker-chose-this-one-7';
const OWNER_PASSWORD = 'the-real-cfo-sets-this-1';
const STAFF = 'ops@splash.example';
const VICTIM = 'cfo@victim.example';

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
  await client.exec(`INSERT INTO organizations (id, name) VALUES ('acme', 'Acme Sdn Bhd')`);
  return { client, db };
}

/** Source with comments stripped, so prose that names a function is not a call. */
function code(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

async function userRow(db, email) {
  const rows = await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
  return rows[0] ?? null;
}

/** The demo organisation every desk proposal is booked under. Pinned: the seed,
 *  the zkLogin route and the tests all agree on it, and a silent rename would
 *  strand every membership granted against the old id. */
test('the demo org id is pinned', () => {
  assert.equal(DEFAULT_ORG_ID, 'demo-business');
});

/* ── X5, reproduced ────────────────────────────────────────────────────── */

test('X5 · a pre-registered address receives the grant meant for the mailbox owner', async () => {
  const { client, db } = await migratedDb();

  // The attacker registers the CFO's address first. No email is ever sent, so
  // nothing about this step involves the real mailbox.
  const attacker = await createAccount(db, { email: VICTIM, password: ATTACKER_PASSWORD, name: 'Not the CFO' });
  assert.equal(attacker.email, VICTIM);

  // The real CFO signs up later. The route answers 201 either way; here that
  // is the AccountExistsError the route swallows. Nothing changes.
  await assert.rejects(
    () => createAccount(db, { email: VICTIM, password: OWNER_PASSWORD, name: 'Victim Sdn Bhd' }),
    AccountExistsError,
  );

  // An administrator grants approver rights to the address they know.
  //
  // RED (this commit): the grant goes through, and the approval authority
  // lands on whoever holds the attacker's password. This test PASSES on the
  // tree before the fix — that is the reproduction. The green commit flips
  // it to expect `unverified_email`.
  await grantRole(db, { email: VICTIM, orgId: 'acme', role: 'checker', grantedBy: STAFF });

  const holder = await verifyAccountPassword(db, { email: VICTIM, password: ATTACKER_PASSWORD });
  assert.ok(holder, 'the attacker still signs in with the password they chose');
  const authority = await resolveAuthorityFromDb(db, VICTIM);
  assert.equal(authority.role, 'APPROVER', 'and can now approve payments as the CFO');

  await client.close();
});

/* ── The grant check ───────────────────────────────────────────────────── */

test('grantRole refuses an account that has not proven its mailbox, and says so to the operator', async () => {
  const { client, db } = await migratedDb();
  await createAccount(db, { email: 'new@acme.example', password: PASSWORD, name: 'New' });

  await assert.rejects(
    grantRole(db, { email: 'new@acme.example', orgId: 'acme', role: 'viewer', grantedBy: STAFF }),
    (error) =>
      error instanceof MembershipAdminError &&
      error.code === 'unverified_email' &&
      /verif/i.test(error.message),
  );
  await assert.rejects(() => resolveAuthorityFromDb(db, 'new@acme.example'), UnauthorizedError);

  await markEmailVerified(db, 'new@acme.example');
  await grantRole(db, { email: 'new@acme.example', orgId: 'acme', role: 'viewer', grantedBy: STAFF });
  assert.equal((await resolveAuthorityFromDb(db, 'new@acme.example')).role, 'VIEWER');

  await client.close();
});

test('grantMembership — the one grant path — refuses an unverified account and a missing one', async () => {
  const { client, db } = await migratedDb();
  await createAccount(db, { email: 'unproven@acme.example', password: PASSWORD, name: 'U' });

  await assert.rejects(
    grantMembership(db, { email: 'unproven@acme.example', orgId: 'acme', role: 'maker' }),
    (error) => error.name === 'GrantRefusedError' && error.code === 'unverified_email',
  );
  // It used to insert a password-less user on the way to granting. It may not
  // create an account at all any more: a grant is not a registration.
  await assert.rejects(
    grantMembership(db, { email: 'nobody@acme.example', orgId: 'acme', role: 'maker' }),
    (error) => error.name === 'GrantRefusedError' && error.code === 'no_account',
  );
  assert.equal(await userRow(db, 'nobody@acme.example'), null, 'the refused grant must leave no account behind');

  await client.close();
});

/* ── The mailbox owner wins ────────────────────────────────────────────── */

test('verification sets the password entered now, so a pre-registered password stops working', async () => {
  const { client, db } = await migratedDb();
  const { issueVerificationToken, completeEmailVerification } = await verification();

  const attacker = await createAccount(db, { email: VICTIM, password: ATTACKER_PASSWORD, name: 'Not the CFO' });
  const issued = await issueVerificationToken(db, { userId: attacker.userId, purpose: 'verify_email' });
  assert.match(issued.token, /^[A-Za-z0-9_-]{40,}$/, 'a raw token of at least 32 random bytes, base64url');

  // The link lands in the CFO's mailbox. The CFO opens it and sets a password.
  const result = await completeEmailVerification(db, { token: issued.token, password: OWNER_PASSWORD });
  assert.equal(result.email, VICTIM);

  assert.equal(
    await verifyAccountPassword(db, { email: VICTIM, password: ATTACKER_PASSWORD }),
    null,
    'the attacker is locked out',
  );
  assert.ok(await verifyAccountPassword(db, { email: VICTIM, password: OWNER_PASSWORD }), 'the owner is in');

  const row = await userRow(db, VICTIM);
  assert.ok(row.emailVerifiedAt instanceof Date, 'when it was proven is the auditable fact');

  await client.close();
});

test('a session minted before verification is rejected after it', async () => {
  const { client, db } = await migratedDb();
  const { issueVerificationToken, completeEmailVerification } = await verification();
  const { readCredentialVersion, sessionCredentialIsCurrent } = await import('../lib/auth/accounts.ts');

  const account = await createAccount(db, { email: VICTIM, password: ATTACKER_PASSWORD, name: 'Not the CFO' });
  const before = await readCredentialVersion(db, VICTIM);
  assert.equal(before, 1);

  // The attacker logs in and holds a cookie.
  const secret = 'test-secret-with-enough-entropy-for-hmac-signing';
  const session = createCustomerSessionFromIdentity({ email: VICTIM, credentialVersion: before });
  const decoded = readCustomerSessionToken(createCustomerSessionToken(session, secret), secret);
  assert.equal(decoded.credentialVersion, before, 'the version must survive the round trip, or it binds nothing');
  assert.equal(await sessionCredentialIsCurrent(db, decoded), true);

  // The owner verifies. Every session minted before this moment dies.
  const issued = await issueVerificationToken(db, { userId: account.userId, purpose: 'verify_email' });
  await completeEmailVerification(db, { token: issued.token, password: OWNER_PASSWORD });

  assert.equal(await readCredentialVersion(db, VICTIM), before + 1);
  assert.equal(await sessionCredentialIsCurrent(db, decoded), false);
  // A session that predates versioning carries none, and is rejected too.
  assert.equal(await sessionCredentialIsCurrent(db, { ...decoded, credentialVersion: undefined }), false);

  await client.close();
});

/* ── Tokens ────────────────────────────────────────────────────────────── */

test('tokens: unknown, expired, reused and wrong-purpose are all refused', async () => {
  const { client, db } = await migratedDb();
  const { issueVerificationToken, consumeVerificationToken, VerificationTokenError, TOKEN_TTL_MS } = await verification();
  const account = await createAccount(db, { email: 'tok@acme.example', password: PASSWORD, name: 'T' });
  const now = new Date('2026-09-23T10:00:00.000Z');

  const refused = (promise) => assert.rejects(promise, (error) => error instanceof VerificationTokenError);

  await refused(consumeVerificationToken(db, { token: 'not-a-token-anyone-issued', purpose: 'verify_email', now }));

  const fresh = await issueVerificationToken(db, { userId: account.userId, purpose: 'verify_email', now });
  assert.equal(TOKEN_TTL_MS, 30 * 60 * 1000);
  const consumed = await consumeVerificationToken(db, { token: fresh.token, purpose: 'verify_email', now });
  assert.equal(consumed.userId, account.userId);
  // Single use: the same link a second time is nothing.
  await refused(consumeVerificationToken(db, { token: fresh.token, purpose: 'verify_email', now }));

  const stale = await issueVerificationToken(db, { userId: account.userId, purpose: 'verify_email', now });
  await refused(
    consumeVerificationToken(db, {
      token: stale.token,
      purpose: 'verify_email',
      now: new Date(now.getTime() + TOKEN_TTL_MS + 1),
    }),
  );

  const reset = await issueVerificationToken(db, { userId: account.userId, purpose: 'reset_password', now });
  await refused(consumeVerificationToken(db, { token: reset.token, purpose: 'verify_email', now }));

  // Only the hash is stored: a stolen table cannot be replayed as links.
  const stored = await db
    .select({ hash: schema.emailVerificationTokens.tokenHash })
    .from(schema.emailVerificationTokens);
  assert.ok(stored.length >= 3);
  for (const row of stored) {
    assert.notEqual(row.hash, fresh.token);
    assert.notEqual(row.hash, stale.token);
    assert.match(row.hash, /^[a-f0-9]{64}$/);
  }

  await client.close();
});

test('the migration creates the token table with a unique hash and gives users a credential version', async () => {
  const { client } = await migratedDb();

  const { rows: columns } = await client.query(`
    select column_name, data_type, is_nullable, column_default
    from information_schema.columns
    where table_name = 'email_verification_tokens'
    order by ordinal_position
  `);
  const names = columns.map((c) => c.column_name);
  for (const expected of ['id', 'user_id', 'token_hash', 'purpose', 'expires_at', 'used_at', 'created_at']) {
    assert.ok(names.includes(expected), `email_verification_tokens.${expected} must exist; got ${names.join(', ')}`);
  }

  const { rows: version } = await client.query(`
    select data_type, is_nullable, column_default
    from information_schema.columns
    where table_name = 'users' and column_name = 'credential_version'
  `);
  assert.equal(version.length, 1, 'users.credential_version must exist');
  assert.equal(version[0].data_type, 'integer');
  assert.equal(version[0].is_nullable, 'NO');
  assert.match(String(version[0].column_default), /1/);

  await client.exec(`insert into users (id, email, name) values ('op_a', 'a@x.example', 'A')`);
  await client.exec(
    `insert into email_verification_tokens (id, user_id, token_hash, purpose, expires_at) values ('t1', 'op_a', 'h', 'verify_email', now())`,
  );
  await assert.rejects(
    client.exec(
      `insert into email_verification_tokens (id, user_id, token_hash, purpose, expires_at) values ('t2', 'op_a', 'h', 'verify_email', now())`,
    ),
    /duplicate key|unique/i,
    'two tokens may never share a hash',
  );

  await client.close();
});

/* ── Delivery ──────────────────────────────────────────────────────────── */

const OBJ = '0x' + 'ab'.repeat(32);
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
  USE_MOCK_APIS: 'true',
  NEXT_PUBLIC_DEMO_MODE: 'true',
  SUI_SETTLEMENT_MODE: 'simulate',
};

const keysOf = (fn) => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof EnvValidationError, `expected EnvValidationError, got ${e?.constructor?.name}: ${e?.message}`);
    return e.issues.map((i) => i.key);
  }
  assert.fail('expected parseEnv to throw');
};

test('production refuses to start without a real email transport', () => {
  assert.ok(keysOf(() => parseEnv(PROD_OK)).includes('EMAIL_TRANSPORT'), 'unset transport must be named');
  assert.ok(
    keysOf(() => parseEnv({ ...PROD_OK, EMAIL_TRANSPORT: 'console' })).includes('EMAIL_TRANSPORT'),
    'console is development only',
  );
  const half = keysOf(() => parseEnv({ ...PROD_OK, EMAIL_TRANSPORT: 'resend' }));
  assert.ok(
    half.includes('EMAIL_API_KEY') && half.includes('EMAIL_FROM'),
    `resend needs its key and a sender; got ${half.join(', ')}`,
  );

  const env = parseEnv({
    ...PROD_OK,
    EMAIL_TRANSPORT: 'resend',
    EMAIL_API_KEY: 're_test_key',
    EMAIL_FROM: 'no-reply@splash.example',
  });
  assert.equal(env.EMAIL_TRANSPORT, 'resend');
  assert.equal(parseEnv({ NODE_ENV: 'development' }).EMAIL_TRANSPORT, 'console');
});

test('the console transport refuses to exist in production; resend posts the link with the key and never in the subject', async () => {
  const { resolveEmailTransport, createResendTransport, createConsoleTransport } = await transport();

  assert.throws(() => resolveEmailTransport({ NODE_ENV: 'production', EMAIL_TRANSPORT: 'console' }), /production/);
  assert.throws(() => createConsoleTransport({ NODE_ENV: 'production' }), /production/);
  assert.equal(resolveEmailTransport({ NODE_ENV: 'development' }).name, 'console');
  assert.equal(
    resolveEmailTransport({
      NODE_ENV: 'production',
      EMAIL_TRANSPORT: 'resend',
      EMAIL_API_KEY: 're_k',
      EMAIL_FROM: 'no-reply@splash.example',
    }).name,
    'resend',
  );

  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ id: 'email_123' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const resend = createResendTransport({ apiKey: 're_k', from: 'no-reply@splash.example', fetch: fakeFetch });
  await resend.sendVerification({
    to: 'cfo@victim.example',
    url: 'https://v1.splashz.xyz/verify-email?token=abc',
    kind: 'verify_email',
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer re_k');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.from, 'no-reply@splash.example');
  assert.deepEqual(body.to, ['cfo@victim.example']);
  assert.match(body.text, /verify-email\?token=abc/);
  assert.doesNotMatch(body.subject, /abc/, 'the token belongs in the body, never the subject line');

  const failing = createResendTransport({
    apiKey: 're_k',
    from: 'no-reply@splash.example',
    fetch: async () => new Response('nope', { status: 500 }),
  });
  await assert.rejects(
    failing.sendVerification({ to: 'x@y.example', url: 'https://v1.splashz.xyz/verify-email?token=t', kind: 'verify_email' }),
  );
});

/* ── The routes ────────────────────────────────────────────────────────── */

test('signup delivers a verification link, and verify-email mints no session', async () => {
  const signup = code(await readFile(new URL('../app/api/auth/signup/route.ts', import.meta.url), 'utf8'));
  assert.match(signup, /issueVerificationToken|sendVerificationEmail/, 'signup must trigger delivery');
  assert.doesNotMatch(signup, /setCustomerSessionCookie/);

  const verify = code(await readFile(new URL('../app/api/auth/verify-email/route.ts', import.meta.url), 'utf8'));
  assert.match(verify, /completeEmailVerification/);
  assert.doesNotMatch(verify, /setCustomerSessionCookie/, 'verifying proves the mailbox; it does not sign anyone in');
  assert.doesNotMatch(verify, /grantMembership|grantRole/, 'it grants nothing either');

  const resend = code(await readFile(new URL('../app/api/auth/verify-email/resend/route.ts', import.meta.url), 'utf8'));
  assert.match(resend, /checkRateLimit/, 'resend must be rate limited');
  assert.match(resend, /202/, 'resend answers the same way whether or not the address exists');
});

test('zkLogin marks the mailbox proven only when the provider asserts email_verified: true', async () => {
  const { readEmailVerifiedClaim } = await import('../lib/auth/zklogin.ts');
  assert.equal(typeof readEmailVerifiedClaim, 'function');
  assert.equal(readEmailVerifiedClaim({ email_verified: true }), true);
  assert.equal(readEmailVerifiedClaim({ email_verified: 'true' }), false, 'a string is not the boolean the spec defines');
  assert.equal(readEmailVerifiedClaim({ email_verified: false }), false);
  assert.equal(readEmailVerifiedClaim({}), false);

  const route = code(await readFile(new URL('../app/api/auth/zklogin/route.ts', import.meta.url), 'utf8'));
  assert.match(route, /emailVerified\s*===\s*true[\s\S]{0,300}markEmailVerified/, 'the route reads the claim; it does not assume');
});

test('resend and signup are rate limited per address and per IP', async () => {
  const { client, db } = await migratedDb();
  const { checkRateLimit, recordHit } = await rateLimit();
  const now = new Date('2026-09-23T10:00:00.000Z');
  const rule = { bucket: 'verify-resend:email', limit: 3, windowMs: 15 * 60 * 1000 };

  for (let i = 0; i < 3; i++) {
    assert.equal((await checkRateLimit(db, { ...rule, key: 'cfo@victim.example', now })).allowed, true);
    await recordHit(db, { bucket: rule.bucket, key: 'cfo@victim.example', now });
  }
  const verdict = await checkRateLimit(db, { ...rule, key: 'cfo@victim.example', now });
  assert.equal(verdict.allowed, false);
  assert.ok(verdict.retryAfterSeconds > 0 && verdict.retryAfterSeconds <= 15 * 60);

  // Another address in the same bucket is untouched; the same address in
  // another bucket is untouched; the window ages out.
  assert.equal((await checkRateLimit(db, { ...rule, key: 'other@victim.example', now })).allowed, true);
  assert.equal((await checkRateLimit(db, { ...rule, bucket: 'signup:ip', key: 'cfo@victim.example', now })).allowed, true);
  assert.equal(
    (await checkRateLimit(db, { ...rule, key: 'cfo@victim.example', now: new Date(now.getTime() + rule.windowMs + 1) }))
      .allowed,
    true,
  );

  await client.close();
});

test('the local seed verifies the accounts it grants, so the demo still works under the grant check', async () => {
  const seed = code(await readFile(new URL('../scripts/dev-db.mjs', import.meta.url), 'utf8'));
  assert.match(seed, /markEmailVerified/);
  assert.match(seed, /'acme'/, 'the seeded org ids are part of the local demo contract');
});

/* ── Recovery ──────────────────────────────────────────────────────────── */

test('password reset rides the same token primitive: new password in, old one out, mailbox proven, sessions dead', async () => {
  const { client, db } = await migratedDb();
  const { issueVerificationToken, completePasswordReset } = await verification();
  const { readCredentialVersion } = await import('../lib/auth/accounts.ts');

  const account = await createAccount(db, { email: 'reset@acme.example', password: PASSWORD, name: 'R' });
  const issued = await issueVerificationToken(db, { userId: account.userId, purpose: 'reset_password' });
  const NEW_PASSWORD = 'a-brand-new-passphrase-2026';
  await completePasswordReset(db, { token: issued.token, password: NEW_PASSWORD });

  assert.equal(await verifyAccountPassword(db, { email: 'reset@acme.example', password: PASSWORD }), null);
  assert.ok(await verifyAccountPassword(db, { email: 'reset@acme.example', password: NEW_PASSWORD }));
  assert.ok(
    (await userRow(db, 'reset@acme.example')).emailVerifiedAt instanceof Date,
    'a link opened from the mailbox proves the mailbox',
  );
  assert.equal(await readCredentialVersion(db, 'reset@acme.example'), 2);

  await client.close();
});

test('the recovery route issues a reset link instead of pointing at a support mailbox', async () => {
  const recovery = code(await readFile(new URL('../app/api/auth/recovery/route.ts', import.meta.url), 'utf8'));
  assert.match(recovery, /reset_password/);
  assert.match(recovery, /checkRateLimit/);
  assert.match(recovery, /202/, 'the answer must not reveal whether the address is registered');

  const reset = code(await readFile(new URL('../app/api/auth/reset-password/route.ts', import.meta.url), 'utf8'));
  assert.match(reset, /completePasswordReset/);
  assert.doesNotMatch(reset, /setCustomerSessionCookie/);
});
