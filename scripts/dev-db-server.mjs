/**
 * Options for the dev database's socket server (scripts/dev-db.mjs).
 *
 * @electric-sql/pglite-socket accepts ONE connection unless told otherwise,
 * while lib/db/client.ts opens a pg Pool of up to DATABASE_POOL_MAX (default
 * 10). With the default, a page that runs queries in parallel gets one result
 * and a reset for the rest, and in `next dev` it hangs. The server funnels
 * every connection through one query queue into the single PGlite instance,
 * so allowing the pool's size is safe.
 */
const APP_POOL_DEFAULT = 10;

/** @param {NodeJS.ProcessEnv} env */
export function devDbSocketOptions(env) {
  const configured = Number.parseInt(env.DATABASE_POOL_MAX ?? '', 10);
  const maxConnections = Number.isInteger(configured) && configured >= 1 ? configured : APP_POOL_DEFAULT;
  return { maxConnections };
}

/**
 * Whether this database still needs the dev seed. The seed writes a marker
 * row when it finishes (see markSeeded); a database seeded before the marker
 * existed is recognised by the demo workspace it made. Neither depends on a
 * particular account, so deleting the demo accounts does not make the next
 * start reseed them, or crash on the rows that are still there.
 *
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }} client
 */
export async function isFirstBoot(client) {
  await client.query('CREATE TABLE IF NOT EXISTS splash_dev_seed (seeded_at timestamptz NOT NULL DEFAULT now())');
  if ((await client.query('SELECT 1 FROM splash_dev_seed LIMIT 1')).rows.length > 0) return false;
  const legacy = await client.query("SELECT 1 FROM organizations WHERE id = 'demo-business' LIMIT 1");
  return legacy.rows.length === 0;
}

/** Record that the dev seed ran. Safe to call more than once. */
export async function markSeeded(client) {
  await client.query('CREATE TABLE IF NOT EXISTS splash_dev_seed (seeded_at timestamptz NOT NULL DEFAULT now())');
  if ((await client.query('SELECT 1 FROM splash_dev_seed LIMIT 1')).rows.length === 0) {
    await client.query('INSERT INTO splash_dev_seed DEFAULT VALUES');
  }
}
