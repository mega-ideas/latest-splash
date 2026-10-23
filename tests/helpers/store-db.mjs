/**
 * A real Postgres (PGlite) behind the application's own `getDb()`, and a way
 * to throw the process away and come back.
 *
 * The stores decide between Postgres and their in-process fallback by
 * `DATABASE_URL`, and reach the database through `lib/db/client.ts`, which
 * keeps its handle on `globalThis.splashDb`. Putting a PGlite drizzle handle
 * there makes every store under test write to a migrated database that
 * behaves like the deployed one.
 *
 * `coldStart` is what a serverless cold start does to a module: every
 * `globalThis` store is gone and the module is evaluated again from scratch.
 * The database is the one thing that is not process state, so it stays — and
 * a store that kept its records in a `Map` comes back empty.
 */
import { readdir, readFile } from 'node:fs/promises';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

import * as schema from '../../lib/db/schema.ts';

export const ORGS = ['acme', 'northwind'];

export async function migratedDb() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  const dir = new URL('../../drizzle/', import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const text = await readFile(new URL(file, dir), 'utf8');
    for (const statement of text.split('--> statement-breakpoint')) {
      const trimmed = statement.trim();
      if (trimmed) await client.exec(trimmed);
    }
  }
  await client.exec(`INSERT INTO organizations (id, name) VALUES ('acme', 'Acme Trading'), ('northwind', 'Northwind')`);
  return { client, db };
}

/** Point the application's `getDb()` at this database. Returns the undo. */
export function attachDb(db) {
  const previousUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'postgres://pglite.invalid/store-test';
  globalThis.splashDb = { pool: { end: async () => {} }, db };
  return () => {
    delete globalThis.splashDb;
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
  };
}

let generation = 0;

/**
 * Drop every in-process store and evaluate `relativePath` again, as a fresh
 * instance would. The database handle survives: it stands for the managed
 * cluster, which a cold start does not touch.
 */
export async function coldStart(relativePath) {
  for (const key of Object.keys(globalThis)) {
    if (key.startsWith('splash') && key !== 'splashDb') delete globalThis[key];
  }
  generation += 1;
  const url = new URL(`../../${relativePath}`, import.meta.url);
  return import(`${url.href}?cold=${generation}`);
}
