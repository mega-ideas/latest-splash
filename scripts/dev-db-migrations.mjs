/**
 * Migrations for the local dev database (scripts/dev-db.mjs).
 *
 * The dev database applies the files in `drizzle/` itself, one statement at a
 * time (0020 adds an enum value and uses it, which a single wrapping
 * transaction would refuse), and records each file in `splash_dev_migrations`:
 * its name, and a hash that catches a migration edited after this database
 * applied it.
 *
 * ─── drizzle's own ledger ───────────────────────────────────────────────────
 *
 * Everything else asks drizzle's ledger, `drizzle.__drizzle_migrations`, what
 * has been applied: `npm run db:migrate` and `db:migrate:run`, `/api/health`
 * and `npm run doctor`. The dev database never wrote it, so the health check
 * reported "0/27 migrations applied — run npm run db:migrate" on a database
 * with all 27 applied. Following that advice would have run every file again
 * over tables that already exist, on a second connection to a server that
 * takes one.
 *
 * So each applied file is also recorded there, exactly as drizzle's migrator
 * would have recorded it: the sha256 of the file's text, and the `when` of its
 * journal entry. The migrator applies a file only when its `when` is later
 * than the newest row's, so with these rows it finds nothing to do, and the
 * health check counts one row per file. A database made before this change
 * has the rows filled in the next time it starts.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

/** A migration file that did not apply cleanly. */
export class DevMigrationError extends Error {
  constructor(file, cause) {
    super(`${file} failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = 'DevMigrationError';
    this.file = file;
  }
}

/**
 * Apply what this database has not seen, then make sure drizzle's ledger has a
 * row for every file it has applied.
 *
 * @param {{ exec(sql: string): Promise<unknown>, query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> }} client
 * @param {URL} dir The `drizzle/` folder, as a URL ending in a slash.
 * @param {{ onApplied?(file: string): void, onChanged?(file: string): void }} [notify]
 */
export async function migrateDevDatabase(client, dir, notify = {}) {
  await client.exec(`CREATE TABLE IF NOT EXISTS splash_dev_migrations (
  name text PRIMARY KEY,
  sha256 text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
)`);
  const applied = new Map(
    (await client.query('SELECT name, sha256 FROM splash_dev_migrations')).rows.map((r) => [r.name, r.sha256]),
  );
  const alreadyApplied = applied.size;

  let appliedNow = 0;
  for (const file of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
    const sqlText = await readFile(new URL(file, dir), 'utf8');
    const sha256 = createHash('sha256').update(sqlText).digest('hex');
    if (applied.has(file)) {
      if (applied.get(file) !== sha256) notify.onChanged?.(file);
      continue;
    }
    try {
      for (const statement of sqlText.split('--> statement-breakpoint')) {
        const trimmed = statement.trim();
        if (trimmed) await client.exec(trimmed);
      }
    } catch (error) {
      throw new DevMigrationError(file, error);
    }
    await client.query('INSERT INTO splash_dev_migrations (name, sha256) VALUES ($1, $2)', [file, sha256]);
    applied.set(file, sha256);
    appliedNow += 1;
    notify.onApplied?.(file);
  }

  const ledgerAdded = await recordInDrizzleLedger(client, dir, applied);
  return { alreadyApplied, appliedNow, ledgerAdded };
}

/**
 * One row in `drizzle.__drizzle_migrations` per applied file, keyed by its
 * journal timestamp, with the hash it was applied under. The table is created
 * the way drizzle's migrator creates it. Rows already there are left alone, so
 * this runs on every start and only fills gaps.
 */
async function recordInDrizzleLedger(client, dir, applied) {
  const journal = JSON.parse(await readFile(new URL('meta/_journal.json', dir), 'utf8'));
  const whenByFile = new Map(journal.entries.map((entry) => [`${entry.tag}.sql`, Number(entry.when)]));

  await client.exec('CREATE SCHEMA IF NOT EXISTS "drizzle"');
  await client.exec(`CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
  id SERIAL PRIMARY KEY,
  hash text NOT NULL,
  created_at bigint
)`);
  const recorded = new Set(
    (await client.query('SELECT created_at FROM "drizzle"."__drizzle_migrations"')).rows.map((r) => Number(r.created_at)),
  );

  let added = 0;
  // In journal order, as the migrator would have written them.
  for (const [file, when] of whenByFile) {
    if (!applied.has(file) || recorded.has(when)) continue;
    await client.query('INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at) VALUES ($1, $2)', [
      applied.get(file),
      when,
    ]);
    added += 1;
  }
  return added;
}
