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
 * contains NO STRUCT FIELD CAPABLE OF HOLDING VALUE. Not gated. Absent. Client
 * value exists only as a `Coin<T>` or `Balance<T>` parameter that enters and
 * exits a `payment_intent` settle path within a single PTB; there is no
 * object to accumulate into.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * REWRITTEN 2026-08-17 after an adversarial review DEFEATED the first version.
 *
 * v1 matched `^\s*<name>\s*:\s*<Type>\s*<` — field name and unwrapped type at
 * the start of one physical line. A reviewer compiled a complete client omnibus
 * into splash_core while v1 reported "invariant holds":
 *
 *     per_client: Table<address, Balance<SUI>>,   // nested — missed
 *     float:      vector<Coin<SUI>>,              // nested — missed
 *     reserve:    Option<Balance<SUI>>,           // nested — missed
 *     house:      Ledger<SUI>,                    // aliased import — missed
 *     slush:
 *         Balance<SUI>,                           // split across lines — missed
 *     public struct V has key { id: UID, pot: Balance<SUI> }  // one line — missed
 *
 * plus anything under `sources/<subdir>/`, which v1's non-recursive readdir
 * never opened even though the Move compiler publishes it.
 *
 * A control that the thing it forbids can walk straight past is worse than no
 * control, because it is quoted as evidence. This version parses STRUCT BODIES
 * out of comment-stripped, whitespace-normalised source and rejects a value type
 * appearing ANYWHERE inside one, at any nesting depth, under any local alias.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const CORE_SOURCES = path.join('move', 'splash_core', 'sources');
const CORE_BYTECODE = path.join('move', 'splash_core', 'build', 'splash_core', 'bytecode_modules');
const CORE_TESTS = path.join('move', 'splash_core', 'tests');

/**
 * Types that can hold or mint value. Matched anywhere inside a struct body, so
 * `Table<address, Balance<SUI>>` and `vector<Coin<SUI>>` are caught by the
 * inner type — no need to enumerate every container.
 */
const VALUE_TYPES = [
  { name: 'Balance', why: 'a Balance accumulates value across transactions — that is custody' },
  { name: 'Coin', why: 'a Coin passed as a PARAMETER is the non-custodial path; a Coin stored in a struct outlives the transaction and is custody' },
  { name: 'TreasuryCap', why: 'mint authority does not belong in the non-custodial core package' },
];

/** Strip line and block comments so prose can never trip or hide a match. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
}

/**
 * Local aliases for a value type: `use sui::balance::Balance as Ledger;`.
 * Without this, renaming on import walks past the check.
 */
function aliasesFor(source, typeName) {
  const found = new Set([typeName]);
  const re = new RegExp(`use\\s+[\\w:]*\\b${typeName}\\s+as\\s+([A-Za-z_][A-Za-z0-9_]*)`, 'g');
  let m;
  while ((m = re.exec(source)) !== null) found.add(m[1]);
  // Grouped form: `use sui::balance::{Self, Balance as Ledger};`
  const grouped = new RegExp(`\\b${typeName}\\s+as\\s+([A-Za-z_][A-Za-z0-9_]*)`, 'g');
  while ((m = grouped.exec(source)) !== null) found.add(m[1]);
  return [...found];
}

/**
 * Every `struct <Name> ... { <body> }` in the file, brace-matched so nested
 * generics and inner braces do not truncate the body early.
 */
function structBodies(source) {
  const out = [];
  const header = /\b(?:public\s+)?struct\s+([A-Za-z_][A-Za-z0-9_]*)/g;
  let m;
  while ((m = header.exec(source)) !== null) {
    const open = source.indexOf('{', m.index);
    if (open === -1) continue;
    let depth = 0;
    let end = -1;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') {
        depth -= 1;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end === -1) continue;
    out.push({ name: m[1], body: source.slice(open + 1, end), index: m.index });
  }
  return out;
}

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

/** Recursive — the Move compiler walks sources/ recursively, so we must too. */
async function moveFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await moveFiles(full)));
    else if (entry.name.endsWith('.move')) files.push(full);
  }
  return files;
}

async function main() {
  let files;
  try {
    files = await moveFiles(CORE_SOURCES);
  } catch {
    console.error(`FAIL: ${CORE_SOURCES} does not exist. splash_core is the mainnet package — it cannot be missing.`);
    process.exit(1);
  }
  if (files.length === 0) {
    console.error(`FAIL: ${CORE_SOURCES} contains no .move files.`);
    process.exit(1);
  }

  const violations = [];
  for (const file of files) {
    const raw = await readFile(file, 'utf8');
    const source = stripComments(raw);

    for (const valueType of VALUE_TYPES) {
      const names = aliasesFor(source, valueType.name);
      for (const struct of structBodies(source)) {
        for (const name of names) {
          // `\b<Name>\s*<` catches the type at ANY nesting depth inside the
          // body, and tolerates a newline between the field name and its type.
          const re = new RegExp(`\\b${name}\\s*<`);
          if (re.test(struct.body)) {
            violations.push({
              file,
              line: lineOf(source, struct.index),
              struct: struct.name,
              type: name === valueType.name ? name : `${name} (alias of ${valueType.name})`,
              why: valueType.why,
            });
          }
        }
      }
    }
  }

  // Coverage cross-check: if a build exists, every compiled module must have
  // been scanned. Catches a module the source walk missed for any reason.
  //
  // `sui move test` also compiles modules under tests/ into bytecode_modules.
  // Those are `#[test_only]` and never publish, so they are legitimately outside
  // the scan — but they must be enumerated rather than pattern-guessed, or this
  // check quietly stops noticing a real gap.
  let coverageNote = '';
  try {
    const compiled = (await readdir(CORE_BYTECODE)).filter((f) => f.endsWith('.mv'));
    const scanned = new Set(files.map((f) => path.basename(f, '.move')));
    let testModules = new Set();
    try {
      testModules = new Set((await moveFiles(CORE_TESTS)).map((f) => path.basename(f, '.move')));
    } catch {
      /* no tests/ directory — nothing to exclude */
    }
    const missed = compiled
      .map((f) => path.basename(f, '.mv'))
      .filter((m) => !scanned.has(m) && !testModules.has(m));
    if (missed.length > 0) {
      console.error(`\n  FAIL: the compiler produced modules this scan never opened: ${missed.join(', ')}`);
      console.error('  Every module that publishes must be scanned. Fix the source walk before trusting this check.\n');
      process.exit(1);
    }
    coverageNote = `, cross-checked against ${compiled.length} compiled module(s)`;
  } catch {
    coverageNote = ' (no build output to cross-check — run `sui move build` for full coverage)';
  }

  if (violations.length > 0) {
    console.error('\n  CORE INVARIANT VIOLATED — splash_core must hold no client value.\n');
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}  struct ${v.struct}`);
      console.error(`    holds ${v.type}`);
      console.error(`    -> ${v.why}\n`);
    }
    console.error('  splash_core publishes to mainnet, and Splash holds no licence that would');
    console.error('  permit holding client funds. Move this struct to move/splash_custody,');
    console.error('  which publishes only when the e-money licence is granted.\n');
    console.error('  Do not add an exception to this script. The check passing IS the');
    console.error('  regulatory claim.\n');
    process.exit(1);
  }

  console.log(`Core invariant holds: no value-bearing field in ${files.length} splash_core module(s)${coverageNote}.`);
}

await main();
