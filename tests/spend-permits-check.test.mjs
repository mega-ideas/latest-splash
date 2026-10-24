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
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const CHECKER = path.resolve('scripts/check-spend-permits.mjs');
const REAL = path.resolve('move/splash_spend/sources');
const MODULE = 'splash_spend.move';

/**
 * Run the checker over a copy of the sources with `edit` applied to
 * splash_spend.move, and `extra` written beside it (paths relative to
 * sources/, subdirectories created).
 */
function runWith(edit, extra = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'splash-spend-permits-'));
  try {
    cpSync(REAL, dir, { recursive: true });
    const file = path.join(dir, MODULE);
    const before = readFileSync(file, 'utf8');
    const after = edit(before);
    if (edit !== keep) assert.notEqual(after, before, 'the planted edit did not change the source');
    writeFileSync(file, after);
    for (const [relative, contents] of Object.entries(extra)) {
      const full = path.join(dir, relative);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, contents);
    }
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

test('returning a Coin is caught', () => {
  const r = runWith(
    plant(`public fun out<C>(c: sui::coin::Coin<C>): sui::coin::Coin<C> { c }`),
  );
  assert.equal(r.exitCode, 1);
  assert.match(r.output, /returns a Coin/);
});

// v2 review: the spending-rule path pays only on Sui, so no function may hand
// the business's coin back, not even beside a BridgeObligation (the removed
// pay_intent_cross_chain did, and a by-reference adapter could keep it).
test('returning a Coin beside a BridgeObligation is caught too', () => {
  const r = runWith(
    plant(`public fun out2<C>(c: sui::coin::Coin<C>, o: splash_core::payment_intent::BridgeObligation): (sui::coin::Coin<C>, splash_core::payment_intent::BridgeObligation) { (c, o) }`),
  );
  assert.equal(r.exitCode, 1, r.output);
  assert.match(r.output, /out2/);
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

// ─── Bypasses an adversarial review compiled past the first version ─────────
//
// Each one built with Sui CLI 1.82.3 and the check still printed "keeps its
// permits". The check read text with regexes: it saw no data flow, only
// return types, only `internal::permit` spelled out, no method calls, no
// string literals, no function that did not start its line, and no
// subdirectory.

/** The arguments draw() takes after the allowance and withdrawal. */
const DRAW_ARGS = 'intent, account, policy, option::none(), clock, ctx';
const DRAW_PARAMS = `allowance: &mut Allowance<Balance<C>>,
    withdrawal: AllowanceWithdrawal<Balance<C>>,
    intent: &PaymentIntent,
    account: &BusinessAccount,
    policy: &SpendPolicy,
    clock: &Clock,
    ctx: &mut TxContext,`;

test('a public function that sends the drawn Balance anywhere but splash_core is caught', () => {
  const r = runWith(
    plant(`public fun pay_me<C>(
    ${DRAW_PARAMS}
) {
    let funds = draw(allowance, withdrawal, ${DRAW_ARGS});
    sui::balance::send_funds(funds, ctx.sender());
}`),
  );
  assert.equal(r.exitCode, 1, r.output);
  assert.match(r.output, /pay_me/);
});

test('a &mut out-parameter filled with a settings permit through an aliased std::internal is caught', () => {
  const r = runWith(
    plant(`use std::internal as i;
public fun lend(out: &mut Option<allowance::SettingsPermit<SPLASH_SPEND>>) {
    out.fill(allowance::settings_permit(i::permit<SPLASH_SPEND>()));
}`),
  );
  assert.equal(r.exitCode, 1, r.output);
  assert.match(r.output, /as i|SettingsPermit|permit is called/);
});

test('a rotate_spender between b"/*" and b"*/" constants is caught', () => {
  const r = runWith(
    plant(`const OPEN: vector<u8> = b"/*";
public fun rot<T>(a: &mut Allowance<T>, to: address) {
    allowance::rotate_spender(a, allowance::settings_permit(internal::permit<SPLASH_SPEND>()), to)
}
const CLOSE: vector<u8> = b"*/";`),
  );
  assert.equal(r.exitCode, 1, r.output);
  assert.match(r.output, /rotate_spender/);
});

test('a rotate_spender after b"//" on the same line is caught', () => {
  const r = runWith(
    plant(
      'public fun rot2<T>(a: &mut Allowance<T>, to: address) { let _tag = b"//"; allowance::rotate_spender(a, allowance::settings_permit(std::internal::permit<SPLASH_SPEND>()), to) }',
    ),
  );
  assert.equal(r.exitCode, 1, r.output);
  assert.match(r.output, /rotate_spender/);
});

test('a public function written after an attribute on the same line is still read', () => {
  const r = runWith(plant('#[allow(unused_variable)] public fun skim<C>(b: Balance<C>): Balance<C> { b }'));
  assert.equal(r.exitCode, 1, r.output);
  assert.match(r.output, /skim/);
  assert.match(r.output, /returns a Balance/);
});

test('a module in a subdirectory of sources/ is read, as the compiler reads it', () => {
  const r = runWith(keep, {
    'inner/evil.move': `module splash_spend::evil;

use sui::allowance::{Self, Allowance};

public fun rot<T>(a: &mut Allowance<T>, to: address) {
    allowance::rotate_spender(a, allowance::settings_permit(std::internal::permit<SPLASH_SPEND>()), to)
}
`,
  });
  assert.equal(r.exitCode, 1, r.output);
  assert.match(r.output, /inner[\\/]evil\.move/);
  assert.match(r.output, /rotate_spender/);
});

test('an aliased std::internal and a method-call app_balance_spend in a public drain are caught', () => {
  const r = runWith(
    plant(`use std::internal as intl;
public fun drain<C>(a: &mut Allowance<Balance<C>>, w: AllowanceWithdrawal<Balance<C>>, clock: &Clock, ctx: &mut TxContext) {
    let b = a.app_balance_spend(allowance::spend_permit(intl::permit<SPLASH_SPEND>()), w, clock, ctx);
    sui::balance::send_funds(b, ctx.sender());
}`),
  );
  assert.equal(r.exitCode, 1, r.output);
  assert.match(r.output, /drain|app_balance_spend/);
});

test('the witness settling money the caller brought, not money drawn under a rule, is caught', () => {
  const r = runWith(
    plant(`public fun settle_any<C>(
    intent: &mut PaymentIntent,
    account: &mut BusinessAccount,
    config: &ComplianceConfig,
    funds: Balance<C>,
    clock: &Clock,
    ctx: &mut TxContext,
): SettleReceipt {
    payment_intent::settle_from_app<C, SettleWitness>(SettleWitness {}, intent, account, config, funds, 0, clock, ctx)
}`),
  );
  assert.equal(r.exitCode, 1, r.output);
  assert.match(r.output, /settle_any/);
});

test('a use fun alias that reaches draw() as a method is caught', () => {
  const r = runWith(
    plant(`use fun draw as Allowance.pull;
public fun yank<C>(
    ${DRAW_PARAMS}
) {
    let funds = allowance.pull(withdrawal, ${DRAW_ARGS});
    sui::balance::send_funds(funds, ctx.sender());
}`),
  );
  assert.equal(r.exitCode, 1, r.output);
  assert.match(r.output, /use fun/);
});

test('a &mut Balance out-parameter that the drawn money is joined into is caught', () => {
  const r = runWith(
    plant(`public fun pour<C>(
    out: &mut Balance<C>,
    ${DRAW_PARAMS}
) {
    out.join(draw(allowance, withdrawal, ${DRAW_ARGS}));
}`),
  );
  assert.equal(r.exitCode, 1, r.output);
  assert.match(r.output, /pour/);
});

test('a witness passthrough whose drop is not the first constraint is caught', () => {
  const r = runWith(plant('public fun pass<W: store + drop>(w: W): W { w }'));
  assert.equal(r.exitCode, 1, r.output);
  assert.match(r.output, /generic over a droppable type/);
});

// Found by the independent check of the hardened script: "splash_core's
// settle path" was any `payment_intent::*_from_app`, so a module of
// splash_spend's own named payment_intent could take the drawn Balance.
test("a splash_spend module named payment_intent, standing in for core's, is caught", () => {
  const r = runWith(
    (s) => s.replace(
      'use splash_core::payment_intent::{Self, PaymentIntent, SettleReceipt};',
      'use splash_core::payment_intent::{PaymentIntent, SettleReceipt};\nuse splash_spend::payment_intent;',
    ),
    {
      'payment_intent.move': `module splash_spend::payment_intent;
use sui::balance::Balance;
public fun settle_from_app<C, W>(_w: W, funds: Balance<C>) {
    sui::balance::send_funds(funds, @0xBAD);
}
`,
    },
  );
  assert.equal(r.exitCode, 1, r.output);
  assert.match(r.output, /payment_intent/);
});

test('reading the drawn amount before returning it is allowed', () => {
  // A check inside draw() that reads the Balance is not a leak; the
  // hardened rules must not push anyone into rewriting a safe draw.
  const r = runWith((s) =>
    s.replace(
      /\n([ \t]*)funds\r?\n\}/,
      '\n$1assert!(funds.value() == payment_intent::amount_usd(intent), E_OVER_PER_PAYMENT_MAX);\n$1funds\n}',
    ),
  );
  assert.equal(r.exitCode, 0, r.output);
});
