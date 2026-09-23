/**
 * Create (or reset) a demo operator you can actually sign in as.
 *
 * ─── Why this exists ────────────────────────────────────────────────────────
 *
 * Phase 3 split identity from authority: signing up creates a user and grants
 * NOTHING, and `resolveAuthorityForSession` throws rather than provisioning a
 * membership. That is the correct behaviour, and it means a fresh database has
 * no account that can open the dashboard. Getting one previously required a SQL
 * client and knowledge of three tables and an enum.
 *
 * This writes those three rows and nothing else:
 *
 *   organizations   the workspace, and its KYB lifecycle state
 *   users           the identity, with a scrypt hash from lib/auth/password.ts
 *   memberships     the authority — without this row the account sees nothing
 *
 * ─── This is a development tool ─────────────────────────────────────────────
 *
 * It refuses to run against a non-local database unless you pass --force, and
 * it prints the password it set. Both are deliberate: a seeded account with a
 * known password is exactly what you do not want in a production cluster, and a
 * script that silently created one would be worse than one that says so.
 *
 * Usage:
 *   npm run seed:demo
 *   npm run seed:demo -- --kyb ACTIVE --email me@example.com
 */
import { readFileSync } from 'node:fs';

import pg from 'pg';

import { hashPassword } from '../lib/auth/password.ts';

/**
 * Read `.env.local` the way Next does, because a standalone script does not get
 * it for free. Deliberately does not overwrite anything already in the
 * environment: `DATABASE_URL=... npm run seed:demo` should point where you said,
 * not where the file says.
 */
function loadEnvLocal() {
  let text;
  try {
    text = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
  } catch {
    return;
  }
  for (const rawLine of text.split('\n')) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue;
    let value = trimmed.slice(eq + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted) value = value.slice(1, -1);
    process.env[key] = value;
  }
}

loadEnvLocal();

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (!arg.startsWith('--')) continue;
  const key = arg.slice(2);
  const next = process.argv[i + 1];
  if (next && !next.startsWith('--')) {
    args.set(key, next);
    i += 1;
  } else {
    args.set(key, 'true');
  }
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Point it at your local Postgres and try again.');
  process.exit(1);
}

const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url);
if (!isLocal && args.get('force') !== 'true') {
  console.error(
    'DATABASE_URL does not look local. This seeds an account with a known password —\n' +
      'if you genuinely mean to do that here, re-run with --force.',
  );
  process.exit(1);
}

const email = (args.get('email') ?? 'demo@acme.test').toLowerCase();
const password = args.get('password') ?? 'SplashDemo!2026';
const orgId = args.get('org') ?? 'demo-business';
const orgName = args.get('org-name') ?? 'Acme Manufacturing';
// REGISTERED is the honest default: it is the state a real new business is in,
// and it exercises the KYB gate. Pass --kyb ACTIVE when you need to click
// through money movement.
const kyb = args.get('kyb') ?? 'REGISTERED';
// admin | checker | maker | viewer. `admin` can prepare and approve, which is
// what a single-operator walkthrough needs — note that the same person being
// maker and checker on one proposal is still refused, by design.
const role = args.get('role') ?? 'admin';

const client = new pg.Client({ connectionString: url });
await client.connect();

try {
  // The ORIGINATOR half of FATF R.16, which is org-level and established once
  // at KYB. Without it every payment is refused with
  // `travel_rule_incomplete → originator.addressLine1` — correctly, but it
  // makes a seeded workspace unable to send anything, which is not much of a
  // demo. These are obviously fictional values for an obviously fictional org.
  await client.query(
    `INSERT INTO organizations (
       id, name, kyb_lifecycle, legal_name, registration_number,
       address_line1, address_city, address_state, address_postal_code, address_country
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       kyb_lifecycle = EXCLUDED.kyb_lifecycle,
       legal_name = COALESCE(organizations.legal_name, EXCLUDED.legal_name),
       registration_number = COALESCE(organizations.registration_number, EXCLUDED.registration_number),
       address_line1 = COALESCE(organizations.address_line1, EXCLUDED.address_line1),
       address_city = COALESCE(organizations.address_city, EXCLUDED.address_city),
       address_state = COALESCE(organizations.address_state, EXCLUDED.address_state),
       address_postal_code = COALESCE(organizations.address_postal_code, EXCLUDED.address_postal_code),
       address_country = COALESCE(organizations.address_country, EXCLUDED.address_country)`,
    [
      orgId,
      orgName,
      kyb,
      `${orgName} Sdn Bhd`,
      '202401000001',
      'Level 8, Menara Demo, Jalan Ampang',
      'Kuala Lumpur',
      'Wilayah Persekutuan',
      '50450',
      'MY',
    ],
  );

  // Ids are derived from the EMAIL, not the org. Deriving them from the org
  // meant the second person seeded into one workspace collided on the users
  // primary key — which is exactly the case you need for maker-checker, since
  // a maker and a checker are two people in the same organisation.
  const slug = email.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

  const hash = await hashPassword(password);
  const inserted = await client.query(
    `INSERT INTO users (id, email, name, password_hash, email_verified_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
     RETURNING id`,
    [`usr_seed_${slug}`, email, 'Demo Operator', hash],
  );
  // On conflict the RETURNING id is the EXISTING row's id, which may differ
  // from the one just proposed. The membership below must use that one.
  const userId = inserted.rows[0].id;

  // The row that actually grants access. Without it the account signs in and
  // sees nothing, which is the intended fail-closed behaviour.
  await client.query(
    `INSERT INTO memberships (id, user_id, org_id, role)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, org_id) DO UPDATE SET role = EXCLUDED.role`,
    [`mem_seed_${slug}_${orgId}`, userId, orgId, role],
  );

  const gateNote = kyb === 'ACTIVE' ? '' : '  — money movement is gated until this is ACTIVE';
  console.log('Seeded a demo operator:\n');
  console.log(`  email     ${email}`);
  console.log(`  password  ${password}`);
  console.log(`  org       ${orgId} (${orgName})`);
  console.log(`  role      ${role}`);
  console.log(`  KYB       ${kyb}${gateNote}`);
  console.log('\nSign in at /login.');
} finally {
  await client.end();
}
