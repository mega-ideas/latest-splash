#!/usr/bin/env node
/**
 * Abort codes must be globally unique across every Move package here.
 *
 * Move does not require this. A code is scoped to its module, and the VM
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
 * Run by `npm run lint`.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const PACKAGES = [
  'move/splash_core/sources',
  'move/splash_custody/sources',
  'move/splash_meter/sources',
  'move/splash_spend/sources',
  'move/splash_upgrade_delay/sources',
];
const TABLE = 'lib/server/sui-settlement.ts';

const ABORT_CONST = /const\s+(E_[A-Z0-9_]+)\s*:\s*u64\s*=\s*([0-9_]+)\s*;/g;

/** code -> [{ module, name }] */
const byCode = new Map();

for (const dir of PACKAGES) {
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.move'));
  } catch {
    console.error(`${dir}: not readable — this check cannot verify what it claims to.`);
    process.exit(1);
  }
  for (const file of files) {
    const source = readFileSync(join(dir, file), 'utf8');
    const moduleName = file.replace(/\.move$/, '');
    for (const match of source.matchAll(ABORT_CONST)) {
      const code = Number(match[2].replace(/_/g, ''));
      if (!byCode.has(code)) byCode.set(code, []);
      byCode.get(code).push({ module: moduleName, name: match[1] });
    }
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
const documented = new Set(
  [...table.matchAll(/^\s{2}(\d{1,4}):\s*'/gm)].map((m) => Number(m[1])),
);
const undocumented = [...byCode.keys()].filter((code) => !documented.has(code)).sort((a, b) => a - b);

let failed = false;

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
  console.error(
    `These abort codes reach a user as a bare number — add them to ABORT_CODES in ${TABLE}:\n`,
  );
  for (const code of undocumented) {
    const owner = byCode.get(code)[0];
    console.error(`  • ${code}  (${owner.module}::${owner.name})`);
  }
  console.error('');
}

if (failed) process.exit(1);

console.log(
  `Abort codes are unique and explained: ${byCode.size} across ${PACKAGES.length} packages.`,
);
