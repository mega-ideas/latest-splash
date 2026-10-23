/**
 * Two things that were true only by luck.
 *
 * 1. CI ran ten named test scripts, which listed 41 of the 117 test files.
 *    The other 76 ran only under a bare `npm test`, which nothing in CI
 *    calls, so any of them could fail on main without anyone seeing it.
 *    CI now runs `npm test`, which takes every `tests/*.test.mjs`.
 *
 * 2. Splash on Sui and the Solana build are separate products in separate
 *    repositories (mega-ideas/latest-splash and sky9484/splash-solana).
 *    Nothing stopped a Solana toolchain, program or package from being
 *    committed here by mistake. `scripts/check-separate-builds.mjs` now
 *    fails the lint if one appears. Naming Solana as a chain a customer can
 *    fund FROM over CCTP (lib/payments/cctp.ts) is not a Solana build and is
 *    allowed: the guard looks at dependencies and build files, not words.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => readFile(path.join(root, rel), 'utf8');
const guard = path.join(root, 'scripts', 'check-separate-builds.mjs');

test('CI runs every test file, not a hand-kept list of scripts', async () => {
  const ci = await read('.github/workflows/ci.yml');
  assert.match(ci, /run: npm test\s*$/m, 'a step runs the whole suite');
  const pkg = JSON.parse(await read('package.json'));
  assert.match(pkg.scripts.test, /tests\/\*\.test\.mjs/, 'npm test takes every tests/*.test.mjs');
});

test('the separate-builds guard runs under lint and passes on this tree', async () => {
  const pkg = JSON.parse(await read('package.json'));
  assert.match(pkg.scripts.lint, /check:builds/);
  assert.match(pkg.scripts['check:builds'] ?? '', /check-separate-builds\.mjs/);
  const run = spawnSync(process.execPath, [guard, root], { encoding: 'utf8' });
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
});

function plantedTree(files) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'splash-builds-'));
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: {}, devDependencies: {} }));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

test('the guard fails on a Solana package, an Anchor workspace or a Solana program folder', () => {
  const cases = {
    'a @solana/web3.js dependency': { 'package.json': JSON.stringify({ dependencies: { '@solana/web3.js': '1.0.0' } }) },
    'an Anchor dev dependency': { 'package.json': JSON.stringify({ devDependencies: { '@coral-xyz/anchor': '0.30.0' } }) },
    'an Anchor.toml': { 'Anchor.toml': '[programs.localnet]\n' },
    'a Solana program crate': { 'programs/splash/Cargo.toml': '[dependencies]\nanchor-lang = "0.30"\n' },
  };
  for (const [name, files] of Object.entries(cases)) {
    const run = spawnSync(process.execPath, [guard, plantedTree(files)], { encoding: 'utf8' });
    assert.equal(run.status, 1, `${name} must fail the guard`);
    assert.match(`${run.stdout}${run.stderr}`, /splash-solana/, `${name}: the failure says where Solana work belongs`);
  }
});

test('the guard passes a tree that only names Solana as a funding source', () => {
  const dir = plantedTree({ 'lib/payments/cctp.ts': "export type FundingChain = 'SUI' | 'SOLANA';\n" });
  const run = spawnSync(process.execPath, [guard, dir], { encoding: 'utf8' });
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
});
