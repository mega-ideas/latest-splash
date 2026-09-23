/**
 * Apply migrations, without a TTY.
 *
 * ─── Why this is not just `drizzle-kit migrate` ─────────────────────────────
 *
 * `npm run db:migrate` shells out to `drizzle-kit migrate`, which renders an
 * interactive spinner and does not complete when stdout is not a terminal. Run
 * headlessly — CI, a deploy step, an agent — it prints spinner frames, applies
 * NOTHING, and exits without an error. A migration runner that silently does
 * nothing is worse than one that fails, because the deploy goes green and the
 * schema is a version behind.
 *
 * This uses Drizzle's programmatic migrator, which is the same code path
 * `drizzle-kit migrate` calls once it has finished drawing. It reads
 * `drizzle/meta/_journal.json` (not the directory listing — see
 * `scripts/check-migration-journal.mjs` for why that distinction has bitten us)
 * and records what it applied in `drizzle.__drizzle_migrations`, so re-running
 * is a no-op rather than a re-apply.
 *
 * Usage:
 *   npm run db:migrate:run
 *   DATABASE_URL=... npm run db:migrate:run
 */
import { readFileSync } from 'node:fs';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

/** Read `.env.local` the way Next does; a standalone script does not get it. */
function loadEnvLocal() {
  let text;
  try {
    text = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
  } catch {
    return;
  }
  for (const rawLine of text.split('\n')) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    // Never override something already set: `DATABASE_URL=... npm run …`
    // should point where you said, not where the file says.
    if (process.env[key] !== undefined) continue;
    let value = trimmed.slice(eq + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted) value = value.slice(1, -1);
    process.env[key] = value;
  }
}

loadEnvLocal();

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const journal = JSON.parse(
  readFileSync(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8'),
);

const pool = new pg.Pool({
  connectionString: url,
  max: 1,
  ssl: url.includes('sslmode=disable') ? undefined : { rejectUnauthorized: false },
});

try {
  const db = drizzle(pool);
  console.log(`Applying ${journal.entries.length} migration(s) from drizzle/…`);
  await migrate(db, { migrationsFolder: 'drizzle' });

  // Say what is actually in the database now, rather than "done". The failure
  // this replaces was one that reported success and changed nothing.
  const applied = await pool.query(
    'select count(*)::int as n from drizzle.__drizzle_migrations',
  );
  const tables = await pool.query(
    "select count(*)::int as n from information_schema.tables where table_schema = 'public'",
  );
  console.log(
    `Done. ${applied.rows[0].n} migration(s) recorded, ${tables.rows[0].n} table(s) in public.`,
  );

  if (applied.rows[0].n < journal.entries.length) {
    console.error(
      `\nExpected ${journal.entries.length} recorded migrations, found ${applied.rows[0].n}.`,
    );
    process.exit(1);
  }
} finally {
  await pool.end();
}
