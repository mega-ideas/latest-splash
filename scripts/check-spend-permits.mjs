#!/usr/bin/env node
/**
 * splash_spend can never rotate a spender, its permits never leave it, and
 * the money it draws goes only into splash_core's settle path.
 *
 * `splash_spend` is the only code that can pull a business's funds under an
 * app-bound allowance (D2), and it publishes IMMUTABLE. Whoever holds
 * `SettingsPermit<SPLASH_SPEND>` can call `allowance::rotate_spender` on every
 * allowance bound to the app and point each one at a new spender; whoever holds
 * `SpendPermit<SPLASH_SPEND>`, or the `Balance` a spend returns, can take the
 * money without `SpendPolicy` ever being consulted. Sui's docs warn about the
 * first; the brief (§3.4) asks for a test that it cannot happen.
 *
 * A Move test cannot call a function that does not exist, so the guarantee is
 * checked on the source, on every build. The first version of this script was
 * regexes over comment-stripped text, and an adversarial review compiled seven
 * leaks past it (tests/spend-permits-check.test.mjs pins each one). This one
 * reads every `.move` file under sources/, RECURSIVELY as the compiler does,
 * with comments and string contents blanked by the Move lexer rules in
 * scripts/move-source.mjs (so b"//" and b"/*" hide nothing), and requires:
 *
 *   1. No renaming. No `use … as …` and no `use fun`, so every name below is
 *      the name the code calls. `allowance` is only ever sui::allowance and
 *      `internal` only std::internal, and the package declares no module with
 *      either name.
 *   2. `rotate_spender` appears nowhere: not qualified, not imported, not as a
 *      method call.
 *   3. No permit type is named anywhere: `Permit`, `SettingsPermit` and
 *      `SpendPermit` appear in no parameter, return, field, `let` or type
 *      argument. A permit cannot be stored, returned or written to an
 *      out-parameter without naming its type.
 *   4. `permit` is called exactly twice, each time as
 *      `internal::permit<SPLASH_SPEND>()` passed straight into
 *      `allowance::settings_permit(…)` as a whole argument of
 *      `allowance::issue(…)`, or straight into `allowance::spend_permit(…)` as
 *      a whole argument of `allowance::app_balance_spend(…)`. There is exactly
 *      one of each, and `issue`, `settings_permit`, `spend_permit` and
 *      `app_balance_spend` appear nowhere else, in any form.
 *   5. The function that calls `app_balance_spend` (draw, today) is private,
 *      returns a `Balance`, and binds the Balance to one name that it only
 *      returns, or reads with `.value()`.
 *   6. Every call of that function is `let x = draw(…);` with `x` then used
 *      exactly once, as a whole argument of a `payment_intent::…_from_app`
 *      settle call, or is itself a whole argument of one. And every such settle
 *      call is handed money that way, so the witness never settles funds a
 *      caller brought.
 *   7. `SettleWitness {}` is built only as the first argument of a
 *      `payment_intent::…_for_app` or `…_from_app` call. The name appears
 *      nowhere else but its declaration and those calls' type arguments, so it
 *      is never bound, returned, stored or taken as a parameter.
 *   8. No `public`, `public(package)` or `entry` function returns a `Balance`;
 *      no function returns a `Coin` except beside a `BridgeObligation`; no
 *      function takes `&mut` of anything holding a `Balance` or a `Coin` except
 *      the `Allowance` itself.
 *   9. `SPLASH_SPEND` and `SettleWitness` are each declared once with exactly
 *      `drop`, and `SPLASH_SPEND` is never constructed.
 *  10. No function is generic over a type parameter with `drop`, through
 *      which a witness could be passed on.
 *
 * WHAT IT DOES NOT CATCH. It reads text: it does not compile, resolve types or
 * follow a value through anything but the shapes above, so it cannot see
 *   - a mistake in what draw() checks (the Move tests do that);
 *   - anything splash_core does with the witness or the money once handed it;
 *   - code the compiler generates or inlines from a dependency;
 *   - a difference between this source and the bytecode actually published.
 *     At the mainnet ceremony the on-chain modules must be compared with a
 *     build of the audited commit.
 * Where it cannot follow a form (an alias, a method call it cannot resolve, a
 * call in a shape not listed) it fails rather than pass. If a legitimate
 * change trips it, restructure the change; do not add an exception here.
 *
 * Run by `npm run lint`, and by .github/workflows/core-invariant.yml.
 */
import path from 'node:path';

import {
  MoveLexError,
  calls,
  closing,
  datatypes,
  enclosing,
  functions,
  lineOf,
  modules,
  moveFiles,
  parameters,
  readMove,
  squash,
  tokens,
  uses,
} from './move-source.mjs';

const SOURCES = process.env.SPEND_SOURCES ?? 'move/splash_spend/sources';

/** Optional `sui::` / `0x2::`, then `allowance::`. */
const ALLOWANCE = String.raw`(?:(?:sui|0x0*2)\s*::\s*)?allowance\s*::\s*`;
/** The two permit expressions, squashed, with framework prefixes removed. */
const SETTINGS_PERMIT = 'allowance::settings_permit(internal::permit<SPLASH_SPEND>())';
const SPEND_PERMIT = 'allowance::spend_permit(internal::permit<SPLASH_SPEND>())';
/** splash_core's app entry points: create*_for_app and settle*_from_app. */
const CORE_APP = String.raw`(?:\w+\s*::\s*)?payment_intent\s*::\s*\w+_(?:for|from)_app`;
const CORE_SETTLE = String.raw`(?:\w+\s*::\s*)?payment_intent\s*::\s*\w+_from_app`;
const PERMIT_TYPES = ['Permit', 'SettingsPermit', 'SpendPermit'];
/** `let x =` or `let mut x: T =` at the end of the text before a call. */
const LET_BINDING = /\blet\s+(?:mut\s+)?([A-Za-z_]\w*)\s*(?::[^=;]*)?=\s*$/d;

/** An expression squashed, with `sui::`/`0x2::`/`std::`/`0x1::` prefixes dropped. */
function canonical(text) {
  return squash(text).replace(/(?<![\w:])(?:sui|std|0x0*[12])::/g, '');
}

const failures = [];
const fail = (unit, index, message) => failures.push(`${unit.file}:${lineOf(unit.raw, index)}: ${message}`);

let files;
try {
  files = moveFiles(SOURCES);
} catch {
  console.error(`FAIL: ${SOURCES} does not exist. splash_spend is the only spender of app-bound allowances; it cannot be missing.`);
  process.exit(1);
}
if (files.length === 0) {
  console.error(`FAIL: no Move sources in ${SOURCES}.`);
  process.exit(1);
}

const units = [];
for (const file of files) {
  try {
    const unit = readMove(file);
    unit.file = path.normalize(file);
    unit.fns = functions(unit.code);
    unit.types = datatypes(unit.code);
    units.push(unit);
  } catch (error) {
    if (!(error instanceof MoveLexError)) throw error;
    failures.push(`${error.message}. The check cannot read what the compiler would.`);
  }
}

const count = (name) => units.reduce((n, u) => n + tokens(u.code, name).length, 0);

// 1. No renaming, and the two framework modules are the framework's.
for (const unit of units) {
  for (const u of uses(unit.code)) {
    if (u.fun) {
      fail(unit, u.index, `\`use ${u.path}\`: a use fun alias makes a method call reach a function this check cannot follow.`);
      continue;
    }
    if (u.alias) fail(unit, u.index, `\`use ${u.path} as ${u.alias}\`: nothing in splash_spend is imported under another name.`);
    const [address, module] = u.path.split('::');
    if (module === 'allowance' && !/^(?:sui|0x0*2)$/.test(address)) fail(unit, u.index, `\`use ${u.path}\` is not sui::allowance.`);
    if (module === 'internal' && !/^(?:std|0x0*1)$/.test(address)) fail(unit, u.index, `\`use ${u.path}\` is not std::internal.`);
  }
  for (const m of modules(unit.code)) {
    if (m.name === 'allowance' || m.name === 'internal') {
      fail(unit, m.index, `module ${m.address}::${m.name} would shadow the framework's \`${m.name}\`.`);
    }
  }
}

// 2. No spender rotation, by any route.
for (const unit of units) {
  for (const at of tokens(unit.code, 'rotate_spender')) {
    fail(unit, at, 'mentions `rotate_spender`. splash_spend must never rotate a spender.');
  }
}

// 3. No permit type is ever named.
for (const unit of units) {
  for (const fn of unit.fns) {
    if (PERMIT_TYPES.some((t) => tokens(fn.returns, t).length)) {
      fail(unit, fn.index, `\`${fn.name}\` returns a permit (${fn.returns}).`);
    }
  }
  for (const type of PERMIT_TYPES) {
    for (const at of tokens(unit.code, type)) {
      fail(unit, at, `names \`${type}\`. A permit is only ever created and consumed inside one expression.`);
    }
  }
}

// 4. The two permits, where they go, and nowhere else.
const permitCalls = count('permit');
if (permitCalls !== 2) {
  failures.push(`${SOURCES}: internal::permit is called ${permitCalls} time(s); exactly 2 are allowed (issue and app_balance_spend).`);
}
for (const [name, expected] of [
  ['settings_permit', 1],
  ['spend_permit', 1],
  ['issue', 1],
  ['app_balance_spend', 1],
]) {
  const found = count(name);
  if (found !== expected) {
    failures.push(`${SOURCES}: \`${name}\` appears ${found} time(s); exactly ${expected} is allowed, in the one permitted call.`);
  }
}
let issueThroughSettings = 0;
let spendThroughSpendPermit = 0;
let spendCall = null;
for (const unit of units) {
  for (const call of calls(unit.code, `${ALLOWANCE}issue\\b`)) {
    issueThroughSettings += call.args.filter((a) => canonical(a.text) === SETTINGS_PERMIT).length;
  }
  for (const call of calls(unit.code, `${ALLOWANCE}app_balance_spend\\b`)) {
    const n = call.args.filter((a) => canonical(a.text) === SPEND_PERMIT).length;
    spendThroughSpendPermit += n;
    if (n) spendCall = { unit, call };
  }
}
if (issueThroughSettings !== 1) {
  failures.push(`${SOURCES}: expected exactly one allowance::issue(… allowance::settings_permit(internal::permit<SPLASH_SPEND>()) …), found ${issueThroughSettings}.`);
}
if (spendThroughSpendPermit !== 1) {
  failures.push(`${SOURCES}: expected exactly one allowance::app_balance_spend(… allowance::spend_permit(internal::permit<SPLASH_SPEND>()) …), found ${spendThroughSpendPermit}.`);
}

// 5. The function that spends: private, returns the Balance and nothing else.
let spendFn = null;
if (spendCall) {
  const { unit, call } = spendCall;
  spendFn = enclosing(unit.fns, call.index);
  if (!spendFn) {
    fail(unit, call.index, 'app_balance_spend is called outside any function body.');
  } else {
    spendFn.unit = unit;
    const kinds = [spendFn.visibility, spendFn.entry ? 'entry' : '', spendFn.macro ? 'macro' : ''].filter(Boolean);
    if (kinds.length) {
      fail(unit, spendFn.index, `\`${spendFn.name}\` calls app_balance_spend and is \`${kinds.join(' ')}\`. It must be a private \`fun\`.`);
    }
    if (!/^(?:(?:sui|0x0*2)\s*::\s*)?(?:balance\s*::\s*)?Balance\s*</.test(spendFn.returns)) {
      fail(unit, spendFn.index, `\`${spendFn.name}\` calls app_balance_spend and returns \`${spendFn.returns || 'nothing'}\`, not the Balance.`);
    }
    const offset = spendFn.bodyStart + 1;
    const bodyText = unit.code.slice(offset, spendFn.bodyEnd);
    const lead = unit.code.slice(offset, call.index);
    const bound = LET_BINDING.exec(lead);
    const tailIsCall = /^\s*$/.test(unit.code.slice(call.end, spendFn.bodyEnd)) && /(?:^|[;{}])\s*$/.test(lead);
    if (bound) {
      const name = bound[1];
      const binding = offset + bound.indices[1][0];
      const seen = tokens(bodyText, name).map((i) => i + offset);
      const tail = seen.filter((i) => /^\s*$/.test(unit.code.slice(i + name.length, spendFn.bodyEnd)));
      for (const at of seen) {
        if (at === binding) continue;
        if (tail.includes(at)) continue;
        if (/^\s*\.\s*value\s*\(\s*\)/.test(unit.code.slice(at + name.length))) continue;
        fail(unit, at, `\`${name}\`, the Balance app_balance_spend returned, is used other than returned or read with .value().`);
      }
      if (tail.length !== 1) fail(unit, spendFn.index, `\`${spendFn.name}\` must end by returning \`${name}\`, the Balance it drew.`);
    } else if (!tailIsCall) {
      fail(unit, call.index, 'the Balance app_balance_spend returns is neither bound with `let` nor returned directly.');
    }
  }
}

// 6. Where that Balance goes: only into a settle call, and every settle call
//    is handed it.
let settleCalls = 0;
{
  const name = spendFn?.name ?? null;
  for (const unit of units) {
    const settles = calls(unit.code, CORE_SETTLE);
    /** The settle call that takes code[start, end) as one whole argument, or null. */
    const settleTaking = (start, end) =>
      settles.find((c) => c.args.some((a) => a.start === start && a.end === end)) ?? null;
    /** The end (exclusive) of the call of `name` at `at`, or -1 if it is not a call. */
    const callEnd = (at) => {
      const m = /^\s*(?:<[^<>]*(?:<[^<>]*>[^<>]*)*>)?\s*\(/.exec(unit.code.slice(at + name.length));
      if (!m) return -1;
      const close = closing(unit.code, at + name.length + m[0].length - 1);
      return close === -1 ? -1 : close + 1;
    };

    // Every call of the spend function. It is private, so only its own module
    // can call it.
    if (name && unit === spendFn.unit) {
      for (const at of tokens(unit.code, name)) {
        const fnHere = enclosing(unit.fns, at);
        if (!fnHere) {
          if (at > spendFn.index && at < spendFn.paramsStart) continue; // its declaration
          fail(unit, at, `\`${name}\` is named outside a function body.`);
          continue;
        }
        const end = callEnd(at);
        if (end === -1 || /[.:]\s*$/.test(unit.code.slice(Math.max(0, at - 4), at))) {
          fail(unit, at, `\`${name}\` is referenced other than as a direct call.`);
          continue;
        }
        if (settleTaking(at, end)) {
          settleCalls += 1;
          continue;
        }
        const bound = LET_BINDING.exec(unit.code.slice(fnHere.bodyStart + 1, at));
        if (!bound) {
          fail(unit, at, `\`${fnHere.name}\` calls \`${name}\` and does not hand the Balance straight to splash_core's settle.`);
          continue;
        }
        const local = bound[1];
        const offset = fnHere.bodyStart + 1;
        const seen = tokens(unit.code.slice(offset, fnHere.bodyEnd), local).map((i) => i + offset);
        const before = seen.filter((i) => i < at);
        const later = seen.filter((i) => i > at);
        const intoSettle = later.filter((i) => settleTaking(i, i + local.length));
        if (before.length !== 1 || later.length !== 1 || intoSettle.length !== 1) {
          fail(unit, at, `\`${fnHere.name}\` binds the Balance \`${name}\` returns to \`${local}\` and does not pass it, once and whole, to splash_core's settle.`);
          continue;
        }
        settleCalls += 1;
      }
    }

    // Every settle call is handed the drawn Balance, so the witness never
    // settles money a caller brought.
    for (const settle of settles) {
      const fnHere = enclosing(unit.fns, settle.index);
      const drawn =
        name &&
        unit === spendFn.unit &&
        fnHere &&
        settle.args.some((a) => {
          if (a.text.startsWith(name) && callEnd(a.start) === a.end) return true;
          if (!/^[A-Za-z_]\w*$/.test(a.text)) return false;
          const lead = unit.code.slice(fnHere.bodyStart + 1, settle.index);
          return new RegExp(String.raw`\blet\s+(?:mut\s+)?${a.text}\s*(?::[^=;]*)?=\s*${name}\b`).test(lead);
        });
      if (!drawn) {
        fail(unit, settle.index, `\`${fnHere?.name ?? '(outside a function)'}\` settles through splash_core with money that did not come from \`${name ?? 'the one function that spends'}\`.`);
      }
    }
  }
}

// 7. Where SettleWitness is built, and nowhere else.
let witnessUses = 0;
for (const unit of units) {
  const allowed = [];
  for (const call of calls(unit.code, CORE_APP)) {
    if (call.typeArgs) allowed.push([call.typeArgs.start, call.typeArgs.end]);
    const first = call.args[0];
    if (first && squash(first.text) === 'SettleWitness{}') {
      allowed.push([first.start, first.end]);
      witnessUses += 1;
    }
  }
  const declarations = unit.types.filter((t) => t.name === 'SettleWitness').map((t) => [t.index, t.end]);
  const inside = (i, ranges) => ranges.some(([a, b]) => i >= a && i < b);
  for (const fn of unit.fns) {
    if (tokens(fn.returns, 'SettleWitness').length) fail(unit, fn.index, `\`${fn.name}\` returns the settlement witness.`);
  }
  for (const at of tokens(unit.code, 'SettleWitness')) {
    if (inside(at, declarations) || inside(at, allowed)) continue;
    fail(unit, at, 'SettleWitness is named here. SettleWitness {} is constructed only as the first argument of a splash_core app entry point.');
  }
}

// 8. What a function may hand back, and what it may write into.
for (const unit of units) {
  for (const fn of unit.fns) {
    const exposed = fn.visibility !== '' || fn.entry;
    if (exposed && /\bBalance\s*</.test(fn.returns)) {
      fail(unit, fn.index, `\`${fn.name}\` is ${[fn.visibility, fn.entry ? 'entry' : ''].filter(Boolean).join(' ')} and returns a Balance (${fn.returns}).`);
    }
    if (/\bCoin\s*</.test(fn.returns) && !/\bBridgeObligation\b/.test(fn.returns)) {
      fail(unit, fn.index, `\`${fn.name}\` returns a Coin without a BridgeObligation (${fn.returns}).`);
    }
    for (const p of parameters(fn.params)) {
      const type = p.type.replace(/\s+/g, ' ');
      if (!/^&\s*mut\b/.test(type) || !/\b(?:Balance|Coin)\s*</.test(type)) continue;
      if (/^&\s*mut\s+(?:\w+\s*::\s*)*Allowance\s*</.test(type)) continue;
      fail(unit, fn.index, `\`${fn.name}\` takes \`${p.name}: ${type}\`, somewhere the drawn money could be written.`);
    }
    // 10. No witness passthrough.
    if (fn.typeParameters.some((t) => t.constraints.has('drop'))) {
      fail(unit, fn.index, `\`${fn.name}${fn.generics}\` is generic over a droppable type it could pass a witness through.`);
    }
  }
}

// 9. The two marker types.
for (const name of ['SPLASH_SPEND', 'SettleWitness']) {
  const found = units.flatMap((unit) => unit.types.filter((t) => t.name === name).map((t) => ({ unit, t })));
  if (found.length === 0) {
    failures.push(`${SOURCES}: no \`public struct ${name}\` found; this check cannot verify what it claims to.`);
  } else if (found.length > 1) {
    failures.push(`${SOURCES}: \`${name}\` is declared ${found.length} times.`);
  }
  for (const { unit, t } of found) {
    const abilities = [...t.abilities].sort().join(', ');
    if (abilities !== 'drop') fail(unit, t.index, `${name} must have exactly \`drop\` (has ${abilities || 'none'}).`);
  }
}
for (const unit of units) {
  const declarations = unit.types.filter((t) => t.name === 'SPLASH_SPEND').map((t) => [t.index, t.end]);
  for (const at of tokens(unit.code, 'SPLASH_SPEND')) {
    if (declarations.some(([a, b]) => at >= a && at < b)) continue;
    if (/^\s*\(/.test(unit.code.slice(at + 'SPLASH_SPEND'.length))) {
      fail(unit, at, 'SPLASH_SPEND is constructed. The app type is never packed.');
    }
  }
}

if (failures.length > 0) {
  console.error('\n  splash_spend would leak spending authority:\n');
  for (const f of failures) console.error(`  • ${f}\n`);
  console.error('  splash_spend publishes immutable. A permit or a Balance that escapes it is\n  escaped for ever. Do not add an exception to this script.\n');
  process.exit(1);
}

console.log(
  `splash_spend keeps its permits: no rotate_spender, 2 permit calls (issue, app_balance_spend), ` +
    `the drawn Balance goes only to splash_core's settle (${settleCalls} call(s)), ` +
    `${witnessUses} witness use(s) all passed straight to splash_core, across ${units.length} module file(s).`,
);
