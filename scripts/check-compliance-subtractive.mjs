#!/usr/bin/env node
/**
 * ComplianceCap is subtractive BY TYPE. This is the check that keeps it so.
 *
 * The claim on the capability is that holding it lets you make the settlement
 * controls stricter and never looser: you can lower a tolerance, raise a
 * requirement, remove a venue, or halt settlement — and you cannot raise a
 * tolerance, lower a requirement, add a venue, or resume. That is what makes it
 * safe to put in a compliance function's hands rather than the cold multisig's,
 * and what makes a compromise of it a denial-of-service rather than a
 * loosening.
 *
 * A claim like that decays the moment someone adds a convenient setter. So the
 * rule is enforced on the SIGNATURE: every function in splash_core whose
 * parameters include `&ComplianceCap` must be one of a named few, and each of
 * those must still look like the operation it claims to be. Adding a loosening
 * function is then not a subtle diff in a 250-line Move file — it is a failing
 * build that names this script.
 *
 * Run by `npm run lint`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SOURCES = 'move/splash_core/sources';

/**
 * The complete set of functions permitted to take `&ComplianceCap`, and what
 * each must still look like.
 *
 * Adding a name here is the deliberate act. If you are adding one, the question
 * to answer in the commit message is: can a holder of this capability use this
 * function to make ANY control looser than it was? If yes, it belongs on
 * `&AdminCap` instead.
 */
const ALLOWED = {
  tighten: {
    why: 'every parameter must move in the stricter direction',
    // One direction assert per numeric field, or a field can drift loose.
    requireAll: ['E_NOT_A_TIGHTENING'],
    minOccurrences: { E_NOT_A_TIGHTENING: 5 },
    forbid: [],
  },
  pause: {
    why: 'halts settlement; resuming is AdminCap',
    requireAll: ['paused = true'],
    forbid: ['paused = false', 'paused;'],
  },
  disallow_pool: {
    why: 'removes a venue from the whitelist',
    requireAll: ['.remove('],
    forbid: ['.insert('],
  },
  // v2 (D11). The three registries an addition to takes 24 hours' notice and
  // the cold multisig. Taking something OFF one only stops money moving.
  remove_registry_entry: {
    why: 'removes an asset, settlement app or bridge adapter from a v2 registry',
    requireAll: ['.remove(', 'E_LAST_ASSET'],
    forbid: ['.insert(', 'push_back'],
  },
  cancel_registry_addition: {
    why: 'withdraws an announced registry addition before it takes effect',
    requireAll: ['pending_additions.remove('],
    forbid: ['.insert(', 'push_back'],
  },
  disable_legacy: {
    why: 'switches the deprecated per-person approval path off, for good',
    requireAll: ['legacy_enabled = false'],
    forbid: ['legacy_enabled = true'],
  },
};

/** Loosening shapes no `&ComplianceCap` function may contain, whatever its name. */
const NEVER = [
  { pattern: '.insert(', why: 'adding a DeepBook venue is a loosening — use admin_allow_pool' },
  { pattern: 'paused = false', why: 'resuming settlement is a loosening — use admin_set_paused' },
  { pattern: 'legacy_enabled = true', why: 're-opening the legacy approval path is a loosening, and nothing may do it' },
];

/**
 * Patterns no function in splash_core may contain, whatever cap it takes.
 *
 * `legacy_enabled` is one-way by design: once compliance or governance has
 * declared migration complete, no key may re-open the deprecated per-person
 * path. The initial `legacy_enabled: true` in `create`'s struct literal is not
 * an assignment and does not match.
 */
const NOWHERE = [
  { pattern: 'legacy_enabled = true', why: 'the legacy approval path can only ever be switched off' },
];

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, '').replace(/^\s*\/\/\/.*$/, ''))
    .join('\n');
}

/**
 * Every `fun` in the file with its body, comment-stripped.
 *
 * Brace counting rather than a regex over the whole function: a regex that
 * tries to match a balanced body either stops at the first `}` (and misses
 * everything after an `if`) or runs to the end of the file.
 */
function functions(source) {
  const code = stripComments(source);
  const out = [];
  const signature = /\b(?:public(?:\([a-z]+\))?\s+)?fun\s+([A-Za-z0-9_]+)\s*(?:<[^>]*>)?\s*\(/g;
  let match;
  while ((match = signature.exec(code)) !== null) {
    const name = match[1];
    // Parameter list: balance parentheses from the opening one.
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

    // Body: from the first `{` after the parameter list.
    const braceStart = code.indexOf('{', paramsEnd);
    let body = '';
    if (braceStart !== -1) {
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
    }
    out.push({ name, params, body });
  }
  return out;
}

const failures = [];
let inspected = 0;

for (const file of readdirSync(SOURCES).filter((f) => f.endsWith('.move'))) {
  const path = join(SOURCES, file);
  const source = readFileSync(path, 'utf8');

  // The cap must stay non-transferable-by-store. `store` would let it be
  // wrapped or public_transfer'd out of the module, past `transfer_cap`.
  if (/public struct ComplianceCap has ([^{]*)\{/.test(source)) {
    const abilities = source.match(/public struct ComplianceCap has ([^{]*)\{/)[1];
    if (abilities.includes('store')) {
      failures.push(`${path}: ComplianceCap gained \`store\` — it must be \`key\` only.`);
    }
  }

  for (const fn of functions(source)) {
    for (const { pattern, why } of NOWHERE) {
      if (fn.body.includes(pattern)) {
        failures.push(`${path}: \`${fn.name}\` contains \`${pattern}\` — ${why}.`);
      }
    }
    if (!/&\s*ComplianceCap\b/.test(fn.params)) continue;

    // Pure reads are exempt, structurally rather than by name: a function with
    // no `&mut` parameter and no transfer or event in its body changes nothing,
    // and a function that changes nothing cannot loosen a control. That is what
    // lets `assert_compliance_cap` and the generation getter take the cap
    // without being enumerated here as subtractive operations.
    const mutates =
      /&\s*mut\b/.test(fn.params) || /transfer::/.test(fn.body) || /event::emit/.test(fn.body);
    if (!mutates) continue;

    inspected += 1;

    const rule = ALLOWED[fn.name];
    if (!rule) {
      failures.push(
        `${path}: \`${fn.name}\` takes \`&ComplianceCap\` but is not an approved subtractive operation.\n` +
          `    ComplianceCap may only make controls STRICTER. If this function can loosen\n` +
          `    anything, gate it on \`&AdminCap\`. If it genuinely cannot, add it to ALLOWED\n` +
          `    in ${process.argv[1]} and say why in the commit message.`,
      );
      continue;
    }

    for (const needle of rule.requireAll ?? []) {
      const count = fn.body.split(needle).length - 1;
      const need = rule.minOccurrences?.[needle] ?? 1;
      if (count < need) {
        failures.push(
          `${path}: \`${fn.name}\` should contain \`${needle}\` at least ${need} time(s) ` +
            `(found ${count}) — ${rule.why}.`,
        );
      }
    }
    for (const needle of rule.forbid ?? []) {
      if (fn.body.includes(needle)) {
        failures.push(`${path}: \`${fn.name}\` contains \`${needle}\`, which is a loosening.`);
      }
    }
    for (const { pattern, why } of NEVER) {
      if (fn.body.includes(pattern)) {
        failures.push(`${path}: \`${fn.name}\` contains \`${pattern}\` — ${why}.`);
      }
    }
  }
}

if (inspected === 0) {
  console.error(
    'No function takes `&ComplianceCap`. Either the capability was removed — in which\n' +
      'case delete this check deliberately — or this script has stopped finding what it\n' +
      'is meant to guard, which is worse than not having it.',
  );
  process.exit(1);
}

if (failures.length > 0) {
  console.error('ComplianceCap is meant to be subtractive. These break that:\n');
  for (const failure of failures) console.error(`  • ${failure}\n`);
  process.exit(1);
}

console.log(
  `ComplianceCap is subtractive: ${inspected} function(s) take it, all of them tightening.`,
);
