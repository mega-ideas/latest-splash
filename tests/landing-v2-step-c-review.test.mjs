/**
 * v2 Phase 4, step C review: what the independent review of the phone
 * landing found.
 *
 * Red before green: on 0ed7875 the phone sticky bar shows a second gold
 * "Open payment desk" button while the calculator's own button (or the
 * product section's) is on screen; the desktop comparison header labels are
 * 70% ink at 11 px, about 4.2:1 to 4.6:1 where the gold glow sits behind
 * them; the loop track is a keyboard stop with an arrow-key hint and
 * carousel roles even on desktop, where it cannot scroll, and its label sits
 * on a div with no role; the header brand mark has no `sizes`, so a 40 px
 * mark is fetched at 1080 px; and the hero contrast comment says "full ink"
 * over a 90% ink value.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (p) => readFileSync(p, 'utf8');

function code(p) {
  return read(p)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|[^:'"`])\/\/.*$/, '$1'))
    .join('\n');
}

const css = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, ' ');

test('sticky CTA: steps aside while the calculator or product button is on screen', () => {
  const src = code('components/landing/PhoneStickyCta.tsx');
  const m = src.match(/STEP_ASIDE_SELECTOR\s*=\s*(['"`])([^'"`]+)\1/);
  assert.ok(m, 'PhoneStickyCta names the elements it steps aside for in one STEP_ASIDE_SELECTOR constant');
  const selectors = m[2].split(',').map((s) => s.trim());
  for (const s of ['.iso-final', '.iso-footer', '.pv-send', '.pv-actions']) {
    assert.ok(selectors.includes(s), `the sticky bar steps aside while ${s} is on screen`);
  }
  assert.match(src, /querySelectorAll\(\s*STEP_ASIDE_SELECTOR\s*\)/, 'the observer watches exactly those elements');
  const product = code('components/landing/ProductSection.tsx');
  assert.match(product, /className="pv-send"[\s\S]{0,80}Open payment desk/, 'the calculator CTA still carries the pv-send class');
  assert.match(product, /className="pv-actions"[\s\S]{0,160}Open payment desk/, 'the product CTA still sits in pv-actions');
});

/** Relative luminance of an sRGB colour. */
function lum([r, g, b]) {
  const c = [r, g, b].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const mix = (fg, bg, a) => fg.map((v, i) => v * a + bg[i] * (1 - a));
const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test('comparison header labels clear 4.5:1 with margin over the gold glow', () => {
  const sheet = css('app/globals.css');
  const block = sheet.match(/\.iso-comparison-table thead th\s*\{([^}]*)\}/);
  assert.ok(block, 'the thead th rule exists');
  const color = block[1].match(/(?<!-)color:\s*rgba\(\s*12,\s*62,\s*72,\s*([\d.]+)\s*\)|(?<!-)color:\s*var\(--iso-ink\)/);
  assert.ok(color, 'the label colour is ink, at an alpha or solid');
  const alpha = color[1] === undefined ? 1 : Number(color[1]);
  // Worst case measured behind "Broker": the gold glow over cream, about #f3e6c4,
  // under the 4.5% ink header tint.
  const ink = [12, 62, 72];
  const bg = mix(ink, [243, 230, 196], 0.045);
  const fg = mix(ink, bg, alpha);
  assert.ok(ratio(fg, bg) >= 6, `header labels reach at least 6:1 on the glow (got ${ratio(fg, bg).toFixed(2)}:1 at ${alpha})`);
});

test('loop track: a labelled group, and carousel semantics only when it can scroll', () => {
  const src = code('components/landing/LoopCarousel.tsx');
  assert.match(src, /role="group"/, 'the track has role="group" so its label is read');
  assert.match(src, /scrollWidth\s*>\s*\w+\.clientWidth|matchMedia\(\s*['"]\(max-width:\s*700px\)/, 'the component knows whether the track can scroll');
  assert.match(src, /tabIndex=\{\s*\w+\s*\?\s*0\s*:\s*undefined\s*\}/, 'the track is a keyboard stop only when it can scroll');
  assert.doesNotMatch(src, /tabIndex=\{0\}|tabIndex="0"/, 'no unconditional keyboard stop on the track');
  assert.match(src, /aria-roledescription=\{\s*\w+\s*\?\s*['"]carousel['"]\s*:\s*undefined\s*\}/, 'the carousel role description is conditional');
  assert.match(src, /cloneElement\([\s\S]{0,200}['"]aria-roledescription['"]\s*:\s*\w+\s*\?\s*['"]slide['"]\s*:\s*undefined/, 'the carousel marks its cards as slides only when it is one');
  assert.doesNotMatch(code('components/IsometricLanding.tsx'), /aria-roledescription="slide"/, 'the landing no longer hard-codes slide on every card');
});

test('header brand mark asks for a 40 px image, not 1080 px', () => {
  const src = code('components/IsometricLanding.tsx');
  const tag = src.match(/<Image[^>]*className="iso-header-brand-icon"[^>]*>/);
  assert.ok(tag, 'the header brand image exists');
  assert.match(tag[0], /sizes="40px"/, 'the header brand image has sizes="40px"');
});

test('hero contrast comment matches the value it describes', () => {
  const sheet = read('styles/landing-v2.css');
  assert.doesNotMatch(sheet, /Full ink clears 4\.5:1 everywhere on the wash/, 'the comment no longer claims full ink over a 90% value');
  assert.match(sheet, /90% ink[^*]*\*\/\s*\.iso-landing \.cin-copy \.iso-hero-description/, 'the comment names the 90% ink actually used');
});
