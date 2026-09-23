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

const server = new PGLiteSocketServer({ db: client, port: PORT, host: '127.0.0.1' });
await server.start();

console.log(`\ndev postgres listening on 127.0.0.1:${PORT}`);
console.log(`DATABASE_URL=postgres://postgres@127.0.0.1:${PORT}/postgres?sslmode=disable`);
console.log(`${seed.length} accounts seeded; ${seed.filter((p) => !p.role).length} awaiting access.\n`);

const stop = async () => {
  await server.stop();
  await client.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
