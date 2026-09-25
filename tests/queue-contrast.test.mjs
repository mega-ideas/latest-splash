import assert from 'node:assert/strict';
import test from 'node:test';

import { NON_TEXT, SMALLEST_PX, WORDS, auditPages, contrast, hex, over, paintsOf } from './helpers/contrast-audit.mjs';

/**
 * Every word on /queue reads at 4.5:1 and 12px or more, and every icon and
 * text-field edge at 3:1.
 *
 * /queue is where payments are released, read quickly by the person who
 * answers for them. Its secondary text was #326273 at 55-80% (2.47-4.15:1 on
 * the cards), status words were --warn, --pending and --ok on their tints
 * (3.72-4.37:1), the approval code's placeholder was 25% teal (about 1.4:1),
 * and two text fields were outlined at 20-25% teal (1.35-1.46:1), which on a
 * near-white card is the only sign a field is there. The approval code's
 * label was 10px and the Example badge 11px.
 *
 * tests/helpers/contrast-audit.mjs does the measuring, from the page's TSX and
 * the app's stylesheet; tests/dashboard-contrast.test.mjs holds the dashboard
 * to the same rules.
 */

const RESULT = auditPages({ entries: ['app/queue/page.tsx'] });
const report = (lines) => `\n  ${lines.join('\n  ')}\n`;
const failures = (pattern) => RESULT.findings.filter((line) => pattern.test(line));

test('the measurements match WCAG on colours whose ratios are known', () => {
  const white = [255, 255, 255];
  const teal = [50, 98, 115];
  const ink = [31, 68, 82];
  const card = over([...white, 0.85], [246, 240, 237]);
  const pairs = [
    ['#326273 at 60% on a lane (white/85 on --bg)', over([...teal, 0.6], card), card, 2.72],
    ['#326273 at 90% on a lane', over([...teal, 0.9], card), card, 5.21],
    ['--warn on --warn-bg', [180, 105, 14], [251, 239, 221], 3.72],
    ['--ok on --ok-bg', [46, 125, 107], [228, 241, 237], 4.25],
    ['ink on --ok-bg', ink, [228, 241, 237], 9.02],
    ['white/75 on ink', over([...white, 0.75], ink), ink, 6.69],
    ['a 20% teal field edge on white', over([...teal, 0.2], white), white, 1.35],
  ];
  for (const [label, foreground, background, expected] of pairs) {
    assert.equal(contrast(foreground, background).toFixed(2), expected.toFixed(2), label);
  }
  const vars = new Map([['--bg', '#F6F0ED']]);
  const [ninety] = paintsOf('color-mix(in srgb, #326273 90%, transparent)', vars).paints;
  assert.deepEqual([hex(ninety), ninety[3].toFixed(2)], ['#326273', '0.90']);
  assert.equal(hex(over(paintsOf('color-mix(in srgb, var(--bg) 85%, #ffffff)', vars).paints[0], white)), '#F7F2F0');
});

test('the check finds every surface the queue paints, through conditions, lookups and where components render', (t) => {
  const white = [255, 255, 255];
  // The page is bg-[#F6F0ED], which app/globals.css lifts 15% towards white.
  const page = over([246, 240, 237, 0.85], white);
  const wash = over([50, 98, 115, 0.03], page);
  const expected = {
    'the page (bg-[#F6F0ED], lifted)': page,
    'the lanes (white/85)': over([...white, 0.85], page),
    'the board and code card (white/80)': over([...white, 0.8], page),
    'decided just now (white/70)': over([...white, 0.7], page),
    'the examples wash': wash,
    'an example card (white/60 on the wash)': over([...white, 0.6], wash),
    'a field (white)': white,
    'a MEDIUM risk chip or the finding note (--warn-bg)': [251, 239, 221],
    'a LOW risk chip or a sent chip (--ok-bg)': [228, 241, 237],
    'a HIGH risk chip or a refusal (--error-bg)': [249, 231, 227],
    'a primary button (bg-[#1F4452], lifted)': over([31, 68, 82, 0.85], white),
  };
  for (const [label, colour] of Object.entries(expected)) {
    assert.ok(RESULT.surfacesSeen.has(hex(colour)), `${label} ${hex(colour)} was not found`);
  }
  const { words, icons, fields } = RESULT.checked;
  t.diagnostic(`${RESULT.files.length} files: ${words} word colours, ${icons} icon colours, ${fields} field edges, on ${RESULT.surfacesSeen.size} surfaces`);
  assert.ok(words >= 100, `only ${words} word colours were checked`);
  assert.ok(icons >= 20, `only ${icons} icon colours were checked`);
  assert.ok(fields >= 2, `only ${fields} field edges were checked`);
});

test(`every word on /queue reads at ${WORDS}:1 against what it sits on`, () => {
  const words = failures(/ (words|placeholder) /);
  assert.equal(words.length, 0, report(words));
});

test(`every icon on /queue is at least ${NON_TEXT}:1 against what it sits on`, () => {
  const icons = failures(/ icon /);
  assert.equal(icons.length, 0, report(icons));
});

test(`every text field on /queue shows its edge at ${NON_TEXT}:1, inside and out`, () => {
  const edges = failures(/ field edge /);
  assert.equal(edges.length, 0, report(edges));
});

test(`nothing on /queue is set smaller than ${SMALLEST_PX}px`, () => {
  const small = failures(/ size /);
  assert.ok(RESULT.checked.sizes >= 100, `only ${RESULT.checked.sizes} sizes were checked`);
  assert.equal(small.length, 0, report(small));
});
