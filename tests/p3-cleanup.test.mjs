import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import test from 'node:test';

import { PGlite } from '@electric-sql/pglite';

import { migrateDevDatabase } from '../scripts/dev-db-migrations.mjs';

/**
 * v2 Phase 3 (p3-cleanup): the migration numbers are the new ones only, the
 * orphan `batch_runs` table is dropped by a migration of its own, and the code
 * the custody removal and the Transfer rebuild left with no caller is gone.
 *
 * Sky's decision: use the new migration numbers only, and delete anything old
 * and not used so the build and the code stay clean.
 */

const root = new URL('..', import.meta.url);
const at = (rel) => new URL(rel, root);
const DRIZZLE = at('drizzle/');
const exists = async (rel) => {
  try {
    await stat(at(rel));
    return true;
  } catch {
    return false;
  }
};

const TEXT = /\.(ts|tsx|mjs|js|cjs|json|md|css|yml|yaml|sql|sh|toml|example)$/;
const SKIP = new Set(['node_modules', '.next', '.git', 'build', '.claude', 'public', 'samples']);

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

const sorted = async () => (await readdir(DRIZZLE)).filter((f) => f.endsWith('.sql')).sort();

// ── The old-numbers repair is gone; the journal-order guard stays ──────────

test('the old-numbers repair page is removed and nothing points at it', async () => {
  assert.equal(await exists('docs/v2/migration-renumber.md'), false);
  const found = [];
  for (const file of await allText('.')) {
    if (file === 'tests/p3-cleanup.test.mjs') continue;
    const text = await readFile(at(file), 'utf8');
    if (/migration-renumber/.test(text)) found.push(`${file}: names the removed page`);
    if (/UPDATE splash_dev_migrations SET name/.test(text)) found.push(`${file}: carries the rename repair`);
    if (/Phase 3's OLD numbers|database that applied Phase 3's old/i.test(text)) found.push(`${file}: describes the old-numbers repair`);
  }
  assert.deepEqual(found, []);
});

test('the journal-order guard and its test are kept', async () => {
  assert.equal(await exists('scripts/check-migration-journal.mjs'), true);
  assert.equal(await exists('tests/migration-journal-order.test.mjs'), true);
  const guard = await readFile(at('scripts/check-migration-journal.mjs'), 'utf8');
  assert.match(guard, /when/, 'it still checks that when rises');
  const pkg = JSON.parse(await readFile(at('package.json'), 'utf8'));
  assert.match(pkg.scripts['check:migrations'], /check-migration-journal/);
  assert.match(pkg.scripts.lint, /check:migrations/, 'and lint still runs it');
  const order = await readFile(at('tests/migration-journal-order.test.mjs'), 'utf8');
  assert.doesNotMatch(order, /migration-renumber/, 'the guard test does not cite the removed page');
});

test('docs/v2 says in one sentence that migrations are applied in journal order, on the migrations page', async () => {
  const sentence = /Migrations are applied in journal order on an empty or current database\./;
  const pages = [];
  for (const file of await readdir(at('docs/v2'))) {
    if (!file.endsWith('.md')) continue;
    if (sentence.test(await readFile(at(`docs/v2/${file}`), 'utf8'))) pages.push(file);
  }
  assert.deepEqual(pages, ['migrations.md'], 'once, on the page an operator looks at for migrations');
});

test('the batch page keeps the approval text with the BATCH_PAYOUT sentence it is about', async () => {
  const doc = (await readFile(at('docs/v2/phase3-batch.md'), 'utf8')).replace(/\r\n/g, '\n');
  const paragraphs = doc.split(/\n\n+/);
  const stays = paragraphs.find((p) => p.startsWith('What stays:'));
  assert.ok(stays, 'the What stays paragraph exists');
  assert.match(stays, /BATCH_PAYOUT/);
  assert.match(stays, /Approving one now records it as\s+\*\*not executed\*\*/, 'the approval text follows the proposal-kind sentence');
  const goes = paragraphs.find((p) => p.startsWith('What goes after it:'));
  assert.ok(goes, 'the What goes after it paragraph exists');
  assert.doesNotMatch(goes, /Approving one|Migrations are applied/);
  assert.match(goes, /wallet_batches\.$/);
  for (const p of paragraphs) assert.ok(p.length < 1200, 'no run-on paragraph');
});

// ── batch_runs is dropped by a new migration ───────────────────────────────

test('batch_runs has a migration that drops it, at the next number, listed in the journal', async () => {
  const files = await sorted();
  const drop = files.find((f) => /batch_runs/.test(f) && f !== '0011_batch_runs.sql');
  assert.equal(drop, '0071_drop_batch_runs.sql');
  const sql = await readFile(at(`drizzle/${drop}`), 'utf8');
  assert.match(sql, /DROP TABLE IF EXISTS "batch_runs"/);
  assert.doesNotMatch(sql, /CASCADE/i, 'nothing else is dropped with it');

  const journal = JSON.parse(await readFile(at('drizzle/meta/_journal.json'), 'utf8'));
  // By tag, not by position: a later migration must not break this test.
  const entry = journal.entries.find((e) => e.tag === '0071_drop_batch_runs');
  assert.ok(entry, '0071 is in the journal');
  assert.equal(entry.idx, 71);
  const before = journal.entries.find((e) => e.idx === 70);
  assert.ok(before, '0070 is in the journal');
  assert.ok(entry.when > before.when, 'when rises, or a database that applied 0070 would skip it');

  // The applied migration is not edited: 0011 still creates the table.
  const eleven = await readFile(at('drizzle/0011_batch_runs.sql'), 'utf8');
  assert.match(eleven, /CREATE TABLE "batch_runs"/);
});

test('the schema no longer defines batch_runs and nothing in the code reads it', async () => {
  const schema = await readFile(at('lib/db/schema.ts'), 'utf8');
  assert.doesNotMatch(schema, /batch_runs|batchRuns/);
  const found = [];
  for (const dir of ['app', 'lib', 'components', 'scripts', 'config', 'content', 'proxy.ts', 'instrumentation.ts']) {
    const files = dir.endsWith('.ts') ? [dir] : await allText(dir);
    for (const file of files) {
      const text = await readFile(at(file), 'utf8');
      if (/batch_runs|batchRuns/.test(text)) found.push(file);
    }
  }
  assert.deepEqual(found, []);
});

async function applyFile(client, name) {
  await client.exec(await readFile(at(`drizzle/${name}`), 'utf8'));
}

const tables = async (client) =>
  (await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`)).rows.map((r) => r.table_name);

test('on a database at 0070 with a run on file, 0071 drops the table and only that, and a second run changes nothing', async () => {
  const client = new PGlite();
  const files = await sorted();
  const upTo0070 = files.filter((f) => f <= '0070_scheduled_cap_pending.sql');
  for (const file of upTo0070) await applyFile(client, file);
  assert.ok((await tables(client)).includes('batch_runs'), 'the table is there before');

  await client.query(`INSERT INTO organizations (id, name) VALUES ('org_cleanup', 'Cleanup Ltd')`);
  await client.query(
    `INSERT INTO batch_runs (id, org_id, state, row_count, accepted_rows, blocked_rows, total_amount_minor, idempotency_key)
     VALUES ('run_1', 'org_cleanup', 'SETTLED', 1, 1, 0, 100, 'k1')`,
  );
  const before = await tables(client);

  await applyFile(client, '0071_drop_batch_runs.sql');
  const after = await tables(client);
  assert.deepEqual(before.filter((t) => !after.includes(t)), ['batch_runs'], 'one table gone, no other');
  assert.deepEqual(after.filter((t) => !before.includes(t)), []);
  assert.equal((await client.query(`SELECT count(*)::int AS n FROM organizations`)).rows[0].n, 1, 'the business is untouched');
  const indexes = await client.query(`SELECT indexname FROM pg_indexes WHERE tablename = 'batch_runs'`);
  assert.equal(indexes.rows.length, 0, 'its indexes went with it');

  // Replay: the same file again, as a re-run migrate would.
  await applyFile(client, '0071_drop_batch_runs.sql');
  assert.deepEqual(await tables(client), after);
  await client.close();
});

test('an empty database migrates in journal order with no batch_runs and a ledger row per file', async () => {
  const client = new PGlite();
  const onDisk = (await sorted()).length;
  const result = await migrateDevDatabase(client, DRIZZLE);
  assert.equal(result.appliedNow, onDisk);
  assert.equal((await tables(client)).includes('batch_runs'), false);
  const ledger = await client.query(`SELECT count(*)::int AS n FROM "drizzle"."__drizzle_migrations"`);
  assert.equal(ledger.rows[0].n, onDisk);
  // A second start applies nothing.
  const again = await migrateDevDatabase(client, DRIZZLE);
  assert.equal(again.appliedNow, 0);
  await client.close();
});

test('the batch history that stays is the wallet batches, tenant-scoped, not the dropped table', async () => {
  const schema = await readFile(at('lib/db/schema.ts'), 'utf8');
  assert.match(schema, /pgTable\('wallet_batches'/);
  const route = await readFile(at('app/api/wallet/batches/route.ts'), 'utf8');
  assert.match(route, /batchRoute\(/, 'still behind the session-scoped wrapper');
});

// ── Code and scripts nothing calls are gone ─────────────────────────────────

const GONE = [
  'components/dashboard/ExplorerLinks.tsx',
  'components/HoverPopup.tsx',
  'components/SourceBadge.tsx',
  'components/SourceBadge.module.css',
  'components/dashboard/SettlementEngineFlow.tsx',
  'components/SettlementProofDrawer.tsx',
  'components/funding/FundingSelector.tsx',
  'lib/dashboard/rate-holds.ts',
  'lib/server/airwallex.ts',
  'lib/server/stripe.ts',
  'lib/server/stable-router.ts',
  'lib/server/usdt-ttl-guard.ts',
  'lib/server/ptb.ts',
  'scripts/fund-settlement-pool.mjs',
  // The two logos only the settlement-flow diagram drew.
  'public/stripe-logo.svg',
  'public/airwallex-logo.png',
  // Images only the image allow-list and one dead style rule named.
  'public/sumsub-logo.png',
  'public/deepbook-mark.png',
  'public/sui-logo-blue.svg',
  // shadcn files that nothing imports (alert, button, input and select stay as the base kit).
  'components/ui/avatar.tsx',
  'components/ui/badge.tsx',
  'components/ui/card.tsx',
  'components/ui/dialog.tsx',
  'components/ui/label.tsx',
  'components/ui/progress.tsx',
  'components/ui/separator.tsx',
  'components/ui/sheet.tsx',
  'components/ui/table.tsx',
  'components/ui/tabs.tsx',
  'components/ui/toggle.tsx',
];

test('files with no caller are removed', async () => {
  for (const gone of GONE) assert.equal(await exists(gone), false, `${gone} must be removed`);
});

test('nothing imports, links or names what was removed', async () => {
  const names = [
    /ExplorerLinks/,
    /HoverPopup/,
    /SourceBadge/,
    /SettlementEngineFlow/,
    /SettlementProofDrawer/,
    /FundingSelector/,
    /dashboard\/rate-holds/,
    /server\/airwallex/,
    /server\/stripe/,
    /stable-router/,
    /usdt-ttl-guard/,
    /server\/ptb/,
    /fund-settlement-pool/,
    /sumsub-logo|deepbook-mark|sui-logo-blue/,
    /iso-deepbook-logo|iso-airwallex-logo/,
    /ui\/(avatar|badge|card|dialog|label|progress|separator|sheet|table|tabs|toggle)['"]/,
  ];
  const found = [];
  for (const file of await allText('.')) {
    // A test that says a page does NOT use one of these has to name it.
    if (file.startsWith('tests/')) continue;
    // A dated record of a past testnet run may name the script; see below.
    if (file === 'docs/KEY-CEREMONY-RUNBOOK.md') continue;
    const text = await readFile(at(file), 'utf8');
    for (const pattern of names) if (pattern.test(text)) found.push(`${file}: ${pattern}`);
  }
  assert.deepEqual(found, []);
  const runbook = await readFile(at('docs/KEY-CEREMONY-RUNBOOK.md'), 'utf8');
  const row = runbook.split('\n').find((line) => line.includes('SettlementPool funded')) ?? '';
  assert.match(row, /removed/, 'the dated record says the script has since been removed');
});

test('the image allow-list no longer admits the removed logos', async () => {
  const config = await readFile(at('next.config.ts'), 'utf8');
  assert.doesNotMatch(config, /airwallex-logo|sumsub-logo|deepbook-mark/);
  assert.match(config, /splash-main-icon\.png/, 'the icon every page uses is still admitted');
});

test('the settlement-flow styles went with the component, and nothing else in the stylesheet changed meaning', async () => {
  const css = await readFile(at('app/globals.css'), 'utf8');
  assert.doesNotMatch(css, /dash-flow/);
  assert.doesNotMatch(css, /iso-deepbook-logo|iso-airwallex-logo/, 'the rules for the removed logos went too');
  // The neighbours of the removed blocks are still there.
  assert.match(css, /\.dash-reveal-stagger/);
});

test('comments no longer point at files that were deleted', async () => {
  const env = await readFile(at('lib/env.ts'), 'utf8');
  assert.doesNotMatch(env, /airwallex\.ts|stripe\.ts/);
  const css = await readFile(at('app/globals.css'), 'utf8');
  assert.doesNotMatch(css, /signature engine|shared dashboard engine/);
});

test('the pages that never used the removed components still do not', async () => {
  for (const file of ['app/dashboard/page.tsx', 'app/dashboard/transfer/page.tsx', 'components/transfer/TransferFlow.tsx', 'components/transfer/StepReceipt.tsx']) {
    const text = await readFile(at(file), 'utf8');
    assert.doesNotMatch(text, /SettlementEngineFlow|SettlementProofDrawer|FundingSelector/, file);
  }
});

test('what the cleanup must not touch is still there', async () => {
  for (const keep of [
    'drizzle/0011_batch_runs.sql',
    'lib/oxwal/phone-desk.ts',
    'lib/safety/anomaly.ts',
    'app/api/rate-holds/route.ts',
    'app/api/wallet/batches/route.ts',
    'scripts/set-compliance-config.mjs',
    'components/ui/button.tsx',
    'components/ui/alert.tsx',
    'components/ui/input.tsx',
    'components/ui/select.tsx',
  ]) {
    assert.equal(await exists(keep), true, `${keep} stays`);
  }
  // Zeke's batch drafting is the next section's.
  const oxwal = await readFile(at('lib/agent/oxwal.ts'), 'utf8');
  assert.match(oxwal, /proposeBatchPayout/);
  const proposals = await readFile(at('lib/server/approval-execution.ts'), 'utf8');
  assert.match(proposals, /BATCH_PAYOUT_RETIRED_REASON/);
});

