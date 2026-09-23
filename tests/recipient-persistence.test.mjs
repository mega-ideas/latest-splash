import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

import * as schema from '../lib/db/schema.ts';
import {
  __testing,
  deleteRecipient,
  findRecipientByEmailOrName,
  getRecipient,
  getRecipientForStaff,
  insertRecipient,
  listRecipients,
} from '../lib/server/repository/recipients.ts';

/**
 * Beneficiaries, in Postgres, belonging to somebody.
 *
 * `suppliers` was built for this record in migration 0006 — legal identity,
 * address, bank routing, screening verdict, the whole FATF R.16 set — and never
 * wired up. The operational beneficiary lived in a `Map` with no org id, so
 * every travel-rule field was discarded on restart AND both routes read the map
 * without a tenant boundary:
 *
 *   GET /api/recipients        every tenant's beneficiaries to any caller
 *   DELETE /api/recipients/:id any tenant's beneficiary, destroyed by id
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

const recipient = (over = {}) => ({
  id: 'rcpt_1',
  orgId: 'acme',
  name: 'Mabuhay Logistics Inc',
  country: 'PH',
  bank: 'BDO Unibank',
  swift: 'BNORPHMM',
  account: '001234567890',
  tier: 'PAYOUT_ONLY',
  kybStatus: 'none',
  createdVia: 'manual',
  ...over,
});

// ── Durability ──────────────────────────────────────────────────────────────

test('a beneficiary survives, with the routing a payout actually needs', async () => {
  const { client, db } = await migratedDb();
  await insertRecipient(db, recipient());

  const read = await getRecipient(db, 'acme', 'rcpt_1');
  assert.equal(read.name, 'Mabuhay Logistics Inc');
  assert.equal(read.bank, 'BDO Unibank');
  assert.equal(read.swift, 'BNORPHMM');
  assert.equal(read.account, '001234567890');
  assert.equal(read.tier, 'PAYOUT_ONLY');
  await client.close();
});

test('the sweep configuration and the invite state come back too', async () => {
  const { client, db } = await migratedDb();
  await insertRecipient(db, recipient({
    tier: 'SWEEP_ACCOUNT',
    orgEmail: 'ops@mabuhay.ph',
    createdVia: 'invoice_link',
    kybInviteSent: true,
    sweepConfig: {
      targetCurrency: 'PHP',
      partner: 'PDAX',
      destinationBank: 'BDO',
      destinationAccount: '001234567890',
      sweepDelaySeconds: 4,
    },
  }));

  const read = await getRecipient(db, 'acme', 'rcpt_1');
  assert.equal(read.sweepConfig.partner, 'PDAX');
  assert.equal(read.sweepConfig.sweepDelaySeconds, 4);
  assert.equal(read.orgEmail, 'ops@mabuhay.ph');
  assert.equal(read.createdVia, 'invoice_link');
  assert.equal(read.kybInviteSent, true);
  await client.close();
});

test('the record’s three KYB states and the column’s five agree', async () => {
  const { toColumnKyb, fromColumnKyb } = __testing;
  // `lite` is `basic` under another name — a type and a table written a year
  // apart. Mapped in one place rather than at each call site.
  assert.equal(toColumnKyb('lite'), 'basic');
  assert.equal(toColumnKyb('full'), 'full');
  assert.equal(toColumnKyb('none'), 'none');
  assert.equal(fromColumnKyb('basic'), 'lite');
  assert.equal(fromColumnKyb('pending'), 'lite');
  // A rejected beneficiary must never read back as `full`. It reads as `lite`,
  // which is the record's only "not verified" state that is not "nothing".
  assert.equal(fromColumnKyb('rejected'), 'lite');
  assert.equal(fromColumnKyb('full'), 'full');
});

// ── Tenant isolation ────────────────────────────────────────────────────────

test('one tenant cannot read another tenant’s beneficiary by id', async () => {
  const { client, db } = await migratedDb();
  await insertRecipient(db, recipient({ id: 'rcpt_acme', orgId: 'acme' }));

  assert.notEqual(await getRecipient(db, 'acme', 'rcpt_acme'), null);
  assert.equal(await getRecipient(db, 'northwind', 'rcpt_acme'), null, 'an id is not authority');
  await client.close();
});

test('listing returns one tenant’s beneficiaries, not the whole book', async () => {
  const { client, db } = await migratedDb();
  await insertRecipient(db, recipient({ id: 'r_a1', orgId: 'acme' }));
  await insertRecipient(db, recipient({ id: 'r_a2', orgId: 'acme', name: 'Cebu Components' }));
  await insertRecipient(db, recipient({ id: 'r_n1', orgId: 'northwind', name: 'Hanoi Textiles' }));

  const acme = await listRecipients(db, 'acme');
  assert.equal(acme.length, 2);
  // The list is the entire PII payload — names, banks, SWIFT codes, account
  // numbers. It went to any authenticated caller, whole.
  assert.ok(!acme.some((r) => r.name === 'Hanoi Textiles'));

  const northwind = await listRecipients(db, 'northwind');
  assert.deepEqual(northwind.map((r) => r.id), ['r_n1']);
  await client.close();
});

test('a delete cannot reach across tenants — the destructive one', async () => {
  const { client, db } = await migratedDb();
  await insertRecipient(db, recipient({ id: 'rcpt_acme', orgId: 'acme' }));

  assert.equal(
    await deleteRecipient(db, 'northwind', 'rcpt_acme'),
    false,
    'any authenticated user could destroy any tenant’s beneficiary by id',
  );
  assert.notEqual(await getRecipient(db, 'acme', 'rcpt_acme'), null, 'still there');

  assert.equal(await deleteRecipient(db, 'acme', 'rcpt_acme'), true);
  assert.equal(await getRecipient(db, 'acme', 'rcpt_acme'), null);
  await client.close();
});

test('a foreign id and a missing id are the same answer', async () => {
  const { client, db } = await migratedDb();
  await insertRecipient(db, recipient({ id: 'rcpt_acme', orgId: 'acme' }));
  assert.equal(await deleteRecipient(db, 'northwind', 'rcpt_acme'), false);
  assert.equal(await deleteRecipient(db, 'northwind', 'rcpt_nope'), false);
  await client.close();
});

test('the invoice-link match stays inside one tenant', async () => {
  const { client, db } = await migratedDb();
  await insertRecipient(db, recipient({ id: 'r_a', orgId: 'acme', name: 'Acme Trading' }));
  await insertRecipient(db, recipient({ id: 'r_n', orgId: 'northwind', name: 'Acme Trading' }));

  // Two tenants, one name. The global match this replaces resolved to whichever
  // sorted first, so an invoice could link to a stranger's beneficiary record.
  assert.equal((await findRecipientByEmailOrName(db, 'acme', { name: 'Acme Trading' })).id, 'r_a');
  assert.equal(
    (await findRecipientByEmailOrName(db, 'northwind', { name: 'Acme Trading' })).id,
    'r_n',
  );
  await client.close();
});

test('the staff read is a separate, differently-named function', async () => {
  const { client, db } = await migratedDb();
  await insertRecipient(db, recipient({ id: 'rcpt_acme', orgId: 'acme' }));
  // Cross-tenant reach exists for the settlement path, which holds a transfer
  // whose owner is already established. Reaching for it is visible.
  assert.equal((await getRecipientForStaff(db, 'rcpt_acme')).orgId, 'acme');
  await client.close();
});

// ── The routes ──────────────────────────────────────────────────────────────

test('every beneficiary route resolves the org from the session', async () => {
  for (const file of ['../app/api/recipients/route.ts', '../app/api/recipients/[id]/route.ts']) {
    const text = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.match(text, /requireSessionAccount/, `${file} must scope by session, not by id alone`);
    assert.doesNotMatch(
      text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, ''),
      /listRecipients\(\)|findRecipient\(|deleteRecipient\(/,
      `${file} still reaches an unscoped read`,
    );
  }
});

test('the record carries an org id, and it is not optional', async () => {
  const source = await readFile(new URL('../lib/server/operations.ts', import.meta.url), 'utf8');
  const type = source.slice(
    source.indexOf('export type RecipientRecord'),
    source.indexOf('export type InvoiceStatusV2'),
  );
  assert.match(type, /orgId: string;/);
  assert.doesNotMatch(type, /orgId\?: string/, 'an optional owner is an owner somebody forgets');
});
