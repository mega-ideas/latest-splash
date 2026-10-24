/**
 * Regression guard for scripts/check-abort-codes.mjs, and for the runtime
 * explainer it protects.
 *
 * `npm run check:aborts` printed "unique and explained" while two things made
 * that untrue at run time. humanizeSuiError (lib/server/sui-settlement.ts)
 * looks a code up only for modules in OUR_MODULES, and that set lacked
 * spend_window, which every v2 payment charges, and cap_registry, so their
 * aborts reached an operator as a bare number. And the check matched only
 * `const E_…: u64 = N;` in files one directory deep, so an abort code under
 * another name, a clever error, a literal code or a module in a subdirectory
 * went unseen.
 *
 * Each case below runs the check, from a scratch root, over copies of the
 * five packages' sources and the code table, with one thing planted.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const CHECKER = path.resolve('scripts/check-abort-codes.mjs');
const PACKAGES = ['splash_core', 'splash_custody', 'splash_meter', 'splash_spend', 'splash_upgrade_delay'];
const TABLE = 'lib/server/sui-settlement.ts';

/** Add `name` to OUR_MODULES in the table's text. */
const withOurModule = (name) => (table) => table.replace(/const OUR_MODULES = new Set\(\[/, `$&\n  '${name}',`);
/** Add `code: 'sentence'` to ABORT_CODES in the table's text. */
const withCode = (code, sentence) => (table) => table.replace(/const ABORT_CODES: Record<number, string> = \{/, `$&\n  ${code}: '${sentence}',`);

/**
 * Run the checker over copies of the sources and the table. `files` are
 * written relative to the scratch root; `table` edits the copied table.
 */
function run({ files = {}, table = (t) => t } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'splash-aborts-'));
  try {
    for (const pkg of PACKAGES) {
      cpSync(path.resolve('move', pkg, 'sources'), path.join(root, 'move', pkg, 'sources'), { recursive: true });
    }
    mkdirSync(path.join(root, path.dirname(TABLE)), { recursive: true });
    writeFileSync(path.join(root, TABLE), table(readFileSync(path.resolve(TABLE), 'utf8')));
    for (const [relative, contents] of Object.entries(files)) {
      const full = path.join(root, relative);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, contents);
    }
    try {
      const out = execFileSync(process.execPath, [CHECKER], { cwd: root, stdio: 'pipe' });
      return { exitCode: 0, output: String(out) };
    } catch (error) {
      return { exitCode: error.status ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** A module planted in splash_core. */
const planted = (name, body) => ({ [`move/splash_core/sources/${name}.move`]: `module splash_core::${name};\n\n${body}\n` });

test('the real sources and table pass', () => {
  const r = run();
  assert.equal(r.exitCode, 0, r.output);
  assert.match(r.output, /unique and explained/);
});

test('a module whose abort codes the runtime explainer would not consult fails the check', () => {
  const r = run({
    files: planted('newmod', 'const E_NEW: u64 = 1990;\npublic fun f(x: bool) { assert!(x, E_NEW); }'),
    table: withCode(1990, 'E_NEW — planted.'),
  });
  assert.equal(r.exitCode, 1, r.output);
  assert.match(r.output, /newmod/);
  assert.match(r.output, /OUR_MODULES/);
});

test('an abort code under a name without E_ is still an abort code', () => {
  const r = run({
    files: planted('extra', 'const ENotOwner: u64 = 1991;\npublic fun f(x: bool) { assert!(x, ENotOwner); }'),
    table: withOurModule('extra'),
  });
  assert.equal(r.exitCode, 1, r.output);
  assert.match(r.output, /1991/);
});

test('a clever error, which the table cannot explain by number, fails the check', () => {
  const r = run({
    files: planted('extra', '#[error]\nconst ENotOwner: vector<u8> = b"not the owner";\npublic fun f(x: bool) { assert!(x, ENotOwner); }'),
    table: withOurModule('extra'),
  });
  assert.equal(r.exitCode, 1, r.output);
  assert.match(r.output, /ENotOwner/);
});

test('an assert! with no code fails the check', () => {
  const r = run({ files: planted('extra', 'public fun f(x: bool) { assert!(x); }'), table: withOurModule('extra') });
  assert.equal(r.exitCode, 1, r.output);
  assert.match(r.output, /extra/);
});

test('a literal abort code fails the check', () => {
  const r = run({ files: planted('extra', 'public fun f(x: bool) { if (!x) abort 7 }'), table: withOurModule('extra') });
  assert.equal(r.exitCode, 1, r.output);
  assert.match(r.output, /extra/);
});

test('a module in a subdirectory of sources/ is read, and its collision caught', () => {
  const r = run({
    files: { 'move/splash_core/sources/extra/dup.move': 'module splash_core::dup;\n\nconst E_DUP: u64 = 1000;\npublic fun f(x: bool) { assert!(x, E_DUP); }\n' },
    table: withOurModule('dup'),
  });
  assert.equal(r.exitCode, 1, r.output);
  assert.match(r.output, /1000/);
  assert.match(r.output, /dup::E_DUP/);
});

test('every module that raises an abort is one the runtime explainer consults', async () => {
  const { humanizeSuiError } = await import('../lib/server/sui-settlement.ts');
  // The CLI prints both renderings of an abort: the MoveLocation, which names
  // the module, and "with code".
  const cliAbort = (moduleName, fn, code) =>
    `Error executing transaction: MoveAbort(MoveLocation { module: ModuleId { address: 0x5a1, name: Identifier("${moduleName}") }, function: 3, instruction: 20, function_name: Some("${fn}") }, ${code}) in command 1\n` +
    `aborted within function '0x5a1::${moduleName}::${fn}' at instruction 20 with code ${code}`;
  assert.match(humanizeSuiError(cliAbort('spend_window', 'charge', 201), ''), /^E_CAP_EXCEEDED/);
  assert.match(humanizeSuiError(cliAbort('cap_registry', 'assert_generation', 210), ''), /^E_STALE_GENERATION/);
  // A dependency's abort is still reported as the dependency's, not ours.
  assert.match(humanizeSuiError(cliAbort('some_dependency', 'f', 201), ''), /^MoveAbort code 201 from module 'some_dependency'/);
});
