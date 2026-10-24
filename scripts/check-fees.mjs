#!/usr/bin/env node
/**
 * check:fees — Amendment A1 §4's guard on Splash's fee. Runs in `npm run lint`.
 *
 * Four rules, each a function below that takes the repository root and
 * returns its failures, so tests/fee-check.test.mjs can plant a breach of
 * each into a scratch copy and see it caught.
 *
 * (a) THE MOVE VECTOR TEST IS UP TO DATE. move/splash_core/tests/
 *     fee_vectors_tests.move is byte for byte (line ends aside) what
 *     scripts/gen-fee-tests.mjs makes of lib/fees/vectors.json, so a vector
 *     edited without regenerating cannot pass for tested on chain.
 *
 * (b) ONE CEILING. FEE_CEILING_BPS, and the BPS_DENOM it is a fraction of,
 *     are each defined exactly once in splash_core's sources, once in
 *     splash_spend's and once in lib/fees/schedule.ts, with the same value
 *     in all three; and the ceiling is A1 §2.1's 100 bps. splash_spend
 *     re-checks the ceiling with its own constant so that no core upgrade can
 *     raise what a rule payment pays; that only holds while the two agree.
 *     A Move constant counts only in code (comments and strings are blanked
 *     by scripts/move-source.mjs); in schedule.ts only an
 *     `export const NAME = <digits>n;` at the start of a line counts.
 *
 * (c) NO LITERAL FEE RATE IN app/, components/ OR content/. Customer copy is
 *     rendered from the schedule (A1 §2.7), never typed in. Every line of
 *     every .ts .tsx .js .jsx .mjs .cjs .json .md .mdx file under those three
 *     directories is read as text, comments included (a rate in a comment
 *     goes stale the same way). A RATE is a number, or a range of two,
 *     followed by `%`, `bps`, `bp` or `basis point(s)` (`0.70%`, `0.7 %`,
 *     `3–5%`, `70 bps`, `15–30 bps`), but not one inside `[…]`, such as a
 *     Tailwind `w-[60%]`. FEE WORDING is one of the words fee, fees, charge,
 *     charges, charged, commission, commissions, pricing, surcharge or
 *     markup, alone or as one word of an identifier (`corridorFee`,
 *     `fee_bps` and `FEE_LABEL` count; `feedback` and `coffee` do not). A
 *     line holds a literal fee rate when it has:
 *       1. a rate and fee wording (`'Fee to local currency', '0.70%'`);
 *       2. a rate equal to one of SPLASH'S OWN RATES, with or without fee
 *          wording: any non-zero rate of fee_config's launch schedule (read
 *          from `launch_schedules`, so 2, 5, 7, 10, 12, 15, 20 and 30 bps
 *          today) or the retired flat 70 bps. This is what catches a typed
 *          pricing line ("0.02% to any Sui wallet") or ticker
 *          (`['0.70%', 'to local currency']`);
 *       3. fee wording and a decimal fraction as a multiplier
 *          (`const fee = source * 0.007`);
 *       4. a fee-rate identifier given a number: a name with `fee` and one of
 *          bps, bp, rate, percent, pct or percentage among its words, then
 *          `:` or `=`, then a numeric literal (`feeBps: 18`,
 *          `"fee_rate": 0.007`).
 *     Allowed: a rate that is not Splash's with no fee wording on its line
 *     (`0.5% slippage`, `-12%`); a fee AMOUNT, which is not a rate
 *     (`min 0.25 USDC`); a fee rate rendered from data
 *     (`${formatBps(bps)}`). lib/ is not scanned: lib/fees holds the
 *     schedule, and the rest of lib/ is §2.8's own grep.
 *     PENDING_2_8 below lists, per file and per rate, the literals A1 §2.8
 *     has still to remove. It can only shrink: a count that no longer
 *     matches, either way, fails, so a new literal cannot hide behind an old
 *     one and a removed one must come off the list.
 *
 * (d) NO IMMEDIATE SETTER BUT set_discount. In splash_core::fee_config,
 *     outside `#[test_only]` and `#[test]` functions (they never publish):
 *       1. Only the five changes below take a FeeConfig mutably or by value,
 *          and each takes `&FeeAdminCap`. A sixth, private or public, fails.
 *       2. The in-force fields are written only by their own change:
 *          `schedules` by apply_schedule, `fee_recipient` by
 *          apply_fee_recipient, `discounts` by set_discount; the pending
 *          slots only by their propose_* and apply_*. A write is an
 *          assignment (`.f = `, `.f[i] = `), a `&mut` borrow of the field, or
 *          a method call on it other than a read (borrow, contains, length,
 *          is_some, is_none, is_empty).
 *       3. Each apply_* asserts E_FEE_PROPOSAL_NOT_READY against `eta_ms`
 *          before it writes the in-force field; each propose_* sets its eta
 *          as `+ FEE_NOTICE_MS`; FEE_NOTICE_MS is at least 24 hours; nothing
 *          assigns an `eta_ms`.
 *       4. No second way to a config: a FeeConfig is packed only in `new`,
 *          and `new` is called only by `init`. A payer could otherwise hand a
 *          settle path a config of its own.
 *       5. Nothing returns a `&mut`, and the module has no `use fun` alias,
 *          which this text check could not follow.
 *
 * WHAT IT DOES NOT CATCH. It reads text; it neither compiles nor resolves
 * names. (c) misses a rate that is not one of Splash's and has its fee
 * wording on another line (`value: '6.5%'` under a `fee:` label), and a
 * rate written without a unit (`70 / 10_000`). A write to a FeeConfig field
 * through a reference held in a local after a read borrow, or through a
 * helper of another module, is out of (d)'s sight; Move field privacy means
 * only fee_config can write its fields, and rule 1 sees every fee_config
 * function that could. The boundary is review of the exact source commit
 * before the fresh publish; this is the tripwire for honest mistakes.
 * Adding a name to an allow-list here is a deliberate act its commit
 * message must justify.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { generatedIsCurrent } from './gen-fee-tests.mjs';
import { MoveLexError, functions, lineOf, moveFiles, modules, parameters, readMove, squash } from './move-source.mjs';

// ─── (a) the generated Move vector test ─────────────────────────────────────

export function checkGeneratedVectors(root) {
  let r;
  try {
    r = generatedIsCurrent(root);
  } catch (error) {
    return [`(a) lib/fees/vectors.json cannot be turned into the Move test: ${error.message}`];
  }
  return r.current ? [] : [`(a) ${r.reason}. Run \`node scripts/gen-fee-tests.mjs\` and commit the result.`];
}

// ─── (b) one ceiling ─────────────────────────────────────────────────────────

export const A1_CEILING_BPS = 100n;
const CORE_SOURCES = path.join('move', 'splash_core', 'sources');
const SPEND_SOURCES = path.join('move', 'splash_spend', 'sources');
const SCHEDULE_TS = path.join('lib', 'fees', 'schedule.ts');

const number = (digits) => BigInt(digits.replace(/_/g, ''));

/** Every `const NAME: u64 = <n>;` in the code (not comments) of the .move files under `dir`. */
function moveConstants(root, dir, name) {
  const found = [];
  for (const file of moveFiles(path.join(root, dir))) {
    const unit = readMove(file);
    const re = new RegExp(`\\bconst\\s+${name}\\s*:\\s*\\w+\\s*=\\s*([0-9][0-9_]*)(?:u\\d+)?\\s*;`, 'g');
    for (const m of unit.code.matchAll(re)) {
      found.push({ where: `${path.relative(root, file)}:${lineOf(unit.raw, m.index)}`, value: number(m[1]) });
    }
  }
  return found;
}

function tsConstants(root, file, name) {
  const raw = readFileSync(path.join(root, file), 'utf8');
  const re = new RegExp(`^export\\s+const\\s+${name}\\s*=\\s*([0-9][0-9_]*)n?\\s*;`, 'gm');
  return [...raw.matchAll(re)].map((m) => ({ where: `${file}:${lineOf(raw, m.index)}`, value: number(m[1]) }));
}

export function checkCeiling(root) {
  const failures = [];
  const values = {};
  for (const name of ['FEE_CEILING_BPS', 'BPS_DENOM']) {
    const places = [
      ['splash_core', () => moveConstants(root, CORE_SOURCES, name)],
      ['splash_spend', () => moveConstants(root, SPEND_SOURCES, name)],
      [SCHEDULE_TS.replace(/\\/g, '/'), () => tsConstants(root, SCHEDULE_TS, name)],
    ];
    const seen = [];
    for (const [label, read] of places) {
      let defs;
      try {
        defs = read();
      } catch (error) {
        failures.push(`(b) ${label}: cannot be read (${error instanceof MoveLexError ? error.message : error.code ?? error.message}).`);
        continue;
      }
      if (defs.length !== 1) {
        failures.push(`(b) ${label} defines ${name} ${defs.length} time(s)${defs.length ? ` (${defs.map((d) => d.where).join(', ')})` : ''}; it must define it exactly once.`);
        continue;
      }
      seen.push({ label, ...defs[0] });
    }
    const distinct = new Set(seen.map((s) => s.value));
    if (distinct.size > 1) {
      failures.push(`(b) ${name} differs: ${seen.map((s) => `${s.value} in ${s.label} (${s.where})`).join(', ')}. It must be identical in all three.`);
    }
    values[name] = seen;
  }
  for (const s of values.FEE_CEILING_BPS ?? []) {
    if (s.value !== A1_CEILING_BPS) {
      failures.push(`(b) FEE_CEILING_BPS is ${s.value} in ${s.label} (${s.where}); A1 §2.1 fixes the ceiling at ${A1_CEILING_BPS} bps.`);
    }
  }
  return failures;
}

// ─── (c) no literal fee rate in app/, components/, content/ ─────────────────

export const RATE_ROOTS = ['app', 'components', 'content'];
const RATE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.mdx']);
const FEE_WORDS = new Set(['fee', 'fees', 'charge', 'charges', 'charged', 'commission', 'commissions', 'pricing', 'surcharge', 'markup']);
const RATE_WORDS = new Set(['bps', 'bp', 'rate', 'percent', 'pct', 'percentage']);
/** The flat rate A1 §1 and §2.8 retire, in bps: 0.70%. Never a Splash rate again. */
export const RETIRED_BPS = Object.freeze([70n]);
/** `0.70%`, `3–5%`, `70 bps`, `15–30 bps`, `2 basis points`; not `w-[60%]`. */
const RATE = /(?<![\w.[])(\d+(?:[.,]\d+)?)(?:\s?[–-]\s?(\d+(?:[.,]\d+)?))?\s?(%|bps\b|bp\b|basis[\s-]points?\b)(?!\])/gi;
/** `feeBps: 18`, `"fee_rate": 0.007`. */
const NAMED = /(?<![\w$])([A-Za-z_][\w$]*)["']?\s*[:=]\s*(-?\d[\d_]*(?:\.\d+)?)/g;
/** `* 0.007`, `0.014 *`. */
const FRACTION = /\*\s*(0?\.\d+)(?![\d.])|(?<![\w.])(0?\.\d+)\s*\*/g;

/** The words of a line, identifiers split at camelCase and underscores, lower case. */
export function words(text) {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
}

/** A rate literal's value in basis points, or null if it is not a whole number of them. */
function toBps(value, unit) {
  const n = Number(value.replace(',', '.'));
  const bps = /%/.test(unit) ? n * 100 : n;
  const whole = Math.round(bps);
  return Math.abs(bps - whole) < 1e-9 ? BigInt(whole) : null;
}

/**
 * The bps rates of fee_config's launch schedule (the `rates` vector of each
 * `build(KIND_…, uppers, rates, …)` in `launch_schedules`), other than 0,
 * and the retired flat rate. Throws if it cannot find them.
 */
export function splashRates(root) {
  const unit = moveFiles(path.join(root, CORE_SOURCES))
    .map(readMove)
    .find((u) => modules(u.code).some((m) => m.address === 'splash_core' && m.name === 'fee_config'));
  const fn = unit && functions(unit.code).find((f) => f.name === 'launch_schedules');
  if (!fn) throw new Error('splash_core::fee_config has no launch_schedules');
  const rates = new Set(RETIRED_BPS);
  const re = /\bbuild\s*\(\s*KIND_\w+\s*,\s*(?:[A-Za-z_]\w*|vector\s*\[[^\]]*\])\s*,\s*vector\s*\[([^\]]*)\]/g;
  let schedules = 0;
  for (const m of fn.body.matchAll(re)) {
    schedules += 1;
    for (const r of m[1].split(',').map((s) => s.trim()).filter(Boolean)) if (number(r) > 0n) rates.add(number(r));
  }
  if (schedules === 0) throw new Error('fee_config::launch_schedules builds no schedule this check can read');
  return rates;
}

/**
 * The literal fee rates on one line, as written (whitespace removed). `rates`
 * is the set of Splash's own rates in bps (`splashRates`).
 */
export function feeRatesInLine(line, rates) {
  const found = [];
  const feeWording = words(line).some((w) => FEE_WORDS.has(w));
  for (const m of line.matchAll(RATE)) {
    const ends = [m[1], m[2]].filter(Boolean).map((v) => toBps(v, m[3]));
    if (feeWording || ends.some((b) => b !== null && rates.has(b))) found.push(squash(m[0]).toLowerCase());
  }
  if (feeWording) for (const m of line.matchAll(FRACTION)) found.push(`*${m[1] ?? m[2]}`);
  for (const m of line.matchAll(NAMED)) {
    const w = words(m[1]);
    if (w.includes('fee') && w.some((x) => RATE_WORDS.has(x))) found.push(`${m[1]}=${m[2]}`);
  }
  return found;
}

function textFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...textFiles(full));
    else if (RATE_EXTENSIONS.has(path.extname(e.name))) out.push(full);
  }
  return out.sort();
}

/** Every literal fee rate under app/, components/ and content/: `{ file, line, rate }`. */
export function feeRateLiterals(root, rates = splashRates(root)) {
  const out = [];
  for (const dir of RATE_ROOTS) {
    for (const full of textFiles(path.join(root, dir))) {
      const file = path.relative(root, full).replace(/\\/g, '/');
      readFileSync(full, 'utf8')
        .split(/\r?\n/)
        .forEach((text, i) => {
          for (const rate of feeRatesInLine(text, rates)) out.push({ file, line: i + 1, rate });
        });
    }
  }
  return out;
}

/**
 * The literal fee rates A1 §2.8 has still to remove (with the flat 0.70% and
 * the copy §2.7 renders from the schedule), per file and rate as
 * `feeRatesInLine` writes it, with how many there are. §2.8 empties this
 * list; nothing is ever added to it.
 */
export const PENDING_2_8 = Object.freeze([
  // Demo numbers: a "1.5% headline" fee estimate.
  { file: 'app/admin/(console)/transactions/page.tsx', rate: '*0.015', count: 1 },
  { file: 'app/admin/(console)/transactions/page.tsx', rate: '1.5%', count: 1 },
  // "15–30 bps cheaper FX": an FX-spread claim, not a fee, but in Splash's
  // own rates; §2.8 removes the same claim from Zeke's reply.
  { file: 'app/dashboard/batch/page.tsx', rate: '15–30bps', count: 1 },
  { file: 'app/dashboard/batch/page.tsx', rate: '*0.014', count: 1 },
  { file: 'app/dashboard/treasury/page.tsx', rate: '*0.014', count: 1 },
  // Seed and demo data.
  { file: 'app/queue/page.tsx', rate: 'feeBps=18', count: 1 },
  { file: 'app/queue/page.tsx', rate: 'feeBps=14', count: 1 },
  { file: 'app/queue/page.tsx', rate: 'feeBps=9', count: 1 },
  // The flat 0.70%, and the comparison table beside it.
  { file: 'components/funding/FundingSelector.tsx', rate: '0.70%', count: 1 },
  { file: 'components/IsometricLanding.tsx', rate: '0.70%', count: 1 },
  { file: 'components/mobile/MobileLanding.tsx', rate: '0.70%', count: 2 },
  { file: 'components/mobile/MobileLanding.tsx', rate: '3–5%', count: 1 },
  { file: 'components/transfer/StepDelivery.tsx', rate: '0.00%', count: 1 },
  { file: 'content/claims.ts', rate: '0.70%', count: 1 },
  { file: 'content/claims.ts', rate: '70bps', count: 1 },
  { file: 'content/sea-numbers.ts', rate: '0.70%', count: 1 },
  // The first fee design's audit-anchor fee, 0.02% (min 0.05, max 5 USDC).
  { file: 'components/stablecoin/SendUsdcDesk.tsx', rate: '0.02%', count: 2 },
]);

export function checkFeeRates(root, pending = PENDING_2_8) {
  let found;
  try {
    found = feeRateLiterals(root);
  } catch (error) {
    return [`(c) Splash's rates cannot be read from fee_config (${error.message}); this check cannot tell a fee rate from any other number.`];
  }
  const failures = [];
  const key = (file, rate) => `${file}\u0000${rate}`;
  const counts = new Map();
  for (const f of found) counts.set(key(f.file, f.rate), (counts.get(key(f.file, f.rate)) ?? 0) + 1);
  const allowed = new Set(pending.map((p) => key(p.file, p.rate)));
  for (const f of found) {
    if (!allowed.has(key(f.file, f.rate))) {
      failures.push(`(c) ${f.file}:${f.line}: \`${f.rate}\` is a literal fee rate. Render it from the schedule (lib/fees/schedule.ts, the quote API), never type it in.`);
    }
  }
  for (const p of pending) {
    const k = key(p.file, p.rate);
    const n = counts.get(k) ?? 0;
    if (n === p.count) continue;
    const lines = found.filter((f) => key(f.file, f.rate) === k).map((f) => f.line);
    failures.push(
      n > p.count
        ? `(c) ${p.file}: \`${p.rate}\` is a literal fee rate ${n} time(s) (lines ${lines.join(', ')}); PENDING_2_8 allows ${p.count}. A new one cannot join those A1 §2.8 is removing.`
        : `(c) ${p.file}: \`${p.rate}\` is a literal fee rate ${n} time(s)${lines.length ? ` (lines ${lines.join(', ')})` : ''}; PENDING_2_8 still lists ${p.count}. Lower or remove its entry in scripts/check-fees.mjs.`,
    );
  }
  return failures;
}

// ─── (d) no immediate setter in fee_config but set_discount ─────────────────

const FEE_MODULE = 'fee_config';
const NOTICE_MIN_MS = 86_400_000n;
const IN_FORCE = { schedules: 'apply_schedule', fee_recipient: 'apply_fee_recipient', discounts: 'set_discount' };
const PENDING_FIELDS = {
  pending_schedules: ['propose_schedule', 'apply_schedule'],
  pending_recipient: ['propose_fee_recipient', 'apply_fee_recipient'],
};
export const CHANGES = {
  propose_schedule: { notice: true },
  apply_schedule: { applies: 'schedules' },
  propose_fee_recipient: { notice: true },
  apply_fee_recipient: { applies: 'fee_recipient' },
  set_discount: {},
};
const READS = new Set(['borrow', 'contains', 'length', 'is_some', 'is_none', 'is_empty']);

/** The attributes written just before `start` in masked code, innermost last. */
function attributesBefore(code, start) {
  const out = [];
  let i = start - 1;
  for (;;) {
    while (i >= 0 && /\s/.test(code[i])) i -= 1;
    if (code[i] !== ']') return out;
    let depth = 0;
    let j = i;
    for (; j >= 0; j -= 1) {
      if (code[j] === ']') depth += 1;
      else if (code[j] === '[') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (j <= 0 || code[j - 1] !== '#') return out;
    out.push(code.slice(j + 1, i));
    i = j - 2;
  }
}

const isTestOnly = (code, fn) => attributesBefore(code, fn.start).some((a) => /\btest(?:_only)?\b/.test(a));

/** Offsets in `body` where `field` is written: assigned, borrowed `&mut`, or called with a non-read method. */
export function fieldWrites(body, field) {
  const at = [];
  const access = new RegExp(`\\.\\s*${field}\\b`, 'g');
  for (const m of body.matchAll(access)) {
    const before = body.slice(0, m.index);
    // `&mut cfg.field` / `&mut self.a.field`, the borrow reaching this access.
    if (/&\s*mut\s+[A-Za-z_][\w]*(?:\s*\.\s*[A-Za-z_]\w*)*\s*$/.test(before)) {
      at.push(m.index);
      continue;
    }
    let rest = body.slice(m.index + m[0].length);
    const index = /^\s*\[[^\]]*\]/.exec(rest);
    if (index) rest = rest.slice(index[0].length);
    if (/^\s*=(?!=)/.test(rest)) {
      at.push(m.index);
      continue;
    }
    const method = /^\s*\.\s*([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\(/.exec(rest);
    if (method && !READS.has(method[1])) at.push(m.index);
  }
  return at;
}

export function checkFeeConfigSetters(root) {
  const failures = [];
  let units;
  try {
    units = moveFiles(path.join(root, CORE_SOURCES)).map(readMove);
  } catch (error) {
    return [`(d) ${CORE_SOURCES} cannot be read (${error.message}); this check cannot verify what it claims to.`];
  }
  const homes = units.filter((u) => modules(u.code).some((m) => m.address === 'splash_core' && m.name === FEE_MODULE));
  if (homes.length !== 1) return [`(d) splash_core declares module ${FEE_MODULE} in ${homes.length} file(s); this check needs exactly one.`];
  const unit = homes[0];
  const where = (index) => `${path.relative(root, unit.file).replace(/\\/g, '/')}:${lineOf(unit.raw, index)}`;
  const fns = functions(unit.code).filter((f) => !isTestOnly(unit.code, f));
  const byName = new Map(fns.map((f) => [f.name, f]));

  for (const m of unit.code.matchAll(/\buse\s+fun\b/g)) {
    failures.push(`(d) ${where(m.index)}: \`use fun\` in fee_config. A method alias hides which function writes a field; call it by name.`);
  }

  // The notice itself.
  const notice = [...unit.code.matchAll(/\bconst\s+FEE_NOTICE_MS\s*:\s*\w+\s*=\s*([0-9][0-9_]*)(?:u\d+)?\s*;/g)];
  if (notice.length !== 1) failures.push(`(d) fee_config defines FEE_NOTICE_MS ${notice.length} time(s); it must define it once.`);
  else if (number(notice[0][1]) < NOTICE_MIN_MS) {
    failures.push(`(d) ${where(notice[0].index)}: FEE_NOTICE_MS is ${number(notice[0][1])} ms; a schedule or recipient change needs at least 24 hours' notice (${NOTICE_MIN_MS}).`);
  }

  for (const [name, shape] of Object.entries(CHANGES)) {
    const fn = byName.get(name);
    if (!fn) {
      failures.push(`(d) fee_config has no \`${name}\`. The fee's change functions have moved; revisit this check before trusting it.`);
      continue;
    }
    const params = parameters(fn.params).map((p) => squash(p.type));
    if (!params.includes('&FeeAdminCap')) failures.push(`(d) ${where(fn.index)}: \`${name}\` does not take &FeeAdminCap. Every fee change is the governance multisig's.`);
    if (shape.notice && !/\+\s*FEE_NOTICE_MS\b/.test(fn.body)) {
      failures.push(`(d) ${where(fn.index)}: \`${name}\` does not set its eta as \`+ FEE_NOTICE_MS\`. A proposal waits 24 hours.`);
    }
    if (shape.applies) {
      const gate = fn.body.search(/\bE_FEE_PROPOSAL_NOT_READY\b/);
      const writes = fieldWrites(fn.body, shape.applies);
      if (gate === -1 || !/\beta_ms\b/.test(fn.body)) {
        failures.push(`(d) ${where(fn.index)}: \`${name}\` does not assert E_FEE_PROPOSAL_NOT_READY against the proposal's eta_ms. Applying early must abort.`);
      } else if (writes.length && writes[0] < gate) {
        failures.push(`(d) ${where(fn.bodyStart + writes[0])}: \`${name}\` writes ${shape.applies} before it checks the eta.`);
      }
    }
  }

  for (const fn of fns) {
    const params = parameters(fn.params).map((p) => squash(p.type));
    const takesConfig = params.some((t) => /^(?:&mut)?FeeConfig$/.test(t));
    if (takesConfig && !(fn.name in CHANGES)) {
      failures.push(`(d) ${where(fn.index)}: \`${fn.name}\` takes a FeeConfig ${params.find((t) => /^(?:&mut)?FeeConfig$/.test(t)).startsWith('&mut') ? 'mutably' : 'by value'}. Only ${Object.keys(CHANGES).join(', ')} may; any other is a change without the 24-hour notice.`);
    }
    if (/&\s*mut\b/.test(fn.returns)) failures.push(`(d) ${where(fn.index)}: \`${fn.name}\` returns \`${fn.returns}\`. A mutable reference out of fee_config is a setter by another name.`);
    for (const [field, owner] of Object.entries(IN_FORCE)) {
      for (const w of fieldWrites(fn.body, field)) {
        if (fn.name !== owner) failures.push(`(d) ${where(fn.bodyStart + w)}: \`${fn.name}\` writes ${field}; only \`${owner}\` may.`);
      }
    }
    for (const [field, owners] of Object.entries(PENDING_FIELDS)) {
      for (const w of fieldWrites(fn.body, field)) {
        if (!owners.includes(fn.name)) failures.push(`(d) ${where(fn.bodyStart + w)}: \`${fn.name}\` writes ${field}; only ${owners.join(' and ')} may.`);
      }
    }
    for (const m of fn.body.matchAll(/\.\s*eta_ms\s*=(?!=)/g)) {
      failures.push(`(d) ${where(fn.bodyStart + m.index)}: \`${fn.name}\` assigns an eta_ms. A proposal's notice is set once, when it is made.`);
    }
    for (const m of fn.body.matchAll(/\bFeeConfig\s*\{/g)) {
      if (fn.name !== 'new') failures.push(`(d) ${where(fn.bodyStart + m.index)}: \`${fn.name}\` builds or unpacks a FeeConfig; only \`new\` builds one, for \`init\`.`);
    }
    for (const m of fn.body.matchAll(/(?<![\w:.])new\s*(?:<[^>]*>)?\s*\(/g)) {
      if (fn.name !== 'init') failures.push(`(d) ${where(fn.bodyStart + m.index)}: \`${fn.name}\` calls \`new\`; only \`init\` makes the one FeeConfig.`);
    }
  }
  return failures;
}

// ─── main ────────────────────────────────────────────────────────────────────

export function checkFees(root = process.cwd()) {
  return [...checkGeneratedVectors(root), ...checkCeiling(root), ...checkFeeRates(root), ...checkFeeConfigSetters(root)];
}

function main() {
  const failures = checkFees();
  if (failures.length > 0) {
    console.error(`check:fees: ${failures.length} problem(s) with Splash's fee (Amendment A1 §4):\n`);
    for (const f of failures) console.error(`  ${f}`);
    console.error('');
    process.exit(1);
  }
  const pending = PENDING_2_8.reduce((n, p) => n + p.count, 0);
  console.log(
    `check:fees: the Move vector test is up to date; FEE_CEILING_BPS is ${A1_CEILING_BPS} in splash_core, splash_spend and lib/fees/schedule.ts; ` +
      `no new literal fee rate in ${RATE_ROOTS.join('/, ')}/ (${pending} still listed for A1 §2.8); fee_config changes only through the 24-hour path, but set_discount.`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
