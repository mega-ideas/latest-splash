/**
 * A throwaway Postgres for local development.
 *
 * The app talks to Postgres over the wire (`pg`), so the PGlite instance the
 * tests use in-process is not reachable from `next dev`. This wraps the same
 * PGlite in its socket server, applies every migration in `drizzle/`, and seeds
 * an organisation plus a few accounts — enough to open the staff console and
 * see real rows without provisioning a cluster.
 *
 *   node --experimental-strip-types scripts/dev-db.mjs
 *   DATABASE_URL=postgres://postgres@127.0.0.1:5433/postgres?sslmode=disable
 *
 * By default it lives in memory and every row is gone when it stops. Set
 * DEV_DB_DIR (in .env.local or the shell, e.g. DEV_DB_DIR=.dev-db) to keep
 * it on disk instead: passkeys, saved recipients, transfers and verified
 * WhatsApp numbers then survive a restart. On disk, only migrations not yet
 * applied run (tracked in splash_dev_migrations) and the seed runs once.
 * Stop it with Ctrl+C so Postgres shuts down cleanly; delete the directory
 * to start over.
 *
 * Neither mode is a substitute for running migration `0004` against a
 * restored copy of production, which is still outstanding.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { drizzle } from 'drizzle-orm/pglite';

import * as schema from '../lib/db/schema.ts';
import { createAccount, markEmailVerified } from '../lib/auth/accounts.ts';
import { TERMS_VERSION } from '../content/legal.ts';

// .env.local first: DEV_DB_DIR, DEV_DB_PORT and the WhatsApp numbers below may
// live there. Values already in the shell win.
try {
  process.loadEnvFile(fileURLToPath(new URL('../.env.local', import.meta.url)));
} catch {
  // No .env.local: defaults apply.
}

const PORT = Number(process.env.DEV_DB_PORT ?? 5433);
const PASSWORD = 'correct-horse-battery-staple-9';

// -- Where the data lives ---------------------------------------------------
const DATA_DIR = process.env.DEV_DB_DIR ? resolve(process.env.DEV_DB_DIR) : null;
const LOCK = DATA_DIR ? `${DATA_DIR}.lock` : null;
if (DATA_DIR) {
  // Two servers on one data directory corrupt it, and PGlite does not stop
  // that on its own. The lock sits beside the directory, not in it, so
  // Postgres never finds a stranger among its files.
  if (existsSync(LOCK)) {
    const pid = Number(readFileSync(LOCK, 'utf8'));
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      // No such process: a stale lock from a run that was killed.
    }
    if (alive) {
      // A hard-killed server leaves its lock behind, and Windows can hand its
      // PID to an unrelated process — so say how to clear it, not just no.
      console.error(
        `${DATA_DIR} looks in use by process ${pid}. Stop that dev:db first, or point DEV_DB_DIR elsewhere.
` +
          `If no dev:db is running (it was killed and the PID was reused), delete ${LOCK} and start again.`,
      );
      process.exit(1);
    }
  }
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(LOCK, String(process.pid));
}

const client = DATA_DIR ? new PGlite(DATA_DIR) : new PGlite();
await client.waitReady;

// -- Migrations: apply what this database has not seen ----------------------
// Each file's statements run one by one, as before (0020 adds an enum value
// and uses it, which a single wrapping transaction would refuse). A file is
// recorded only once all of it succeeded; the hash catches a migration edited
// after this database applied it, which would otherwise drift silently.
await client.exec(`CREATE TABLE IF NOT EXISTS splash_dev_migrations (
  name text PRIMARY KEY,
  sha256 text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
)`);
const applied = new Map(
  (await client.query('SELECT name, sha256 FROM splash_dev_migrations')).rows.map((r) => [r.name, r.sha256]),
);
const dir = new URL('../drizzle', import.meta.url);
let appliedNow = 0;
for (const file of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
  const sqlText = await readFile(new URL(`../drizzle/${file}`, import.meta.url), 'utf8');
  const sha256 = createHash('sha256').update(sqlText).digest('hex');
  if (applied.has(file)) {
    if (applied.get(file) !== sha256) {
      console.warn(`  ${file} has changed since this database applied it; delete ${DATA_DIR} to rebuild if it matters`);
    }
    continue;
  }
  try {
    for (const statement of sqlText.split('--> statement-breakpoint')) {
      const trimmed = statement.trim();
      if (trimmed) await client.exec(trimmed);
    }
  } catch (error) {
    console.error(`  ${file} failed: ${error instanceof Error ? error.message : error}`);
    if (DATA_DIR) console.error(`  ${DATA_DIR} may be half-migrated. Delete it and start again.`);
    await client.close();
    if (LOCK) rmSync(LOCK, { force: true });
    process.exit(1);
  }
  await client.query('INSERT INTO splash_dev_migrations (name, sha256) VALUES ($1, $2)', [file, sha256]);
  appliedNow += 1;
  console.log(`  applied ${file}`);
}
if (applied.size > 0) console.log(`  ${applied.size} migrations already applied, ${appliedNow} new`);

const db = drizzle(client, { schema });

// -- Seed, once --------------------------------------------------------------
// In memory this is every start. On disk, the demo operator's row says the
// seed already ran, and running it again would trip on the accounts it made.
const firstBoot =
  (await client.query('SELECT 1 FROM users WHERE email = $1', ['demo@acme.test'])).rows.length === 0;

const { grantMembership } = await import('../lib/auth/authority.ts');

await client.exec(`
  INSERT INTO organizations (id, name, legal_name)
  VALUES ('acme', 'Acme Trading', 'Acme Trading Sdn Bhd'),
         ('northwind', 'Northwind Foods', 'Northwind Foods Pte Ltd')
  ON CONFLICT (id) DO NOTHING;
`);

// Deliberately mixed: some with authority, some without. The ones without are
// what the console exists to act on, so a seed that grants everyone a role
// would hide the screen's whole purpose. Tom has proven his mailbox and is
// waiting for a grant; Lin has not, and the console must refuse to grant her
// anything until she opens the link.
const seed = [
  { email: 'nadia@acme.example', name: 'Nadia Rahman', role: 'admin', verified: true },
  { email: 'ben@acme.example', name: 'Ben Ooi', role: 'maker', verified: true },
  { email: 'priya@acme.example', name: 'Priya Nair', role: 'checker', verified: true },
  { email: 'tom@acme.example', name: 'Tom Aziz', role: null, verified: true },
  { email: 'lin@northwind.example', name: 'Lin Chua', role: null, verified: false },
];

for (const person of firstBoot ? seed : []) {
  await createAccount(db, { email: person.email, password: PASSWORD, name: person.name });
  // A grant requires a proven mailbox. The seed stands in for the link.
  if (person.verified) await markEmailVerified(db, person.email);
  if (person.role) {
    await grantMembership(db, {
      email: person.email,
      orgId: person.email.endsWith('@acme.example') ? 'acme' : 'northwind',
      role: person.role,
      grantedBy: 'staff@splash.finance',
    });
  }
}

// -- The demo operators ----------------------------------------------------
// Seeded HERE, in-process, rather than by `npm run seed:demo` over the
// socket: the socket server takes exactly one client, and a second one (a
// seed script, a crashed dev server that never let go) wedges it for
// everyone. One process, one command, and the demo works on first sign-in.
//
//   demo@acme.test  - VERIFIED. KYB ACTIVE, terms accepted, intent 'pay',
//                     approvals set. USD in and local-currency out through
//                     the SANDBOX partners; USDC on Sui MAINNET (real).
//   live@acme.test  - UNVERIFIED. Terms accepted, KYB not started. Fiat and
//                     Treasury locked; USDC on Sui MAINNET (real) to saved
//                     wallet recipients, 5,000 USDC per 30 days.
//
// Stablecoins are mainnet for everyone — there is no stablecoin sandbox.
//   fresh@acme.test - a new business: REGISTERED, nothing accepted. Walks
//                     the intent picker and the setup stepper, and shows
//                     every lock.
const DEMO_PASSWORD = 'SplashDemo!2026';
const demos = [
  { email: 'demo@acme.test', name: 'Demo Operator', orgId: 'demo-business', org: 'Acme Manufacturing', kyb: 'ACTIVE', onboarded: true,
    blurb: 'verified - USD in / local-currency out (sandbox), USDC on Sui mainnet (real)' },
  { email: 'live@acme.test', name: 'Live Operator', orgId: 'live-business', org: 'Live Stablecoin Co', kyb: 'REGISTERED', onboarded: true,
    blurb: 'UNVERIFIED - USDC on Sui mainnet only (real), 5,000 USDC / 30 days, fiat locked' },
  { email: 'fresh@acme.test', name: 'Fresh Operator', orgId: 'fresh-business', org: 'Fresh Trading', kyb: 'REGISTERED', onboarded: false,
    blurb: 'new business, walks onboarding' },
];
for (const d of firstBoot ? demos : []) {
  // Obviously fictional originator details, so the travel-rule check on a
  // payment has an org to read (the same values seed:demo writes).
  await client.query(
    `INSERT INTO organizations (id, name, kyb_lifecycle, legal_name, registration_number,
       address_line1, address_city, address_state, address_postal_code, address_country)
     VALUES ($1, $2, $3, $4, '202401000001', 'Level 8, Menara Demo, Jalan Ampang',
       'Kuala Lumpur', 'Wilayah Persekutuan', '50450', 'MY')
     ON CONFLICT (id) DO NOTHING`,
    [d.orgId, d.org, d.kyb, `${d.org} Sdn Bhd`],
  );
  await createAccount(db, { email: d.email, password: DEMO_PASSWORD, name: d.name });
  await markEmailVerified(db, d.email);
  await grantMembership(db, { email: d.email, orgId: d.orgId, role: 'admin', grantedBy: 'staff@splash.finance' });
  if (d.onboarded) {
    const { rows } = await client.query('SELECT id FROM users WHERE email = $1', [d.email]);
    const userId = rows[0].id;
    await client.query(
      `INSERT INTO terms_acceptances (id, user_id, org_id, version) VALUES ($1, $2, $3, $4)`,
      [`terms_dev_${d.orgId}`, userId, d.orgId, TERMS_VERSION],
    );
    await client.query(`UPDATE organizations SET intent = 'pay' WHERE id = $1`, [d.orgId]);
    await client.query(`INSERT INTO org_settings (org_id, updated_by) VALUES ($1, $2)`, [d.orgId, userId]);
  }
}

// -- Optional: pre-verified WhatsApp numbers for the demo admins ------------
// In memory, a restart would mean re-verifying a number every time. Local
// only: set DEV_WHATSAPP_DEMO_ADMIN / DEV_WHATSAPP_LIVE_ADMIN (E.164, e.g.
// +60123456789) in .env.local, which is never committed. It skips the proof
// round-trip the Settings screen does — acceptable for a dev database, never
// anywhere else. One number, one person: the same number cannot serve both
// admins (approver_channels_number_unique). An admin who already has a
// number (seeded earlier, or verified in Settings) keeps it.
const seededNumbers = new Set();
for (const [email, orgId, raw] of [
  ['demo@acme.test', 'demo-business', process.env.DEV_WHATSAPP_DEMO_ADMIN],
  ['live@acme.test', 'live-business', process.env.DEV_WHATSAPP_LIVE_ADMIN],
]) {
  const e164 = (raw ?? '').replace(/[^\d+]/g, '');
  if (!e164) continue;
  if (!/^\+[1-9]\d{7,14}$/.test(e164)) {
    console.warn(`  skipped WhatsApp for ${email}: ${raw} is not E.164 (+ country code, digits)`);
    continue;
  }
  if (seededNumbers.has(e164)) {
    console.warn(`  skipped WhatsApp for ${email}: ${e164} is already the other admin's number`);
    continue;
  }
  const { rows } = await client.query('SELECT id FROM users WHERE email = $1', [email]);
  const taken = await client.query('SELECT 1 FROM approver_channels WHERE user_id = $1 OR whatsapp_e164 = $2', [
    rows[0].id,
    e164,
  ]);
  if (taken.rows.length > 0) {
    seededNumbers.add(e164);
    continue;
  }
  await client.query(
    `INSERT INTO approver_channels (id, org_id, user_id, whatsapp_e164, verified_at) VALUES ($1, $2, $3, $4, now())`,
    [`chn_dev_${orgId}`, orgId, rows[0].id, e164],
  );
  seededNumbers.add(e164);
  console.log(`  WhatsApp ${e164.slice(0, 3)}••••${e164.slice(-4)} pre-verified for ${email}`);
}

const server = new PGLiteSocketServer({ db: client, port: PORT, host: '127.0.0.1' });
await server.start();

console.log(`\ndev postgres listening on 127.0.0.1:${PORT}`);
console.log(`DATABASE_URL=postgres://postgres@127.0.0.1:${PORT}/postgres?sslmode=disable`);
console.log(DATA_DIR ? `data kept in ${DATA_DIR} (Ctrl+C to stop cleanly)` : 'data in memory: gone when this stops (set DEV_DB_DIR to keep it)');
console.log(
  firstBoot
    ? `${seed.length} accounts seeded; ${seed.filter((p) => !p.role).length} awaiting access.`
    : 'existing database: seed skipped, your rows are as you left them.',
);
console.log('');
console.log(`Demo operators (password ${DEMO_PASSWORD}):`);
for (const d of demos) {
  console.log(`  ${d.email.padEnd(18)} ${d.org} - ${d.blurb}`);
}
console.log('');

const stop = async () => {
  await server.stop();
  await client.close();
  if (LOCK) rmSync(LOCK, { force: true });
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
