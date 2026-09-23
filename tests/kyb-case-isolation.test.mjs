import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

import * as schema from '../lib/db/schema.ts';
import * as repo from '../lib/server/repository/kyb-cases.ts';

/**
 * A KYB case belongs to one business, and only that business can read it.
 *
 * The case row carries a registration number, the name and SHA-256 of every
 * document a company uploaded, the reviewer's notes and the reason they were
 * rejected. It lived in a process map, and every customer-facing read was
 * authenticated but not scoped:
 *
 *   GET /api/kyb/cases/[id]     returned any case to any signed-in user.
 *   GET /api/kyb/cases/latest   took a business name from the QUERY STRING and
 *                               searched every case in the process.
 *
 * So one customer could read a competitor's KYB file by guessing their name.
 * These tests run against a real database rather than the source text, because
 * "the argument is present" and "the row is actually filtered" are different
 * claims and only the second one matters.
 */

async function migratedDb() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  const files = (await readdir(new URL('../drizzle', import.meta.url)))
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const sqlText = await readFile(new URL(`../drizzle/${file}`, import.meta.url), 'utf8');
    for (const statement of sqlText.split('--> statement-breakpoint')) {
      const trimmed = statement.trim();
      if (trimmed) await client.exec(trimmed);
    }
  }
  await client.exec(`
    INSERT INTO organizations (id, name) VALUES ('acme', 'Acme Trading'), ('northwind', 'Northwind')
  `);
  return { client, db };
}

const kybCase = (over = {}) => ({
  id: 'kyb_acme',
  orgId: 'acme',
  businessName: 'Acme Trading Sdn Bhd',
  registrationNumber: '202401012345',
  state: 'SUBMITTED',
  riskTier: 'UNASSIGNED',
  corridorAccess: 'LOCKED',
  assignedTo: null,
  sumsubApplicantId: null,
  documents: [{ name: 'form-9.pdf', sha256: 'a'.repeat(64) }],
  reviewNotes: null,
  decisionReason: null,
  auditTrail: [],
  submittedAt: new Date('2026-09-01T00:00:00Z'),
  updatedAt: new Date('2026-09-01T00:00:00Z'),
  ...over,
});

test('a case survives a restart', async () => {
  const { client, db } = await migratedDb();
  await repo.insertOrUpdate(db, kybCase());

  const found = await repo.findForOrg(db, 'acme', 'kyb_acme');
  assert.equal(found?.businessName, 'Acme Trading Sdn Bhd');
  // The document hashes are what a reviewer checks a re-upload against.
  assert.equal(found?.documents[0].sha256, 'a'.repeat(64));
  await client.close();
});

test('one org cannot read another org\'s case by id', async () => {
  const { client, db } = await migratedDb();
  await repo.insertOrUpdate(db, kybCase());

  // The id is guessable — it is derived from the case, and it used to be the
  // whole authorisation check.
  assert.equal(await repo.findForOrg(db, 'northwind', 'kyb_acme'), null);
  assert.notEqual(await repo.findForOrg(db, 'acme', 'kyb_acme'), null);
  await client.close();
});

test('listing is scoped, and the reviewer\'s notes do not leak with it', async () => {
  const { client, db } = await migratedDb();
  await repo.insertOrUpdate(db, kybCase());
  await repo.insertOrUpdate(
    db,
    kybCase({
      id: 'kyb_northwind',
      orgId: 'northwind',
      businessName: 'Northwind Exports',
      registrationNumber: '202399887766',
      state: 'REJECTED',
      decisionReason: 'Adverse media on a director',
      updatedAt: new Date('2026-09-02T00:00:00Z'),
    }),
  );

  const acme = await repo.listForOrg(db, 'acme');
  assert.deepEqual(acme.map((row) => row.id), ['kyb_acme']);

  // The rejection reason is the single most sensitive field on the record and
  // the one a competitor would most want.
  const leaked = acme.some((row) => row.decisionReason?.includes('Adverse media'));
  assert.equal(leaked, false);
  await client.close();
});

test('staff see every tenant, newest first — and that read is named for it', async () => {
  const { client, db } = await migratedDb();
  await repo.insertOrUpdate(db, kybCase());
  await repo.insertOrUpdate(
    db,
    kybCase({
      id: 'kyb_northwind',
      orgId: 'northwind',
      registrationNumber: '202399887766',
      updatedAt: new Date('2026-09-05T00:00:00Z'),
    }),
  );

  // A compliance officer reviews other people's businesses; that is the job.
  // The point is that it is a different function, so a call site cannot cross
  // tenants by omitting an argument.
  const all = await repo.listAllForStaff(db);
  assert.deepEqual(all.map((row) => row.id), ['kyb_northwind', 'kyb_acme']);
  await client.close();
});

test('one company gets one case, not two review histories', async () => {
  const { client, db } = await migratedDb();
  await repo.insertOrUpdate(db, kybCase());

  // A resubmission updates the case. Two rows for one company would mean two
  // audit trails and a decision recorded against whichever the reviewer opened.
  await repo.insertOrUpdate(db, kybCase({ state: 'IN_REVIEW', assignedTo: 'compliance@splash.finance' }));

  const rows = await repo.listForOrg(db, 'acme');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'IN_REVIEW');

  // And a second case id for the same registration number in the same org is
  // refused by the database, not merely discouraged by convention. The driver
  // wraps the constraint name, so the assertion is that the write failed and
  // the second row does not exist — which is the property, rather than the
  // wording of somebody else's error message.
  await assert.rejects(() => repo.insertOrUpdate(db, kybCase({ id: 'kyb_acme_duplicate' })));
  assert.equal((await repo.listForOrg(db, 'acme')).length, 1);
  await client.close();
});

test('the same registration number in a different org is a different company', async () => {
  const { client, db } = await migratedDb();
  await repo.insertOrUpdate(db, kybCase());
  // Registration numbers are only unique within a registry, and two orgs are
  // not required to be in the same one. Scoping the constraint by org is what
  // stops one tenant's filing blocking another's.
  await repo.insertOrUpdate(db, kybCase({ id: 'kyb_northwind', orgId: 'northwind' }));

  assert.equal((await repo.listForOrg(db, 'acme')).length, 1);
  assert.equal((await repo.listForOrg(db, 'northwind')).length, 1);
  await client.close();
});
