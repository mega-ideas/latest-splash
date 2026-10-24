/**
 * No TS/JS code names a splash_core or splash_spend function, event or type
 * that the v2 sources do not have, unless it is marked as a v1 testnet
 * builder (carried finding, LOW).
 *
 * v2 core dropped the v1 entry points (create_payment_intent,
 * confirm_payment_intent, confirm_with_approval, the business_account
 * PayoutApproved events, ...). A builder or event listener that still names
 * one either never runs or runs only against the v1 package on testnet. The
 * first kind is removed; the second is kept, marked "V1 TESTNET ONLY" in the
 * doc comment of the function that builds it (or in the file's header), so a
 * reader knows Phase 2's v2 builder replaces it and mainnet never reaches it.
 *
 * What is read: every `::<module>::<name>` inside a string or template
 * literal in .ts/.tsx/.js/.mjs under app/, components/, lib/ and scripts/,
 * comments stripped, where <module> is a splash_core or splash_spend module.
 * Abort-code explanations (lines of an ABORT_CODES table, `123: '…'`) are
 * check:aborts's business and are not read here.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const PACKAGES = ['splash_core', 'splash_spend'];
const ROOTS = ['app', 'components', 'lib', 'scripts'];
const MARK = /V1 TESTNET ONLY/;

/** module -> every fun, struct and const name it declares. */
function sourceNames() {
  const names = new Map();
  for (const pkg of PACKAGES) {
    const dir = path.join('move', pkg, 'sources');
    for (const file of readdirSync(dir)) {
      const src = readFileSync(path.join(dir, file), 'utf8');
      const mod = /module\s+\w+::(\w+)/.exec(src)?.[1];
      if (!mod) continue;
      const set = names.get(mod) ?? new Set();
      for (const m of src.matchAll(/\bfun\s+(\w+)|\bstruct\s+(\w+)|\bconst\s+(\w+)/g)) set.add(m[1] ?? m[2] ?? m[3]);
      names.set(mod, set);
    }
  }
  return names;
}

function files(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' || e.name.startsWith('.') ? [] : files(full);
    return /\.(ts|tsx|js|mjs)$/.test(e.name) ? [full] : [];
  });
}

/** Comments blanked line for line, so line numbers hold. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((line) => line.replace(/(^|[^:'"`\\])\/\/.*$/, '$1'))
    .join('\n');
}

/** Whether line `i` sits in a function (or file) whose doc comment carries the mark. */
function marked(lines, raw, i) {
  if (MARK.test(raw.slice(0, 60).join('\n')) && /whole file/i.test(raw.slice(0, 60).join('\n'))) return true;
  for (let j = i; j >= 0; j -= 1) {
    if (/^(export\s+)?(async\s+)?function\s|^export\s+const\s|^const\s+\w+\s*=\s*(async\s*)?\(/.test(lines[j])) {
      const above = raw.slice(Math.max(0, j - 40), j).join('\n');
      const doc = above.slice(above.lastIndexOf('/**'));
      return above.includes('/**') && MARK.test(doc);
    }
  }
  return false;
}

function deadReferences() {
  const names = sourceNames();
  const out = [];
  for (const root of ROOTS) {
    for (const full of files(root)) {
      const rawText = readFileSync(full, 'utf8').replace(/\r\n/g, '\n');
      const raw = rawText.split('\n');
      const lines = stripComments(rawText).split('\n');
      lines.forEach((line, i) => {
        if (/^\s*\d+:\s*['"`]/.test(line)) return; // an ABORT_CODES entry
        for (const m of line.matchAll(/::(\w+)::(\w+)/g)) {
          const [, mod, name] = m;
          const known = names.get(mod);
          if (!known || known.has(name)) continue;
          if (marked(lines, raw, i)) continue;
          out.push(`${full.replace(/\\/g, '/')}:${i + 1}: ${mod}::${name}`);
        }
      });
    }
  }
  return out;
}

test('no code names a splash_core or splash_spend member the v2 sources lack, unless marked V1 TESTNET ONLY', () => {
  const dead = deadReferences();
  assert.deepEqual(dead, [], `\n  ${dead.join('\n  ')}\n`);
});

test('the v1 testnet builders say so, and refuse mainnet before they build anything', () => {
  const settlement = readFileSync('lib/server/sui-settlement.ts', 'utf8');
  for (const fn of ['createPaymentIntentOnSui', 'confirmComposedPaymentOnSui']) {
    const at = settlement.indexOf(`export async function ${fn}(`);
    assert.ok(at > 0, `${fn} exists`);
    const doc = settlement.slice(settlement.lastIndexOf('/**', at), at);
    assert.match(doc, /V1 TESTNET ONLY/, `${fn} is marked`);
    const body = settlement.slice(at, settlement.indexOf('\n}\n', at));
    assert.match(body, /refuseV1CoreBuilderOnMainnet\(/, `${fn} refuses mainnet`);
  }
});
