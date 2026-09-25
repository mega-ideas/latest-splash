import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import test from 'node:test';

import { NON_TEXT, ROOT, SMALLEST_PX, WORDS, auditPages, hex, over } from './helpers/contrast-audit.mjs';

/**
 * Every word in the staff console reads at 4.5:1 and 12px or more, and every
 * icon and text-field edge at 3:1: the same rules as /queue and the dashboard
 * (tests/queue-contrast.test.mjs, tests/dashboard-contrast.test.mjs), for the
 * pages under app/admin/(console), their loading screens, the components they
 * render, and the staff sign-in page.
 *
 * Go-live has a loading screen of its own, inside the console's shell. Every
 * other console page shows app/loading.tsx while it loads, in place of the
 * shell, so that screen is held to the same rules here.
 *
 * The console has its own shell: a tinted page (#edf4f2, set !important over
 * the shell's own gradient class) with a glow fixed over it, the dark sidebar
 * and its glow, which the dashboard shares, a context bar styled in
 * app/globals.css, and a rule that gives every bg-white card, field included,
 * a 10% border.
 * The sign-in page is a dark panel filled by a radial gradient beside a light
 * form. tests/helpers/contrast-audit.mjs reads all of them as the browser
 * paints them.
 */

/** The pages and loading screens under `dir`. */
function screensUnder(dir) {
  return readdirSync(join(ROOT, dir)).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(join(ROOT, path)).isDirectory()) return screensUnder(path);
    return name === 'page.tsx' || name === 'loading.tsx' ? [relative('.', path).split(sep).join('/')] : [];
  });
}

const CONSOLE = screensUnder('app/admin/(console)');
const PAGES = CONSOLE.filter((path) => path.endsWith('/page.tsx'));
const RESULT = auditPages({ entries: CONSOLE, layouts: ['app/admin/(console)/layout.tsx'] });
const LOGIN = auditPages({ entries: ['app/admin/login/page.tsx'] });
const LOADING = auditPages({ entries: ['app/loading.tsx'] });
const FINDINGS = [...RESULT.findings, ...LOGIN.findings, ...LOADING.findings];
const report = (lines) => `\n  ${lines.join('\n  ')}\n`;
const failures = (pattern) => FINDINGS.filter((line) => pattern.test(line));

test('the check finds the console’s surfaces: its tinted page, the dark sidebar, their glows, cards, fields, the sign-in panel and the loading screen', (t) => {
  // The shell's bg-[linear-gradient(…),#EEF4F5] loses to `.fintech-admin-shell { background: #edf4f2 !important }`.
  const page = [237, 244, 242];
  const expected = [
    [RESULT, 'the console page (#edf4f2, over the shell’s own class)', page],
    // .fintech-admin-shell::before, fixed to the window: its glow's brightest point over the page.
    [RESULT, 'the console page under its fixed glow', over([92, 158, 173, 0.08], page)],
    [RESULT, 'the sidebar, top of its gradient', [36, 85, 99]],
    [RESULT, 'the sidebar, bottom', [12, 48, 57]],
    // The sidebar's own glow, at its brightest over the top of the rail.
    [RESULT, 'the sidebar under its glow', over([159, 207, 199, 0.1], [36, 85, 99])],
    [RESULT, 'a bg-white card in the console (the card rule)', over([253, 254, 255, 0.93], page)],
    [LOGIN, 'the sign-in panel, the centre of its radial fill', [24, 92, 102]],
    [LOGIN, 'the sign-in panel, its edge', [8, 43, 50]],
    [LOGIN, 'a sign-in field', [255, 253, 248]],
    [LOADING, 'the loading screen, the cream it fades to', [248, 240, 229]],
  ];
  for (const [result, label, colour] of expected) {
    assert.ok(result.surfacesSeen.has(hex(colour)), `${label} ${hex(colour)} was not found`);
  }
  const { words, icons, fields, sizes } = RESULT.checked;
  const loading = CONSOLE.length - PAGES.length;
  t.diagnostic(`${PAGES.length} console pages and ${loading} loading screen${loading === 1 ? '' : 's'}, ${RESULT.files.length} files: ${words} word colours, ${icons} icon colours, ${fields} field edges, ${sizes} sizes; sign-in: ${LOGIN.checked.words} word colours; loading screen: ${LOADING.checked.words}`);
  assert.ok(PAGES.length >= 8, `only ${PAGES.length} console pages were found`);
  assert.ok(CONSOLE.includes('app/admin/(console)/go-live/loading.tsx'), 'Go-live’s loading screen was not found');
  assert.ok(RESULT.files.length >= 15, `only ${RESULT.files.length} files were followed`);
  assert.ok(words >= 500, `only ${words} word colours were checked`);
  assert.ok(LOGIN.checked.words >= 60, `only ${LOGIN.checked.words} sign-in word colours were checked`);
  assert.ok(LOADING.checked.words >= 2, `only ${LOADING.checked.words} loading-screen word colours were checked`);
  assert.ok(RESULT.checked.fields + LOGIN.checked.fields >= 10, 'too few field edges were checked');
});

test('a component is checked where it is used: the dark logout button in the sidebar, the light one in the header', () => {
  // AdminLogoutButton defaults to variant 'dark' (white words) and the mobile
  // header passes variant="light". Checked everywhere as both, the dark one
  // read as white on the light header.
  const logout = FINDINGS.filter((line) => line.includes('AdminLogoutButton'));
  assert.deepEqual(logout, []);
  assert.ok(RESULT.files.includes('components/admin/AdminLogoutButton.tsx'));
});

test(`every word in the staff console reads at ${WORDS}:1 against what it sits on`, () => {
  const words = failures(/ (words|placeholder) /);
  assert.equal(words.length, 0, report(words));
});

test(`every icon in the staff console is at least ${NON_TEXT}:1 against what it sits on`, () => {
  const icons = failures(/ icon /);
  assert.equal(icons.length, 0, report(icons));
});

test(`every text field in the staff console shows its edge at ${NON_TEXT}:1, inside and out`, () => {
  const edges = failures(/ field edge /);
  assert.equal(edges.length, 0, report(edges));
});

test(`nothing in the staff console is set smaller than ${SMALLEST_PX}px`, () => {
  const small = failures(/ size /);
  assert.equal(small.length, 0, report(small));
});
