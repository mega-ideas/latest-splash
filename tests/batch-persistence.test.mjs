import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

import * as schema from '../lib/db/schema.ts';
import {
  __testing,
  claimBatchRun,
  findByIdempotencyKey,
  getBatchRun,
  listBatchRuns,
  patchBatchRun,
} from '../lib/server/repository/batches.ts';

/**
 * Payout runs, in Postgres, belonging to somebody.
 *
 * A batch is a payroll run: many recipients paid under one authorization. It
 * lived in a `Map`, which took the replay guard down with it — the guard that
 * stops a re-submitted file paying everybody twice was a lookup in a store that
 * a restart emptied, and restarts are exactly when an operator retries.
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
  await client.exec(`
    INSERT INTO organizations (id, name) VALUES ('acme', 'Acme Trading'), ('northwind', 'Northwind')
  `);
  return { client, db };
}

const run = (over = {}) => ({
  id: 'batch_1',
  orgId: 'acme',
  accountId: 'dashboard-primary',
  state: 'QUEUED',
  rowCount: 12,
  acceptedRows: 11,
  blockedRows: 1,
  totalAmount: '48250.00',
  targetCurrency: 'PHP',
  idempotencyKey: 'payroll-friday',
  ...over,
});

// ── Durability ──────────────────────────────────────────────────────────────

test('a payout run survives, with the counts an operator reconciles against', async () => {
  const { client, db } = await migratedDb();
  await claimBatchRun(db, run());

  const read = await getBatchRun(db, 'acme', 'batch_1');
  assert.equal(read.rowCount, 12);
  assert.equal(read.acceptedRows, 11);
  assert.equal(read.blockedRows, 1);
  assert.equal(read.totalAmount, '48250');
  assert.equal(read.state, 'QUEUED');
  await client.close();
});

test('the total is minor units, not a float sum rendered to two places', () => {
  const { toMinor, fromMinor } = __testing;
  assert.equal(toMinor('48250.00'), 48_250_000_000n);
  assert.equal(toMinor('0.1') + toMinor('0.2'), toMinor('0.3'));
  assert.equal(fromMinor(9_007_199_254_740_993n), '9007199254.740993');
});

// ── The replay guard, which is why this is a table ─────────────────────────

test('the same file submitted twice pays once', async () => {
  const { client, db } = await migratedDb();

  const first = await claimBatchRun(db, run({ id: 'batch_1' }));
  assert.equal(first.claimed, true);

  // The operator's retry after a dropped response leg. A different run id —
  // the route mints a fresh one — but the same derived key.
  const second = await claimBatchRun(db, run({ id: 'batch_2' }));
  assert.equal(second.claimed, false, 'the second submission must not settle');
  assert.equal(second.run.id, 'batch_1', 'it gets back the run that already exists');

  assert.equal((await listBatchRuns(db, 'acme')).length, 1);
  await client.close();
});

test('the key is claimed by the index, not by a prior read', async () => {
  const { client, db } = await migratedDb();

  // Two copies of the same file arriving together. A read-then-write guard has
  // both find nothing and both insert; the unique index has exactly one win.
  const [a, b] = await Promise.all([
    claimBatchRun(db, run({ id: 'batch_a' })),
    claimBatchRun(db, run({ id: 'batch_b' })),
  ]);

  assert.equal([a, b].filter((r) => r.claimed).length, 1, 'exactly one run is created');
  assert.equal(a.run.id, b.run.id, 'and both callers get the same run back');
  assert.equal((await listBatchRuns(db, 'acme')).length, 1);
  await client.close();
});

test('two tenants may use the same replay key', async () => {
  const { client, db } = await migratedDb();
  const mine = await claimBatchRun(db, run({ id: 'b_a', orgId: 'acme' }));
  const theirs = await claimBatchRun(db, run({ id: 'b_n', orgId: 'northwind' }));

  // Scoped by org, not by the on-chain account id — which falls back to a value
  // shared across orgs, so one tenant's "payroll-friday" would have blocked
  // every other tenant's forever.
  assert.equal(mine.claimed, true);
  assert.equal(theirs.claimed, true);
  assert.equal((await findByIdempotencyKey(db, 'acme', 'payroll-friday')).id, 'b_a');
  assert.equal((await findByIdempotencyKey(db, 'northwind', 'payroll-friday')).id, 'b_n');
  await client.close();
});

// ── Tenant isolation ────────────────────────────────────────────────────────

test('one tenant cannot read another tenant’s payout run', async () => {
  const { client, db } = await migratedDb();
  await claimBatchRun(db, run({ id: 'batch_acme', orgId: 'acme' }));

  assert.notEqual(await getBatchRun(db, 'acme', 'batch_acme'), null);
  // Row counts, totals and the settlement digest of somebody else's payroll.
  assert.equal(await getBatchRun(db, 'northwind', 'batch_acme'), null);
  await client.close();
});

test('listing returns one tenant’s runs', async () => {
  const { client, db } = await migratedDb();
  await claimBatchRun(db, run({ id: 'b1', orgId: 'acme', idempotencyKey: 'k1' }));
  await claimBatchRun(db, run({ id: 'b2', orgId: 'acme', idempotencyKey: 'k2' }));
  await claimBatchRun(db, run({ id: 'b3', orgId: 'northwind', idempotencyKey: 'k3' }));

  assert.deepEqual((await listBatchRuns(db, 'acme')).map((b) => b.id).sort(), ['b1', 'b2']);
  assert.deepEqual((await listBatchRuns(db, 'northwind')).map((b) => b.id), ['b3']);
  await client.close();
});

// ── Settlement ──────────────────────────────────────────────────────────────

test('the settlement digest lands on the run that survives the restart', async () => {
  const { client, db } = await migratedDb();
  await claimBatchRun(db, run());

  await patchBatchRun(db, 'batch_1', { state: 'SETTLING' });
  await patchBatchRun(db, 'batch_1', {
    state: 'SETTLED',
    digest: '0xabc',
    packageId: '0xpkg',
  });

  const read = await getBatchRun(db, 'acme', 'batch_1');
  assert.equal(read.state, 'SETTLED');
  assert.equal(read.digest, '0xabc');
  assert.equal(read.packageId, '0xpkg');
  await client.close();
});

// ── The route ───────────────────────────────────────────────────────────────

test('the idempotency hash is readable source, not raw NUL bytes', async () => {
  const path = new URL('../app/api/batches/authorize/route.ts', import.meta.url);
  const bytes = await readFile(path);
  // The separators are deliberate — NUL cannot appear in the fields it
  // separates — but written as literal bytes the whole file counted as binary:
  // no diff, no grep, no review, for the function that decides whether a
  // payroll run has already been paid.
  assert.equal(bytes.includes(0), false, 'the route must not contain raw NUL bytes');

  const text = bytes.toString('utf8');
  assert.match(text, /\\u0000/, 'the separators are still there, as escapes');
  // And keyed by org, not by an account id that falls back across tenants.
  assert.match(text, /function deriveIdempotencyKey\(orgId: string/);
});

test('the route claims the key through the store rather than reading first', async () => {
  const text = await readFile(
    new URL('../app/api/batches/authorize/route.ts', import.meta.url),
    'utf8',
  );
  assert.match(text, /claimBatch\(/);
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
  assert.doesNotMatch(code, /findBatchByIdempotencyKey/, 'a read-then-write leaves a window');
  assert.doesNotMatch(code, /createBatch\(|updateBatch\(/);
});
