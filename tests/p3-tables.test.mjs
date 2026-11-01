import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

import { PGlite } from '@electric-sql/pglite';

import { migrateDevDatabase } from '../scripts/dev-db-migrations.mjs';

/**
 * v2 Phase 3 (p3-tables): Sky's decision, "if a table is not used in any
 * situation, drop it". Six tables had no reader and no writer anywhere:
 * funding_events, treasury_moves, compliance_cases, screening_results,
 * audit_anchors and login_attempts. One migration, 0080, drops them. Every
 * other table in the schema has a reader or a writer and stays.
 */

const root = new URL('..', import.meta.url);
const at = (rel) => new URL(rel, root);
const DRIZZLE = at('drizzle/');
const MIGRATION = '0080_drop_unused_tables.sql';
const DROPPED = ['funding_events', 'treasury_moves', 'compliance_cases', 'screening_results', 'audit_anchors', 'login_attempts'];
const EXPORTS = ['fundingEvents', 'treasuryMoves', 'complianceCases', 'screeningResults', 'auditAnchors', 'loginAttempts'];

const sorted = async () => (await readdir(DRIZZLE)).filter((f) => f.endsWith('.sql')).sort();
const applyFile = async (client, name) => client.exec(await readFile(at(`drizzle/${name}`), 'utf8'));
const tables = async (client) =>
  (await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`)).rows.map((r) => r.table_name);
const count = async (client, table) => (await client.query(`SELECT count(*)::int AS n FROM "${table}"`)).rows[0].n;

async function migratedTo(name) {
  const client = new PGlite();
  for (const file of (await sorted()).filter((f) => f < name)) await applyFile(client, file);
  return client;
}

// ── The migration file and the journal ─────────────────────────────────────

test('0080 drops the six tables by name, with no CASCADE, and is not the migration that edited an applied one', async () => {
  const sql = await readFile(at(`drizzle/${MIGRATION}`), 'utf8');
  for (const table of DROPPED) {
    assert.match(sql, new RegExp(`DROP TABLE IF EXISTS "${table}";`), `${table} is dropped, and safe on a database that never had it`);
  }
  assert.equal((sql.match(/DROP TABLE/g) ?? []).length, DROPPED.length, 'exactly the six, no more');
  assert.doesNotMatch(sql, /CASCADE/i, 'nothing else goes with them');
  assert.doesNotMatch(sql, /DROP TYPE|DELETE FROM|TRUNCATE/i, 'the screening_verdict type and every row elsewhere are left alone');
});

test('0080 is the next number after the highest on the branch, journalled, and its time rises', async () => {
  const files = await sorted();
  const journal = JSON.parse(await readFile(at('drizzle/meta/_journal.json'), 'utf8'));
  const entry = journal.entries.find((e) => e.tag === '0080_drop_unused_tables');
  assert.ok(entry, '0080 is in the journal');
  assert.equal(entry.idx, 80);
  const before = journal.entries.find((e) => e.idx === 79);
  assert.ok(entry.when > before.when, 'when rises, or a database that applied 0079 would skip it');
  assert.ok(files.includes(MIGRATION));
  // The applied migrations that made the tables are not edited.
  assert.match(await readFile(at('drizzle/0000_flashy_robin_chapel.sql'), 'utf8'), /CREATE TABLE "funding_events"/);
  assert.match(await readFile(at('drizzle/0004_real_users.sql'), 'utf8'), /CREATE TABLE "login_attempts"/);
});

// ── The schema and the code ────────────────────────────────────────────────

test('the schema defines none of the six, and keeps the screening_verdict type the suppliers table uses', async () => {
  const schema = await readFile(at('lib/db/schema.ts'), 'utf8');
  for (const table of DROPPED) assert.doesNotMatch(schema, new RegExp(`['"]${table}['"]`), `${table} is gone from the schema`);
  for (const name of EXPORTS) assert.doesNotMatch(schema, new RegExp(`export const ${name}\\b`));
  assert.match(schema, /export const screeningVerdict = pgEnum\('screening_verdict'/, 'the enum stays, suppliers.screening_verdict uses it');
  assert.match(schema, /screeningVerdict: screeningVerdict\('screening_verdict'\)/);
});

const TEXT = /\.(ts|tsx|mjs|js|cjs|sh|sql)$/;
const SKIP = new Set(['node_modules', '.next', '.git', 'build', '.claude', 'public', 'samples', 'drizzle', 'move']);
async function allText(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(at(dir), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;
    const rel = dir === '.' ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await allText(rel)));
    else if (TEXT.test(entry.name)) out.push(rel);
  }
  return out;
}

test('nothing in the code, the scripts or the other tests reads or writes the dropped tables', async () => {
  const pattern = new RegExp(`(?<![A-Za-z0-9_])(${[...DROPPED, ...EXPORTS].join('|')})(?![A-Za-z0-9_])`);
  const found = [];
  for (const file of await allText('.')) {
    if (file === 'tests/p3-tables.test.mjs') continue;
    const text = await readFile(at(file), 'utf8');
    if (pattern.test(text)) found.push(file);
  }
  assert.deepEqual(found, []);
});

test('the migration page says what dropping loses and how to count it first', async () => {
  const doc = await readFile(at('docs/v2/migrations.md'), 'utf8');
  assert.match(doc, /## `0080_drop_unused_tables`/);
  for (const table of DROPPED) assert.match(doc, new RegExp(`select count\\(\\*\\) from ${table};`), `the page gives the row count for ${table}`);
  assert.match(doc, /loses the rows/i);
  assert.match(doc, /screening_verdict/, 'and says the type stays');
});

test('the legacy login table is described as dropped, not as waiting for a drop', async () => {
  const security = await readFile(at('SECURITY.md'), 'utf8');
  assert.doesNotMatch(security, /waits for a drop migration/);
  assert.match(security, /`login_attempts` was dropped by migration 0080/);
  const limiter = await readFile(at('lib/auth/login-rate-limit.ts'), 'utf8');
  assert.doesNotMatch(limiter, /a later migration drops it/);
});

// ── What the migration does to a database ──────────────────────────────────

test('on a database at 0079 holding rows in all six, 0080 drops those six and no other table, and a second run changes nothing', async () => {
  const client = await migratedTo(MIGRATION);
  const before = await tables(client);
  for (const table of DROPPED) assert.ok(before.includes(table), `${table} is there before`);

  await client.query(`INSERT INTO organizations (id, name) VALUES ('org_tables', 'Tables Ltd')`);
  await client.query(`INSERT INTO funding_events (id, org_id, session_id, provider, method, status, amount_minor, currency) VALUES ('f1', 'org_tables', 's1', 'p', 'm', 'DONE', 100, 'USD')`);
  await client.query(`INSERT INTO treasury_moves (id, org_id, kind, status, amount_minor, currency) VALUES ('t1', 'org_tables', 'k', 'DONE', 100, 'USD')`);
  await client.query(`INSERT INTO compliance_cases (id, org_id, subject_kind, subject_id) VALUES ('c1', 'org_tables', 'PAYMENT', 'x')`);
  await client.query(`INSERT INTO screening_results (id, org_id, subject_kind, subject_id, provider, verdict, screened_at) VALUES ('s1', 'org_tables', 'PAYMENT', 'x', 'p', 'CLEAR', now())`);
  await client.query(`INSERT INTO audit_anchors (id, org_id, batch_date) VALUES ('a1', 'org_tables', '2026-11-01')`);
  await client.query(`INSERT INTO login_attempts (id, email, ip) VALUES ('l1', 'x@example.com', '10.0.0.1')`);
  for (const table of DROPPED) assert.equal(await count(client, table), 1);

  await applyFile(client, MIGRATION);
  const after = await tables(client);
  assert.deepEqual(before.filter((t) => !after.includes(t)).sort(), [...DROPPED].sort(), 'six tables gone, no other');
  assert.deepEqual(after.filter((t) => !before.includes(t)), [], 'nothing new');
  assert.equal(await count(client, 'organizations'), 1, 'the business is untouched');
  const orphans = await client.query(`SELECT indexname FROM pg_indexes WHERE tablename = ANY($1)`, [DROPPED]);
  assert.deepEqual(orphans.rows, [], 'their indexes went with them');

  // The type suppliers use is still there, and a supplier can still be screened.
  const types = await client.query(`SELECT typname FROM pg_type WHERE typname = 'screening_verdict'`);
  assert.equal(types.rows.length, 1);

  await applyFile(client, MIGRATION);
  assert.deepEqual(await tables(client), after, 'replay: the same file again changes nothing');
  await client.close();
});

test('on a database that never had the tables, 0080 still applies', async () => {
  const client = await migratedTo(MIGRATION);
  for (const table of DROPPED) await client.exec(`DROP TABLE "${table}"`);
  const before = await tables(client);
  await applyFile(client, MIGRATION);
  assert.deepEqual(await tables(client), before);
  await client.close();
});

test('an empty database migrates in journal order, ends without the six, and keeps a ledger row per file', async () => {
  const client = new PGlite();
  const onDisk = (await sorted()).length;
  const result = await migrateDevDatabase(client, DRIZZLE);
  assert.equal(result.appliedNow, onDisk);
  const present = await tables(client);
  for (const table of DROPPED) assert.equal(present.includes(table), false, `${table} is absent once every migration has run`);
  // The tables that replaced or kept their work are there.
  for (const kept of ['rate_limit_hits', 'suppliers', 'daily_audit_batches', 'wallet_batches', 'payouts', 'webhook_events']) {
    assert.ok(present.includes(kept), `${kept} stays`);
  }
  assert.equal((await client.query(`SELECT count(*)::int AS n FROM "drizzle"."__drizzle_migrations"`)).rows[0].n, onDisk);
  assert.equal((await migrateDevDatabase(client, DRIZZLE)).appliedNow, 0, 'a second start applies nothing');
  await client.close();
});
