/**
 * Every Move package is built and tested in CI, with the CLI it is pinned to.
 *
 * Some properties are checked only by `sui move test`: that
 * `multisig::derive_address` agrees with the SDK's vectors
 * (tests/multisig-vectors.test.mjs only checks that the vectors are written
 * into multisig_tests.move), the 24-hour upgrade delay, that no spender can
 * be rotated. Until .github/workflows/move.yml existed no workflow installed a
 * Sui CLI, so those ran only when someone typed the command, and a broken
 * derive_address passed CI.
 *
 * The workflow cannot run here. These tests hold it to what it must do: run
 * on every pull request; install the official MystenLabs/sui release for the
 * exact tag the packages name, for ubuntu x86_64, and verify it against a
 * pinned SHA-256; build and test every package under move/; and run the core
 * invariant against the compiled modules.
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const WORKFLOW = '.github/workflows/move.yml';
const read = (rel) => readFileSync(path.resolve(rel), 'utf8').split(/\r?\n/).join('\n');

/** Every directory under move/ that is a Move package. */
const PACKAGES = readdirSync(path.resolve('move'), { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(path.resolve('move', d.name, 'Move.toml')))
  .map((d) => d.name)
  .sort();

/** The steps of the workflow, as `{ name, run, dir }`, in order. */
function steps(yaml) {
  const out = [];
  for (const block of yaml.split(/\n\s{6}- /).slice(1)) {
    out.push({
      name: /(?:^|\n)\s*name:\s*(.+)/.exec(block)?.[1]?.trim() ?? '',
      run: /(?:^|\n)\s*run:\s*([\s\S]*?)(?=\n\s{8}\w[\w-]*:|$)/.exec(block)?.[1] ?? '',
      dir: /(?:^|\n)\s*working-directory:\s*(\S+)/.exec(block)?.[1] ?? '',
      raw: block,
    });
  }
  return out;
}

test('the Move workflow exists and runs on every pull request', () => {
  assert.ok(existsSync(path.resolve(WORKFLOW)), `${WORKFLOW} exists`);
  const yaml = read(WORKFLOW);
  assert.match(yaml, /\non:\n(?:[\s\S]*?\n)?\s{2}pull_request:/, 'it runs on pull_request');
  assert.match(yaml, /\npermissions:\n\s{2}contents: read\n/, 'it reads the repository and nothing else');
  assert.doesNotMatch(yaml, /secrets\./, 'it needs no secret');
});

test('it installs the official Sui release for the tag the packages are built with, checksum verified', () => {
  const yaml = read(WORKFLOW);
  const tag = /\n\s+SUI_TAG:\s*(\S+)/.exec(yaml)?.[1];
  assert.ok(tag, 'the workflow pins SUI_TAG');
  assert.equal(tag, 'mainnet-v1.82.3');
  // The tag every package names as the CLI it is built and tested with.
  for (const pkg of ['splash_core', 'splash_spend', 'splash_upgrade_delay']) {
    assert.match(read(`move/${pkg}/Move.toml`), new RegExp(`Sui CLI ${tag.replace(/\./g, '\\.')}`), `move/${pkg}/Move.toml names ${tag}`);
  }
  const sha = /\n\s+SUI_SHA256:\s*([0-9a-f]+)\s*\n/.exec(yaml)?.[1];
  assert.ok(sha && sha.length === 64, 'the workflow pins the archive SHA-256');
  assert.ok(
    yaml.includes('https://github.com/MystenLabs/sui/releases/download/${SUI_TAG}/sui-${SUI_TAG}-ubuntu-x86_64.tgz'),
    'it downloads the ubuntu x86_64 archive of that tag from the MystenLabs/sui release',
  );
  assert.match(yaml, /sha256sum --check --strict/, 'it verifies the archive before extracting it');
  const install = steps(yaml).find((s) => /install the Sui CLI/.test(s.name));
  assert.ok(install, 'one step installs the CLI');
  assert.ok(install.run.indexOf('sha256sum') < install.run.indexOf('tar '), 'the checksum is verified before tar runs');
  assert.match(yaml, /runs-on: ubuntu-24\.04\b/, 'the runner is the x86_64 ubuntu the archive is built for');
  assert.match(yaml, /--version/, 'it checks the installed version');
});

test('it builds and tests every Move package under move/', () => {
  const all = steps(read(WORKFLOW));
  assert.deepEqual(PACKAGES, ['splash_core', 'splash_custody', 'splash_meter', 'splash_spend', 'splash_upgrade_delay']);
  for (const pkg of PACKAGES) {
    const here = all.filter((s) => s.dir === `move/${pkg}`);
    assert.ok(here.some((s) => /\bsui move build\b/.test(s.run)), `sui move build runs in move/${pkg}`);
    assert.ok(here.some((s) => /\bsui move test\b/.test(s.run)), `sui move test runs in move/${pkg}`);
    const build = all.findIndex((s) => s.dir === `move/${pkg}` && /\bsui move build\b/.test(s.run));
    const install = all.findIndex((s) => /install the Sui CLI/.test(s.name));
    assert.ok(install < build, `the CLI is installed before move/${pkg} is built`);
  }
});

test('it runs the core invariant against the compiled splash_core', () => {
  const all = steps(read(WORKFLOW));
  const build = all.findIndex((s) => s.dir === 'move/splash_core' && /\bsui move build\b/.test(s.run));
  const check = all.findIndex((s) => /node scripts\/check-core-no-balance\.mjs --require-build/.test(s.run));
  assert.ok(check > build && build !== -1, 'check-core-no-balance --require-build runs after splash_core is built');
});
