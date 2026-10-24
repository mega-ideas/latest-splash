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
 * loosening. Two v2 properties ride on the same check: the legacy approval
 * path, once switched off, stays off; and the three v2 registries (accepted
 * assets, settlement apps, bridge adapters) grow only through the 24-hour
 * `activate_addition` path.
 *
 * A claim like that decays the moment someone adds a convenient setter. So it
 * is enforced on the SIGNATURE and the body together. The first version
 * matched `&ComplianceCap` and substrings of one function's own body; a review
 * compiled `&mut` and by-value cap functions, a loosening helper, a parameter
 * written into `legacy_enabled` and a registry insert past it
 * (tests/compliance-subtractive-check.test.mjs pins each one).
 *
 * WHAT THIS CHECKS, on every `.move` file under splash_core's sources/
 * (recursively, as the compiler reads them), with comments and string
 * contents blanked by the Move lexer rules in scripts/move-source.mjs:
 *
 *   1. `ComplianceCap` is declared once, with exactly `key` (prefix or postfix
 *      abilities alike), and is never imported under another name.
 *   2. Every function that takes a ComplianceCap in ANY form — `&`, `&mut` or
 *      by value — and could change anything (a `&mut` parameter, a transfer or
 *      an event) must be one of ALLOWED below and still look like the operation
 *      it claims to be. Pure reads are exempt structurally.
 *   3. Those functions loosen nothing written in their own body (no insert or
 *      push_back, nothing but `true` written to `paused`, no `&mut` borrow of
 *      it), and call no function of compliance_config except the read-only or
 *      checking HELPERS below. A loosening cannot hide one call away.
 *   4. Anywhere in core: nothing but the literal `false` is ever assigned to
 *      `legacy_enabled`, and it is never borrowed `&mut`.
 *   5. Anywhere in core except `activate_addition`: no insert in a function
 *      that touches a v2 registry (`accepted_assets`, `settlement_apps`,
 *      `bridge_adapters` or `registry_set_mut`). Except in `create`, no
 *      registry is assigned wholesale and no ComplianceConfig is packed.
 *
 * WHAT IT DOES NOT CATCH. It reads text; it does not compile or resolve types.
 *   - A loosening reached through a function of ANOTHER module that a cap
 *     function calls. Move field privacy means only compliance_config can
 *     write a ComplianceConfig field, so such a path needs a public function
 *     there, which rules 4 and 5 still see if it touches legacy_enabled or a
 *     registry, but not if it, say, resumes settlement.
 *   - Whether the asserts in an ALLOWED function compare the right way round
 *     (the Move tests in tests/compliance_tests.move do that).
 *   - A difference between this source and the bytecode published.
 * If a legitimate change trips it, restructure the change; adding a name to
 * ALLOWED or HELPERS is a deliberate act that the commit message must justify.
 *
 * Run by `npm run lint`.
 */
import path from 'node:path';

import {
  MoveLexError,
  datatypes,
  functions,
  lineOf,
  moveFiles,
  modules,
  readMove,
  squash,
  tokens,
  uses,
} from './move-source.mjs';

const SOURCES = path.join('move', 'splash_core', 'sources');
const CAP = 'ComplianceCap';
const CONFIG_MODULE = 'compliance_config';

/**
 * The complete set of functions permitted to take a ComplianceCap and change
 * something, and what each must still look like.
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
    require: [{ pattern: /\bE_NOT_A_TIGHTENING\b/g, label: 'E_NOT_A_TIGHTENING', min: 5 }],
  },
  pause: {
    why: 'halts settlement; resuming is AdminCap',
    require: [{ pattern: /\bpaused\s*=\s*true\b/g, label: 'paused = true' }],
  },
  disallow_pool: {
    why: 'removes a venue from the whitelist',
    require: [{ pattern: /\.\s*remove\s*\(/g, label: '.remove(' }],
  },
  // v2 (D11). The three registries an addition to takes 24 hours' notice and
  // the cold multisig. Taking something OFF one only stops money moving.
  remove_registry_entry: {
    why: 'removes an asset, settlement app or bridge adapter from a v2 registry',
    require: [
      { pattern: /\.\s*remove\s*\(/g, label: '.remove(' },
      { pattern: /\bE_LAST_ASSET\b/g, label: 'E_LAST_ASSET' },
    ],
  },
  cancel_registry_addition: {
    why: 'withdraws an announced registry addition before it takes effect',
    require: [{ pattern: /\bpending_additions\s*\.\s*remove\s*\(/g, label: 'pending_additions.remove(' }],
  },
  disable_legacy: {
    why: 'switches the deprecated per-person approval path off, for good',
    require: [{ pattern: /\blegacy_enabled\s*=\s*false\b/g, label: 'legacy_enabled = false' }],
  },
  // Takes the cap BY VALUE to hand it on (audit fix S-03). It touches nothing
  // else: no &mut parameter, and its body is the transfer.
  transfer_cap: {
    why: 'hands the cap to a new holder and changes nothing else',
    require: [{ pattern: /\btransfer\s*::\s*transfer\s*\(\s*cap\s*,/g, label: 'transfer::transfer(cap, …)' }],
    noMutableParameter: true,
  },
};

/** compliance_config functions an ALLOWED function may call: they read or check, and write nothing. */
const HELPERS = new Set(['assert_compliance_cap', 'find_pending', 'registry_set', 'registry_set_mut', 'emit_update', 'assert_valid']);

/** Loosening shapes no ComplianceCap function may contain, whatever its name. */
const NEVER = [
  { pattern: /\binsert\s*\(/, why: 'adding a venue or a registry entry is a loosening — admin_allow_pool, or the 24-hour activate_addition' },
  { pattern: /\bpush_back\s*\(/, why: 'adding to a list is a loosening' },
  { pattern: /\bpaused\s*=(?!=)(?!\s*true\b)/, why: 'anything but `true` written to paused can resume settlement — use admin_set_paused' },
  { pattern: /&\s*mut\s+[\w.]*\bpaused\b/, why: 'a mutable borrow of paused can resume settlement' },
];

const REGISTRIES = /\b(?:accepted_assets|settlement_apps|bridge_adapters|registry_set_mut)\b/;
const REGISTRY_ASSIGNED = /\b(?:accepted_assets|settlement_apps|bridge_adapters)\s*=(?!=)|\*\s*registry_set_mut\s*\(/;

const failures = [];
let inspected = 0;

let files;
try {
  files = moveFiles(SOURCES);
} catch {
  console.error(`${SOURCES} is not readable — this check cannot verify what it claims to.`);
  process.exit(1);
}

const units = [];
for (const file of files) {
  try {
    const unit = readMove(file);
    unit.fns = functions(unit.code);
    unit.modules = modules(unit.code).map((m) => m.name);
    units.push(unit);
  } catch (error) {
    if (!(error instanceof MoveLexError)) throw error;
    failures.push(`${error.message}. The check cannot read what the compiler would.`);
  }
}
const at = (unit, index) => `${path.normalize(unit.file)}:${lineOf(unit.raw, index)}`;

// The functions of compliance_config, which only it can use to write a
// ComplianceConfig field.
const configFns = new Set(units.filter((u) => u.modules.includes(CONFIG_MODULE)).flatMap((u) => u.fns.map((f) => f.name)));

// 1. The cap itself.
const capDecls = units.flatMap((u) => datatypes(u.code).filter((t) => t.name === CAP).map((t) => ({ u, t })));
if (capDecls.length !== 1) {
  failures.push(`${SOURCES}: \`struct ${CAP}\` is declared ${capDecls.length} time(s); this check needs exactly one.`);
}
for (const { u, t } of capDecls) {
  const abilities = [...t.abilities].sort().join(', ');
  if (abilities !== 'key') {
    failures.push(`${at(u, t.index)}: ${CAP} has \`${abilities || 'no abilities'}\` — it must be \`key\` only. \`store\` would let it be wrapped or public_transfer'd past \`transfer_cap\`.`);
  }
}
for (const unit of units) {
  for (const u of uses(unit.code)) {
    if (!u.fun && u.alias && u.path.split('::').at(-1) === CAP) {
      failures.push(`${at(unit, u.index)}: \`use ${u.path} as ${u.alias}\` — ${CAP} is never imported under another name.`);
    }
  }
}

for (const unit of units) {
  const inConfig = unit.modules.includes(CONFIG_MODULE);
  for (const fn of unit.fns) {
    const where = at(unit, fn.index);
    const body = fn.body;

    // 4. legacy_enabled is one-way, everywhere.
    if (/\blegacy_enabled\s*=(?!=)(?!\s*false\b)/.test(body)) {
      failures.push(`${where}: \`${fn.name}\` assigns legacy_enabled something other than \`false\` — the legacy approval path can only ever be switched off.`);
    }
    if (/&\s*mut\s+[\w.]*\blegacy_enabled\b/.test(body)) {
      failures.push(`${where}: \`${fn.name}\` borrows legacy_enabled mutably — the legacy approval path can only ever be switched off.`);
    }

    // 5. The v2 registries grow only through the 24-hour path.
    if (fn.name !== 'activate_addition' && fn.name !== 'create' && REGISTRIES.test(body) && /\binsert\s*\(/.test(body)) {
      failures.push(`${where}: \`${fn.name}\` inserts into a v2 registry. Additions go through propose_addition, 24 hours' notice and activate_addition only.`);
    }
    if (fn.name !== 'create' && REGISTRY_ASSIGNED.test(body)) {
      failures.push(`${where}: \`${fn.name}\` replaces a v2 registry wholesale. Only create builds them.`);
    }
    if (fn.name !== 'create' && /\bComplianceConfig\s*\{/.test(body)) {
      failures.push(`${where}: \`${fn.name}\` packs a ComplianceConfig. Only create builds one, once.`);
    }

    // 2. Every function that takes the cap, in any form.
    if (!tokens(fn.params, CAP).length) continue;

    // Pure reads are exempt, structurally rather than by name: a function with
    // no `&mut` parameter and no transfer or event in its body changes nothing,
    // and a function that changes nothing cannot loosen a control. That is what
    // lets `assert_compliance_cap` and the generation getter take the cap
    // without being enumerated here as subtractive operations.
    const mutableParameter = /&\s*mut\b/.test(fn.params);
    const mutates = mutableParameter || /\btransfer\s*::/.test(body) || /\bevent\s*::\s*emit\b/.test(body);
    if (!mutates) continue;

    inspected += 1;

    const rule = ALLOWED[fn.name];
    if (!rule || !inConfig) {
      failures.push(
        `${where}: \`${fn.name}\` takes \`${CAP}\` but is not an approved subtractive operation.\n` +
          `    ComplianceCap may only make controls STRICTER. If this function can loosen\n` +
          `    anything, gate it on \`&AdminCap\`. If it genuinely cannot, add it to ALLOWED\n` +
          `    in scripts/check-compliance-subtractive.mjs and say why in the commit message.`,
      );
      continue;
    }

    for (const { pattern, label, min = 1 } of rule.require ?? []) {
      const count = body.match(pattern)?.length ?? 0;
      if (count < min) {
        failures.push(`${where}: \`${fn.name}\` should contain \`${label}\` at least ${min} time(s) (found ${count}) — ${rule.why}.`);
      }
    }
    if (rule.noMutableParameter && mutableParameter) {
      failures.push(`${where}: \`${fn.name}\` takes a \`&mut\` parameter — ${rule.why}.`);
    }
    for (const { pattern, why } of NEVER) {
      if (pattern.test(body)) failures.push(`${where}: \`${fn.name}\` contains \`${squash(body.match(pattern)[0])}\` — ${why}.`);
    }

    // 3. No loosening one call away.
    const called = new Set();
    for (const name of configFns) {
      if (name === fn.name) continue;
      // A bare or method call in this module, or a qualified one from another.
      const bare = new RegExp(`(?<![\\w$:])\\.?\\s*${name}\\s*(?:<[^<>]*>)?\\s*\\(`);
      const qualified = new RegExp(`\\b${CONFIG_MODULE}\\s*::\\s*${name}\\s*(?:<[^<>]*>)?\\s*\\(`);
      if (qualified.test(body) || (inConfig && bare.test(body))) called.add(name);
    }
    for (const name of called) {
      if (!HELPERS.has(name)) {
        failures.push(`${where}: \`${fn.name}\` calls \`${name}\`, which this check does not inspect. Write the change out in the function that takes the cap, or add \`${name}\` to HELPERS if it writes nothing.`);
      }
    }
  }
}

if (inspected === 0) {
  console.error(
    'No function takes `ComplianceCap` and changes anything. Either the capability was\n' +
      'removed — in which case delete this check deliberately — or this script has stopped\n' +
      'finding what it is meant to guard, which is worse than not having it.',
  );
  process.exit(1);
}

if (failures.length > 0) {
  console.error('ComplianceCap is meant to be subtractive. These break that:\n');
  for (const failure of failures) console.error(`  • ${failure}\n`);
  process.exit(1);
}

console.log(`ComplianceCap is subtractive: ${inspected} function(s) take it, all of them tightening.`);
