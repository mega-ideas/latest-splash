#!/usr/bin/env node
/**
 * WS3. The operator key pays service orders, and does nothing else with money.
 *
 * Before WS3 the server opened a payment intent with the operator key
 * (`createPaymentIntentOnSui`) and paid it from the operator's own gas coin
 * (`confirmComposedPaymentOnSui`). The chain saw one address authorise and
 * fund its own payout: no client signature, no approver, nothing between a
 * stolen operator key and Splash's capital. That path is deleted, and once an
 * operator is registered in the SettlementPolicy the chain refuses it too
 * (payment_intent abort 421).
 *
 * This keeps it deleted. In any server module that can sign as the operator
 * (it names the operator signer: getOperatorKeypair, getOperatorSigner (WS4), executeSdkTransaction,
 * OPERATOR_SUI_PRIVATE_KEY), the build fails if
 *
 *   1. it composes `payment_intent::create_payment_intent`, `::create`,
 *      `::create_payment_intent_for_account` or `::create_service_order` —
 *      an intent the operator opens is an intent it authorised for itself;
 *      a service order is opened by the client member's own wallet
 *      (lib/sui/service-orders.ts), never by this key; or
 *   2. it calls `transferObjects` anywhere but inside
 *      `confirmServiceOrderOnSui` — a raw transfer of operator coins is a
 *      payout no client ordered and no approver approved.
 *
 * A module that moves a payer's OWN coin (lib/server/stablecoin-chain.ts
 * builds a transfer the sender's wallet signs) names no operator signer and is
 * not this check's business. Scripts under scripts/ are operator CLIs run by
 * a person at the key ceremony, not server modules, and are out of scope.
 *
 * Run by `npm run lint`. `--root <dir>` checks another tree; the test plants
 * violations in a temporary one and asserts this fails.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const args = process.argv.slice(2);
const rootAt = args.indexOf('--root');
const ROOT = resolve(rootAt >= 0 && args[rootAt + 1] ? args[rootAt + 1] : process.cwd());

/** Server code lives here. tests/ and scripts/ do not deploy. */
const SERVER_ROOTS = ['app', 'lib'];
const EXT = /\.(ts|tsx|mjs|js)$/;
const SKIP = new Set(['node_modules', '.next', '.git', 'dist', 'build']);

/** A module that names one of these can sign as the operator. */
const OPERATOR_SIGNER = /\b(getOperatorKeypair|getOperatorSigner|executeSdkTransaction|cachedOperatorKeypair|OPERATOR_SUI_PRIVATE_KEY)\b/;

/** A Move target composed in code: `${pkg}::payment_intent::create…` or `0x…::payment_intent::create…`. */
const CREATE_TARGET =
  /(?:\}|0x[0-9a-fA-F]+)::payment_intent::(create_payment_intent_for_account|create_payment_intent|create_service_order|create)(?![A-Za-z0-9_])/g;

/** The one function allowed to move operator coins, and only by the contract's hand. */
const ALLOWED_TRANSFER_FN = 'confirmServiceOrderOnSui';

function* files(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* files(full);
    else if (EXT.test(name)) yield full;
  }
}

/** Comments become spaces of the same length, so offsets and line numbers hold. */
function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:\\])\/\/[^\n]*/g, (m, lead) => lead + ' '.repeat(m.length - lead.length));
}

function lineOf(code, index) {
  return code.slice(0, index).split('\n').length;
}

/** [start, end) of every body of a function named `name`. */
function functionBodies(code, name) {
  const spans = [];
  const re = new RegExp(`function\\s+${name}\\s*(<[^>]*>)?\\s*\\(`, 'g');
  for (const m of code.matchAll(re)) {
    // Close the parameter list.
    let i = m.index + m[0].length;
    let depth = 1;
    while (i < code.length && depth > 0) {
      if (code[i] === '(') depth += 1;
      if (code[i] === ')') depth -= 1;
      i += 1;
    }
    // The body is the first `{` outside any type arguments of the return type.
    let angle = 0;
    while (i < code.length) {
      const ch = code[i];
      if (ch === '<') angle += 1;
      else if (ch === '>') angle -= 1;
      else if (ch === '{' && angle <= 0) break;
      i += 1;
    }
    const open = i;
    depth = 0;
    for (; i < code.length; i += 1) {
      if (code[i] === '{') depth += 1;
      if (code[i] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    spans.push([open, i + 1]);
  }
  return spans;
}

const violations = [];
let operatorModules = 0;

for (const top of SERVER_ROOTS) {
  for (const file of files(join(ROOT, top))) {
    const code = stripComments(readFileSync(file, 'utf8'));
    if (!OPERATOR_SIGNER.test(code)) continue;
    operatorModules += 1;
    const rel = relative(ROOT, file).split('\\').join('/');

    for (const m of code.matchAll(CREATE_TARGET)) {
      violations.push(
        `${rel}:${lineOf(code, m.index)}  composes payment_intent::${m[1]} in a module that signs as the operator. ` +
          'The operator never opens an intent; a client member opens a service order in their own wallet.',
      );
    }

    const allowed = functionBodies(code, ALLOWED_TRANSFER_FN);
    for (const m of code.matchAll(/\.transferObjects\s*\(/g)) {
      if (allowed.some(([start, end]) => m.index >= start && m.index < end)) continue;
      violations.push(
        `${rel}:${lineOf(code, m.index)}  raw transferObjects in a module that signs as the operator, outside ${ALLOWED_TRANSFER_FN}. ` +
          'Splash capital moves only to settle a service order two members signed.',
      );
    }
  }
}

if (violations.length > 0) {
  console.error('The operator key may pay only what a client ordered and an approver approved (WS3):\n');
  for (const v of violations) console.error(`  • ${v}`);
  console.error('');
  process.exit(1);
}

console.log(
  `Operator paths hold: ${operatorModules} module(s) can sign as the operator, none opens an intent or moves a coin outside ${ALLOWED_TRANSFER_FN}.`,
);
