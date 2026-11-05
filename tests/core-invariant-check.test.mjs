import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

/**
 * Regression guard for scripts/check-core-no-balance.mjs.
 *
 * That script IS the non-custody claim — `move/splash_core/Move.toml`, STATUS.md
 * and SECURITY.md all point at it as the evidence that Splash structurally
 * cannot hold client funds. A control quoted as evidence has to actually work.
 *
 * The first version did not. It matched `^\s*<name>\s*:\s*<Type><` — field name
 * and unwrapped type at the start of one physical line — and an adversarial
 * review compiled a complete client omnibus into splash_core while the check
 * reported "invariant holds". Every bypass it found is pinned below, so the
 * script cannot regress to a weaker match without failing here.
 */

const CHECKER = path.resolve('scripts/check-core-no-balance.mjs');

/**
 * Run the checker against a scratch copy of splash_core with `files` added
 * under sources/. `build`, when given, is the list of module names to place
 * in build/splash_core/bytecode_modules as compiled output; `args` are passed
 * to the checker.
 */
function runAgainst(files, { build = null, args = [] } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'splash-invariant-'));
  try {
    const sources = path.join(root, 'move', 'splash_core', 'sources');
    mkdirSync(sources, { recursive: true });
    cpSync(path.resolve('move/splash_core/sources'), sources, { recursive: true });
    for (const [relative, contents] of Object.entries(files)) {
      const full = path.join(sources, relative);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, contents);
    }
    if (build) {
      const bytecode = path.join(root, 'move', 'splash_core', 'build', 'splash_core', 'bytecode_modules');
      mkdirSync(bytecode, { recursive: true });
      for (const name of build) writeFileSync(path.join(bytecode, `${name}.mv`), '');
    }
    try {
      execFileSync(process.execPath, [CHECKER, ...args], { cwd: root, stdio: 'pipe' });
      return { exitCode: 0 };
    } catch (error) {
      return { exitCode: error.status ?? 1, output: String(error.stderr ?? '') };
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('the real splash_core passes', () => {
  assert.equal(runAgainst({}).exitCode, 0, 'splash_core must hold no value today');
});

test('a plain Balance field is caught', () => {
  const r = runAgainst({
    'v.move': 'module splash_core::v;\nuse sui::balance::Balance;\nuse sui::sui::SUI;\npublic struct V has key {\n    id: UID,\n    pot: Balance<SUI>,\n}\n',
  });
  assert.equal(r.exitCode, 1);
  assert.match(r.output, /CORE INVARIANT VIOLATED/);
});

test('a Balance nested inside a Table is caught', () => {
  // The omnibus shape: per-client balances inside a container. v1 missed this,
  // which is precisely how you would build a custody ledger past the check.
  const r = runAgainst({
    'v.move': 'module splash_core::v;\nuse sui::balance::Balance;\nuse sui::table::Table;\nuse sui::sui::SUI;\npublic struct V has key {\n    id: UID,\n    per_client: Table<address, Balance<SUI>>,\n}\n',
  });
  assert.equal(r.exitCode, 1);
});

test('a Coin inside a vector is caught', () => {
  const r = runAgainst({
    'v.move': 'module splash_core::v;\nuse sui::coin::Coin;\nuse sui::sui::SUI;\npublic struct V has key {\n    id: UID,\n    float: vector<Coin<SUI>>,\n}\n',
  });
  assert.equal(r.exitCode, 1);
});

test('a Balance inside an Option is caught', () => {
  const r = runAgainst({
    'v.move': 'module splash_core::v;\nuse sui::balance::Balance;\nuse sui::sui::SUI;\npublic struct V has key {\n    id: UID,\n    reserve: Option<Balance<SUI>>,\n}\n',
  });
  assert.equal(r.exitCode, 1);
});

test('an aliased import is caught', () => {
  // `use sui::balance::Balance as Ledger;` renames the type at the import, so a
  // name-based check that does not resolve aliases sees nothing.
  const r = runAgainst({
    'v.move': 'module splash_core::v;\nuse sui::balance::Balance as Ledger;\nuse sui::sui::SUI;\npublic struct V has key {\n    id: UID,\n    house: Ledger<SUI>,\n}\n',
  });
  assert.equal(r.exitCode, 1);
  assert.match(r.output, /alias of Balance/);
});

test('a field split across two lines is caught', () => {
  const r = runAgainst({
    'v.move': 'module splash_core::v;\nuse sui::balance::Balance;\nuse sui::sui::SUI;\npublic struct V has key {\n    id: UID,\n    slush:\n        Balance<SUI>,\n}\n',
  });
  assert.equal(r.exitCode, 1);
});

test('a single-line struct is caught', () => {
  const r = runAgainst({
    'v.move': 'module splash_core::v;\nuse sui::balance::Balance;\nuse sui::sui::SUI;\npublic struct V has key { id: UID, pot: Balance<SUI> }\n',
  });
  assert.equal(r.exitCode, 1);
});

test('a module in a SUBDIRECTORY is caught', () => {
  // The Move compiler walks sources/ recursively and publishes what it finds;
  // a non-recursive readdir does not. SECURITY.md I-03 recommends a scaffolds/
  // subdirectory, so this is one refactor away from mattering.
  const r = runAgainst({
    'custody/vault.move': 'module splash_core::vault;\nuse sui::balance::Balance;\nuse sui::sui::SUI;\npublic struct HiddenVault has key {\n    id: UID,\n    pot: Balance<SUI>,\n}\n',
  });
  assert.equal(r.exitCode, 1);
  assert.match(r.output, /vault\.move/);
});

test('a TreasuryCap is caught', () => {
  const r = runAgainst({
    'v.move': 'module splash_core::v;\nuse sui::coin::TreasuryCap;\nuse sui::sui::SUI;\npublic struct V has key {\n    id: UID,\n    minter: TreasuryCap<SUI>,\n}\n',
  });
  assert.equal(r.exitCode, 1);
});

test('a Coin PARAMETER is allowed — that is the non-custodial path', () => {
  // The whole design: a coin enters and leaves within one PTB. Flagging this
  // would make the check useless, so the distinction is stored-vs-passed.
  const r = runAgainst({
    'v.move': 'module splash_core::v;\nuse sui::coin::{Self, Coin};\nuse sui::sui::SUI;\npublic fun pay(c: Coin<SUI>, to: address) {\n    transfer::public_transfer(c, to);\n}\n',
  });
  assert.equal(r.exitCode, 0, 'a Coin parameter is not custody');
});

// ─── Shapes the second version walked past (adversarial review, Oct 2026) ───
//
// It found a struct by the word `struct` and took the next `{`, and looked for
// value types only inside those bodies. A positional struct borrowed the next
// struct's braces, an enum never matched, a generic holder named no value
// type, and a Bag or a dynamic field holds a Balance no struct body mentions.
// Each of these compiled into splash_core with Sui CLI 1.82.3 while the check
// reported "invariant holds".

const HEAD = 'module splash_core::v;\nuse sui::balance::Balance;\nuse sui::sui::SUI;\n';

test('a positional struct wrapping Balance is caught', () => {
  const r = runAgainst({
    'v.move': `${HEAD}public struct Pot<phantom T>(Balance<T>) has store;\npublic struct V<phantom T> has key { id: UID, pot: Pot<T> }\n`,
  });
  assert.equal(r.exitCode, 1, r.output);
  assert.match(r.output, /struct Pot/);
});

test('an enum variant wrapping Balance is caught', () => {
  const r = runAgainst({
    'v.move': `${HEAD}public enum Pot<phantom T> has store { Full(Balance<T>), Empty }\npublic struct V<phantom T> has key { id: UID, pot: Pot<T> }\n`,
  });
  assert.equal(r.exitCode, 1, r.output);
  assert.match(r.output, /enum Pot/);
});

test('a key struct with an unconstrained store type parameter as a field is caught', () => {
  // Instantiated with a Balance in a function, it holds client money; no
  // value type is named in its body.
  const r = runAgainst({
    'v.move': 'module splash_core::v;\npublic struct Holder<V: store> has key { id: UID, v: V }\n',
  });
  assert.equal(r.exitCode, 1, r.output);
  assert.match(r.output, /Holder/);
});

test('a store enum with a generic payload is caught', () => {
  const r = runAgainst({
    'v.move': 'module splash_core::v;\npublic enum Slot<T: store> has store { Full(T), Empty }\n',
  });
  assert.equal(r.exitCode, 1, r.output);
  assert.match(r.output, /Slot/);
});

test('a Bag, which holds values of any type, is caught', () => {
  const r = runAgainst({
    'v.move': 'module splash_core::v;\nuse sui::bag::Bag;\npublic struct V has key { id: UID, b: Bag }\n',
  });
  assert.equal(r.exitCode, 1, r.output);
  assert.match(r.output, /bag/i);
});

test('an ObjectBag is caught', () => {
  const r = runAgainst({
    'v.move': 'module splash_core::v;\nuse sui::object_bag::ObjectBag;\npublic struct V has key { id: UID, b: ObjectBag }\n',
  });
  assert.equal(r.exitCode, 1, r.output);
  assert.match(r.output, /object_bag|ObjectBag/);
});

test('a Balance stored as a dynamic field is caught', () => {
  const r = runAgainst({
    'v.move': `${HEAD}public struct V has key { id: UID }\npublic fun stash(v: &mut V, b: Balance<SUI>) { sui::dynamic_field::add(&mut v.id, 0u8, b) }\n`,
  });
  assert.equal(r.exitCode, 1, r.output);
  assert.match(r.output, /dynamic_field/);
});

test('a Coin stored as a dynamic object field is caught', () => {
  const r = runAgainst({
    'v.move': 'module splash_core::v;\nuse sui::coin::Coin;\nuse sui::sui::SUI;\nuse sui::dynamic_object_field as dof;\npublic struct V has key { id: UID }\npublic fun stash(v: &mut V, c: Coin<SUI>) { dof::add(&mut v.id, 0u8, c) }\n',
  });
  assert.equal(r.exitCode, 1, r.output);
  assert.match(r.output, /dynamic_object_field/);
});

test('a table of balances built in a function body is caught', () => {
  const r = runAgainst({
    'v.move': `${HEAD}use sui::table;\npublic fun open(ctx: &mut TxContext) { let t = table::new<address, Balance<SUI>>(ctx); transfer::public_transfer(t, @0x1) }\n`,
  });
  assert.equal(r.exitCode, 1, r.output);
  assert.match(r.output, /Balance/);
});

test('sharing a framework object, whose contents the source never has to name, is caught', () => {
  // `public_share_object` is how core would share a Table whose value type
  // was inferred. Core shares its own types with `share_object`.
  const r = runAgainst({
    'v.move': `${HEAD}use sui::table;\npublic fun open(b: Balance<SUI>, ctx: &mut TxContext) { let mut t = table::new(ctx); t.add(ctx.sender(), b); transfer::public_share_object(t) }\n`,
  });
  assert.equal(r.exitCode, 1, r.output);
  assert.match(r.output, /public_share_object/);
});

test('funds held at an object address and withdrawn from it are caught', () => {
  const r = runAgainst({
    'v.move': `${HEAD}use sui::balance;\npublic struct V has key { id: UID }\npublic fun take(v: &mut V, amount: u64): Balance<SUI> { balance::redeem_funds(balance::withdraw_funds_from_object(&mut v.id, amount)) }\n`,
  });
  assert.equal(r.exitCode, 1, r.output);
  assert.match(r.output, /withdraw_funds_from_object/);
});

test('an object received at a core object address is caught', () => {
  const r = runAgainst({
    'v.move': 'module splash_core::v;\nuse sui::coin::Coin;\nuse sui::sui::SUI;\nuse sui::transfer::Receiving;\npublic struct V has key { id: UID }\npublic fun take(v: &mut V, r: Receiving<Coin<SUI>>): Coin<SUI> { transfer::public_receive(&mut v.id, r) }\n',
  });
  assert.equal(r.exitCode, 1, r.output);
  assert.match(r.output, /Receiving|public_receive/);
});

test('a balance Supply, mint authority like a TreasuryCap, is caught', () => {
  const r = runAgainst({
    'v.move': 'module splash_core::v;\nuse sui::balance::Supply;\npublic struct X has drop {}\npublic struct V has key { id: UID, s: Supply<X> }\n',
  });
  assert.equal(r.exitCode, 1, r.output);
  assert.match(r.output, /Supply/);
});

test('a Kiosk, which holds its own Balance of profits, is caught', () => {
  const r = runAgainst({
    'v.move': 'module splash_core::v;\nuse sui::kiosk::Kiosk;\npublic struct V has key { id: UID, k: Kiosk }\n',
  });
  assert.equal(r.exitCode, 1, r.output);
  assert.match(r.output, /kiosk/i);
});

/** The modules the real sources compile to, by file name (they match today). */
const REAL_MODULES = readdirSync(path.resolve('move/splash_core/sources')).map((f) => path.basename(f, '.move'));

test('a compiled module is matched to the source that declares it, not to a file name', () => {
  const r = runAgainst(
    { 'extra.move': 'module splash_core::vault_free;\npublic struct V has key { id: UID, n: u64 }\n' },
    { build: [...REAL_MODULES, 'vault_free'] },
  );
  assert.equal(r.exitCode, 0, r.output);
});

test('a compiled module no source declares still fails the coverage cross-check', () => {
  const r = runAgainst({}, { build: [...REAL_MODULES, 'hidden'] });
  assert.equal(r.exitCode, 1, r.output);
  assert.match(r.output, /hidden/);
});

test('--require-build fails when there is no build to cross-check against', () => {
  // CI runs the check after `sui move build` with this flag, so a missing
  // build is a failure there rather than a quiet skip.
  const r = runAgainst({}, { args: ['--require-build'] });
  assert.equal(r.exitCode, 1, r.output);
  assert.match(r.output, /sui move build/);
});

test('the word Balance in a comment does not trip the check', () => {
  const r = runAgainst({
    'v.move': '/// This module deliberately holds no Balance<SUI> and no Coin<SUI>.\nmodule splash_core::v;\npublic struct V has key {\n    id: UID,\n    // not a Balance<SUI> field, just prose\n    n: u64,\n}\n',
  });
  assert.equal(r.exitCode, 0, 'comments are prose, not code');
});
