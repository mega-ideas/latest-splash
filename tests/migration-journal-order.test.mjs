/**
 * The journal's `when` values must rise with the migration numbers.
 *
 * drizzle's migrator does not look at names or idx to decide what to run. It
 * reads the newest row in drizzle.__drizzle_migrations and applies only the
 * journal entries whose `when` is later than that row's created_at
 * (node_modules/drizzle-orm/pg-core/dialect.js, migrate()). An entry whose
 * `when` is not later than the one before it is therefore skipped on every
 * database that has applied the one before, and nothing says so: the deploy
 * goes green and the table is not there. This is how Phase 2's 0055 to 0057
 * would have been skipped on a database that had applied Phase 3's old 0055 to
 * 0060 (docs/v2/migration-renumber.md).
 *
 * scripts/check-migration-journal.mjs checks names, idx and file order. It must
 * check `when` too.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const SCRIPT = path.resolve('scripts/check-migration-journal.mjs');

/** A drizzle/ folder with the given journal entries, run through the guard. */
function runGuard(whens) {
  const root = mkdtempSync(path.join(tmpdir(), 'journal-order-'));
  try {
    mkdirSync(path.join(root, 'drizzle', 'meta'), { recursive: true });
    const entries = whens.map((when, idx) => {
      const tag = `${String(idx).padStart(4, '0')}_m${idx}`;
      writeFileSync(path.join(root, 'drizzle', `${tag}.sql`), 'SELECT 1;\n');
      return { idx, version: '7', when, tag, breakpoints: true };
    });
    writeFileSync(path.join(root, 'drizzle', 'meta', '_journal.json'), JSON.stringify({ version: '7', dialect: 'postgresql', entries }));
    return spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: 'utf8' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('the guard accepts a journal whose when values rise', () => {
  const result = runGuard([1000, 2000, 3000]);
  assert.equal(result.status, 0, result.stderr);
});

test('the guard refuses an entry whose when is not later than the one before it', () => {
  for (const whens of [[1000, 3000, 2000], [1000, 2000, 2000]]) {
    const result = runGuard(whens);
    assert.notEqual(result.status, 0, `${whens.join(', ')} must be refused`);
    assert.match(result.stderr, /when/, 'and it says which value is wrong');
    assert.match(result.stderr, /skip/i, 'and why it matters');
  }
});

test("this repository's own journal rises", () => {
  const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8'));
  journal.entries.forEach((entry, i) => {
    if (i === 0) return;
    assert.ok(
      entry.when > journal.entries[i - 1].when,
      `${entry.tag} (${entry.when}) must be later than ${journal.entries[i - 1].tag} (${journal.entries[i - 1].when})`,
    );
  });
});
