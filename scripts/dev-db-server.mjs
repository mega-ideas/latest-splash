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
