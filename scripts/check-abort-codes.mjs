#!/usr/bin/env node
/**
 * Abort codes must be globally unique across every Move package here, and
 * every one must be one the runtime explainer actually explains.
 *
 * Move does not require uniqueness. A code is scoped to its module, and the VM
 * reports both, so two modules using `601` are never ambiguous on chain.
 *
 * The off-chain diagnostic table is what requires it. `ABORT_CODES` in
 * `lib/server/sui-settlement.ts` maps a bare NUMBER to a sentence, with no
 * module in the key, and that sentence is what an operator or a customer
 * actually reads when a payment fails. Two modules sharing a number means one
 * of them gets the other's explanation — not "no message", which is honest,
 * but a confident wrong one, during the failure.
 *
 * This shipped once already: `splash_core::daily_limit` was written with the
 * 600-block that `splash_custody::dual_treasury` owns, so a tenant hitting
 * their 24h payout ceiling would have been told "E_USDT_BUFFER_EMPTY —
 * emergency_sweep called with zero balance". Nothing caught it. TypeScript
 * only noticed the SECOND attempt, and only because that one happened to
 * duplicate a key already present in the object literal.
 *
 * And it shipped a second way: `humanizeSuiError` consults the table only for
 * modules in `OUR_MODULES`, which lacked spend_window and cap_registry, so a
 * v2 payment over its daily ceiling reached the operator as a bare
 * "MoveAbort code 201" while this check printed "unique and explained".
 *
 * WHAT THIS CHECKS, on every `.move` file under each package's sources/
 * (recursively, as the compiler reads them), with comments and string
 * contents blanked by the Move lexer rules in scripts/move-source.mjs, module
 * by module as each file declares them:
 *
 *   1. An abort code is a `const NAME: u64 = <literal>;` that is named E_… or
 *      is used as an abort code: the second argument of `assert!`, or what
 *      follows `abort`.
 *   2. Every `assert!` names its code, and every code an `assert!` or `abort`
 *      raises is one of its module's u64 constants. A literal number, an
 *      expression, a missing code or a `#[error]` (clever error) constant
 *      fails: the table explains bare numbers it can see.
 *   3. No two modules share a code.
 *   4. Every code is in ABORT_CODES.
 *   5. Every module that declares an abort code is in OUR_MODULES, so
 *      humanizeSuiError consults the table for it.
 *
 * WHAT IT DOES NOT CATCH. Aborts raised inside a dependency (DeepBook, the
 * framework) are explained, if at all, by DEPENDENCY_ABORT_CODES, which this
 * does not check; a code raised by a macro defined in another package is
 * checked where the macro is written; and whether a sentence is TRUE is for a
 * reader.
 *
 * Run by `npm run lint`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { MoveLexError, calls, lineOf, modules, moveFiles, readMove } from './move-source.mjs';

const PACKAGES = [
  'move/splash_core/sources',
  'move/splash_custody/sources',
  'move/splash_meter/sources',
  'move/splash_spend/sources',
  'move/splash_upgrade_delay/sources',
];
const TABLE = 'lib/server/sui-settlement.ts';

/** code -> [{ module, name }] */
const byCode = new Map();
/** module names that declare at least one abort code */
const raising = new Set();
const problems = [];

for (const dir of PACKAGES) {
  let files;
  try {
    files = moveFiles(dir);
  } catch {
    console.error(`${dir}: not readable — this check cannot verify what it claims to.`);
    process.exit(1);
  }
  for (const file of files) {
    let unit;
    try {
      unit = readMove(file);
    } catch (error) {
      if (!(error instanceof MoveLexError)) throw error;
      problems.push(`${error.message}. The check cannot read what the compiler would.`);
      continue;
    }
    const { code, raw } = unit;
    const where = (index) => `${path.normalize(file)}:${lineOf(raw, index)}`;
    const decls = modules(code);
    if (decls.length === 0) problems.push(`${path.normalize(file)}: declares no module.`);

    decls.forEach((decl, k) => {
      const start = decl.index;
      const end = k + 1 < decls.length ? decls[k + 1].index : code.length;
      const text = code.slice(start, end);
      const moduleName = decl.name;

      // Every constant, and every clever error.
      const consts = new Map();
      for (const m of text.matchAll(/\bconst\s+([A-Za-z_]\w*)\s*:\s*([^=;]+?)\s*=\s*([^;]+?)\s*;/g)) {
        consts.set(m[1], { type: m[2].replace(/\s+/g, ''), value: m[3].trim(), index: start + m.index });
      }
      for (const m of text.matchAll(/#\[\s*error\b[^\]]*\]\s*const\s+([A-Za-z_]\w*)/g)) {
        problems.push(`${where(start + m.index)}: \`${moduleName}::${m[1]}\` is a clever error (#[error]). Its abort code packs the line number, so ABORT_CODES cannot explain it. Use a u64 constant.`);
      }

      // Every code an assert! or abort raises.
      const used = new Set();
      const named = (expr, index, how) => {
        const c = consts.get(expr);
        if (/^[A-Za-z_]\w*$/.test(expr) && c && c.type === 'u64') {
          used.add(expr);
          return;
        }
        problems.push(`${where(index)}: \`${moduleName}\` ${how} \`${expr}\`, which is not one of its u64 constants. Name the code with a \`const …: u64\` so the table can explain it.`);
      };
      for (const call of calls(text, 'assert!')) {
        if (call.args.length < 2) {
          problems.push(`${where(start + call.index)}: \`${moduleName}\` has an assert! with no abort code. Give it a named u64 constant.`);
          continue;
        }
        named(call.args[1].text, start + call.index, 'aborts with');
      }
      for (const m of text.matchAll(/\babort\b\s*(\(\s*([^()]*?)\s*\)|[^\s;}),]+)/g)) {
        named((m[2] ?? m[1]).trim(), start + m.index, 'aborts with');
      }

      // The abort codes: E_… u64 constants, and any u64 constant used as one.
      for (const [name, c] of consts) {
        if (c.type !== 'u64' || !(name.startsWith('E_') || used.has(name))) continue;
        const literal = /^(\d[\d_]*)(?:u64)?$/.exec(c.value);
        if (!literal) {
          problems.push(`${where(c.index)}: \`${moduleName}::${name}\` = \`${c.value}\` is not a plain number, so this check cannot read the code.`);
          continue;
        }
        const value = Number(literal[1].replace(/_/g, ''));
        if (!byCode.has(value)) byCode.set(value, []);
        byCode.get(value).push({ module: moduleName, name });
        raising.add(moduleName);
      }
    });
  }
}

const collisions = [...byCode.entries()].filter(([, owners]) => owners.length > 1);

/**
 * A code the table explains but no module raises is a message that can never
 * appear; a code some module raises but the table omits reaches the user as a
 * bare number. The first is dead weight, the second is the actual gap, so only
 * the second fails.
 */
const table = readFileSync(TABLE, 'utf8');
const documented = new Set([...table.matchAll(/^\s{2}(\d{1,4}):\s*'/gm)].map((m) => Number(m[1])));
const undocumented = [...byCode.keys()].filter((code) => !documented.has(code)).sort((a, b) => a - b);

const ourModulesText = /const OUR_MODULES = new Set\(\[([\s\S]*?)\]\)/.exec(table)?.[1];
const ourModules = new Set([...(ourModulesText ?? '').matchAll(/'([a-z_][a-z0-9_]*)'/g)].map((m) => m[1]));
const unconsulted = [...raising].filter((m) => !ourModules.has(m)).sort();

let failed = false;

if (problems.length > 0) {
  failed = true;
  console.error('Abort codes this check cannot see as numbers the table explains:\n');
  for (const p of problems) console.error(`  • ${p}`);
  console.error('');
}

if (collisions.length > 0) {
  failed = true;
  console.error('Two modules cannot share an abort code — the off-chain table is flat:\n');
  for (const [code, owners] of collisions.sort((a, b) => a[0] - b[0])) {
    console.error(`  • ${code}: ${owners.map((o) => `${o.module}::${o.name}`).join('  vs  ')}`);
  }
  // Name the free space, so the fix is a lookup rather than a search.
  const taken = new Set([...byCode.keys()].map((c) => Math.floor(c / 100)));
  const free = [];
  for (let block = 1; block <= 20; block += 1) if (!taken.has(block)) free.push(`${block * 100}s`);
  console.error(`\n    Free blocks: ${free.length > 0 ? free.join(', ') : 'none under 2000 — start a new decade'}\n`);
}

if (undocumented.length > 0) {
  failed = true;
  console.error(`These abort codes reach a user as a bare number — add them to ABORT_CODES in ${TABLE}:\n`);
  for (const code of undocumented) {
    const owner = byCode.get(code)[0];
    console.error(`  • ${code}  (${owner.module}::${owner.name})`);
  }
  console.error('');
}

if (!ourModulesText) {
  failed = true;
  console.error(`${TABLE} has no \`const OUR_MODULES = new Set([…])\`; this check cannot tell which modules humanizeSuiError explains.\n`);
} else if (unconsulted.length > 0) {
  failed = true;
  console.error(`humanizeSuiError never consults ABORT_CODES for these modules — add them to OUR_MODULES in ${TABLE}:\n`);
  for (const m of unconsulted) console.error(`  • ${m}`);
  console.error('');
}

if (failed) process.exit(1);

console.log(
  `Abort codes are unique and explained: ${byCode.size} across ${PACKAGES.length} packages, from ${raising.size} module(s) the explainer consults.`,
);
