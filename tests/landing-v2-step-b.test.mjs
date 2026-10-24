/**
 * v2 Phase 4, step B: routes and comparison, the three loops, platform,
 * trust, the footer and /working-capital (SPLASH_SUI_V2_PROMPT section 6).
 *
 * Red before green: on the step A tree the routes still offer a "Sweep
 * account" and a "Stored balance", the comparison has a "Yield on idle USD"
 * row and "~400ms", competitor cells carry unsourced claims, the Supply card
 * and /working-capital are coral, the trust gates speak only of payouts and
 * end "Not yet a licensed money-services business", the footer files the
 * login links under Trust, and the /working-capital loop is drawn by scroll
 * animation (it renders empty until scrolled).
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const read = (p) => readFileSync(p, 'utf8');

function code(p) {
  return read(p)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|[^:'"`])\/\/.*$/, '$1'))
    .join('\n');
}

const LANDING = () => code('components/IsometricLanding.tsx');

/* ── Routes and comparison ─────────────────────────────────────────────── */

test('routes: PH and ID live, four under pilot access, and the Splash Wallet replaces the sweep and stored balance', () => {
  const landing = LANDING();
  assert.doesNotMatch(landing, /Sweep account|Stored balance|stored balance|sweep/i, 'no sweep account or stored balance');
  assert.match(landing, /Splash Wallet/);
  assert.match(landing, /stablecoins only/i);
  assert.match(landing, /held by your business/i);
  assert.match(landing, /Pilot access/);
  assert.match(landing, /QUOTABLE_ROUTES/, 'live routes come from lib/landing/routes.ts');
  assert.match(landing, /PILOT_ROUTES/, 'pilot routes come from lib/landing/routes.ts');
  assert.doesNotMatch(landing, /CUSTODY_LICENCE/, 'no licence talk in the routes');
});

test('comparison: no yield row, no ~400ms, sourced competitor cells or "Varies"', async () => {
  const landing = LANDING();
  assert.doesNotMatch(landing, /Yield on idle USD|yieldBenchmarks|\/api\/market\/yields/, 'the yield row and its fetch are gone');
  assert.doesNotMatch(landing, /400\s*ms|lockedCopy\.speed/, 'no ~400ms on the landing');
  assert.match(landing, /comparisonRows\(/, 'the rows come from lib/landing/comparison.ts');

  const { comparisonRows, UNSOURCED, SPEED_LINE } = await import('../lib/landing/comparison.ts');
  const { getComparisonBaseline } = await import('../lib/fx/comparison-baselines.ts');
  assert.equal(SPEED_LINE, 'Seconds on Sui, minutes to a PH bank');
  assert.equal(UNSOURCED, 'Varies');

  const pricing = { feesOn: false, bank: '0.5% to a bank', bankFeePhrase: 'No fee yet' };
  const baseline = getComparisonBaseline('PHP');
  const rows = comparisonRows(pricing, baseline);
  const features = rows.map((r) => r.feature);
  for (const gone of [/yield/i, /netting/i, /early payment/i, /ladder/i]) {
    assert.ok(!features.some((f) => gone.test(f)), `no ${gone} row: Splash cannot claim it today`);
  }
  assert.equal(rows.find((r) => /speed/i.test(r.feature)).splash, SPEED_LINE);
  assert.equal(rows.find((r) => /fee to a bank/i.test(r.feature)).splash, 'No fee yet', 'the fee is the schedule, in words');
  assert.ok(rows.some((r) => /Splash Wallet/.test(r.splash)), 'where the money sits: the Splash Wallet');

  // A competitor cell is a figure from the dataset, or "Varies". Nothing else.
  const sourced = new Set([baseline.bankWire.delivery, baseline.fintech.delivery]);
  for (const row of rows) {
    for (const col of ['bank', 'broker', 'fintech']) {
      const cell = row[col];
      const fromDataset = sourced.has(cell) || /^US\$\d+\.\d{2} \+ [\d.]+% FX margin$/.test(cell);
      assert.ok(cell === UNSOURCED || fromDataset, `${row.feature} / ${col}: "${cell}" has no source`);
    }
  }

  // With no reviewed dataset, every competitor cell says "Varies".
  for (const row of comparisonRows(pricing, null)) {
    for (const col of ['bank', 'broker', 'fintech']) assert.equal(row[col], UNSOURCED);
  }
});

/* ── Loops, platform ───────────────────────────────────────────────────── */

const CORALISH = /coral|E39774|227,\s*151,\s*116|155,\s*78,\s*50|#9b4e32/i;

test('the loops, the roadmap chip and /working-capital carry no coral', () => {
  const offenders = [];
  for (const file of ['styles/cinematic.css', 'app/globals.css', 'styles/landing-v2.css', 'styles/tokens.css', 'app/working-capital/page.tsx', 'components/supply/RoadmapChip.tsx']) {
    if (!existsSync(file)) continue;
    read(file).split(/\r?\n/).forEach((line, i) => { if (CORALISH.test(line)) offenders.push(`${file}:${i + 1}`); });
  }
  assert.deepEqual(offenders, []);
});

test('Platform 01 Liquidity reads the pipeline, which prefers the cream deck', async () => {
  const landing = LANDING();
  assert.match(landing, /landingImage\('liquidity-pools'\)/);
  assert.doesNotMatch(landing, /liquidity-pools(?:-cream)?\.png/, 'the PNG original is never requested');
  const script = read('scripts/landing-images.mjs');
  const cream = script.indexOf('liquidity-pools-cream.png');
  const current = script.indexOf("'public/cinematic/liquidity-pools.png'");
  assert.ok(cream > 0 && current > cream, 'the cream deck is tried first, the current image second');
});

/* ── Trust ─────────────────────────────────────────────────────────────── */

test('trust: four gates true for bank and wallet payments, and the software footnote', () => {
  const landing = LANDING();
  for (const title of ['Verified before money moves', 'A person signs', 'Exactly as approved', 'Proof that outlives the payment']) {
    assert.match(landing, new RegExp(title), title);
  }
  assert.match(landing, /ownership proof/, 'wallet recipients prove ownership');
  assert.match(landing, /all-or-nothing/, 'the on-chain step');
  assert.match(landing, /partner confirms/, 'the bank leg is tracked until the partner confirms');
  assert.match(landing, /Splash is software; it has no key to your Splash Wallet\./);
  assert.doesNotMatch(landing, /Sandbox environment|money-services|No real money moves/);
});

/* ── Footer ────────────────────────────────────────────────────────────── */

test('footer: Product, Trust and Get started columns, and the SaaS compliance text', async () => {
  const landing = LANDING();
  const footer = landing.slice(landing.indexOf('<footer'), landing.indexOf('</footer>'));
  const columns = [...footer.matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1]).filter((l) => ['Product', 'Trust', 'Get started'].includes(l));
  assert.deepEqual(columns, ['Product', 'Trust', 'Get started']);

  const col = (label) => {
    const start = footer.indexOf(`aria-label="${label}"`);
    return footer.slice(start, footer.indexOf('</nav>', start));
  };
  const links = (s) => [...s.matchAll(/>([^<>{}]+)<\/(?:a|Link)>/g)].map((m) => m[1].trim().replace('&amp;', '&'));
  assert.deepEqual(links(col('Product')), ['How it works', 'Compare', 'Platform', 'Working capital', 'Routes']);
  assert.deepEqual(links(col('Trust')), ['Trust & compliance', 'Zeke control plane']);
  assert.deepEqual(links(col('Get started')), ['Log in', 'Open payment desk']);

  const { saasCompliance } = await import('../content/claims.ts');
  const text = saasCompliance(null).join(' ');
  assert.match(text, /software \(SaaS\) provider operating under Malaysian law \(BNM\/SC\)/);
  assert.match(text, /does not hold customer funds/);
  assert.match(text, /partners of record/);
  assert.doesNotMatch(text, /licen[cs]e|Labuan|authoris/i, 'no licence claim, no Labuan line yet');
  assert.equal(saasCompliance(null).length, saasCompliance('SPLASH MY SDN BHD (000000-X)').length - 1, 'the entity line renders only once an entity exists');
  assert.match(saasCompliance('SPLASH MY SDN BHD (000000-X)').join(' '), /SPLASH MY SDN BHD/);
  assert.match(footer, /saasCompliance\(BRAND\.legalEntity\)/, 'the entity comes from BRAND.legalEntity');
});

/* ── /working-capital ──────────────────────────────────────────────────── */

test('/working-capital: the build-order card is dark cyan, and the loop renders without scroll animation', () => {
  const page = code('app/working-capital/page.tsx');
  assert.doesNotMatch(page, /WorkingCapitalFlywheel/, 'the scroll-drawn flywheel is replaced');
  assert.match(page, /<SupplyLoop/, 'a static three-node loop');
  assert.doesNotMatch(page, /testnet/i);

  const loop = code('components/supply/SupplyLoop.tsx');
  assert.doesNotMatch(loop, /'use client'|gsap|ScrollTrigger|whileInView|motion/, 'nothing waits for scroll');
  const at = ['Settle', 'Supply', 'Save'].map((n) => loop.indexOf(`name: '${n}'`));
  assert.ok(at.every((i) => i >= 0), 'three nodes');
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'Settle, then Supply, then Save');
  assert.match(loop, /wc-loop-link/, 'connector lines between the nodes');
  assert.match(loop, /wc-loop-return/, 'and the line back to Settle');

  const css = read('app/globals.css');
  const close = css.match(/\.wc-close \{([^}]*)\}/)?.[1] ?? '';
  assert.match(close, /background:[^;]*var\(--iso-teal-dark\);/, 'the Shape the build order card sits on dark cyan');

  // No background grid on /working-capital: only the landing Platform keeps one (D14).
  const rule = (text, sel) => text.match(new RegExp(`\\${sel} \\{([^}]*)\\}`))?.[1] ?? '';
  assert.doesNotMatch(rule(css, '.wc-mechanics'), /1px, transparent 1px/);
  assert.doesNotMatch(rule(read('styles/cinematic.css'), '.iso-supply'), /1px, transparent 1px/);
});
