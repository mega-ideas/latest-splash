#!/usr/bin/env node
/**
 * splash_spend can never rotate a spender, and its permits never leave it.
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
 * checked on the source, on every build:
 *
 *   1. `rotate_spender` appears nowhere.
 *   2. `internal::permit` is called exactly twice, both times as
 *      `internal::permit<SPLASH_SPEND>()`, once passed straight through
 *      `allowance::settings_permit(` into `allowance::issue(`, once passed
 *      straight through `allowance::spend_permit(` into
 *      `allowance::app_balance_spend(`.
 *   3. The function that calls `app_balance_spend` is private.
 *   4. No function returns a permit, a witness or a `Balance`; a `Coin` is
 *      returned only beside a `BridgeObligation`.
 *   5. `SettleWitness {}` is constructed only as the first argument of one of
 *      splash_core's app entry points, never bound to a name or returned.
 *   6. `SettleWitness` and `SPLASH_SPEND` have exactly `drop`.
 *   7. No function is generic over a `W: drop` it could pass a witness through.
 *
 * Run by `npm run lint`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SOURCES = process.env.SPEND_SOURCES ?? 'move/splash_spend/sources';

/** The splash_core functions a SettleWitness may be handed to. */
const CORE_APP_ENTRIES = ['create_for_app', 'create_cross_chain_for_app', 'settle_from_app', 'settle_cross_chain_from_app'];

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

/** Every function: name, visibility, parameter list, return type and body. */
function functions(code) {
  const out = [];
  const signature = /(^|\n)\s*((?:public(?:\([a-z]+\))?\s+)?(?:entry\s+)?)fun\s+([A-Za-z0-9_]+)\s*(<[^>]*>)?\s*\(/g;
  let match;
  while ((match = signature.exec(code)) !== null) {
    const visibility = match[2].trim();
    const name = match[3];
    const generics = match[4] ?? '';
    let i = match.index + match[0].length - 1;
    let depth = 0;
    let paramsEnd = i;
    for (; i < code.length; i += 1) {
      if (code[i] === '(') depth += 1;
      else if (code[i] === ')') {
        depth -= 1;
        if (depth === 0) {
          paramsEnd = i;
          break;
        }
      }
    }
    const params = code.slice(match.index + match[0].length, paramsEnd);
    const braceStart = code.indexOf('{', paramsEnd);
    const returns = code.slice(paramsEnd + 1, braceStart).replace(/^\s*:\s*/, '').trim();
    let body = '';
    let d = 0;
    for (let j = braceStart; j < code.length; j += 1) {
      if (code[j] === '{') d += 1;
      else if (code[j] === '}') {
        d -= 1;
        if (d === 0) {
          body = code.slice(braceStart, j + 1);
          break;
        }
      }
    }
    out.push({ name, visibility, generics, params, returns, body });
  }
  return out;
}

function structAbilities(code, name) {
  const m = code.match(new RegExp(`public\\s+struct\\s+${name}\\b[^;{]*?has\\s+([a-z,\\s]+?)\\s*(?:\\{|;)`));
  if (!m) return null;
  return m[1].split(',').map((a) => a.trim()).filter(Boolean).sort();
}

const failures = [];
let files;
try {
  files = readdirSync(SOURCES).filter((f) => f.endsWith('.move'));
} catch {
  console.error(`FAIL: ${SOURCES} does not exist. splash_spend is the only spender of app-bound allowances; it cannot be missing.`);
  process.exit(1);
}
if (files.length === 0) {
  console.error(`FAIL: no Move sources in ${SOURCES}.`);
  process.exit(1);
}

let permitCalls = 0;
let issueThroughSettings = 0;
let spendThroughSpendPermit = 0;
let witnessConstructions = 0;
let witnessAsCoreArgument = 0;
let sawSplashSpend = false;
let sawSettleWitness = false;

for (const file of files) {
  const path = join(SOURCES, file);
  const code = stripComments(readFileSync(path, 'utf8'));

  // 1. No spender rotation, by any route.
  if (/\brotate_spender\b/.test(code)) {
    failures.push(`${path}: mentions \`rotate_spender\`. splash_spend must never rotate a spender.`);
  }

  // 2. Every internal::permit call, and what wraps it.
  for (const m of code.matchAll(/internal::permit\s*<([^>]*)>\s*\(\s*\)/g)) {
    permitCalls += 1;
    if (m[1].trim() !== 'SPLASH_SPEND') {
      failures.push(`${path}: \`internal::permit<${m[1]}>()\` — only SPLASH_SPEND's permit belongs here.`);
    }
  }
  const bare = (code.match(/internal::permit\b/g) ?? []).length;
  const called = (code.match(/internal::permit\s*<[^>]*>\s*\(\s*\)/g) ?? []).length;
  if (bare !== called) {
    failures.push(`${path}: \`internal::permit\` is referenced other than as a direct call.`);
  }
  issueThroughSettings += (
    code.match(/allowance::issue\s*\([^;]*?allowance::settings_permit\s*\(\s*internal::permit\s*<\s*SPLASH_SPEND\s*>\s*\(\s*\)\s*\)/g) ?? []
  ).length;
  spendThroughSpendPermit += (
    code.match(/allowance::app_balance_spend\s*\([^;]*?allowance::spend_permit\s*\(\s*internal::permit\s*<\s*SPLASH_SPEND\s*>\s*\(\s*\)\s*\)/g) ?? []
  ).length;

  // 6. The two marker types keep exactly `drop`.
  const appAbilities = structAbilities(code, 'SPLASH_SPEND');
  if (appAbilities) {
    sawSplashSpend = true;
    if (appAbilities.join(',') !== 'drop') failures.push(`${path}: SPLASH_SPEND must have exactly \`drop\` (has ${appAbilities.join(', ')}).`);
  }
  const witnessAbilities = structAbilities(code, 'SettleWitness');
  if (witnessAbilities) {
    sawSettleWitness = true;
    if (witnessAbilities.join(',') !== 'drop') failures.push(`${path}: SettleWitness must have exactly \`drop\` (has ${witnessAbilities.join(', ')}).`);
  }
  if (/\bSPLASH_SPEND\s*\(\s*\)\s*(?!has)/.test(code.replace(/public\s+struct\s+SPLASH_SPEND\s*\(\s*\)/g, ''))) {
    failures.push(`${path}: SPLASH_SPEND is constructed. The app type is never packed.`);
  }

  // 5. Where SettleWitness is built.
  witnessConstructions += (code.match(/\bSettleWitness\s*\{\s*\}/g) ?? []).length;
  for (const entry of CORE_APP_ENTRIES) {
    const re = new RegExp(`payment_intent::${entry}\\s*<[^>]*>\\s*\\(\\s*SettleWitness\\s*\\{\\s*\\}`, 'g');
    witnessAsCoreArgument += (code.match(re) ?? []).length;
  }

  for (const fn of functions(code)) {
    // 3. The spend itself is private.
    if (/allowance::app_balance_spend\s*\(/.test(fn.body) && fn.visibility !== '') {
      failures.push(`${path}: \`${fn.name}\` calls app_balance_spend and is \`${fn.visibility}\`. It must be a private \`fun\`.`);
    }
    // 4. What a function may hand back.
    if (/Permit\b/.test(fn.returns)) failures.push(`${path}: \`${fn.name}\` returns a permit (${fn.returns}).`);
    if (/\bSettleWitness\b/.test(fn.returns)) failures.push(`${path}: \`${fn.name}\` returns the settlement witness.`);
    if (/\bBalance\s*</.test(fn.returns) && fn.visibility !== '') {
      failures.push(`${path}: \`${fn.name}\` is ${fn.visibility} and returns a Balance (${fn.returns}).`);
    }
    if (/\bCoin\s*</.test(fn.returns) && !/\bBridgeObligation\b/.test(fn.returns)) {
      failures.push(`${path}: \`${fn.name}\` returns a Coin without a BridgeObligation (${fn.returns}).`);
    }
    // 7. No witness passthrough.
    if (/\b[A-Z][A-Za-z0-9_]*\s*:\s*drop\b/.test(fn.generics)) {
      failures.push(`${path}: \`${fn.name}${fn.generics}\` is generic over a droppable type it could pass a witness through.`);
    }
  }
}

if (!sawSplashSpend) failures.push(`${SOURCES}: no \`public struct SPLASH_SPEND\` found; this check cannot verify what it claims to.`);
if (!sawSettleWitness) failures.push(`${SOURCES}: no \`public struct SettleWitness\` found; this check cannot verify what it claims to.`);
if (permitCalls !== 2) failures.push(`${SOURCES}: internal::permit is called ${permitCalls} time(s); exactly 2 are allowed (issue and app_balance_spend).`);
if (issueThroughSettings !== 1) failures.push(`${SOURCES}: expected exactly one allowance::issue(… allowance::settings_permit(internal::permit<SPLASH_SPEND>())), found ${issueThroughSettings}.`);
if (spendThroughSpendPermit !== 1) failures.push(`${SOURCES}: expected exactly one allowance::app_balance_spend(… allowance::spend_permit(internal::permit<SPLASH_SPEND>()) …), found ${spendThroughSpendPermit}.`);
if (witnessConstructions !== witnessAsCoreArgument) {
  failures.push(`${SOURCES}: SettleWitness {} is constructed ${witnessConstructions} time(s) but passed straight to splash_core only ${witnessAsCoreArgument} time(s).`);
}

if (failures.length > 0) {
  console.error('\n  splash_spend would leak spending authority:\n');
  for (const f of failures) console.error(`  • ${f}\n`);
  console.error('  splash_spend publishes immutable. A permit or a Balance that escapes it is\n  escaped for ever. Do not add an exception to this script.\n');
  process.exit(1);
}

console.log(
  `splash_spend keeps its permits: no rotate_spender, 2 permit calls (issue, app_balance_spend), ` +
    `${witnessConstructions} witness use(s) all passed straight to splash_core, across ${files.length} module(s).`,
);
