#!/usr/bin/env node
/**
 * THE CORE INVARIANT — splash_core cannot hold client funds.
 *
 * Splash is not licensed to hold client money, and holds none.
 * The weak way to honour that is a runtime gate: a `LicenceState` object and an
 * `assert_custody_permitted` in every custodial function. That works until
 * someone forgets the assert, and it forces an auditor to trace every call site
 * before they can believe the claim.
 *
 * The strong way — the one this script enforces — is that the published package
 * contains NO PLACE CAPABLE OF HOLDING VALUE. Not gated. Absent. Client value
 * exists only as a `Coin<T>` or `Balance<T>` parameter that enters and exits a
 * `payment_intent` settle path within a single PTB; there is no object to
 * accumulate into.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * REWRITTEN 2026-08-17 after an adversarial review DEFEATED the first version,
 * and HARDENED 2026-10-24 after a second review walked past the rewrite.
 *
 * v1 matched `^\s*<name>\s*:\s*<Type>\s*<` — field name and unwrapped type at
 * the start of one physical line. A reviewer compiled a complete client omnibus
 * into splash_core while v1 reported "invariant holds": nested containers,
 * aliased imports, fields split across lines, one-line structs, and anything
 * under `sources/<subdir>/`.
 *
 * v2 found a struct by the word `struct` and took the next `{`. A positional
 * struct `Pot(Balance<T>)` borrowed the NEXT struct's braces, an `enum` never
 * matched, a generic `Holder<V: store> { v: V }` names no value type until a
 * function instantiates it, and a Bag or a dynamic field holds a Balance that
 * no struct body mentions. All compiled; v2 passed them.
 *
 * A control that the thing it forbids can walk straight past is worse than no
 * control, because it is quoted as evidence.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * WHAT THIS CHECKS, on every `.move` file under sources/ (recursively, as the
 * compiler reads them), with comments and string contents blanked by the Move
 * lexer rules in scripts/move-source.mjs, and every value type matched under
 * any local `use … as` alias:
 *
 *   1. No struct or enum body names a value type (Balance, Coin, TreasuryCap,
 *      balance::Supply), at any nesting depth: named-field, positional and
 *      enum-variant bodies alike, on one line or many.
 *   2. No `key` or `store` struct or enum has a non-phantom type parameter
 *      without `copy` or `drop` that it uses in its body. Such a holder takes a
 *      Balance the moment a function instantiates it, and no value type is
 *      named. (`copy` or `drop` rules it out: a Balance, and anything holding
 *      one, has neither.)
 *   3. No value type appears inside another type's type arguments anywhere in
 *      the code, functions included: `table::new<address, Balance<SUI>>()`,
 *      `vector<Coin<T>>`, `Option<Balance<T>>`.
 *   4. Nothing that stores values of a type the source never has to name, or
 *      that holds value of its own: the modules bag, object_bag,
 *      dynamic_field, dynamic_object_field, versioned, kiosk, transfer_policy
 *      and token, and the types Bag, ObjectBag, Versioned, Kiosk,
 *      KioskOwnerCap, TransferPolicy, TransferPolicyCap and TokenPolicy.
 *   5. Nothing that takes in value sent to an object's own address:
 *      `withdraw_funds_from_object`, `Receiving`, `transfer::receive` and
 *      `public_receive`. And no `public_share_object`: core shares its own
 *      types with `share_object`, so this only ever shares a framework object,
 *      such as a Table whose contents were inferred.
 *   6. Coverage: when a build exists, every compiled module is one a scanned
 *      source declares (matched by its `module` declaration, not its file
 *      name). `--require-build` makes a missing build a failure; the Move CI
 *      workflow runs the check that way after `sui move build`.
 *
 * WHAT IT DOES NOT CATCH. It reads text; it does not compile or resolve types.
 *   - A value type reached only through type inference inside a function and
 *     never spelled (rules 4 and 5 close the ways core could keep one).
 *   - A framework type that holds value internally and is not listed in rule 4.
 *   - Where money is SENT: a payment to the wrong address, an operator's
 *     address included, is not custody by this package and is not seen here.
 *   - A difference between this source and the bytecode published; the
 *     ceremony compares the on-chain modules with a build of the audited
 *     commit.
 * If a legitimate change trips it, move the struct to move/splash_custody or
 * restructure; do not add an exception here.
 */
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { MoveLexError, datatypes, lineOf, modules, moveFiles, readMove, tokens, uses } from './move-source.mjs';

const CORE_SOURCES = path.join('move', 'splash_core', 'sources');
const CORE_BYTECODE = path.join('move', 'splash_core', 'build', 'splash_core', 'bytecode_modules');
const CORE_TESTS = path.join('move', 'splash_core', 'tests');
const REQUIRE_BUILD = process.argv.includes('--require-build');

/**
 * Types that can hold or mint value. Matched anywhere inside a struct or enum
 * body, and inside any other type's type arguments, so
 * `Table<address, Balance<SUI>>` is caught by the inner type.
 */
const VALUE_TYPES = [
  { name: 'Balance', why: 'a Balance accumulates value across transactions — that is custody' },
  { name: 'Coin', why: 'a Coin passed as a PARAMETER is the non-custodial path; a Coin stored in a struct outlives the transaction and is custody' },
  { name: 'TreasuryCap', why: 'mint authority does not belong in the non-custodial core package' },
  { name: 'Supply', why: 'a balance::Supply is mint authority, like a TreasuryCap' },
];

/** Framework modules and types that store values core would not have to name, or hold value themselves. */
const FORBIDDEN_MODULES = {
  bag: 'a Bag holds values of any type, a Balance included, with none named in a struct',
  object_bag: 'an ObjectBag holds objects of any type, a Coin included',
  dynamic_field: 'a dynamic field stores a value under an object without any struct naming its type',
  dynamic_object_field: 'a dynamic object field stores an object, a Coin included, under another',
  versioned: 'a Versioned stores any value as a dynamic field',
  kiosk: 'a Kiosk holds a Balance of profits and the items in it',
  transfer_policy: 'a TransferPolicy holds a Balance of royalties',
  token: 'closed-loop tokens and their policies hold value',
};
const FORBIDDEN_TYPES = {
  Bag: 'bag',
  ObjectBag: 'object_bag',
  Versioned: 'versioned',
  Kiosk: 'kiosk',
  KioskOwnerCap: 'kiosk',
  TransferPolicy: 'transfer_policy',
  TransferPolicyCap: 'transfer_policy',
  TokenPolicy: 'token',
};
const INTAKE = [
  { pattern: /(?<![\w$])withdraw_funds_from_object(?!\w)/g, name: 'withdraw_funds_from_object', why: 'it withdraws funds held at an object address: core would be holding them' },
  { pattern: /(?<![\w$])Receiving(?!\w)/g, name: 'Receiving', why: 'it receives an object sent to an object address: core would be holding it' },
  { pattern: /(?<![\w$])public_receive(?!\w)/g, name: 'public_receive', why: 'it receives an object sent to an object address: core would be holding it' },
  { pattern: /(?<![\w$])transfer\s*::\s*receive(?!\w)/g, name: 'transfer::receive', why: 'it receives an object sent to an object address: core would be holding it' },
  { pattern: /(?<![\w$])public_share_object(?!\w)/g, name: 'public_share_object', why: 'core shares its own types with share_object; this shares a framework object, such as a Table of balances whose type was inferred' },
];

/** Local names for `typeName`: itself, and every `use … as` alias of it. */
function aliasesFor(useList, typeName) {
  const found = new Set([typeName]);
  for (const u of useList) {
    if (!u.fun && u.alias && u.path.split('::').at(-1) === typeName) found.add(u.alias);
  }
  return [...found];
}

/** Is the `<` at `index`'s enclosing angle bracket a type-argument list? Returns the owning name or null. */
function enclosingTypeArgs(code, index) {
  let depth = 0;
  for (let i = index - 1; i >= 0; i -= 1) {
    const c = code[i];
    if (c === '>') depth += 1;
    else if (c === '<') {
      if (depth === 0) {
        const owner = /([A-Za-z_]\w*)\s*$/.exec(code.slice(Math.max(0, i - 64), i));
        return owner ? owner[1] : null;
      }
      depth -= 1;
    } else if (';{}()='.includes(c)) return null;
  }
  return null;
}

function main() {
  let files;
  try {
    files = moveFiles(CORE_SOURCES);
  } catch {
    console.error(`FAIL: ${CORE_SOURCES} does not exist. splash_core is the mainnet package — it cannot be missing.`);
    process.exit(1);
  }
  if (files.length === 0) {
    console.error(`FAIL: ${CORE_SOURCES} contains no .move files.`);
    process.exit(1);
  }

  const violations = [];
  const declared = new Set();
  const note = (file, raw, index, what, held, why) =>
    violations.push({ file, line: lineOf(raw, index), what, held, why });

  for (const file of files) {
    let unit;
    try {
      unit = readMove(file);
    } catch (error) {
      if (!(error instanceof MoveLexError)) throw error;
      violations.push({ file, line: 0, what: 'source', held: 'text the Move lexer rules cannot read', why: error.message });
      continue;
    }
    const { code, raw } = unit;
    for (const m of modules(code)) declared.add(m.name);
    const useList = uses(code);
    const types = datatypes(code);

    for (const valueType of VALUE_TYPES) {
      const names = aliasesFor(useList, valueType.name);
      const label = (name) => (name === valueType.name ? name : `${name} (alias of ${valueType.name})`);
      for (const name of names) {
        // 1. Inside any struct or enum body, at any depth.
        for (const t of types) {
          if (new RegExp(`(?<![\\w$])${name}\\s*<`).test(t.body)) {
            note(file, raw, t.index, `${t.kind} ${t.name}`, label(name), valueType.why);
          }
        }
        // 3. Inside another type's type arguments, anywhere.
        for (const at of tokens(code, name)) {
          if (!/^\s*</.test(code.slice(at + name.length))) continue;
          const owner = enclosingTypeArgs(code, at);
          if (owner) note(file, raw, at, `type argument of ${owner}<…>`, label(name), `${valueType.why}; inside ${owner} it is held, not passed`);
        }
      }
    }

    // 2. Generic holders.
    for (const t of types) {
      if (!t.abilities.has('key') && !t.abilities.has('store')) continue;
      for (const p of t.typeParameters) {
        if (p.phantom || p.constraints.has('copy') || p.constraints.has('drop')) continue;
        if (tokens(t.body, p.name).length) {
          note(file, raw, t.index, `${t.kind} ${t.name}<${p.name}>`, `a ${p.name} field with ${[...t.abilities].join(', ')}`, `instantiated with a Balance, it holds client money; constrain ${p.name} with drop, make it phantom, or move this to splash_custody`);
        }
      }
    }

    // 4. Stores that hold what the source never names, or hold value themselves.
    for (const u of useList) {
      if (u.fun) continue;
      const used = u.path.split('::')[1];
      if (FORBIDDEN_MODULES[used]) note(file, raw, u.index, `use ${u.path}`, `sui::${used}`, FORBIDDEN_MODULES[used]);
    }
    for (const [forbidden, why] of Object.entries(FORBIDDEN_MODULES)) {
      for (const m of code.matchAll(new RegExp(`(?<![\\w$])${forbidden}\\s*::`, 'g'))) {
        note(file, raw, m.index, `${forbidden}::…`, `sui::${forbidden}`, why);
      }
    }
    for (const [type, home] of Object.entries(FORBIDDEN_TYPES)) {
      for (const at of tokens(code, type)) note(file, raw, at, type, `sui::${home}::${type}`, FORBIDDEN_MODULES[home]);
    }

    // 5. Taking in what was sent to an object's address, and sharing framework objects.
    for (const { pattern, name, why } of INTAKE) {
      for (const m of code.matchAll(pattern)) note(file, raw, m.index, name, name, why);
    }
  }

  // 6. Coverage cross-check: every compiled module must be one we scanned.
  //
  // `sui move test` also compiles modules under tests/ into bytecode_modules.
  // Those are `#[test_only]` and never publish, so they are legitimately outside
  // the scan — but they are enumerated by their declarations rather than
  // pattern-guessed, or this check quietly stops noticing a real gap.
  let coverageNote = '';
  if (existsSync(CORE_BYTECODE)) {
    const compiled = readdirSync(CORE_BYTECODE).filter((f) => f.endsWith('.mv')).map((f) => path.basename(f, '.mv'));
    const testModules = new Set();
    try {
      for (const file of moveFiles(CORE_TESTS)) for (const m of modules(readMove(file).code)) testModules.add(m.name);
    } catch {
      /* no tests/ directory — nothing to exclude */
    }
    const missed = compiled.filter((m) => !declared.has(m) && !testModules.has(m));
    if (missed.length > 0) {
      console.error(`\n  FAIL: the compiler produced modules this scan never opened: ${missed.join(', ')}`);
      console.error('  Every module that publishes must be scanned. Fix the source walk before trusting this check.\n');
      process.exit(1);
    }
    coverageNote = `, cross-checked against ${compiled.length} compiled module(s)`;
  } else if (REQUIRE_BUILD) {
    console.error(`\n  FAIL: --require-build, and there is no ${CORE_BYTECODE}. Run \`sui move build\` in move/splash_core first.\n`);
    process.exit(1);
  } else {
    coverageNote = ' (no build output to cross-check — run `sui move build` for full coverage)';
  }

  if (violations.length > 0) {
    console.error('\n  CORE INVARIANT VIOLATED — splash_core must hold no client value.\n');
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}  ${v.what}`);
      console.error(`    holds ${v.held}`);
      console.error(`    -> ${v.why}\n`);
    }
    console.error('  splash_core publishes to mainnet, and Splash holds no licence that would');
    console.error('  permit holding client funds. Value-holding code belongs in');
    console.error('  move/splash_custody, which v2 retired from the mainnet path for good (D11).\n');
    console.error('  Do not add an exception to this script. The check passing IS the');
    console.error('  regulatory claim.\n');
    process.exit(1);
  }

  console.log(`Core invariant holds: no value-bearing field in ${files.length} splash_core module(s)${coverageNote}.`);
}

main();
