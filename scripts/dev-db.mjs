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
 * It is not durable and it is not a substitute for running migration `0004`
 * against a restored copy of production, which is still outstanding.
 */
import { readdir, readFile } from 'node:fs/promises';

import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { drizzle } from 'drizzle-orm/pglite';

import * as schema from '../lib/db/schema.ts';
import { createAccount, markEmailVerified } from '../lib/auth/accounts.ts';
import { TERMS_VERSION } from '../content/legal.ts';

const PORT = Number(process.env.DEV_DB_PORT ?? 5433);
const PASSWORD = 'correct-horse-battery-staple-9';

const client = new PGlite();
await client.waitReady;

const dir = new URL('../drizzle', import.meta.url);
for (const file of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
  const sqlText = await readFile(new URL(`../drizzle/${file}`, import.meta.url), 'utf8');
  for (const statement of sqlText.split('--> statement-breakpoint')) {
    const trimmed = statement.trim();
    if (trimmed) await client.exec(trimmed);
  }
  console.log(`  applied ${file}`);
}

const db = drizzle(client, { schema });

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

const { grantMembership } = await import('../lib/auth/authority.ts');
for (const person of seed) {
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
//   demo@acme.test  - VERIFIED, SANDBOX. KYB ACTIVE, terms accepted, intent
//                     'pay', approvals set. USD in and local-currency out
//                     (sandbox partners), USDC on Sui TESTNET.
//   live@acme.test  - UNVERIFIED, REAL MONEY. Terms accepted, KYB not
//                     started. Fiat and Treasury locked; USDC on Sui MAINNET
//                     to saved wallet recipients, 5,000 USDC per 30 days,
//                     signed in the operator's own wallet.
//   fresh@acme.test - a new business: REGISTERED, nothing accepted. Walks
//                     the intent picker and the setup stepper, and shows
//                     every lock.
const DEMO_PASSWORD = 'SplashDemo!2026';
const demos = [
  { email: 'demo@acme.test', name: 'Demo Operator', orgId: 'demo-business', org: 'Acme Manufacturing', kyb: 'ACTIVE', onboarded: true, network: 'testnet',
    blurb: 'verified, sandbox - USD in, local-currency out, USDC on Sui testnet' },
  { email: 'live@acme.test', name: 'Live Operator', orgId: 'live-business', org: 'Live Stablecoin Co', kyb: 'REGISTERED', onboarded: true, network: 'mainnet',
    blurb: 'UNVERIFIED, REAL USDC on Sui MAINNET - 5,000 USDC / 30 days, fiat locked' },
  { email: 'fresh@acme.test', name: 'Fresh Operator', orgId: 'fresh-business', org: 'Fresh Trading', kyb: 'REGISTERED', onboarded: false, network: 'testnet',
    blurb: 'new business, walks onboarding' },
];
for (const d of demos) {
  // Obviously fictional originator details, so the travel-rule check on a
  // payment has an org to read (the same values seed:demo writes).
  await client.query(
    `INSERT INTO organizations (id, name, kyb_lifecycle, legal_name, registration_number,
       address_line1, address_city, address_state, address_postal_code, address_country,
       stablecoin_network)
     VALUES ($1, $2, $3, $4, '202401000001', 'Level 8, Menara Demo, Jalan Ampang',
       'Kuala Lumpur', 'Wilayah Persekutuan', '50450', 'MY', $5)
     ON CONFLICT (id) DO NOTHING`,
    [d.orgId, d.org, d.kyb, `${d.org} Sdn Bhd`, d.network],
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

const server = new PGLiteSocketServer({ db: client, port: PORT, host: '127.0.0.1' });
await server.start();

console.log(`\ndev postgres listening on 127.0.0.1:${PORT}`);
console.log(`DATABASE_URL=postgres://postgres@127.0.0.1:${PORT}/postgres?sslmode=disable`);
console.log(`${seed.length} accounts seeded; ${seed.filter((p) => !p.role).length} awaiting access.`);
console.log('');
console.log(`Demo operators (password ${DEMO_PASSWORD}):`);
for (const d of demos) {
  console.log(`  ${d.email.padEnd(18)} ${d.org} - ${d.blurb}`);
}
console.log('');

const stop = async () => {
  await server.stop();
  await client.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
