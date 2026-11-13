import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/**
 * What ships to the server is what `dependencies` and the lockfile say ships.
 *
 * `shadcn` is a command-line tool for copying components into the repo. The
 * only thing the app takes from it is `shadcn/tailwind.css`, which Tailwind
 * inlines at build time — and Tailwind itself is a devDependency. Listed under
 * `dependencies` it dragged an MCP server, Express, body-parser and
 * proxy-addr into the production tree, and `npm audit --omit=dev` reported
 * them as critical and high. None of that code runs in the app; all of it was
 * in the audit's production scope and in every production install.
 *
 * `next` 16.0.0 through 16.4.0 carries unauthenticated remote code execution
 * in the image optimizer (GHSA-2464-fhr4-w9xw) and in `use cache` functions
 * (GHSA-673q-mjm6-r5xr), and a Server Actions denial of service
 * (GHSA-p3m5-59mp-jv5r). 16.4.1 is the first 16.x release outside all three.
 */

const readJson = async (file) => JSON.parse(await readFile(new URL(file, import.meta.url), 'utf8'));

/** [major, minor, patch] of a plain x.y.z version; throws on anything else. */
function parts(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  assert.ok(match, `expected an exact x.y.z version, got ${version}`);
  return match.slice(1).map(Number);
}

function atLeast(version, floor) {
  const a = parts(version);
  const b = parts(floor);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

test('shadcn is a build-time tool, not a runtime dependency', async () => {
  const pkg = await readJson('../package.json');
  assert.equal(pkg.dependencies.shadcn, undefined, 'shadcn must not be listed under dependencies');
  assert.ok(pkg.devDependencies.shadcn, 'shadcn stays installed for the build (app/globals.css imports shadcn/tailwind.css)');
  // The CSS import only works because the build installs devDependencies;
  // Tailwind being one is what makes that true everywhere the app is built.
  assert.ok(pkg.devDependencies.tailwindcss, 'tailwindcss is a devDependency, so builds already install them');
});

test('nothing in the production tree pulls in an HTTP server framework', async () => {
  const lock = await readJson('../package-lock.json');
  for (const name of ['express', 'body-parser', 'proxy-addr', '@modelcontextprotocol/sdk']) {
    const entry = lock.packages[`node_modules/${name}`];
    if (entry) assert.equal(entry.dev, true, `${name} is in the production tree`);
  }
});

test('next is past the 16.x releases with known remote code execution', async () => {
  const pkg = await readJson('../package.json');
  const lock = await readJson('../package-lock.json');
  const pinned = pkg.dependencies.next;
  const installed = lock.packages['node_modules/next'].version;
  assert.equal(installed, pinned, 'package.json pins next exactly and the lockfile installs that version');
  assert.ok(atLeast(installed, '16.4.1'), `next ${installed} is inside GHSA-2464-fhr4-w9xw / GHSA-673q-mjm6-r5xr`);
  assert.equal(pkg.devDependencies['eslint-config-next'], pinned, 'eslint-config-next moves with next');
});
