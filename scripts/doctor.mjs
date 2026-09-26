/**
 * npm run doctor — is this machine able to run Splash, and if not, exactly why.
 *
 * Both developers run this before starting work and paste the output into any
 * bug report. It exists because Seal broke between two machines that both
 * booted cleanly: the divergence was invisible until a request hit it. This
 * makes the whole configuration surface visible in one table, on demand.
 *
 * It calls lib/server/health-checks.ts — the same module GET /api/health
 * serves — so the table and the endpoint can never disagree about the same
 * machine. Nothing here is a second implementation of "is X healthy".
 *
 * Two Node features carry it, both built in, so doctor has no dependency of
 * its own and works on a fresh clone before `npm ci` finishes:
 *   - process.loadEnvFile() reads .env.local the way `next dev` does.
 *   - scripts/alias-hook.mjs resolves the '@/…' alias and the extensionless
 *     imports that tsconfig defines and plain Node does not know about.
 *
 * Exit code is 0 when every check is ok or deliberately skipped, 1 when
 * anything failed — so CI or a pre-push hook can gate on it.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

/* ── Environment file, then the alias hook ────────────────────────────── */

// `next dev` loads .env.local; plain Node does not. Without this, doctor
// would report a correctly-configured machine as empty.
for (const file of ['.env.local', '.env']) {
  const full = path.join(ROOT, file);
  if (existsSync(full)) {
    try { process.loadEnvFile(full); } catch { /* malformed file surfaces in the checks below */ }
  }
}
process.env.NODE_ENV ??= 'development';

// The alias and extensionless imports, resolved for plain Node. Imported
// after loadEnvFile so the environment is in place before any module reads
// it, and before the application imports below.
await import('./alias-hook.mjs');

/* ── Table rendering ──────────────────────────────────────────────────── */

const COLOUR = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (COLOUR ? `[${code}m${s}[0m` : s);
const green = (s) => c('32', s);
const red = (s) => c('31', s);
const yellow = (s) => c('33', s);
const dim = (s) => c('2', s);
const bold = (s) => c('1', s);

const MARK = { ok: green('  ok  '), fail: red(' FAIL '), skipped: yellow(' skip ') };

/** Visible width, ignoring the colour escapes. */
const width = (s) => s.replace(/\[[0-9;]*m/g, '').length;
const pad = (s, n) => s + ' '.repeat(Math.max(0, n - width(s)));

function table(rows) {
  const w = Math.max(...rows.map((r) => width(r.name)));
  const lines = [];
  for (const row of rows) {
    const latency = row.latencyMs === undefined ? '' : dim(` ${row.latencyMs}ms`);
    lines.push(`  ${MARK[row.status]}  ${pad(bold(row.name), w)}  ${row.detail}${latency}`);
  }
  return lines.join('\n');
}

/* ── Checks that belong to the machine, not the services ──────────────── */

function nodeVersionCheck(pkg) {
  const want = pkg.engines?.node;
  const actual = process.versions.node;
  if (!want) return { name: 'Node', status: 'fail', detail: 'package.json declares no engines.node' };
  const [major] = actual.split('.').map(Number);
  const bounds = want.match(/>=\s*(\d+)(?:\.(\d+))?[^<]*<\s*(\d+)/);
  const ok = bounds ? major >= Number(bounds[1]) && major < Number(bounds[3]) : true;
  return {
    name: 'Node',
    status: ok ? 'ok' : 'fail',
    detail: ok
      ? `v${actual} satisfies ${want}`
      : `v${actual} does not satisfy ${want} — .nvmrc pins the version this repo is built and tested on`,
  };
}

function envFileCheck() {
  const local = path.join(ROOT, '.env.local');
  if (existsSync(local)) return { name: 'Env file', status: 'ok', detail: '.env.local loaded' };
  return {
    name: 'Env file',
    status: 'skipped',
    detail: 'no .env.local — development defaults apply; secrets (DATABASE_URL, ENOKI_API_KEY) belong here',
  };
}

function finish(code) {
  process.exitCode = code;
  // The Sui gRPC client keeps an async handle open. Calling process.exit()
  // while libuv still holds it trips
  //   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)
  // on Windows, and the shell sees 127 rather than this code. Let the loop
  // drain on its own; force only if something is still holding it open.
  setTimeout(() => process.exit(code), 250).unref();
}

/* ── Run ──────────────────────────────────────────────────────────────── */

const pkg = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(ROOT, 'package.json'), 'utf8'));

console.log(`\n${bold('Splash doctor')} ${dim(`— ${new Date().toISOString()}`)}\n`);

const rows = [nodeVersionCheck(pkg), envFileCheck()];

// The environment contract first: if it is invalid there is no point probing
// services, and its message names every key at once.
try {
  const { getEnv } = await import('@/lib/env.ts');
  const env = getEnv();
  rows.push({ name: 'Env contract', status: 'ok', detail: `valid for NODE_ENV=${env.NODE_ENV}` });
} catch (error) {
  const lines = String(error.message).split('\n');
  rows.push({ name: 'Env contract', status: 'fail', detail: lines[0] });
  console.log(table(rows));
  console.log(`\n${red('Environment is invalid — service checks skipped.')}\n`);
  for (const line of lines.slice(1)) console.log(line);
  console.log('');
  finish(1);
  process.exit(1);
}

const { runHealthChecks } = await import('@/lib/server/health-checks.ts');
const report = await runHealthChecks();

const NAMES = {
  rpc: 'Sui RPC', package: 'Package ID', db: 'Postgres', seal: 'Seal', enoki: 'Enoki',
  // Go-live: the setup steps a person does by hand.
  laneNode: 'Sui mainnet (USDC)', peg: 'Peg (DeepBook)', usdyPrice: 'USDY price (Ondo)', feeAddress: 'Fee wallet',
  twilio: 'WhatsApp (Twilio)', passkeyDomain: 'Passkey domain', screening: 'Wallet screening',
  launchScope: 'Launch scope',
};
for (const [key, check] of Object.entries(report.checks)) {
  rows.push({ name: NAMES[key] ?? key, status: check.status, detail: check.detail, latencyMs: check.latencyMs });
}

console.log(table(rows));

console.log(`\n  ${bold('Flags')}`);
const flags = Object.entries(report.flags);
const fw = Math.max(...flags.map(([k]) => k.length));
for (const [k, v] of flags) {
  const shown = v === true ? green('true') : v === false ? dim('false') : String(v);
  console.log(`    ${pad(k, fw)}  ${shown}`);
}

const failed = rows.filter((r) => r.status === 'fail');
const skipped = rows.filter((r) => r.status === 'skipped');

console.log('');
if (failed.length === 0) {
  const suffix = skipped.length ? dim(` (${skipped.length} deliberately not configured)`) : '';
  console.log(`  ${green('All checks passed.')}${suffix}\n`);
  finish(0);
}
console.log(`  ${red(`${failed.length} check${failed.length === 1 ? '' : 's'} failed:`)}`);
for (const f of failed) console.log(`    ${bold(f.name)} — ${f.detail}`);
console.log('');
finish(1);
