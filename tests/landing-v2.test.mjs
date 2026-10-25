/**
 * v2 Phase 4, step A: the landing's order, hero, product section, partners
 * and how it works (SPLASH_SUI_V2_PROMPT section 6).
 *
 * Red before green: on the Phase 3 tree the hero still carries a grid, a
 * "testnet" callout and a "USDY posture", the stats marquee sits under it,
 * the product vision is "Payments are the feature", six partners are named
 * whose agreements are not signed, there is no calculator, no request for
 * pilot access, and the hero art is the 3.9 MB PNG.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const read = (p) => readFileSync(p, 'utf8');
const exists = (p) => existsSync(p);

function code(p) {
  return read(p)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|[^:'"`])\/\/.*$/, '$1'))
    .join('\n');
}

function filesUnder(dir, re = /\.(tsx?|css)$/) {
  const out = [];
  if (!exists(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name).replaceAll('\\', '/');
    if (entry.isDirectory()) out.push(...filesUnder(full, re));
    else if (re.test(entry.name)) out.push(full);
  }
  return out;
}

const LANDING_FILES = () => [
  'components/IsometricLanding.tsx',
  ...filesUnder('components/landing'),
  ...(exists('styles/landing-v2.css') ? ['styles/landing-v2.css'] : []),
];

/* ── Order ─────────────────────────────────────────────────────────────── */

test('the sections run in section 6 order, and the stats marquee is gone', () => {
  const landing = code('components/IsometricLanding.tsx');
  assert.doesNotMatch(landing, /iso-marquee/, 'no stats marquee');

  const markers = ['<SettlementCinematic', '<ProductSection', '<PartnersRail', 'id="how-it-works"', 'id="comparison"', 'id="loops"', 'id="platform"', 'id="trust"', 'id="copilot"', 'className="iso-section iso-final"', '<footer'];
  const at = markers.map((m) => landing.indexOf(m));
  assert.ok(at.every((i) => i >= 0), `every section is present: ${markers.filter((_, i) => at[i] < 0).join(', ')} missing`);
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'in the order of section 6');

  // The flex order in CSS is the order a reader sees; it must agree.
  const css = read('app/globals.css');
  const order = (cls) => Number((css.match(new RegExp(`\\.${cls} \\{ order: (\\d+); \\}`)) ?? [])[1]);
  const classes = ['cin-section', 'iso-product', 'iso-partner-rail', 'iso-flow', 'iso-comparison', 'iso-loops', 'iso-operating', 'iso-trust', 'iso-copilot', 'iso-final', 'iso-footer'];
  const values = classes.map(order);
  assert.ok(values.every(Number.isFinite), `each section has one order: ${classes.map((c, i) => `${c}=${values[i]}`).join(' ')}`);
  for (let i = 1; i < values.length; i += 1) assert.ok(values[i] > values[i - 1], `${classes[i]} comes after ${classes[i - 1]}`);
});

/* ── Hero ──────────────────────────────────────────────────────────────── */

test('the hero has no grid, tells the mainnet truth, and loads the light WebP art', () => {
  const hero = code('components/landing/SettlementCinematic.tsx');
  assert.doesNotMatch(hero, /cin-grid/, 'no grid lines behind the hero');
  assert.doesNotMatch(hero, /testnet/i);
  assert.doesNotMatch(hero, /USDY posture/);
  assert.doesNotMatch(hero, /Payments are the feature/, 'the old product vision is replaced by the Product section');
  assert.doesNotMatch(hero, /hero-district-v\d\.png/, 'the PNG original is never requested');
  assert.match(hero, /landingImage\('hero'\)/, 'the art comes from the image pipeline');
});

/* ── Images ────────────────────────────────────────────────────────────── */

test('the image pipeline ships WebP at 1600 and 2400 px and a phone crop, the hero under 400 KB', async () => {
  assert.ok(exists('scripts/landing-images.mjs'), 'the pipeline script exists');
  const { manifestProblems, HERO_BUDGET_BYTES } = await import('../scripts/landing-images.mjs');
  assert.deepEqual(manifestProblems(), [], 'the manifest matches the best source on disk');
  const manifest = JSON.parse(read('lib/landing/images.json'));
  for (const key of ['hero', 'liquidity-pools']) {
    const entry = manifest[key];
    assert.ok(entry, `${key} is in the manifest`);
    for (const v of entry.variants) assert.match(v.src, /^\/cinematic\/landing\/.+\.webp$/);
    assert.match(entry.phone.src, /-phone\.webp$/);
  }
  const hero1600 = manifest.hero.variants.find((v) => v.width <= 1600) ?? manifest.hero.variants[0];
  assert.ok(hero1600.bytes < HERO_BUDGET_BYTES, `hero at ${hero1600.width}px is ${hero1600.bytes} bytes`);
  // v6 is preferred whenever it is on disk.
  if (exists('public/cinematic/hero-district-v6.png')) assert.equal(manifest.hero.source, 'cinematic/hero-district-v6.png');
  if (exists('public/cinematic/liquidity-pools-cream.png')) assert.equal(manifest['liquidity-pools'].source, 'cinematic/liquidity-pools-cream.png');

  // No component names an original.
  for (const file of [...filesUnder('components', /\.tsx?$/), ...filesUnder('app', /\.tsx?$/)]) {
    assert.doesNotMatch(read(file), /hero-district-v\d\.png|liquidity-pools(?:-cream)?\.png/, `${file} requests a PNG original`);
  }
});

test('the plinth recolour turns a red-orange panel gold and touches nothing else', async () => {
  const { recolourPanel } = await import('../scripts/landing-images.mjs');
  const W = 20;
  const H = 10;
  const data = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i += 1) data.set([12, 62, 72, 255], i * 4); // teal plinth
  const paint = (x, y, rgb) => data.set([...rgb, 255], (y * W + x) * 4);
  for (let y = 2; y < 6; y += 1) for (let x = 2; x < 6; x += 1) paint(x, y, [214, 92, 60]); // the red square
  paint(15, 5, [214, 92, 60]); // a red pixel outside the box
  const changed = recolourPanel(data, W, H, { x0: 0, y0: 0, x1: 0.5, y1: 1 });
  assert.equal(changed, 16);
  const px = (x, y) => [...data.subarray((y * W + x) * 4, (y * W + x) * 4 + 3)];
  const [r, g, b] = px(3, 3);
  assert.ok(r > 180 && g > 140 && b < 140 && r > g && g > b, `the panel is gold now: ${[r, g, b]}`);
  assert.deepEqual(px(0, 0), [12, 62, 72], 'the teal is untouched');
  assert.deepEqual(px(15, 5), [214, 92, 60], 'outside the box nothing changes');
});

/* ── Routes ────────────────────────────────────────────────────────────── */

test('PHP and IDR are quotable; MYR, VND, THB and SGD are under pilot access', async () => {
  const { QUOTABLE_ROUTES, PILOT_ROUTES, isQuotable, isPilot } = await import('../lib/landing/routes.ts');
  assert.deepEqual(QUOTABLE_ROUTES.map((r) => r.currency), ['PHP', 'IDR']);
  assert.deepEqual(PILOT_ROUTES.map((r) => r.currency), ['MYR', 'VND', 'THB', 'SGD']);
  assert.equal(QUOTABLE_ROUTES.find((r) => r.currency === 'IDR').decimals, 0, 'IDR has no minor unit');
  assert.equal(QUOTABLE_ROUTES.find((r) => r.currency === 'PHP').decimals, 2);
  assert.ok(isQuotable('PHP') && isQuotable('IDR') && !isQuotable('MYR'));
  assert.ok(isPilot('SGD') && !isPilot('PHP') && !isPilot('EUR'));
});

/* ── The landing quote ─────────────────────────────────────────────────── */

const mockAdapter = { async quote(currency) { return { fxRate: currency === 'PHP' ? '56.5' : '16250', partnerFeeBps: 20 }; } };
const deadAdapter = { async quote() { throw new Error('not configured'); } };

test('a landing quote comes from the payout partner, and fails closed rather than invent a rate', async () => {
  const { landingQuote } = await import('../lib/server/landing-quote.ts');
  const thousand = 1_000_000_000n; // 1,000 USDC

  const sandbox = await landingQuote({ currency: 'PHP', amountMinor: thousand }, { adapter: mockAdapter, sandbox: true, sandboxAllowed: true, partnerLabel: 'our Philippines payout partner' });
  assert.equal(sandbox.rate, '56.5');
  assert.equal(sandbox.sandbox, true, 'a sandbox rate says so');
  assert.equal(sandbox.partnerFee.minor, '2000000', "the partner's own fee, from its own quote");
  // (1,000 - 2) USDC at 56.5 = 56,387.00 PHP, in centavos.
  assert.equal(sandbox.receivedMinor, '5638700');
  assert.ok(sandbox.ttlSeconds > 0);

  const idr = await landingQuote({ currency: 'IDR', amountMinor: thousand }, { adapter: mockAdapter, sandbox: true, sandboxAllowed: true, partnerLabel: 'our Indonesia payout partner' });
  assert.equal(idr.receivedMinor, '16217500', 'whole rupiah: (1,000 - 2) x 16,250');

  const production = await landingQuote({ currency: 'PHP', amountMinor: thousand }, { adapter: mockAdapter, sandbox: true, sandboxAllowed: false, partnerLabel: 'x' });
  assert.equal(production.rate, null, 'a sandbox rate never reaches a production page');
  assert.equal(production.receivedMinor, null);
  assert.equal(production.partnerFee.minor, null);

  const dead = await landingQuote({ currency: 'IDR', amountMinor: thousand }, { adapter: deadAdapter, sandbox: false, sandboxAllowed: false, partnerLabel: 'x' });
  assert.equal(dead.rate, null, 'an unconfigured partner quotes nothing');
  assert.match(dead.partnerFee.source, /Not quoted yet/);

  await assert.rejects(() => landingQuote({ currency: 'MYR', amountMinor: thousand }, { adapter: mockAdapter, sandbox: true, sandboxAllowed: true, partnerLabel: 'x' }), /pilot|not quoted/i);
});

test('the public quote and access routes are rate-limited by network and need no session', () => {
  const limits = read('lib/server/rate-limit.ts');
  assert.match(limits, /quotePreviewIp:/);
  assert.match(limits, /accessRequestIp:/);

  const quote = code('app/api/quotes/preview/route.ts');
  assert.doesNotMatch(quote, /requireCustomerRequest/);
  assert.match(quote, /enforceRateLimit\(\{ rule: RATE_LIMITS\.quotePreviewIp, key: clientIp\(request\)/);
  assert.match(quote, /landingQuote/);

  const access = code('app/api/access-requests/route.ts');
  assert.match(access, /enforceRateLimit\(\{ rule: RATE_LIMITS\.accessRequestIp, key: clientIp\(request\)/);
  assert.match(access, /parseAccessRequest/);
  assert.doesNotMatch(access, /export async function GET/, 'nobody reads the requests back through the public route');
});

/* ── Pilot access requests ─────────────────────────────────────────────── */

test('a pilot access request is validated: a work email, a company, a pilot route', async () => {
  const { parseAccessRequest } = await import('../lib/landing/access-request.ts');
  const ok = parseAccessRequest({ email: ' Ops@Kedai.MY ', company: 'Kedai Teknik Sdn Bhd', currency: 'MYR' });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value, { email: 'ops@kedai.my', company: 'Kedai Teknik Sdn Bhd', currency: 'MYR' });

  assert.equal(parseAccessRequest({ email: 'not-an-email', company: 'A Co', currency: 'MYR' }).ok, false);
  assert.equal(parseAccessRequest({ email: 'a@b.co', company: ' ', currency: 'MYR' }).ok, false);
  assert.equal(parseAccessRequest({ email: 'a@b.co', company: 'x'.repeat(161), currency: 'MYR' }).ok, false);
  assert.equal(parseAccessRequest({ email: 'a@b.co', company: 'A Co', currency: 'PHP' }).ok, false, 'PHP is quotable, not pilot');
  assert.equal(parseAccessRequest({ email: 'a@b.co', company: 'A Co', currency: 'EUR' }).ok, false);
  const bot = parseAccessRequest({ email: 'a@b.co', company: 'A Co', currency: 'THB', website: 'http://spam' });
  assert.equal(bot.ok, true);
  assert.equal(bot.spam, true, 'the honeypot is answered like success and stored nowhere');
});

test('access requests are stored server-side, once per email and route, and only staff read them', async () => {
  const saved = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const store = await import('../lib/server/access-requests.ts');
    store.resetAccessRequestsForTests();
    const first = await store.recordAccessRequest({ email: 'ops@kedai.my', company: 'Kedai', currency: 'MYR' });
    assert.equal(first.created, true);
    const again = await store.recordAccessRequest({ email: 'ops@kedai.my', company: 'Kedai Teknik', currency: 'MYR' });
    assert.equal(again.created, false, 'the same person asking twice for one route is one request');
    const other = await store.recordAccessRequest({ email: 'ops@kedai.my', company: 'Kedai', currency: 'SGD' });
    assert.equal(other.created, true, 'each route is its own request');
    const rows = await store.listAccessRequestsForStaff();
    assert.equal(rows.length, 2);
    assert.ok(!('listAccessRequests' in store), 'there is no unscoped customer read');
  } finally {
    if (saved !== undefined) process.env.DATABASE_URL = saved;
  }
  const sql = readdirSync('drizzle').find((f) => /access_requests\.sql$/.test(f));
  assert.ok(sql, 'a migration creates the table');
  const journal = JSON.parse(read('drizzle/meta/_journal.json'));
  assert.ok(journal.entries.some((e) => e.tag === sql.replace(/\.sql$/, '')), 'and the journal lists it');
  assert.match(read(`drizzle/${sql}`), /UNIQUE[\s\S]*email[\s\S]*currency|email[\s\S]*currency[\s\S]*UNIQUE/i);
});

/* ── Product section ───────────────────────────────────────────────────── */

test('the product section: pay the invoice, keep the proof, a calculator in front of the desk', () => {
  const product = code('components/landing/ProductSection.tsx');
  assert.match(product, /Pay the invoice\./);
  assert.match(product, /Keep the proof\./);
  assert.match(product, /To a bank/);
  assert.match(product, /To a wallet/);
  assert.match(product, /Pilot access/);
  assert.match(product, /Request access/);
  assert.match(product, /\/api\/quotes\/preview/, 'the bank quote is live, from the server');
  assert.match(product, /\/api\/access-requests/);
  assert.match(product, /splashFee\(/, "Splash's fee is the schedule's");
  assert.match(product, /Not quoted yet/, "the partner's fee is its own line, or says it is not quoted");
  assert.match(product, /QUOTABLE_ROUTES|PILOT_ROUTES/);
  assert.doesNotMatch(product, /Payments are the feature/);
});

/* ── Partners ──────────────────────────────────────────────────────────── */

test('partners render only when signed; otherwise the rails and standards', async () => {
  const landing = code('components/IsometricLanding.tsx');
  for (const name of ['Stripe', 'Airwallex', 'Pyth', 'DeepBook', 'Sumsub']) {
    assert.doesNotMatch(landing, new RegExp(`name: '${name}'`), `${name} is not named on the landing`);
  }
  const rail = code('components/landing/PartnersRail.tsx');
  assert.match(rail, /signed/, 'the rail is given the signed partners');
  assert.match(rail, /LANDING_RAILS/);
  const { LANDING_RAILS } = await import('../content/rails.ts');
  assert.deepEqual(LANDING_RAILS.map((r) => r.name), ['Sui', 'USDC', 'Walrus', 'InstaPay and PESONet', 'BI-FAST']);
  const page = code('app/page.tsx');
  assert.match(page, /signedPartners\(\)/, 'the server decides who is signed');
});

/* ── How it works ──────────────────────────────────────────────────────── */

test('how it works: two transfer types, the Splash Wallet, five steps true for both', () => {
  const how = code('components/landing/HowItWorks.tsx');
  assert.match(how, /local currency/i, 'stablecoin to a bank in local currency');
  assert.match(how, /Splash business or a wallet/i, 'stablecoin to stablecoin');
  assert.match(how, /Splash Wallet/);
  assert.match(how, /card/i);
  assert.match(how, /bank transfer/i);
  assert.match(how, /another wallet/i);
  const steps = [...how.matchAll(/\btitle: '([^']+)'/g)].map((m) => m[1]);
  assert.equal(steps.length, 5, `five steps: ${steps.join(' | ')}`);
  assert.match(how, /Splash has no key to your Splash Wallet/);
});

/* ── Section 8 greps on the landing ───────────────────────────────────── */

test('section 8 greps return nothing on the landing surfaces', () => {
  const offenders = [];
  for (const file of LANDING_FILES()) {
    const text = read(file);
    for (const [label, re] of [
      ['E39774', /E39774/i],
      ['coral', /coral/i],
      ['Demo', /\bDemo\b|\bDEMO\b/],
      ['Coming soon', /Coming soon/i],
      ['testnet', /testnet/i],
      ['non-custodial', /non-custodial/i],
      ['mainnet live', /mainnet live/i],
      ['same-day', /same-day/i],
      ['zero fees', /zero fees/i],
    ]) if (re.test(text)) offenders.push(`${file}: ${label}`);
  }
  assert.deepEqual(offenders, []);
  assert.ok(statSync('components/landing').isDirectory());
});
