/**
 * No source file is secretly binary.
 *
 * A NUL byte in a text file makes git treat the whole file as binary. It stops
 * appearing in diffs, `grep` skips it, and code review sees `Bin 9075 -> 9908
 * bytes` instead of the change. The file still compiles and still runs, so
 * nothing else complains.
 *
 * This has now happened twice in this repository, both times for the same
 * reason: NUL is a genuinely good field separator — it cannot occur inside the
 * values it separates — so it gets reached for when building a canonical hash
 * input. Written as a literal byte rather than an escape sequence, it takes the
 * file out of review with it.
 *
 * Both times it landed in a file that decides whether money moves:
 *
 *   app/api/batches/authorize/route.ts — the payroll replay key, the guard
 *   that stops a re-submitted file paying every recipient twice.
 *
 *   lib/server/dual-approval.ts — the module that decides whether a payment
 *   needs a second approver. It was committed binary and reviewed by nobody,
 *   because there was nothing to look at.
 *
 * The escape produces the identical byte at runtime. The only thing that
 * changes is whether a human can see the line.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOTS = ['app', 'lib', 'components', 'scripts', 'tests', 'drizzle', 'move'];
const SKIP = new Set(['node_modules', '.next', '.git', 'dist', 'build', '.tools']);
const TEXT = /\.(ts|tsx|js|jsx|mjs|cjs|css|sql|move|md|json|toml|ya?ml)$/;

async function filesUnder(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await filesUnder(full)));
    else if (TEXT.test(entry.name)) out.push(full);
  }
  return out;
}

const violations = [];
let scanned = 0;

for (const root of ROOTS) {
  for (const file of await filesUnder(root)) {
    scanned += 1;
    const bytes = await readFile(file);
    const at = bytes.indexOf(0);
    if (at === -1) continue;

    // Report the line, so the fix is obvious rather than a hunt.
    const line = bytes.subarray(0, at).toString('utf8').split('\n').length;
    const count = bytes.filter((b) => b === 0).length;
    violations.push(
      `${file.replace(/\\/g, '/')}:${line} contains ${count} NUL byte(s) — ` +
        'git treats this file as binary, so it never appears in a diff.',
    );
  }
}

if (violations.length > 0) {
  console.error('Source files that git will treat as binary:\n');
  for (const violation of violations) console.error(`  ✖ ${violation}`);
  console.error(
    '\nWrite the separator as an escape instead. In a JS/TS template literal:\n' +
      '\n' +
      '    .update(`${a}\\u0000${b}`)     // same byte at runtime, visible in review\n' +
      '\n' +
      'A file that cannot be reviewed is a file nobody reviewed.',
  );
  process.exit(1);
}

console.log(`No binary source: ${scanned} text file(s) scanned, none contain a NUL byte.`);
