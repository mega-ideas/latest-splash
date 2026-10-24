/**
 * Amendment A1 §2.8: every flat 0.70% is gone.
 *
 * A1's check, run as a test:
 *
 *   rg -n "feeBps|0\.70 ?%|0\.7 ?%|70 ?bps|MAX_FEE_BPS" app components lib content scripts
 *
 * returns nothing outside lib/fees/ (the schedule, which may name the rates
 * it retires) and the retired splash_custody (move/, not searched). The
 * walk reads every text file under the five roots, as rg does, skipping
 * dependencies and build output.
 *
 * Also pinned: check:fees's PENDING_2_8, the list of literal fee rates §2.8
 * had still to remove, is empty, so no literal rate is left waiting in
 * app/, components/ or content/; and the corridor table carries no fee.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOTS = ['app', 'components', 'lib', 'content', 'scripts'];
const EXEMPT = [/^lib\/fees\//];
const SKIP_DIRS = new Set(['node_modules', '.next', 'build', '.git']);
const A1_GREP = /feeBps|0\.70 ?%|0\.7 ?%|70 ?bps|MAX_FEE_BPS/;

function files(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return SKIP_DIRS.has(e.name) ? [] : files(full);
    return [full];
  });
}

function hits() {
  const out = [];
  for (const root of ROOTS) {
    for (const full of files(root)) {
      const rel = full.replace(/\\/g, '/');
      if (EXEMPT.some((re) => re.test(rel))) continue;
      const buf = readFileSync(full);
      if (buf.includes(0)) continue; // binary, as rg skips it
      buf
        .toString('utf8')
        .split(/\r?\n/)
        .forEach((line, i) => {
          if (A1_GREP.test(line)) out.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
        });
    }
  }
  return out;
}

test("A1 §2.8's grep returns nothing outside lib/fees/ and the retired splash_custody", () => {
  const found = hits();
  assert.deepEqual(found, [], `\n  ${found.join('\n  ')}\n`);
});

test("check:fees has no literal fee rate left waiting for §2.8", async () => {
  const { PENDING_2_8 } = await import('../scripts/check-fees.mjs');
  assert.deepEqual(PENDING_2_8 ?? [], []);
});

test('a corridor carries an exchange rate and a status, never a fee', async () => {
  const corridors = await import('../lib/fx/corridors.ts');
  for (const c of corridors.USD_CORRIDORS) {
    assert.equal(Object.keys(c).some((k) => /fee/i.test(k)), false, `${c.pair} carries a fee field`);
  }
  for (const name of ['getCorridorFeeBps', 'CONTRACT_MAX_FEE_BPS', 'FALLBACK_FEE_BPS']) {
    assert.equal(name in corridors, false, `${name} is gone: the fee comes from the kind, on chain`);
  }
});
