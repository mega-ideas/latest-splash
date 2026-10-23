/**
 * The dev database must accept as many connections as the app opens.
 *
 * `npm run dev:db` wraps PGlite in @electric-sql/pglite-socket, whose server
 * accepts ONE connection unless told otherwise. lib/db/client.ts opens a pg
 * Pool of up to DATABASE_POOL_MAX (default 10). A login uses one connection
 * and works; a dashboard page runs several queries at once, the extra
 * connections are refused or left waiting, and the page hangs. The socket
 * server multiplexes every connection through one query queue, so raising
 * its limit to the pool size is safe.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import pg from 'pg';

test('the socket server allows as many connections as the app pool opens', async () => {
  const { devDbSocketOptions } = await import('../scripts/dev-db-server.mjs');
  assert.equal(devDbSocketOptions({}).maxConnections, 10, 'matches the pool default in lib/db/client.ts');
  assert.equal(devDbSocketOptions({ DATABASE_POOL_MAX: '4' }).maxConnections, 4, 'follows DATABASE_POOL_MAX');
  assert.ok(devDbSocketOptions({ DATABASE_POOL_MAX: 'nonsense' }).maxConnections >= 1);
});

test('five pool connections run queries at the same time against the dev socket server', async () => {
  const { devDbSocketOptions } = await import('../scripts/dev-db-server.mjs');
  const db = new PGlite();
  const port = 15433 + Math.floor(Math.random() * 1000);
  const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1', ...devDbSocketOptions({ DATABASE_POOL_MAX: '5' }) });
  await server.start();
  const pool = new pg.Pool({ connectionString: `postgres://postgres@127.0.0.1:${port}/postgres?sslmode=disable`, max: 5 });
  try {
    const clients = await Promise.all(Array.from({ length: 5 }, () => pool.connect()));
    const results = await Promise.all(clients.map((client, i) => client.query('SELECT $1::int AS n', [i])));
    assert.deepEqual(results.map((r) => r.rows[0].n), [0, 1, 2, 3, 4]);
    for (const client of clients) client.release();
  } finally {
    await pool.end();
    await server.stop();
    await db.close();
  }
});

test('dev-db starts its server with those options', async () => {
  const { readFile } = await import('node:fs/promises');
  const script = await readFile(new URL('../scripts/dev-db.mjs', import.meta.url), 'utf8');
  assert.match(script, /devDbSocketOptions\(process\.env\)/);
});
