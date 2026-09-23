import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/**
 * A NUL byte makes git treat a text file as binary. It stops appearing in
 * diffs, grep skips it, and review sees "Bin 9075 -> 9908 bytes" instead of the
 * change. It still compiles and still runs, so nothing else complains.
 *
 * It has happened three times here, always for the same reason: NUL is a good
 * field separator — it cannot occur inside the values it separates — so it gets
 * reached for when building a canonical hash input.
 *
 * Twice it landed in a file that decides whether money moves. The third time
 * was inside the guard written to prevent it, which is how the guard was first
 * proven to work.
 */

test('the two files that reached for NUL as a separator are text', async () => {
  for (const file of [
    '../app/api/batches/authorize/route.ts',
    '../lib/server/dual-approval.ts',
  ]) {
    const bytes = await readFile(new URL(file, import.meta.url));
    assert.equal(bytes.indexOf(0), -1, `${file} must not contain a NUL byte`);
    // The separator is still there, and still a NUL at runtime.
    assert.ok(
      // String.raw, so this assertion does not itself become the thing it
      // checks for. Six visible characters, not one invisible byte.
      bytes.toString('utf8').includes(String.raw`\u0000`),
      `${file} should keep the escaped separator`,
    );
  }
});

test('the guard is in the lint chain', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(pkg.scripts.lint, /check:binary/);
  assert.equal(pkg.scripts['check:binary'], 'node scripts/check-no-binary-source.mjs');
});

test('the guard reports where, not just that', async () => {
  const guard = await readFile(
    new URL('../scripts/check-no-binary-source.mjs', import.meta.url),
    'utf8',
  );
  // "somewhere in this repo there is a NUL" is not actionable.
  assert.match(guard, /contains \$\{count\} NUL byte/);
  assert.match(guard, /\$\{line\}/);
  // And it must not itself be the thing it forbids.
  const bytes = await readFile(
    new URL('../scripts/check-no-binary-source.mjs', import.meta.url),
  );
  assert.equal(bytes.indexOf(0), -1);
});
