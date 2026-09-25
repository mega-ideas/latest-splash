import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import test from 'node:test';

import { NON_TEXT, ROOT, SMALLEST_PX, WORDS, auditPages, hex, over, paintsOf } from './helpers/contrast-audit.mjs';

/**
 * Every word on the dashboard reads at 4.5:1 and 12px or more, and every icon
 * and text-field edge at 3:1: the same rules as /queue
 * (tests/queue-contrast.test.mjs), for every page under app/dashboard and each
 * component they render.
 *
 * The dashboard's colours come from more places than /queue's: its own CSS
 * classes (.dash-surface, .dash-kicker, .dash-btn), variables set on the shell
 * (--fintech-*), theme names (text-primary, bg-card), rules that lift every
 * bg-[#1F4452] and bg-white inside it, a gradient page, and a stylesheet rule
 * that styles every field. tests/helpers/contrast-audit.mjs reads all of them
 * the way the browser cascades them, and measures what is painted.
 *
 * Disabled controls are exempt (WCAG 1.4.3), and so is a section dimmed while
 * a condition says it cannot be used yet (disabled, locked, busy, loading).
 */

function pagesUnder(dir) {
  return readdirSync(join(ROOT, dir)).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(join(ROOT, path)).isDirectory()) return pagesUnder(path);
    return name === 'page.tsx' ? [relative('.', path).split(sep).join('/')] : [];
  });
}

const PAGES = pagesUnder('app/dashboard');
const RESULT = auditPages({ entries: PAGES, layouts: ['app/dashboard/layout.tsx'] });
const report = (lines) => `\n  ${lines.join('\n  ')}\n`;
const failures = (pattern) => RESULT.findings.filter((line) => pattern.test(line));

test('the dashboard stylesheet is read the way the browser paints it', () => {
  const vars = new Map([
    ['--ink', '#1F4452'],
    ['--primary', '#5c9ead'],
    ['--color-primary', 'var(--primary)'],
  ]);
  // color-mix() in sRGB, including a mix with transparent.
  const [faint] = paintsOf('color-mix(in srgb, #326273 16%, transparent)', vars).paints;
  assert.deepEqual([hex(faint), faint[3].toFixed(2)], ['#326273', '0.16']);
  assert.equal(hex(paintsOf('color-mix(in srgb, var(--ink) 85%, #ffffff)', vars).paints[0]), '#41606C');
  // Tailwind's palette is oklch: red-500.
  assert.equal(hex(paintsOf('oklch(63.7% 0.237 25.331)', vars).paints[0]), '#FB2C36');
  // A theme name resolves through its variables; a gradient is each of its stops.
  assert.equal(hex(paintsOf('var(--color-primary)', vars).paints[0]), '#5C9EAD');
  assert.deepEqual(
    paintsOf('linear-gradient(180deg, #ece3de 0%, #efe6e1 42%, #e5d8d1 100%)', vars).paints.map(hex),
    ['#ECE3DE', '#EFE6E1', '#E5D8D1'],
  );
});

test('the check finds the dashboard’s surfaces: the gradient page, the lifted ink sidebar, cards and fields', (t) => {
  const white = [255, 255, 255];
  const stops = { top: [236, 227, 222], middle: [239, 230, 225], bottom: [229, 216, 209] };
  const expected = {
    'the page, top of its gradient': stops.top,
    'the page, middle': stops.middle,
    'the page, bottom': stops.bottom,
    'the sidebar (bg-[#1F4452], lifted towards white)': over([31, 68, 82, 0.85], white),
    'a .dash-surface card on the page': over([255, 253, 249, 0.93], stops.top),
    'a field in the dashboard (the field rule)': over([255, 253, 247, 0.92], over([255, 253, 249, 0.93], stops.top)),
  };
  for (const [label, colour] of Object.entries(expected)) {
    assert.ok(RESULT.surfacesSeen.has(hex(colour)), `${label} ${hex(colour)} was not found`);
  }
  const { words, icons, fields, sizes } = RESULT.checked;
  t.diagnostic(`${PAGES.length} pages, ${RESULT.files.length} files: ${words} word colours, ${icons} icon colours, ${fields} field edges, ${sizes} sizes, on ${RESULT.surfacesSeen.size} surfaces`);
  assert.ok(PAGES.length >= 15, `only ${PAGES.length} dashboard pages were found`);
  assert.ok(RESULT.files.length >= 45, `only ${RESULT.files.length} files were followed`);
  assert.ok(words >= 2000, `only ${words} word colours were checked`);
  assert.ok(icons >= 400, `only ${icons} icon colours were checked`);
  assert.ok(fields >= 50, `only ${fields} field edges were checked`);
});

test(`every word on the dashboard reads at ${WORDS}:1 against what it sits on`, () => {
  const words = failures(/ (words|placeholder) /);
  assert.equal(words.length, 0, report(words));
});

test(`every icon on the dashboard is at least ${NON_TEXT}:1 against what it sits on`, () => {
  const icons = failures(/ icon /);
  assert.equal(icons.length, 0, report(icons));
});

test(`every text field on the dashboard shows its edge at ${NON_TEXT}:1, inside and out`, () => {
  const edges = failures(/ field edge /);
  assert.equal(edges.length, 0, report(edges));
});

test(`nothing on the dashboard is set smaller than ${SMALLEST_PX}px`, () => {
  const small = failures(/ size /);
  assert.equal(small.length, 0, report(small));
});
