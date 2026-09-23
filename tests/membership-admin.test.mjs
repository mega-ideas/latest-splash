import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

import * as schema from '../lib/db/schema.ts';
import { createAccount, markEmailVerified } from '../lib/auth/accounts.ts';
import { resolveAuthorityFromDb, UnauthorizedError } from '../lib/auth/authority.ts';
import {
  MEMBERSHIP_ROLES,
  MembershipAdminError,
  ROLE_MEANING,
  grantRole,
  isMembershipRole,
  listAccounts,
  listOrganizations,
  revokeRole,
} from '../lib/server/memberships.ts';

/**
 * The operator surface for the gap Phase 3 opened.
 *
 * Phase 3 removed every implicit grant, which left `grantMembership()` with no
 * caller: the only way to give a real account access was a SQL client. These
 * tests hold the console to the same standard as the thing it operates —
 * it must not become a second, softer way to acquire authority.
 */

async function migratedDb() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  const files = (await readdir(new URL('../drizzle', import.meta.url)))
    .filter((f) => f.endsWith('.sql'))
    .sort();
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

const PASSWORD = 'correct-horse-battery-staple-9';
const STAFF = 'ops@splash.example';

/** An account whose mailbox has been proven — what a grant requires (WS1, X5).
 *  The refusal for an unproven one lives in tests/account-verification.test.mjs. */
async function verifiedAccount(db, email, name) {
  await createAccount(db, { email, password: PASSWORD, name });
  await markEmailVerified(db, email);
}

/* ── Granting ──────────────────────────────────────────────────────────── */

test('a granted role is the role that resolves', async () => {
  const { client, db } = await migratedDb();
  await verifiedAccount(db, 'maker@example.com', 'Maker Ltd');

  await assert.rejects(
    resolveAuthorityFromDb(db, 'maker@example.com'),
    UnauthorizedError,
    'an account with no membership must not resolve to any authority',
  );

  await grantRole(db, { email: 'maker@example.com', orgId: 'acme', role: 'maker', grantedBy: STAFF });

  const authority = await resolveAuthorityFromDb(db, 'maker@example.com');
  assert.equal(authority.orgId, 'acme');
  await client.close();
});

test('the grant records who made it', async () => {
  const { client, db } = await migratedDb();
  await verifiedAccount(db, 'a@example.com', 'A');
  await grantRole(db, { email: 'a@example.com', orgId: 'acme', role: 'viewer', grantedBy: STAFF });

  const [row] = await listAccounts(db);
  assert.equal(row.membership.grantedBy, STAFF, 'an authority change with no author is not auditable');
  await client.close();
});

test('granting to an address with no account is refused, not silently created', async () => {
  const { client, db } = await migratedDb();

  await assert.rejects(
    grantRole(db, { email: 'typo@example.com', orgId: 'acme', role: 'checker', grantedBy: STAFF }),
    (error) => error instanceof MembershipAdminError && error.code === 'no_account',
  );

  // The refusal must leave nothing behind — a half-made account with a real
  // role is exactly the state this guard exists to prevent.
  assert.deepEqual(await listAccounts(db), []);
  await client.close();
});

test('a second grant is refused rather than layered on the first', async () => {
  const { client, db } = await migratedDb();
  await verifiedAccount(db, 'b@example.com', 'B');
  await grantRole(db, { email: 'b@example.com', orgId: 'acme', role: 'viewer', grantedBy: STAFF });

  await assert.rejects(
    grantRole(db, { email: 'b@example.com', orgId: 'acme', role: 'admin', grantedBy: STAFF }),
    (error) => error instanceof MembershipAdminError && error.code === 'already_member',
  );

  const [row] = await listAccounts(db);
  assert.equal(row.membership.role, 'viewer', 'the failed escalation must not have taken');
  await client.close();
});

test('the email is normalised, so case cannot produce a second membership', async () => {
  const { client, db } = await migratedDb();
  await verifiedAccount(db, 'c@example.com', 'C');

  await grantRole(db, { email: '  C@Example.COM  ', orgId: 'acme', role: 'maker', grantedBy: STAFF });

  const [row] = await listAccounts(db);
  assert.equal(row.membership.role, 'maker');
  await client.close();
});

/* ── Revoking ──────────────────────────────────────────────────────────── */

test('revoking removes the authority, not the account', async () => {
  const { client, db } = await migratedDb();
  await verifiedAccount(db, 'd@example.com', 'D');
  await grantRole(db, { email: 'd@example.com', orgId: 'acme', role: 'checker', grantedBy: STAFF });

  await revokeRole(db, { email: 'd@example.com' });

  await assert.rejects(resolveAuthorityFromDb(db, 'd@example.com'), UnauthorizedError);

  const [row] = await listAccounts(db);
  assert.equal(row.email, 'd@example.com', 'the account survives');
  assert.equal(row.membership, null, 'the authority does not');
  await client.close();
});

test('a revoked member can be granted again', async () => {
  const { client, db } = await migratedDb();
  await verifiedAccount(db, 'e@example.com', 'E');
  await grantRole(db, { email: 'e@example.com', orgId: 'acme', role: 'admin', grantedBy: STAFF });
  await revokeRole(db, { email: 'e@example.com' });

  // A hard delete, unlike the passkey tombstone: a membership is current
  // authority, not evidence, so nothing should be occupying the slot.
  await grantRole(db, { email: 'e@example.com', orgId: 'acme', role: 'viewer', grantedBy: STAFF });

  const [row] = await listAccounts(db);
  assert.equal(row.membership.role, 'viewer');
  await client.close();
});

/* ── Listing ───────────────────────────────────────────────────────────── */

test('accounts without a membership are listed — they are the ones to act on', async () => {
  const { client, db } = await migratedDb();
  await verifiedAccount(db, 'granted@example.com', 'G');
  await verifiedAccount(db, 'waiting@example.com', 'W');
  await grantRole(db, { email: 'granted@example.com', orgId: 'acme', role: 'maker', grantedBy: STAFF });

  const rows = await listAccounts(db);
  assert.equal(rows.length, 2, 'a left join, not an inner one');
  const waiting = rows.find((r) => r.email === 'waiting@example.com');
  assert.equal(waiting.membership, null);
  await client.close();
});

test('the listing never carries a password hash', async () => {
  const { client, db } = await migratedDb();
  await createAccount(db, { email: 'f@example.com', password: PASSWORD, name: 'F' });

  const [row] = await listAccounts(db);
  assert.equal(row.hasPassword, true);
  assert.equal(
    JSON.stringify(row).includes('scrypt$'),
    false,
    'the console serialises this straight to a client component',
  );
  await client.close();
});

test('organizations are listed for the grant form', async () => {
  const { client, db } = await migratedDb();
  const orgs = await listOrganizations(db);
  assert.deepEqual(orgs, [{ id: 'acme', name: 'Acme Sdn Bhd' }]);
  await client.close();
});

/* ── The register the console speaks in ────────────────────────────────── */

test('every role has a meaning, and the two that move money say so', () => {
  for (const role of MEMBERSHIP_ROLES) {
    assert.equal(typeof ROLE_MEANING[role], 'string');
    assert.ok(ROLE_MEANING[role].length > 0, `${role} needs a plain-language meaning`);
  }
  // "checker" is the most dangerous option in the list and the least alarming
  // word in it. The console has to close that gap at the point of granting.
  assert.match(ROLE_MEANING.checker, /move money|Releases payments/i);
  assert.match(ROLE_MEANING.admin, /releasing payments|move money/i);
  assert.doesNotMatch(ROLE_MEANING.viewer, /move money/i);
  assert.doesNotMatch(ROLE_MEANING.maker, /can approve/i);
});

test('isMembershipRole rejects anything not in the enum', () => {
  assert.equal(isMembershipRole('checker'), true);
  assert.equal(isMembershipRole('CHECKER'), false);
  assert.equal(isMembershipRole('superadmin'), false);
  assert.equal(isMembershipRole(undefined), false);
});

/* ── The console must not become a second grant path ───────────────────── */

test('memberships.ts inserts nothing itself — it calls the one grant function', async () => {
  const source = await readFile(new URL('../lib/server/memberships.ts', import.meta.url), 'utf8');
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');

  assert.doesNotMatch(
    withoutComments,
    /\.insert\s*\(/,
    'a second way to create a membership is a second way to acquire authority',
  );
  assert.match(withoutComments, /grantMembership\s*\(/);
});

test('every membership route requires a staff session', async () => {
  const source = await readFile(new URL('../app/api/admin/memberships/route.ts', import.meta.url), 'utf8');
  const handlers = source.split(/export async function /).slice(1);
  assert.equal(handlers.length, 3, 'GET, POST and DELETE');
  for (const handler of handlers) {
    const name = handler.slice(0, handler.indexOf('('));
    assert.match(handler, /getAdminSession\(\)/, `${name} must authenticate`);
    assert.match(handler, /status:\s*401/, `${name} must reject an unauthenticated caller`);
  }
});

test('the grant route has no default role', async () => {
  const source = await readFile(new URL('../app/api/admin/memberships/route.ts', import.meta.url), 'utf8');
  const grantSchema = source.slice(source.indexOf('const grantSchema'), source.indexOf('const revokeSchema'));
  assert.doesNotMatch(
    grantSchema,
    /\.default\(/,
    'a role that arrives by default is a role nobody chose',
  );
});
