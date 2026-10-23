/**
 * Regression guard for scripts/check-spend-permits.mjs.
 *
 * That script is the brief's "test that greps/asserts" that splash_spend can
 * never rotate a spender and never lets its permits out (§3.4). splash_spend
 * publishes immutable, so a leak that ships is a leak for ever. Each case below
 * plants one leak into a copy of the real sources and requires the check to
 * fail on it; the first requires the real sources to pass.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const CHECKER = path.resolve('scripts/check-spend-permits.mjs');
const REAL = path.resolve('move/splash_spend/sources');
const MODULE = 'splash_spend.move';

/** Run the checker over a copy of the sources with `edit` applied to splash_spend.move. */
function runWith(edit) {
  const dir = mkdtempSync(path.join(tmpdir(), 'splash-spend-permits-'));
  try {
    cpSync(REAL, dir, { recursive: true });
    const file = path.join(dir, MODULE);
    const before = readFileSync(file, 'utf8');
    const after = edit(before);
    if (edit !== keep) assert.notEqual(after, before, 'the planted edit did not change the source');
    writeFileSync(file, after);
    try {
      const out = execFileSync(process.execPath, [CHECKER], { env: { ...process.env, SPEND_SOURCES: dir }, stdio: 'pipe' });
      return { exitCode: 0, output: String(out) };
    } catch (error) {
      return { exitCode: error.status ?? 1, output: String(error.stderr ?? '') };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const keep = (s) => s;

/** Append a function to the module. */
const plant = (fn) => (s) => `${s}\n${fn}\n`;

test('the real splash_spend passes', () => {
  const r = runWith(keep);
  assert.equal(r.exitCode, 0, r.output);
});

test('a rotate_spender call is caught', () => {
  const r = runWith(
    plant(`public fun rotate<T>(a: &mut sui::allowance::Allowance<T>, to: address) {
    sui::allowance::rotate_spender(a, sui::allowance::settings_permit(std::internal::permit<SPLASH_SPEND>()), to)
}`),
  );
  assert.equal(r.exitCode, 1);
  assert.match(r.output, /rotate_spender/);
});

test('a function returning a settings permit is caught', () => {
  const r = runWith(
    plant(`public fun leak(): sui::allowance::SettingsPermit<SPLASH_SPEND> {
    sui::allowance::settings_permit(std::internal::permit<SPLASH_SPEND>())
}`),
  );
  assert.equal(r.exitCode, 1);
  assert.match(r.output, /returns a permit|permit is called/);
});

test('a third internal::permit call is caught even when it is not returned', () => {
  const r = runWith(
    plant(`fun quiet() {
    let _p = std::internal::permit<SPLASH_SPEND>();
}`),
  );
  assert.equal(r.exitCode, 1);
  assert.match(r.output, /called 3 time/);
});

test('making the spend helper public is caught', () => {
  const r = runWith((s) => s.replace('\nfun draw<C>(', '\npublic fun draw<C>('));
  assert.equal(r.exitCode, 1);
  assert.match(r.output, /calls app_balance_spend and is `public`/);
});

test('a public function returning a Balance is caught', () => {
  const r = runWith(
    plant(`public fun skim<C>(b: sui::balance::Balance<C>): sui::balance::Balance<C> { b }`),
  );
  assert.equal(r.exitCode, 1);
  assert.match(r.output, /returns a Balance/);
});

test('returning a Coin without a bridge obligation is caught', () => {
  const r = runWith(
    plant(`public fun out<C>(c: sui::coin::Coin<C>): sui::coin::Coin<C> { c }`),
  );
  assert.equal(r.exitCode, 1);
  assert.match(r.output, /returns a Coin without a BridgeObligation/);
});

test('handing out the settlement witness is caught', () => {
  const r = runWith(plant(`public fun witness(): SettleWitness { SettleWitness {} }`));
  assert.equal(r.exitCode, 1);
  assert.match(r.output, /returns the settlement witness|SettleWitness \{\} is constructed/);
});

test('a generic witness passthrough is caught', () => {
  const r = runWith(plant(`public fun pass<W: drop>(w: W): W { w }`));
  assert.equal(r.exitCode, 1);
  assert.match(r.output, /generic over a droppable type/);
});

test('giving the witness copy is caught', () => {
  const r = runWith((s) => s.replace('public struct SettleWitness has drop {}', 'public struct SettleWitness has copy, drop {}'));
  assert.equal(r.exitCode, 1);
  assert.match(r.output, /SettleWitness must have exactly `drop`/);
});

test('a comment cannot hide a leak or fake a pass', () => {
  // A leak inside a comment is not a leak; a real one after it still is.
  const r = runWith(
    plant(`// public fun rotate_spender_doc() {}
public fun skim<C>(b: sui::balance::Balance<C>): sui::balance::Balance<C> { b }`),
  );
  assert.equal(r.exitCode, 1);
  assert.doesNotMatch(r.output, /mentions `rotate_spender`/);
  assert.match(r.output, /returns a Balance/);
});
