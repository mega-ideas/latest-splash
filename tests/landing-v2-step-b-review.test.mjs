/**
 * v2 Phase 4, step B: the independent review's findings, held.
 *
 * Red before green: on the step B tree the 11 px labels on /working-capital
 * §03 and the phone comparison sit at 4.1 to 4.3:1; the loops' number badges
 * are white on the light teal (3.0:1) and the Live chip is 4.4:1; Save says
 * "Live" before Treasury's legal sign-off; the loops say money "moves for
 * free" on a "zero-fee rail"; PH and ID say "Live" with no signed payout
 * partner while content/claims.ts says payouts are not live; the Splash fee
 * cell sits beside all-in competitor costs without naming the partner's leg;
 * seven comparison rows are three "Varies" cells each; the phone table loses
 * its roles; "Request access" opens nothing; the footer titles are not
 * headings; and "testnet" and "~400ms" survive on the share image, /trust,
 * the numbers page and a dead phone landing.
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

/* ── Contrast ──────────────────────────────────────────────────────────── */

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
function luminance([r, g, b]) {
  const f = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function ratio(fg, bg) {
  const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}
/** An rgba() ink blended over a solid background. */
function blended(rgba, bg) {
  const [r, g, b, a] = rgba.match(/rgba\(([^)]+)\)/)[1].split(',').map(Number);
  return [r, g, b].map((v, i) => v * a + bg[i] * (1 - a));
}
/** A declaration's value inside the first rule for `selector`. */
function declaration(css, selector, property) {
  const body = css.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`))?.[1] ?? '';
  return body.match(new RegExp(`(?:^|;|\\n)\\s*${property}:\\s*([^;]+);`))?.[1]?.trim() ?? null;
}

// The darkest cream the label tokens sit on: paper-deep (#f8f0e5), and the
// #f1e6d6 tint of a card over it.
const CREAMS = ['#fffaf4', '#f8f0e5', '#f1e6d6'];

test('the text tokens under 13 px hold 4.5:1 on every cream they sit on', () => {
  const css = read('app/globals.css');
  const block = css.slice(css.indexOf('.iso-landing {'), css.indexOf('}', css.indexOf('.iso-landing {')));
  for (const token of ['--iso-text-label', '--iso-text-muted', '--iso-text-secondary']) {
    const value = block.match(new RegExp(`${token}:\\s*(rgba\\([^)]+\\))`))?.[1];
    assert.ok(value, `${token} is defined`);
    for (const cream of CREAMS) {
      const r = ratio(blended(value, hex(cream)), hex(cream));
      assert.ok(r >= 4.5, `${token} ${value} on ${cream} is ${r.toFixed(2)}:1`);
    }
  }
});

test('the /working-capital loop labels and the phone comparison labels use those tokens', () => {
  const css = read('styles/landing-v2.css');
  const labelRules = [...css.matchAll(/(\.wc-loop[\w-]*(?:\s[\w.:-]+)?|\.iso-comparison-table tbody td::before) \{([^}]*)\}/g)];
  const colours = labelRules
    .map(([, sel, body]) => [sel, body.match(/(?:^|\n)\s*color:\s*([^;]+);/)?.[1]?.trim()])
    .filter(([, colour]) => colour);
  assert.ok(colours.length >= 5, 'the loop and comparison label rules are found');
  for (const [sel, colour] of colours) {
    const ok = /var\(--iso-(?:text-(?:label|muted|secondary)|ink|teal|paper)\)|var\(--(?:gold|ok)-ink\)|#fffaf1/.test(colour);
    assert.ok(ok, `${sel} sets its words in ${colour}, not a checked token`);
  }
});

test('the loops badges, Live chip and platform labels clear 4.5:1', () => {
  const cinematic = read('styles/cinematic.css');
  const badge = declaration(cinematic, '.iso-loops-meta span', 'background');
  assert.match(badge, /--iso-teal|#0d6370/, `the number badge sits on the deep teal, not ${badge}`);
  assert.ok(ratio([255, 255, 255], hex('#0d6370')) >= 4.5);
  assert.equal(declaration(cinematic, '.iso-loops-live', 'color'), 'var(--ok-ink)', 'the Live chip words take --ok-ink');
  const meta = declaration(read('app/globals.css'), '.iso-layer-meta', 'color');
  assert.equal(meta, 'var(--iso-text-label)', `the platform labels use the label token, not ${meta}`);
});

/* ── True claims ───────────────────────────────────────────────────────── */

test('the loops make no free or zero-fee claim, and Save is not "Live" before sign-off', () => {
  const landing = LANDING();
  assert.doesNotMatch(landing, /for free|zero[- ]fee|Collect USD/i);
  assert.match(landing, /treasuryLive \? 'live' : 'signoff'/, 'Save is Live only once treasury execution is on');
  const page = code('app/page.tsx');
  assert.match(page, /TREASURY_EXECUTION_ENABLED === "true"/, 'the switch is the treasury execution flag');
  assert.match(page, /treasuryLive=\{treasuryLive\}/);
});

test('a route says "Live" only once its payout partner is signed', async () => {
  const { QUOTABLE_ROUTES, routeIsLive, livePayoutCurrencies } = await import('../lib/landing/routes.ts');
  const php = QUOTABLE_ROUTES.find((r) => r.currency === 'PHP');
  assert.equal(routeIsLive(php, new Set()), false, 'no signed partner, not live');
  assert.equal(routeIsLive(php, new Set(['pdax'])), true);
  assert.deepEqual(livePayoutCurrencies(new Set()), []);
  assert.deepEqual(livePayoutCurrencies(new Set(['durianpay'])), ['IDR']);

  const landing = LANDING();
  assert.match(landing, /livePayouts\.includes\(route\.currency\)/, 'the Live group is built from the signed routes');
  // The wallet payout is the stablecoin lane, live on its own; a bank payout waits for a partner.
  assert.match(landing, /title: 'Bank payout',\s*status: bankLive \? 'Live'/, 'no hard-coded Live bank payout');
  assert.match(code('app/page.tsx'), /livePayoutCurrencies\(signed\)/);

  const { claims } = await import('../content/claims.ts');
  assert.doesNotMatch(claims.footerLegal.claim, /Labuan|not live yet/i, 'the claims register agrees with the landing');
});

test('the fee row names the partner leg, and unsourced rows become a list of what Splash does', async () => {
  const { comparisonRows, splashToday, UNSOURCED } = await import('../lib/landing/comparison.ts');
  const { getComparisonBaseline } = await import('../lib/fx/comparison-baselines.ts');
  const baseline = getComparisonBaseline('PHP');
  const on = { feesOn: true, bank: '0.05-0.30%', bankFeePhrase: '0.05-0.30% Splash fee to a bank' };
  const rows = comparisonRows(on, baseline);
  for (const row of rows) {
    assert.ok(['bank', 'broker', 'fintech'].some((c) => row[c] !== UNSOURCED), `${row.feature} compares something`);
  }
  const fee = rows.find((r) => /fee to a bank/i.test(r.feature));
  assert.match(fee.splash, /Splash fee/);
  assert.match(fee.splash, /partner/, 'the Splash cell names the partner leg');
  assert.match(comparisonRows({ ...on, feesOn: false, bankFeePhrase: 'No Splash fee charged yet' }, baseline)[1].splash, /partner/);

  const today = splashToday();
  assert.ok(today.length >= 5);
  assert.ok(today.some((t) => /Splash Wallet/.test(t.splash)));
  assert.match(LANDING(), /splashToday\(\)/, 'the landing renders the list');
});

/* ── Accessibility and the access request ─────────────────────────────── */

test('the phone comparison keeps its table roles and its column headers', () => {
  const landing = LANDING();
  for (const role of ['table', 'rowgroup', 'row', 'columnheader', 'rowheader', 'cell']) {
    assert.match(landing, new RegExp(`role="${role}"`), role);
  }
  const css = read('styles/landing-v2.css');
  const theads = [...css.matchAll(/\.iso-comparison-table thead \{([^}]*)\}/g)].map((m) => m[1]);
  assert.ok(theads.length > 0);
  assert.doesNotMatch(theads.at(-1), /display:\s*none/, 'the headers are visually hidden, not removed');
});

test('"Request access" opens the calculator on a pilot route', () => {
  const landing = LANDING();
  assert.match(landing, /href=\{`#\$\{REQUEST_ACCESS_ID\}`\}/);
  const product = code('components/landing/ProductSection.tsx');
  assert.match(product, /export const REQUEST_ACCESS_ID = 'request-access'/);
  assert.match(product, /id=\{REQUEST_ACCESS_ID\}/);
  assert.match(product, /hashchange/);
  assert.match(product, /setDestination\(PILOT_ROUTES\[0\]\.currency\)/);
});

test('the footer column titles are headings that name their nav', () => {
  const landing = LANDING();
  const footer = landing.slice(landing.indexOf('<footer'), landing.indexOf('</footer>'));
  for (const [id, title] of [['footer-product', 'Product'], ['footer-trust', 'Trust'], ['footer-start', 'Get started']]) {
    assert.match(footer, new RegExp(`aria-labelledby="${id}"`));
    assert.match(footer, new RegExp(`<h2 id="${id}">${title}</h2>`));
  }
});

/* ── testnet and ~400ms off the Phase 4 surfaces ──────────────────────── */

test('no "testnet" or "~400ms" on the share image, /trust, the numbers or a dead phone landing', async () => {
  for (const file of ['app/opengraph-image.tsx', 'components/compliance/TrustCompliance.tsx', 'content/sea-numbers.ts']) {
    assert.doesNotMatch(code(file), /testnet|400\s*ms/i, file);
  }
  assert.equal(existsSync('components/mobile/MobileLanding.tsx'), false, 'the unused phone landing is gone');
  const { lockedCopy } = await import('../content/claims.ts');
  assert.doesNotMatch(lockedCopy.speed, /400/);
});
