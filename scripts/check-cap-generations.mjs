#!/usr/bin/env node
/**
 * A revoked capability must not keep working anywhere.
 *
 * Phase 7 made `AnchorCap` and `ComplianceCap` revocable by giving each a
 * generation and holding the live one in a shared `CapRegistry`. That only
 * means something if EVERY function accepting one checks it. A single consumer
 * that forgets is a hole through which a stolen cap keeps signing — and it is
 * the kind of hole found by an incident rather than by a review, because the
 * function works perfectly for the ninety-nine percent of the time nobody has
 * revoked anything.
 *
 * So the rule is checked on the signature and the body together: a function
 * that takes `&AnchorCap` must also take `&CapRegistry` and must call
 * `assert_anchor_cap`. Same for the compliance cap. Capabilities taken BY VALUE
 * are exempt — `destroy_anchor_cap`, `rotate_anchor_cap` and `transfer_cap`
 * consume the object rather than exercise its authority, and a revoked cap
 * being destroyed or handed on is harmless.
 *
 * Run by `npm run lint`.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SOURCES = 'move/splash_core/sources';

const REVOCABLE = [
  { cap: 'AnchorCap', assertFn: 'assert_anchor_cap' },
  { cap: 'ComplianceCap', assertFn: 'assert_compliance_cap' },
];

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    .map((line) => (/^\s*\/\//.test(line) ? '' : line.replace(/\/\/.*$/, '')))
    .join('\n');
}

function functions(source) {
  const code = stripComments(source);
  const out = [];
  const signature = /\b(?:public(?:\([a-z]+\))?\s+)?fun\s+([A-Za-z0-9_]+)\s*(?:<[^>]*>)?\s*\(/g;
  let match;
  while ((match = signature.exec(code)) !== null) {
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
    out.push({ name: match[1], params, body });
  }
  return out;
}

const failures = [];
const checked = { AnchorCap: 0, ComplianceCap: 0 };

for (const file of readdirSync(SOURCES).filter((f) => f.endsWith('.move'))) {
  const path = join(SOURCES, file);
  const source = readFileSync(path, 'utf8');

  for (const fn of functions(source)) {
    for (const { cap, assertFn } of REVOCABLE) {
      // By-reference only. By-value means the object is consumed, not exercised.
      if (!new RegExp(`&\\s*${cap}\\b`).test(fn.params)) continue;
      // The assert function itself is where the check lives.
      if (fn.name === assertFn) continue;
      // Test helpers do not gate anything a user can reach.
      if (fn.name.endsWith('_for_testing')) continue;
      // Pure reads are exempt, and the exemption is STRUCTURAL rather than a
      // list of names I decided to trust: a function with no `&mut` parameter
      // and no transfer or event in its body cannot change anything, so a
      // revoked capability passing through it exercises no authority. It can
      // still return data — which is a smaller concern than authority, and the
      // reason this is an exemption for reads rather than for getters.
      const mutates =
        /&\s*mut\b/.test(fn.params) || /transfer::/.test(fn.body) || /event::emit/.test(fn.body);
      if (!mutates) continue;

      checked[cap] += 1;

      if (!/&\s*CapRegistry\b/.test(fn.params)) {
        failures.push(
          `${path}: \`${fn.name}\` takes \`&${cap}\` but no \`&CapRegistry\`, so it cannot ` +
            `know whether the capability has been revoked.`,
        );
        continue;
      }
      if (!fn.body.includes(`${assertFn}(`)) {
        failures.push(
          `${path}: \`${fn.name}\` takes \`&${cap}\` and a \`&CapRegistry\` but never calls ` +
            `\`${assertFn}\`. A revoked capability would keep working here.`,
        );
      }
    }
  }
}

if (checked.AnchorCap === 0 || checked.ComplianceCap === 0) {
  const missing = Object.entries(checked)
    .filter(([, n]) => n === 0)
    .map(([cap]) => cap);
  failures.push(
    `No function exercises ${missing.join(' or ')} by reference. Either the capability was ` +
      `removed — in which case delete this check deliberately — or this script has stopped ` +
      `finding what it guards, which is worse than not having it.`,
  );
}

if (failures.length > 0) {
  console.error('A revoked capability must stop working everywhere. These break that:\n');
  for (const failure of failures) console.error(`  • ${failure}\n`);
  process.exit(1);
}

console.log(
  `Revocation is total: ${checked.AnchorCap} AnchorCap and ${checked.ComplianceCap} ` +
    `ComplianceCap consumers, every one of them generation-checked.`,
);
