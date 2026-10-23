#!/usr/bin/env node
/**
 * Splash on Sui and the Solana build are separate products in separate
 * repositories:
 *
 *   github.com/mega-ideas/latest-splash   this repository, Sui
 *   github.com/sky9484/splash-solana      the Solana build
 *
 * This guard fails if Solana build material lands here: a Solana or Anchor
 * package in package.json, an Anchor workspace, or a Solana program crate.
 * It looks at dependencies and build files, not at words, so naming Solana
 * as a chain a customer can fund FROM over CCTP (lib/payments/cctp.ts) is
 * fine.
 *
 *   node scripts/check-separate-builds.mjs [root]
 *
 * Run by `npm run lint`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? process.cwd());

/** Packages that only a Solana build needs. */
const SOLANA_PACKAGES = [
  /^@solana\//,
  /^@coral-xyz\//,
  /^@project-serum\//,
  /^@metaplex-foundation\//,
  /^@sqds\//,
  /^@solana-program\//,
  /^@solana-mobile\//,
];

/** Crates that only a Solana program needs. */
const SOLANA_CRATES = /^\s*(anchor-lang|anchor-spl|solana-program|solana-sdk|pinocchio)\s*=/m;

const problems = [];

const pkgPath = path.join(root, 'package.json');
if (existsSync(pkgPath)) {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const name of Object.keys(pkg[field] ?? {})) {
      if (SOLANA_PACKAGES.some((pattern) => pattern.test(name))) {
        problems.push(`package.json ${field} has ${name}`);
      }
    }
  }
}

if (existsSync(path.join(root, 'Anchor.toml'))) problems.push('Anchor.toml (an Anchor workspace)');

/** Every Cargo.toml outside node_modules, build output and git. */
function cargoManifests(dir, depth = 0) {
  if (depth > 6) return [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of entries) {
    if (['node_modules', '.git', '.next', 'target', 'build', '.claude', '.tools'].includes(name)) continue;
    const full = path.join(dir, name);
    let stats;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }
    if (stats.isDirectory()) out.push(...cargoManifests(full, depth + 1));
    else if (name === 'Cargo.toml') out.push(full);
  }
  return out;
}

for (const manifest of cargoManifests(root)) {
  if (SOLANA_CRATES.test(readFileSync(manifest, 'utf8'))) {
    problems.push(`${path.relative(root, manifest).replaceAll('\\', '/')} depends on a Solana program crate`);
  }
}

if (problems.length > 0) {
  console.error('Solana build material found in the Sui repository:');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('Splash on Solana is a separate build. It belongs in github.com/sky9484/splash-solana, not here.');
  process.exit(1);
}

console.log('Builds are separate: no Solana package, Anchor workspace or program crate in this repository.');
