import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

import * as schema from '../lib/db/schema.ts';
import {
  __testing,
  findBySlug,
  getInvoice,
  getInvoiceForStaff,
  insertInvoice,
  listInvoices,
  patchInvoice,
} from '../lib/server/repository/invoices.ts';

/**
 * Invoices, in Postgres, belonging to somebody.
 *
 * `invoices` has had org_id NOT NULL, bigint minor units and a unique pay-link
 * slug since migration 0000. The operational invoice lived in a `Map` with none
 * of it, and every route read that Map by id alone — including a PATCH, which
 * made it a write across the tenant boundary rather than only a read.
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

const invoice = (over = {}) => ({
  id: 'inv_1',
  orgId: 'acme',
  issuerOrg: 'Acme Trading',
  payerOrgName: 'Mabuhay Logistics Inc',
  payerOrgEmail: 'ap@mabuhay.ph',
  amountUsd: '5000.00',
  targetCurrency: 'PHP',
  dueDate: '2026-10-01',
  memo: 'Component supply invoice',
  status: 'draft',
  payLinkSlug: 'acme-ph-5000',
  ...over,
});

// ── Durability ──────────────────────────────────────────────────────────────

test('an invoice survives, and comes back as the same amount', async () => {
  const { client, db } = await migratedDb();
  await insertInvoice(db, invoice());

  const read = await getInvoice(db, 'acme', 'inv_1');
  assert.equal(read.amountUsd, '5000', 'trailing zeros are not significant');
  assert.equal(read.issuerOrg, 'Acme Trading');
  assert.equal(read.payerOrgEmail, 'ap@mabuhay.ph');
  assert.equal(read.status, 'draft');
  await client.close();
});

test('money round-trips through minor units without a float anywhere', () => {
  const { toMinor, fromMinor } = __testing;
  assert.equal(toMinor('5000.00'), 5_000_000_000n);
  assert.equal(toMinor('0.1') + toMinor('0.2'), toMinor('0.3'));
  assert.equal(fromMinor(9_007_199_254_740_993n), '9007199254.740993');
  // More precision than the unit holds is truncated, never rounded up: an
  // invoice must not ask for more than it was written for.
  assert.equal(toMinor('1.0000009'), 1_000_000n);
});

test('the four columns that were missing hold what they were added for', async () => {
  const { client, db } = await migratedDb();
  await insertInvoice(db, invoice({
    paymentReference: 'SPL-ACME-5000',
    documentSha256: 'a'.repeat(64),
    transferIntentId: 'ti_1',
    demo: true,
  }));

  const read = await getInvoice(db, 'acme', 'inv_1');
  assert.equal(read.paymentReference, 'SPL-ACME-5000', 'so a bank credit can be matched back');
  assert.equal(read.documentSha256, 'a'.repeat(64), 'so tampering is detectable without a fetch');
  assert.equal(read.transferIntentId, 'ti_1', 'so "was this paid" is not a scan');
  assert.equal(read.demo, true);
  await client.close();
});

// ── Tenant isolation ────────────────────────────────────────────────────────

test('one tenant cannot read another tenant’s invoice by id', async () => {
  const { client, db } = await migratedDb();
  await insertInvoice(db, invoice({ id: 'inv_acme', orgId: 'acme' }));

  assert.notEqual(await getInvoice(db, 'acme', 'inv_acme'), null);
  assert.equal(await getInvoice(db, 'northwind', 'inv_acme'), null, 'an id is not authority');
  await client.close();
});

test('one tenant cannot MODIFY another tenant’s invoice — the sharper half', async () => {
  const { client, db } = await migratedDb();
  await insertInvoice(db, invoice({ id: 'inv_acme', orgId: 'acme', status: 'sent' }));

  // PATCH took an id and no owner, so any authenticated user could mark another
  // tenant's invoice paid, rewrite its payment reference, or bind it to a
  // transfer of their own.
  assert.equal(
    await patchInvoice(db, 'northwind', 'inv_acme', { status: 'paid' }),
    null,
  );
  assert.equal((await getInvoice(db, 'acme', 'inv_acme')).status, 'sent', 'untouched');

  const patched = await patchInvoice(db, 'acme', 'inv_acme', { status: 'paid' });
  assert.equal(patched.status, 'paid');
  await client.close();
});

test('listing is scoped — including the list the copilot reads', async () => {
  const { client, db } = await migratedDb();
  await insertInvoice(db, invoice({ id: 'i_a1', orgId: 'acme', payLinkSlug: 's1' }));
  await insertInvoice(db, invoice({ id: 'i_a2', orgId: 'acme', payLinkSlug: 's2' }));
  await insertInvoice(db, invoice({ id: 'i_n1', orgId: 'northwind', payLinkSlug: 's3' }));

  const acme = await listInvoices(db, 'acme');
  assert.deepEqual(acme.map((i) => i.id).sort(), ['i_a1', 'i_a2']);
  // `/api/copilot/summary` and `/api/copilot/suggest` read this list and
  // describe it back to the user as "your invoices".
  assert.deepEqual((await listInvoices(db, 'northwind')).map((i) => i.id), ['i_n1']);
  await client.close();
});

test('the staff read is a separate, differently-named function', async () => {
  const { client, db } = await migratedDb();
  await insertInvoice(db, invoice({ id: 'inv_acme', orgId: 'acme' }));
  assert.equal((await getInvoiceForStaff(db, 'inv_acme')).orgId, 'acme');
  await client.close();
});

// ── The pay link is a capability, and that is deliberate ────────────────────

test('the slug resolves without an org, because the slug IS the authority', async () => {
  const { client, db } = await migratedDb();
  await insertInvoice(db, invoice({ id: 'inv_acme', orgId: 'acme', payLinkSlug: 'unguessable-9f2a' }));

  // Unscoped on purpose: handed to a payer who has no account, unguessable, and
  // it resolves to one invoice and nothing else.
  const found = await findBySlug(db, 'unguessable-9f2a');
  assert.equal(found.id, 'inv_acme');
  assert.equal(await findBySlug(db, 'not-a-slug'), null);
  await client.close();
});

test('a slug cannot be claimed twice', async () => {
  const { client, db } = await migratedDb();
  await insertInvoice(db, invoice({ id: 'inv_a', orgId: 'acme', payLinkSlug: 'same-slug' }));
  await assert.rejects(
    // Across tenants, too: a second org taking a live slug would silently
    // redirect a payer to a different invoice.
    () => insertInvoice(db, invoice({ id: 'inv_n', orgId: 'northwind', payLinkSlug: 'same-slug' })),
  );
  await client.close();
});

// ── The routes ──────────────────────────────────────────────────────────────

test('every invoice route resolves the org from the session', async () => {
  for (const file of [
    '../app/api/invoices/route.ts',
    '../app/api/invoices/[id]/route.ts',
    '../app/api/copilot/summary/route.ts',
    '../app/api/copilot/suggest/route.ts',
    '../app/api/copilot/extract-invoice/route.ts',
  ]) {
    const text = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.match(text, /requireSessionAccount/, `${file} must scope by session`);
    assert.doesNotMatch(
      text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, ''),
      /listInvoices\(\)|updateInvoice\(/,
      `${file} still reaches an unscoped read or write`,
    );
  }
});

test('the record carries an org id, and it is not optional', async () => {
  const source = await readFile(new URL('../lib/server/operations.ts', import.meta.url), 'utf8');
  const type = source.slice(
    source.indexOf('export type InvoiceRecord'),
    source.indexOf('export type LedgerEntry'),
  );
  assert.match(type, /orgId: string;/);
  assert.doesNotMatch(type, /orgId\?: string/);
});

test('the pay-link issuer lookup no longer crosses tenants', async () => {
  const store = await readFile(
    new URL('../lib/server/recipients-store.ts', import.meta.url),
    'utf8',
  );
  // It was a global name match for one release, because the invoice had no org
  // id. Two tenants both called "Acme Trading" resolved to whichever sorted
  // first, and the page could show one org's KYB status for the other.
  assert.match(store, /export async function findIssuerForPayLink\(\s*orgId: string,/);

  const repo = await readFile(
    new URL('../lib/server/repository/recipients.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(
    repo.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, ''),
    /findByNameAcrossOrgs/,
    'the cross-org escape hatch has no remaining caller and should be gone',
  );
});
