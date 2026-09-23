import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

/**
 * WS9 — landing page, calculator, numbers, copy.
 *
 * Splash prices one leg: USD → PHP. The landing page says what a customer
 * receives, prices that leg against a named, dated dataset and nothing else,
 * shows only numbers that carry a source, a URL and a date, names no entity
 * that does not exist and no partner that has not signed, and explains no
 * protocol. The copy lint knows the reason for every rule it enforces.
 *
 * Red before green: on the tree before the fix there is no calculator, no
 * numbers module, no brand module, the landing compares Splash with Wise and
 * a yield benchmark, the footer names "Splash Financial Labuan Ltd.", and the
 * lint has no reasons and no jargon rule.
 */

const calculator = () => import('../lib/fx/calculator.ts');
const baselines = () => import('../lib/fx/comparison-baselines.ts');
const numbers = () => import('../content/sea-numbers.ts');
const brand = () => import('../content/brand.ts');
const copyRules = () => import('../scripts/copy-rules.mjs');

async function source(relative) {
  const raw = await readFile(new URL(`../${relative}`, import.meta.url), 'utf8');
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

async function filesUnder(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await filesUnder(full)));
    else if (/\.(ts|tsx|mjs)$/.test(entry.name)) out.push(full.replaceAll('\\', '/'));
  }
  return out;
}

/* ── Calculator ────────────────────────────────────────────────────────── */

test('the calculator prices the one leg Splash prices, in minor units, and fails closed without a rate', async () => {
  const { SPLASH_USD_PHP, splashCostMinor, estimatePayment } = await calculator();

  // Flat $4.50 + 0.80% — the same numbers lib/server/quote.ts applies.
  assert.equal(SPLASH_USD_PHP.flatUsdMinor, 450n);
  assert.equal(SPLASH_USD_PHP.marginBps, 80);
  assert.equal(SPLASH_USD_PHP.label, 'Illustrative');
  assert.equal(splashCostMinor(100_000n), 450n + 800n, '$1,000 costs $4.50 + $8.00');
  assert.equal(typeof splashCostMinor(1n), 'bigint');

  // No exchange rate: no PHP figure. Never a substituted default.
  const estimate = estimatePayment({ amountUsdMinor: 100_000n, baseline: null, fxRate: null });
  assert.equal(estimate.phpReceivedMinor, null);
  assert.equal(estimate.bankWire, null, 'no dataset, no bank row');
  assert.equal(estimate.splash.costMinor, 1250n);

  // With a dated rate the received amount is exact integer arithmetic.
  const withRate = estimatePayment({
    amountUsdMinor: 100_000n,
    baseline: null,
    fxRate: { phpPerUsd: '56.00', asOf: '2026-09-01' },
  });
  assert.equal(withRate.phpReceivedMinor, (100_000n - 1250n) * 56n, 'PHP centavos on the net amount');

  // The Splash row never carries a leg Splash does not price: no MYR anywhere
  // near it, and no Wise anywhere at all.
  const calc = await source('lib/fx/calculator.ts');
  assert.doesNotMatch(calc, /MYR/);
  assert.doesNotMatch(calc, /\bWise\b/);
  assert.doesNotMatch(calc, /parseFloat\(|\* 0\.\d|\/ 100\b|\.toFixed\(/, 'money is bigint minor units, never float');
  const component = await source('components/landing/FeeCalculator.tsx');
  assert.doesNotMatch(component, /\bWise\b/i);
  assert.match(component, /Illustrative/);
  assert.match(component, /dataset\.name|baseline\.dataset/, 'the bank row is a named, dated dataset');
});

test('the worked examples hold — for the education page only, never the landing', async () => {
  const { effectiveRateBps } = await calculator();
  // RM30 flat + 2.85% margin, from the master prompt.
  assert.equal(effectiveRateBps({ flatMinor: 3000n, marginBps: 285, amountMinor: 61_000n }), 777, '7.77% on RM610');
  assert.equal(effectiveRateBps({ flatMinor: 3000n, marginBps: 285, amountMinor: 153_000n }), 481, '4.81% on RM1,530');
  assert.equal(effectiveRateBps({ flatMinor: 3000n, marginBps: 285, amountMinor: 5_000_000n }), 291, '2.91% on RM50,000');

  const landing = await source('components/landing/Landing.tsx');
  assert.doesNotMatch(landing, /RM ?30|2\.85|7\.77|4\.81|2\.91/, 'the MYR examples do not belong on the landing');
});

test('baselines name a dataset and do their arithmetic in minor units', async () => {
  const { getComparisonBaseline, baselineCostMinor } = await baselines();
  const php = getComparisonBaseline('PHP');
  assert.ok(php, 'PHP is the live corridor');
  assert.match(php.dataset.name, /\S/, 'a named dataset');
  assert.match(php.dataset.url, /^https:\/\//, 'with a URL');
  assert.match(php.dataset.asOf, /^\d{4}-\d{2}-\d{2}$/, 'and a date');
  assert.equal(typeof php.bankWire.flatUsdMinor, 'bigint');
  assert.ok(Number.isInteger(php.bankWire.marginBps));

  const cost = baselineCostMinor(php.bankWire, 250_000n);
  assert.equal(typeof cost, 'bigint');
  assert.equal(cost, php.bankWire.flatUsdMinor + (250_000n * BigInt(php.bankWire.marginBps)) / 10_000n);

  const baselinesSource = await source('lib/fx/comparison-baselines.ts');
  assert.doesNotMatch(baselinesSource, /commonly 1[–-]3%/, 'the vague review comment is replaced by the dataset reference');
  assert.doesNotMatch(baselinesSource, /amountUsd \*|\/ 100\)/, 'no float math on money');
  assert.match(baselinesSource, /from '\.\.\/money\.ts'/);
});

/* ── Numbers ───────────────────────────────────────────────────────────── */

test('every number carries a source, a URL and a date, and production refuses one that does not', async () => {
  const { SEA_NUMBERS, validateSeaNumbers, publishedNumbers } = await numbers();
  assert.ok(SEA_NUMBERS.length >= 4, 'there is a "by the numbers" section to fill');

  assert.deepEqual(validateSeaNumbers(SEA_NUMBERS), [], 'the shipped numbers are complete');
  for (const entry of SEA_NUMBERS) {
    assert.match(entry.asOf, /^\d{4}-\d{2}-\d{2}$/, `${entry.id} has a date`);
    assert.match(entry.sourceUrl, /^https:\/\//, `${entry.id} has a URL`);
    assert.ok(entry.source.length > 3, `${entry.id} names its source`);
    assert.ok(['verified', 'needs_verification'].includes(entry.status));
  }

  const broken = [{ ...SEA_NUMBERS[0], source: '', sourceUrl: 'ftp://x', asOf: 'yesterday' }];
  const problems = validateSeaNumbers(broken);
  assert.ok(problems.some((p) => /source/.test(p)));
  assert.ok(problems.some((p) => /sourceUrl|URL/.test(p)));
  assert.ok(problems.some((p) => /asOf|date/.test(p)));

  // needs_verification renders in preview only.
  const inProduction = publishedNumbers('production', SEA_NUMBERS);
  assert.ok(inProduction.every((n) => n.status === 'verified'));
  const inPreview = publishedNumbers('development', SEA_NUMBERS);
  assert.equal(inPreview.length, SEA_NUMBERS.length);

  // Every MyInvois and BIR rule starts unverified.
  const regulatory = SEA_NUMBERS.filter((n) => /MyInvois|\bBIR\b|LHDN|e-invoic/i.test(`${n.meaning} ${n.source}`));
  assert.ok(regulatory.length >= 2, 'the MyInvois and BIR rules are recorded');
  for (const rule of regulatory) assert.equal(rule.status, 'needs_verification', `${rule.id} starts as needs_verification`);
});

test('the build fails on an unsourced number: the guard exists and runs under lint', async () => {
  const guard = await source('scripts/check-numbers.mjs');
  assert.match(guard, /validateSeaNumbers/);
  assert.match(guard, /process\.exit\(1\)/);
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(pkg.scripts.lint, /check:numbers/);
  assert.match(pkg.scripts['check:numbers'] ?? '', /check-numbers\.mjs/);
  // And the module itself refuses to load in production with a bad entry.
  const numbersSource = await source('content/sea-numbers.ts');
  assert.match(numbersSource, /NODE_ENV === 'production'[\s\S]{0,200}throw|throw[\s\S]{0,200}NODE_ENV === 'production'/);
});

/* ── Brand as configuration ────────────────────────────────────────────── */

test('brand name, domain and support email are configuration, and no entity that does not exist is named', async () => {
  const { BRAND } = await brand();
  assert.equal(BRAND.name, 'Splash');
  assert.equal(BRAND.legalEntity, null, 'nothing is incorporated yet; nothing is named');
  assert.match(BRAND.supportEmail, /@/);
  assert.match(BRAND.siteUrl, /^https?:\/\//);
  assert.match(BRAND.copyright(2026), /^© 2026 Splash$/);

  const offenders = [];
  for (const root of ['app', 'components', 'lib', 'content']) {
    for (const file of await filesUnder(root)) {
      const text = await readFile(file, 'utf8');
      if (file !== 'content/brand.ts' && /support@splash\.finance/.test(text)) offenders.push(`${file}: support email literal`);
      if (/Splash Financial Labuan/.test(text)) offenders.push(`${file}: names an entity that is not incorporated`);
      if (/legalName/.test(text) && file === 'app/page.tsx') offenders.push(`${file}: JSON-LD legalName`);
    }
  }
  assert.deepEqual(offenders, []);
});

/* ── The landing ───────────────────────────────────────────────────────── */

test('the landing is the v1 cinematic: sections in order, supply on its own page, no claim the truth pass removed', async () => {
  // Rewritten 2026-09-23. The WS9 eight-section page was replaced by the
  // restored v1 isometric cinematic on the owner's direction; what this test
  // used to pin about STRUCTURE moved to the v1 layout, and what it pinned
  // about TRUTH is kept verbatim — the claims WS9 stripped stay stripped,
  // whichever landing renders.
  const landing = await source('components/IsometricLanding.tsx');

  const ids = [...landing.matchAll(/id="([a-z-]+)"/g)].map((m) => m[1]);
  const expected = ['loops', 'how-it-works', 'comparison', 'corridors', 'trust', 'platform', 'copilot', 'control-plane'];
  const inOrder = expected.map((id) => ids.indexOf(id));
  assert.ok(inOrder.every((i) => i >= 0), `every section is present; found ${ids.join(', ')}`);
  assert.deepEqual([...inOrder].sort((a, b) => a - b), inOrder, 'in this order');

  // Corridors is a block INSIDE comparison (one argument, one section), and
  // it keeps its anchor so the header nav still lands on it.
  assert.doesNotMatch(landing, /<section id="corridors"/, 'corridors must not be its own section');
  // Supply lives on /working-capital; the landing links it instead of
  // repeating it.
  assert.doesNotMatch(landing, /id="supply"/, 'supply must not be a landing section');
  assert.match(landing, /href="\/working-capital"/, 'loop 03 links the supply page');

  // Two ways into a payment: an invoice, or a transfer filled in by hand.
  assert.match(landing, /Invoice in, or type it in/);
  assert.match(landing, /Manual transfer branch/);

  // The control plane reveals inside the copilot section, on demand.
  assert.match(landing, /aria-controls="control-plane"/);
  assert.match(landing, /ctrlOpen \?/);

  // The truth rules, unchanged from the WS9 version of this test: no licence
  // or regulator claim, no dead entity, no protocol vocabulary, no three.js.
  for (const banned of [/Licensed[- ]partner/i, /Splash Financial/i, /Labuan FSA/, /\bBNM\b/, /\bBSP\b/, /Walrus/i, /audit spine/i, /from 'three'|@react-three/]) {
    assert.doesNotMatch(landing, banned, `${banned} must not be on the landing`);
  }

  const page = await source('app/page.tsx');
  assert.match(page, /<IsometricLanding/);
  for (const banned of [/Licensed partners/, /Labuan FSA/, /\bBNM\b/, /\bBSP\b/, /legalName/, /Splash Financial/]) {
    assert.doesNotMatch(page, banned, `JSON-LD must not carry ${banned}`);
  }
});

test('design discipline on the landing: no all-caps eyebrows, no arrows on buttons, no middle-dot strings, motion respects the reader', async () => {
  const landing = await source('components/landing/Landing.tsx');
  const css = await readFile(new URL('../styles/landing.css', import.meta.url), 'utf8');

  assert.doesNotMatch(css, /text-transform:\s*uppercase/, 'no all-caps eyebrows');
  assert.doesNotMatch(css, /font-family:\s*var\(--font-mono\)/, 'no mono data labels');
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /var\(--/, 'tokens, not literals');
  assert.doesNotMatch(css, /#[0-9a-fA-F]{6}\b/, 'no raw hex outside styles/tokens.css');

  for (const line of landing.split('\n')) {
    if (/<(Link|button|a)\b/.test(line) || /className="ld-button/.test(line)) {
      assert.doesNotMatch(line, /→/, 'no → on buttons');
    }
  }
  assert.doesNotMatch(landing, / · /, 'no middle-dot meta strings');
  assert.doesNotMatch(landing, /IntersectionObserver|cin-reveal/, 'no fade-on-every-section');
});

/* ── The copy lint ─────────────────────────────────────────────────────── */

test('the copy lint gives a reason for every rule, fails on a planted "licensed partner", and leaves the locked sentence alone', async () => {
  const { copyViolations, CUSTOMER_RULES, MARKETING_JARGON } = await copyRules();

  for (const rule of [...CUSTOMER_RULES, ...MARKETING_JARGON]) {
    assert.ok(rule.reason && rule.reason.length > 10, `${rule.pattern} has a reason`);
  }

  const planted = copyViolations('app/page.tsx', 'We work with licensed partners across the region.');
  assert.ok(planted.some((v) => /licensed partners/i.test(v.excerpt) && /partners of record/i.test(v.reason)), 'licensed partner is caught on a customer route, with its reason');
  assert.ok(planted.every((v) => v.reason.length > 10));

  assert.deepEqual(
    copyViolations('content/money-path.ts', 'Labuan FSA license in process. Splash is not yet a licensed money-services business.'),
    [],
    'the locked trust sentence stays legal',
  );
  assert.deepEqual(
    copyViolations('app/trust/page.tsx', 'Splash is not yet a licensed money-services business.'),
    [],
    'the negation the Trust page must carry',
  );
  assert.ok(copyViolations('app/dashboard/settings/page.tsx', 'licensed partners are the system of record').length > 0);
  assert.ok(copyViolations('components/landing/Landing.tsx', 'Splash Financial Labuan Ltd.').length > 0, 'the trademark holder');
  assert.ok(copyViolations('app/page.tsx', 'BNM MSB registration planned').length > 0);
  assert.ok(copyViolations('components/landing/Landing.tsx', 'Idle balance earns a floating T-bill rate').length > 0);
  assert.equal(copyViolations('components/landing/Landing.tsx', 'shown as a projection; the rate is variable').length, 0);

  // Protocol jargon is banned on marketing routes and nowhere else.
  assert.ok(copyViolations('components/landing/Landing.tsx', 'Receipts live on Walrus and are anchored on-chain.').length >= 2);
  assert.deepEqual(copyViolations('lib/server/walrus.ts', 'Walrus blob store'), []);
  assert.deepEqual(copyViolations('app/dashboard/receipts/page.tsx', 'Walrus blob id'), [], 'the dashboard may say what it does');
  assert.ok(copyViolations('app/page.tsx', 'alt="a payment intent on the audit spine"').length >= 2, 'alt text and JSON-LD are scanned too');

  const lint = await source('scripts/check-copy.mjs');
  assert.match(lint, /copy-rules\.mjs/, 'the lint uses the rules module');
});
