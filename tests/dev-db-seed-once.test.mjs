/**
 * The dev database seeds once, and knows it did.
 *
 * scripts/dev-db.mjs used to decide "first boot" by looking for the demo
 * operator's row (demo@acme.test). Delete that account from a dev database
 * kept on disk and the next start thinks the database is new: it seeds again,
 * trips on rows that are still there (org_settings_pkey), and refuses to
 * start. Where the seed does get through, it quietly brings back accounts
 * someone deleted on purpose.
 *
 * The seed now writes a marker row when it finishes, and a database seeded
 * before the marker existed is recognised by the demo workspace it made,
 * which deleting accounts does not remove.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { PGlite } from '@electric-sql/pglite';

async function freshDb() {
  const db = new PGlite();
  await db.exec(`CREATE TABLE organizations (id text PRIMARY KEY, name text);
                 CREATE TABLE users (id text PRIMARY KEY, email text UNIQUE);`);
  return db;
}

test('a new database is a first boot, and is not one once the seed is marked', async () => {
  const { isFirstBoot, markSeeded } = await import('../scripts/dev-db-server.mjs');
  const db = await freshDb();
  assert.equal(await isFirstBoot(db), true);
  await markSeeded(db);
  assert.equal(await isFirstBoot(db), false);
  await markSeeded(db); // idempotent
  assert.equal(await isFirstBoot(db), false);
  await db.close();
});

test('deleting the demo accounts does not make the next start reseed', async () => {
  const { isFirstBoot, markSeeded } = await import('../scripts/dev-db-server.mjs');
  const db = await freshDb();
  await db.exec(`INSERT INTO organizations VALUES ('demo-business', 'Acme Manufacturing');
                 INSERT INTO users VALUES ('u1', 'demo@acme.test');`);
  await markSeeded(db);
  await db.exec(`DELETE FROM users WHERE email = 'demo@acme.test';`);
  assert.equal(await isFirstBoot(db), false);
  await db.close();
});

test('a database seeded before the marker existed is recognised by its demo workspace', async () => {
  const { isFirstBoot } = await import('../scripts/dev-db-server.mjs');
  const db = await freshDb();
  await db.exec(`INSERT INTO organizations VALUES ('demo-business', 'Acme Manufacturing');`);
  assert.equal(await isFirstBoot(db), false, 'accounts deleted, workspace still there: not a first boot');
  await db.close();
});

test('dev-db asks isFirstBoot and marks the seed, instead of looking for the demo account', async () => {
  const { readFile } = await import('node:fs/promises');
  const script = await readFile(new URL('../scripts/dev-db.mjs', import.meta.url), 'utf8');
  assert.match(script, /const firstBoot = await isFirstBoot\(client\)/);
  assert.match(script, /if \(firstBoot\) await markSeeded\(client\)/);
  assert.doesNotMatch(script, /SELECT 1 FROM users WHERE email = \$1', \['demo@acme\.test'\]/);
});
