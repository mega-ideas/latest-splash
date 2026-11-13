import assert from 'node:assert/strict';
import { access, readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

import { hasLocalMatch } from 'next/dist/shared/lib/match-local-pattern.js';
import { hasRemoteMatch } from 'next/dist/shared/lib/match-remote-pattern.js';

/**
 * /_next/image fetches and decodes whatever images.remotePatterns and
 * images.localPatterns admit, for anyone, with no session. With
 * `hostname: "**"` that was any HTTPS host on the internet, which is what made
 * GHSA-2xp9-vwfh-vxw4 (RCE through an AVIF in sharp/libheif) reachable here,
 * and it is an SSRF and decoder surface on every release after the fix.
 *
 * Red before green: on the tree before the fix remotePatterns is
 * [{ protocol: "https", hostname: "**" }], localPatterns is unset (every local
 * path, API routes included, is admitted) and redirects follow the default 3.
 */

const config = async () => (await import('../next.config.ts')).default.images;

const UI_ROOTS = ['app', 'components', 'lib', 'content'];
const RASTER_LITERAL = /['"`](\/[A-Za-z0-9_./-]+\.(?:png|jpe?g|webp|avif|gif))['"`]/g;

async function walk(dir) {
  const entries = await readdir(new URL(`../${dir}/`, import.meta.url), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else if (/\.(tsx?|mjs)$/.test(entry.name)) files.push(path);
  }
  return files;
}

async function rasterPaths() {
  const found = new Map();
  for (const root of UI_ROOTS) {
    for (const file of await walk(root)) {
      const text = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
      for (const [, path] of text.matchAll(RASTER_LITERAL)) {
        if (!found.has(path)) found.set(path, file);
      }
    }
  }
  return found;
}

test('no remote host is admitted by a wildcard', async () => {
  const { remotePatterns = [], domains = [] } = await config();
  assert.deepEqual(domains, [], 'images.domains is deprecated and unrestricted by path');
  for (const pattern of remotePatterns) {
    const { protocol, hostname, pathname } = pattern instanceof URL
      ? { protocol: pattern.protocol.replace(/:$/, ''), hostname: pattern.hostname, pathname: pattern.pathname }
      : pattern;
    assert.equal(protocol, 'https', `remote pattern for ${hostname} must pin https`);
    assert.ok(hostname && !hostname.includes('*'), `remote hostname "${hostname}" must be exact`);
    assert.ok(pathname && pathname !== '/**' && pathname !== '**', `remote pattern for ${hostname} needs a path prefix`);
  }
});

test('the optimizer refuses arbitrary internet hosts', async () => {
  const { domains, remotePatterns } = await config();
  for (const href of [
    'https://attacker.example/poc.avif',
    'https://raw.githubusercontent.com/x/y/main/a.avif',
    'https://aggregator.walrus-testnet.walrus.space/v1/blobs/abc',
    'http://169.254.169.254/latest/meta-data/',
  ]) {
    assert.equal(hasRemoteMatch(domains ?? [], remotePatterns ?? [], new URL(href)), false, href);
  }
});

test('redirects are not followed and private addresses stay blocked', async () => {
  const images = await config();
  assert.equal(images.maximumRedirects, 0);
  assert.equal(images.dangerouslyAllowLocalIP, false);
});

test('SVGs are served as files, never run through the optimizer', async () => {
  // With dangerouslyAllowSVG on, /_next/image rasterizes SVG input (the
  // GHSA-q8wf-6r8g-63ch DoS) and serves script-bearing SVG from our origin.
  const images = await config();
  assert.notEqual(images.dangerouslyAllowSVG, true);
});

test('local images are limited to public/ asset paths without query strings', async () => {
  const { localPatterns } = await config();
  assert.ok(Array.isArray(localPatterns) && localPatterns.length > 0, 'localPatterns must be set');
  for (const pattern of localPatterns) {
    assert.equal(pattern.search, '', `${pattern.pathname} must forbid query strings`);
    assert.ok(pattern.pathname && pattern.pathname !== '**' && pattern.pathname !== '/**', 'no catch-all local pattern');
  }
  for (const path of ['/api/walrus/abc', '/api/kyb/upload', '/receipt/tok.png', '/cinematic/hero-district-v5.png?w=1']) {
    assert.equal(hasLocalMatch(localPatterns, path), false, path);
  }
});

async function publicFiles(dir = 'public') {
  const entries = await readdir(new URL(`../${dir}/`, import.meta.url), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await publicFiles(path)));
    else files.push(path);
  }
  return files;
}

/** True when the bytes are PNG, JPEG, GIF, WebP or AVIF; false for SVG or anything else. */
function isRaster(bytes) {
  const ascii = (from, to) => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes[0] === 0x89 && ascii(1, 4) === 'PNG') return true;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true;
  if (ascii(0, 4) === 'GIF8') return true;
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return true;
  if (ascii(4, 8) === 'ftyp' && ['avif', 'avis'].includes(ascii(8, 12))) return true;
  return false;
}

test('the optimizer admits no SVG from public/', async () => {
  // dangerouslyAllowSVG is off, so the <Image> component serves every .svg
  // src as a plain file and never asks /_next/image for one. A direct request
  // still can: next 16.0.0 to 16.4.4 lets the optimizer process an SVG with
  // dangerouslyAllowSVG off (GHSA-7qx7-33qx-rqx2, published 3 Nov 2026,
  // fixed in 16.4.5). Refusing .svg paths in localPatterns closes that
  // surface whatever the next version.
  const { localPatterns } = await config();
  const admitted = (await publicFiles())
    .filter((file) => file.toLowerCase().endsWith('.svg'))
    .map((file) => file.slice('public'.length))
    .filter((path) => hasLocalMatch(localPatterns, path));
  assert.deepEqual(admitted, [], 'images.localPatterns admits these SVGs to /_next/image');
});

test('every public/ file the local patterns admit is a raster image by its bytes', async () => {
  // An extension filter alone would admit an SVG saved under a .png name.
  const { localPatterns } = await config();
  const notRaster = [];
  for (const file of await publicFiles()) {
    const path = file.slice('public'.length);
    if (!hasLocalMatch(localPatterns, path)) continue;
    const bytes = await readFile(new URL(`../${file}`, import.meta.url));
    if (!isRaster(bytes)) notRaster.push(path);
  }
  assert.deepEqual(notRaster, [], 'images.localPatterns admits files that are not raster images');
});

test('every raster image the UI references exists and is admitted by localPatterns', async () => {
  const { localPatterns } = await config();
  const paths = await rasterPaths();
  assert.ok(paths.size > 0, 'expected to find image paths in the UI');
  for (const [path, file] of paths) {
    await access(new URL(`../public${path}`, import.meta.url)).catch(() => {
      assert.fail(`${file} references ${path}, which is not in public/`);
    });
    assert.ok(
      hasLocalMatch(localPatterns, path),
      `${file} renders ${path}, which images.localPatterns in next.config.ts does not admit (it would 400 in production)`,
    );
  }
});
