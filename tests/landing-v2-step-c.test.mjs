/**
 * v2 Phase 4, step C: the phone landing as its own composition, the image
 * weight checked end to end, and the Treasury-on-Solana design doc
 * (SPLASH_SUI_V2_PROMPT sections 6 and 7, D15).
 *
 * Red before green: on the step B tree the phone hero is 430vh tall (a
 * narrow-screen rule meant for the pinned cinematic also lands on the static
 * one, leaving about 1,900 px of empty cream under the telemetry); the loop
 * cards can only be swiped, with no buttons and no keys; the desk behind the
 * calculator is the desktop desk cut to its title; the comparison on a phone
 * is the four-column table re-laid as twelve cards; the trust gates are four
 * full desktop cards; the stepped-pools art ignores its phone crop and the
 * Platform's other two pictures load at 1920 px on a 390 px screen; and
 * docs/treasury-solana-design.md does not exist.
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

/** The body of every `@media (max-width: 700px)` block in a stylesheet. */
function phoneCss(p) {
  const css = read(p).replace(/\/\*[\s\S]*?\*\//g, ' ');
  const out = [];
  const re = /@media\s*\(max-width:\s*700px\)\s*\{/g;
  while (re.exec(css)) {
    let depth = 1;
    let i = re.lastIndex;
    while (depth > 0 && i < css.length) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') depth -= 1;
      i += 1;
    }
    out.push(css.slice(re.lastIndex, i - 1));
  }
  return out.join('\n');
}

const LANDING = () => code('components/IsometricLanding.tsx');

test('phone hero: the static cinematic is as tall as its content, not 430vh', () => {
  const css = read('styles/cinematic.css').replace(/\/\*[\s\S]*?\*\//g, ' ');
  assert.match(
    css,
    /\.cin-section\.cin-section-static\s*\{[^}]*height:\s*auto/,
    'a rule that outranks the narrow-screen `.cin-section { height: 430vh }` keeps the static hero at its own height',
  );
});

test('phone loops: a carousel with buttons, keys and a position, not swipe only', () => {
  assert.ok(existsSync('components/landing/LoopCarousel.tsx'), 'components/landing/LoopCarousel.tsx exists');
  const carousel = code('components/landing/LoopCarousel.tsx');
  // Conditional since the step C review: a carousel only while the row scrolls.
  assert.match(carousel, /aria-roledescription=(?:"carousel"|\{\s*\w+\s*\?\s*'carousel'\s*:\s*undefined\s*\})/, 'announced as a carousel');
  assert.match(carousel, /aria-label="Previous loop"/, 'a previous button');
  assert.match(carousel, /aria-label="Next loop"/, 'a next button');
  assert.match(carousel, /<button/, 'real buttons');
  assert.match(carousel, /ArrowLeft/, 'the left arrow key moves back');
  assert.match(carousel, /ArrowRight/, 'the right arrow key moves on');
  assert.match(carousel, /tabIndex=\{(?:0|\s*\w+\s*\?\s*0\s*:\s*undefined\s*)\}/, 'the track takes focus, so the keys work');
  assert.match(carousel, /aria-live="polite"/, 'the position is announced');
  assert.match(carousel, /of \{/, 'the position reads "1 of 3"');
  assert.match(carousel, /prefers-reduced-motion/, 'no smooth scroll under reduced motion');
  assert.match(LANDING(), /<LoopCarousel/, 'the landing renders the loops through it');
  const phone = phoneCss('styles/landing-v2.css');
  assert.match(phone, /\.lc-controls\s*\{[^}]*display:\s*flex/, 'the controls show on phones');
  assert.match(read('styles/landing-v2.css'), /\.lc-controls\s*\{[^}]*display:\s*none/, 'and are hidden on wider screens');
});

test('phone product: the calculator first, a phone-sized dashboard peeking behind it, with no figures', () => {
  const product = code('components/landing/ProductSection.tsx');
  assert.match(product, /function PhoneDeskPreview/, 'a phone dashboard of its own');
  const body = product.slice(product.indexOf('function PhoneDeskPreview'));
  const fn = body.slice(0, body.indexOf('\n}\n') + 3);
  assert.match(fn, /aria-hidden="true"/, 'a picture of the layout, hidden from screen readers');
  assert.doesNotMatch(fn.replace(/className="[^"]*"|width=\{\d+\}|height=\{\d+\}/g, ''), /\d/, 'no figures in it: nothing it shows is a number');
  assert.ok(
    product.indexOf('<PhoneDeskPreview') > product.indexOf('className="pv-calc'),
    'it comes after the calculator, which leads on a phone',
  );
  const phone = phoneCss('styles/landing-v2.css');
  assert.match(phone, /\.pv-phone-desk\s*\{[^}]*display:\s*block/, 'shown on phones');
  assert.match(phone, /\.iso-product \.pv-desk\s*\{[^}]*display:\s*none/, 'the desktop desk is not squeezed onto a phone');
  assert.match(read('styles/landing-v2.css'), /\.pv-phone-desk\s*\{[^}]*display:\s*none/, 'and hidden on wider screens');
});

test('phone comparison: Splash beside one alternative at a time, from the same rows', () => {
  const landing = LANDING();
  assert.match(landing, /function PhoneComparison/, 'a phone comparison of its own');
  const fn = landing.slice(landing.indexOf('function PhoneComparison'));
  assert.match(fn, /role="tablist"/, 'the alternative is chosen with tabs');
  assert.match(fn, /role="tab"/);
  assert.match(fn, /aria-selected=/);
  assert.match(fn, /role="tabpanel"/);
  assert.match(fn, /ArrowRight/, 'the tabs move with the arrow keys');
  assert.match(landing, /<PhoneComparison rows=\{rows\}/, 'fed the same comparisonRows as the table');
  const phone = phoneCss('styles/landing-v2.css');
  assert.match(phone, /\.iso-comparison-table\s*\{[^}]*display:\s*none/, 'the twelve-card table is not shown on a phone');
  assert.match(phone, /\.pc-compare\s*\{[^}]*display:\s*grid/, 'the phone comparison is');
  assert.match(read('styles/landing-v2.css'), /\.pc-compare\s*\{[^}]*display:\s*none/, 'and hidden on wider screens');
});

test('phone trust: the four gates as one connected sequence, not four desktop cards', () => {
  const phone = phoneCss('styles/landing-v2.css');
  assert.match(phone, /\.iso-trust-grid::before/, 'a rail joins the gates');
  assert.match(phone, /\.iso-trust-card\s*\{[^}]*padding-left/, 'each gate hangs off the rail');
});

test('image weight: the pools art uses its phone crop, and no Platform picture loads desktop widths on a phone', () => {
  const landing = LANDING();
  assert.match(landing, /<source media="\(max-width: 700px\)" srcSet=\{layer\.art\.phone\.src\}/, 'the pools phone crop is served to phones');
  const platform = landing.slice(landing.indexOf('className="iso-layer-grid"'), landing.indexOf('id="trust"'));
  const images = platform.match(/<Image\b[^>]*>/g) ?? [];
  assert.ok(images.length >= 2, 'the Platform has its pictures');
  for (const tag of images) assert.match(tag, /sizes=/, `every Platform picture says how wide it renders: ${tag.slice(0, 80)}`);
});

test('section 7: the Treasury-on-Solana design doc, and only the doc', () => {
  assert.ok(existsSync('docs/treasury-solana-design.md'), 'docs/treasury-solana-design.md exists');
  const doc = read('docs/treasury-solana-design.md');
  for (const must of [
    /Ondo/,
    /tokeni[sz]ed (stocks|equities)/i,
    /ETF/,
    /CCTP V2/,
    /Squads/,
    /same signers/i,
    /splash-solana/,
    /FEATURE_ONDO_STOCKS/,
    /\boff\b/,
    /mainnet payments/i,
    /legal advice/i,
    /\bSC\b|Securities Commission/,
    /eligib/i,
    /Malaysia/,
  ]) {
    assert.match(doc, must, `the doc covers ${must}`);
  }
  assert.doesNotMatch(doc, /CCTP V1/, 'CCTP V1 is never the route');
  const pkg = read('package.json');
  for (const dep of ['@sqds/', '@solana/web3.js', '@coral-xyz/anchor', '@ondo']) {
    assert.ok(!pkg.includes(dep), `no Solana or Ondo dependency lands in this repo (${dep})`);
  }
});
