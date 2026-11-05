#!/usr/bin/env node
/**
 * Install or update the repository-local Sui Pilot checkout.
 *
 * This was a PowerShell script, which meant `npm run setup:sui-pilot` could
 * not execute at all on macOS or Linux — the one setup step the Sui Move
 * workflow in AGENTS.md depends on was Windows-only. Same behaviour, in
 * Node, so one script runs wherever the repo does:
 *
 *   - no checkout yet        → shallow clone into .tools/sui-pilot
 *   - already a git checkout → fast-forward pull
 *   - path exists, not git   → refuse, rather than clone over it
 *
 * git is invoked directly, no shell, so the same argv works on every
 * platform and nothing is interpolated into a command string.
 *
 *   node scripts/setup-sui-pilot.mjs [--install-path <dir>]
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const REPOSITORY = 'https://github.com/contract-hero/sui-pilot.git';
/** The reviewed commit (2 Oct 2026). Sui Pilot is advisory only and nothing
 *  in it is executed; pinning keeps what reviewers read the same for
 *  everyone. Move the pin deliberately, after reading the new commit. */
const PINNED_COMMIT = '280357025bfc414473b1a7656f8de555ad5e674a';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, stdio: 'inherit', shell: false });
  if (result.error) throw new Error(`git could not be run: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} exited ${result.status}`);
}

const installPath = resolve(process.cwd(), arg('--install-path', '.tools/sui-pilot'));

if (existsSync(resolve(installPath, '.git'))) {
  console.log(`Updating Sui Pilot at ${installPath} to ${PINNED_COMMIT}`);
} else if (existsSync(installPath)) {
  throw new Error(`${installPath} exists but is not a Sui Pilot git checkout.`);
} else {
  mkdirSync(dirname(installPath), { recursive: true });
  console.log(`Installing Sui Pilot at ${installPath}, pinned to ${PINNED_COMMIT}`);
  git(['clone', '--depth', '1', '--no-checkout', REPOSITORY, installPath]);
}
git(['-C', installPath, 'fetch', '--depth', '1', 'origin', PINNED_COMMIT]);
git(['-C', installPath, 'checkout', '--detach', PINNED_COMMIT]);

console.log('Sui Pilot is ready (advisory only). See docs/sui-pilot.md for the Splash workflow.');
