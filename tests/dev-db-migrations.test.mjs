import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { migrate } from 'drizzle-orm/pglite/migrator';

import { migrateDevDatabase } from '../scripts/dev-db-migrations.mjs';

/**
 * The dev database and drizzle's ledger agree on what has been applied.
 *
 * `npm run dev:db` applies the files in drizzle/ itself and recorded them only
 * in its own splash_dev_migrations table. /api/health, `npm run doctor` and
 * `npm run db:migrate` read drizzle.__drizzle_migrations, which it never wrote,
 * so on a fully migrated dev database the health check answered "0/27
 * migrations applied — run npm run db:migrate", and following that advice would
 * have run every file again over tables that already exist.
 */

// The health check reads its host from here; getEnv() caches on first use.
process.env.DATABASE_URL = 'postgres://postgres@127.0.0.1:5433/postgres?sslmode=disable';

const DRIZZLE = new URL('../drizzle/', import.meta.url);
const FOLDER = fileURLToPath(DRIZZLE);

async function filesOnDisk() {
  return (await readdir(DRIZZLE)).filter((f) => f.endsWith('.sql')).length;
}

/** What drizzle's migrator writes for these files: its hash and its journal time, in order. */
function drizzleRows() {
  return readMigrationFiles({ migrationsFolder: FOLDER }).map((m) => ({ hash: m.hash, created_at: m.folderMillis }));
}

async function ledger(client) {
  const { rows } = await client.query('SELECT hash, created_at FROM "drizzle"."__drizzle_migrations" ORDER BY id');
  return rows.map((r) => ({ hash: r.hash, created_at: Number(r.created_at) }));
}

test('a fresh dev database records every file where drizzle and the health check look', async () => {
  const client = new PGlite();
  const onDisk = await filesOnDisk();

  const result = await migrateDevDatabase(client, DRIZZLE);
  assert.deepEqual(result, { alreadyApplied: 0, appliedNow: onDisk, ledgerAdded: onDisk });

  // Row for row what the migrator itself would have written.
  assert.deepEqual(await ledger(client), drizzleRows());

  // So the migrator finds nothing left to apply. Before, it would have started
  // again at 0000 and failed on the first table that already exists.
  await migrate(drizzle(client), { migrationsFolder: FOLDER });
  assert.equal((await ledger(client)).length, onDisk, 'and writes no second row for anything');
  await client.close();
});

test('a dev database made before the ledger gets it filled in on its next start, once', async () => {
  const client = new PGlite();
  const onDisk = await filesOnDisk();
  await migrateDevDatabase(client, DRIZZLE);
  // As every durable .dev-db made before this change is: migrated, recorded in
  // splash_dev_migrations, and nothing in drizzle's ledger.
  await client.exec('DROP TABLE "drizzle"."__drizzle_migrations"');

  const restart = await migrateDevDatabase(client, DRIZZLE);
  assert.deepEqual(restart, { alreadyApplied: onDisk, appliedNow: 0, ledgerAdded: onDisk });
  assert.deepEqual(await ledger(client), drizzleRows());

  // Every later start leaves it alone.
  assert.equal((await migrateDevDatabase(client, DRIZZLE)).ledgerAdded, 0);
  assert.equal((await ledger(client)).length, onDisk);

  // A ledger with only its first rows (a start that stopped halfway) gets the
  // rest, and keeps what it had.
  const keep = drizzleRows()[9].created_at;
  await client.query('DELETE FROM "drizzle"."__drizzle_migrations" WHERE created_at > $1', [keep]);
  assert.equal((await migrateDevDatabase(client, DRIZZLE)).ledgerAdded, onDisk - 10);
  const rows = await ledger(client);
  assert.deepEqual(
    rows.map((r) => r.created_at).sort((a, b) => a - b),
    drizzleRows().map((r) => r.created_at),
  );

  await migrate(drizzle(client), { migrationsFolder: FOLDER });
  assert.equal((await ledger(client)).length, onDisk);
  await client.close();
});

test('the health check counts a dev database as migrated, and still fails one whose ledger is missing', async () => {
  const client = new PGlite();
  const onDisk = await filesOnDisk();
  await migrateDevDatabase(client, DRIZZLE);
  globalThis.splashDb = { pool: { end: async () => {} }, db: drizzle(client) };
  try {
    const { checkDb } = await import('../lib/server/health-checks.ts');

    const migrated = await checkDb();
    assert.equal(migrated.status, 'ok', migrated.detail);
    assert.equal(migrated.detail, `127.0.0.1:5433 reachable, ${onDisk}/${onDisk} migrations applied`);

    // The check itself did not loosen: a database drizzle has no record of —
    // a deployment nobody migrated — still fails, and says what to run.
    await client.exec('DROP TABLE "drizzle"."__drizzle_migrations"');
    const missing = await checkDb();
    assert.equal(missing.status, 'fail');
    assert.match(missing.detail, new RegExp(`0/${onDisk} migrations applied — run npm run db:migrate`));
  } finally {
    delete globalThis.splashDb;
    await client.close();
  }
});
