import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import test from 'node:test';

/**
 * v2 Phase 3 global rules (brief section 5 intro, D14): the product has no
 * coral, no "Demo" in its text, and no background grid.
 *
 * Coral #E39774 goes entirely: a solid coral fill becomes gold #efc46f with
 * ink text, a peach tint becomes the pale gold tint #fdf3dc, and a Zeke
 * accent becomes teal. The landing (Phase 4) still carries its own coral
 * until that phase rebuilds it, so its files are listed here and nowhere
 * else; everything a signed-in customer or the operator sees is checked.
 */

const ROOT = process.cwd();

/** Phase 4's surfaces: the landing, its phone layout and /working-capital. */
const LANDING = [
  'components/landing/',
  'components/mobile/',
  'components/supply/',
  'components/IsometricLanding.tsx',
  'app/working-capital/',
  'app/globals.css',
];

function filesUnder(dir) {
  return readdirSync(join(ROOT, dir)).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(join(ROOT, path)).isDirectory()) return filesUnder(path);
    return /\.(tsx?|css)$/.test(name) ? [relative('.', path).split(sep).join('/')] : [];
  });
}

const PRODUCT = [...filesUnder('app'), ...filesUnder('components'), ...filesUnder('content')];
const outsideLanding = (file) => !LANDING.some((prefix) => file === prefix || file.startsWith(prefix));

function hits(files, pattern) {
  return files.flatMap((file) =>
    readFileSync(join(ROOT, file), 'utf8')
      .split(/\r?\n/)
      .flatMap((line, index) => (pattern.test(line) ? [`${file}:${index + 1}: ${line.trim().slice(0, 140)}`] : [])),
  );
}

test('no coral anywhere a customer or the operator signs in to', () => {
  const found = hits(PRODUCT.filter(outsideLanding), /E39774|coral|227,\s*151,\s*116/i);
  assert.deepEqual(found, [], `\n  ${found.join('\n  ')}\n`);
});

test('no "Demo" or "DEMO" in product text', () => {
  const found = hits(PRODUCT, /\bDemo\b|\bDEMO\b/);
  assert.deepEqual(found, [], `\n  ${found.join('\n  ')}\n`);
});

test('the dashboard says Sui mainnet, not testnet, and its loading screen draws no grid', () => {
  // The Zeke composer's context tag and the Transfer country list are what a
  // signed-in customer reads; the brief bans "testnet" on customer surfaces.
  for (const file of ['components/oxwal/OxWalComposer.tsx', 'components/transfer/StepBeneficiary.tsx', 'components/dashboard/DashboardShell.tsx']) {
    const found = hits([file], /testnet/i);
    assert.deepEqual(found, [], `\n  ${found.join('\n  ')}\n`);
  }
  const css = readFileSync(join(ROOT, 'app/globals.css'), 'utf8');
  const start = css.indexOf('.splash-loading-shell {');
  const rule = css.slice(start, css.indexOf('}', start));
  assert.doesNotMatch(rule, /1px, transparent 1px/, '"Loading your dashboard" sits on plain paper');
});

test('the gold that replaces coral is a token, with its pale tint', () => {
  const tokens = readFileSync(join(ROOT, 'styles/tokens.css'), 'utf8');
  assert.match(tokens, /--gold-light:\s*#efc46f;/i, 'solid accent: gold #efc46f, ink text on it');
  assert.match(tokens, /--gold-tint:\s*#fdf3dc;/i, 'tint: the pale gold #fdf3dc');
  assert.match(tokens, /--gold-ink:\s*#7a5410;/i, 'words on the tint, 6:1 on it');
});

test('the dashboard and the shadcn accents are not coral, and the dashboard has no background grid', () => {
  const css = readFileSync(join(ROOT, 'app/globals.css'), 'utf8');
  const root = css.slice(css.indexOf(':root {'), css.indexOf('.dark {'));
  assert.doesNotMatch(root, /e39774/i, 'the --accent and --sidebar-accent of the app shell');

  const start = css.indexOf('.fintech-dashboard-shell::before {');
  assert.ok(start > 0);
  const rule = css.slice(start, css.indexOf('}', start));
  assert.doesNotMatch(rule, /1px, transparent 1px/, 'no hairline grid behind the dashboard');
  assert.doesNotMatch(rule, /background-size:[^;]*\d+px \d+px/);
  assert.doesNotMatch(rule, /227,\s*151,\s*116/, 'no coral glow');
});
