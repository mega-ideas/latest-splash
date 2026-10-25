import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { migratedDb } from './helpers/store-db.mjs';

/* v2 brief 5.8, Get paid: an invoice is created once.

   The create form posted with no key. A second click, or a retry after the
   connection dropped while the server had already saved, made a second
   invoice with its own pay link and its own exact USDC amount, so a payer
   could be sent two links for one debt and pay both.

   Now the dialog makes one create key (a UUID) per invoice it is creating
   and keeps it across retries. The server keeps the key with the invoice
   under a unique index per org: the same key with the same details answers
   with the invoice already made, the same key with other details is
   refused, and another org's key is another org's. */

const KEY = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const KEY_2 = '16fd2706-8baf-433b-82eb-8c7fada847da';

const INPUT = {
  issuerOrg: 'Acme Trading',
  payerOrgName: 'Mabuhay Logistics Inc',
  payerOrgEmail: 'ap@mabuhay.ph',
  amountUsd: 5000,
  targetCurrency: 'php',
  dueDate: '2026-11-09',
  memo: 'Component supply',
};

const createOnce = () => import('../lib/invoices/create-once.ts');

async function source(relative) {
  return readFile(new URL(`../${relative}`, import.meta.url), 'utf8');
}

test('the create key is a UUID, and the fingerprint is the details the payer sees, normalised', async () => {
  const { isCreateKey, createFingerprint } = await createOnce();
  assert.equal(isCreateKey(KEY), true);
  for (const bad of ['', 'inv_1', `${KEY} `, KEY.replace(/-/g, ''), 'x'.repeat(36), null, undefined, 42]) {
    assert.equal(isCreateKey(bad), false, `${JSON.stringify(bad)} is not a create key`);
  }

  const base = createFingerprint(INPUT);
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(createFingerprint({ ...INPUT, amountUsd: '5000.00', targetCurrency: 'PHP', payerOrgName: '  Mabuhay Logistics Inc ' }), base, 'the same invoice typed again is the same');
  for (const change of [{ amountUsd: 5000.01 }, { targetCurrency: 'IDR' }, { dueDate: '2026-11-10' }, { payerOrgName: 'Someone Else' }, { payerOrgEmail: 'other@mabuhay.ph' }, { memo: 'Another note' }, { issuerOrg: 'Acme' }, { documentSha256: 'ab'.repeat(32) }]) {
    assert.notEqual(createFingerprint({ ...INPUT, ...change }), base, `${Object.keys(change)[0]} changes the invoice`);
  }
});

test('in Postgres, a create key is held once per org by the database', async () => {
  const { client, db } = await migratedDb();
  const repo = await import('../lib/server/repository/invoices.ts');
  const row = (over) => ({ id: 'inv_a', orgId: 'acme', issuerOrg: 'Acme Trading', amountUsd: '5000', targetCurrency: 'PHP', dueDate: '2026-11-09', status: 'draft', payLinkSlug: 'slug-a', createKey: KEY, createFingerprint: 'f'.repeat(64), ...over });

  await repo.insertInvoice(db, row());
  await assert.rejects(repo.insertInvoice(db, row({ id: 'inv_b', payLinkSlug: 'slug-b' })), 'the same key twice in one org is refused by the index');
  await repo.insertInvoice(db, row({ id: 'inv_nw', orgId: 'northwind', payLinkSlug: 'slug-nw' }));
  await repo.insertInvoice(db, row({ id: 'inv_c', payLinkSlug: 'slug-c', createKey: KEY_2 }));

  const found = await repo.findInvoiceByCreateKey(db, 'acme', KEY);
  assert.equal(found.id, 'inv_a');
  assert.equal(found.createFingerprint, 'f'.repeat(64));
  assert.equal((await repo.findInvoiceByCreateKey(db, 'northwind', KEY)).id, 'inv_nw', 'another org with the same key reads its own');
  assert.equal(await repo.findInvoiceByCreateKey(db, 'acme', '0f8fad5b-d9cb-469f-a165-70867728950e'), null);
  await client.close();
});

async function withStore(useDb, fn) {
  const saved = process.env.DATABASE_URL;
  let client;
  if (useDb) {
    const made = await migratedDb();
    client = made.client;
    globalThis.splashDb = made.db;
    process.env.DATABASE_URL = 'postgres://pglite.test/splash';
  } else {
    delete process.env.DATABASE_URL;
  }
  try {
    const store = await import('../lib/server/invoices-store.ts');
    const { buildInvoice } = await import('../lib/server/operations.ts');
    const { createFingerprint } = await createOnce();
    await fn({ store, buildInvoice, createFingerprint });
  } finally {
    if (saved === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = saved;
    delete globalThis.splashDb;
    await client?.close();
  }
}

for (const useDb of [true, false]) {
  test(`the store makes one invoice per create key, and a changed retry is refused (${useDb ? 'Postgres' : 'in process'})`, async () => {
    await withStore(useDb, async ({ store, buildInvoice, createFingerprint }) => {
      const make = (orgId, input = INPUT) => buildInvoice({ orgId, issuerOrg: input.issuerOrg, payerOrgName: input.payerOrgName, payerOrgEmail: input.payerOrgEmail, amountUsd: Number(input.amountUsd).toFixed(2), targetCurrency: input.targetCurrency.toUpperCase(), dueDate: input.dueDate, memo: input.memo, status: 'draft' });
      const org = useDb ? 'acme' : `acme-${Date.now()}`;
      const other = useDb ? 'northwind' : `northwind-${Date.now()}`;
      const fp = createFingerprint(INPUT);

      const first = await store.createInvoiceOnce(make(org), { createKey: KEY, fingerprint: fp });
      assert.equal(first.outcome, 'created');

      const again = await store.createInvoiceOnce(make(org), { createKey: KEY, fingerprint: fp });
      assert.equal(again.outcome, 'replay', 'the retry is answered with the invoice already made');
      assert.equal(again.invoice.id, first.invoice.id);
      assert.equal(again.invoice.payLinkSlug, first.invoice.payLinkSlug, 'one pay link');

      const changed = { ...INPUT, amountUsd: 7000 };
      const refused = await store.createInvoiceOnce(make(org, changed), { createKey: KEY, fingerprint: createFingerprint(changed) });
      assert.equal(refused.outcome, 'conflict', 'the same key with another amount is not a retry');
      assert.equal(refused.invoice, undefined, 'a conflict hands back nothing of the first invoice');

      const theirs = await store.createInvoiceOnce(make(other), { createKey: KEY, fingerprint: fp });
      assert.equal(theirs.outcome, 'created', 'another org with the same key is its own invoice');
      assert.notEqual(theirs.invoice.id, first.invoice.id);

      const mine = (await store.listInvoicesFor(org)).filter((i) => i.payerOrgName === INPUT.payerOrgName);
      assert.equal(mine.length, 1, 'one invoice on file, however many times it was sent');
    });
  });
}

test('two creates racing on one key leave one invoice', async () => {
  await withStore(true, async ({ store, buildInvoice, createFingerprint }) => {
    const fp = createFingerprint(INPUT);
    const make = () => buildInvoice({ orgId: 'acme', issuerOrg: INPUT.issuerOrg, payerOrgName: INPUT.payerOrgName, amountUsd: '5000.00', targetCurrency: 'PHP', dueDate: INPUT.dueDate, memo: INPUT.memo, payerOrgEmail: INPUT.payerOrgEmail, status: 'draft' });
    const results = await Promise.all([1, 2, 3].map(() => store.createInvoiceOnce(make(), { createKey: KEY, fingerprint: fp })));
    const ids = new Set(results.map((r) => r.invoice.id));
    assert.equal(ids.size, 1, 'every racer is answered with the same invoice');
    assert.equal(results.filter((r) => r.outcome === 'created').length, 1);
    assert.equal((await store.listInvoicesFor('acme')).length, 1);
  });
});

test('the create route needs a create key, checks it before any document work, and answers a replay and a conflict', async () => {
  const route = await source('app/api/invoices/route.ts');
  assert.match(route, /createKey/, 'the body carries the create key');
  assert.match(route, /isCreateKey/, 'and it must be a UUID');
  assert.match(route, /createInvoiceOnce/, 'the invoice is written once per key');
  assert.match(route, /create_key_reused/, 'the same key with other details is a 409 the client can read');
  assert.match(route, /status: 409/);
  assert.match(route, /replay/, 'a replay is said to be one');
  assert.ok(route.indexOf('findInvoiceByCreateKey') !== -1 || route.indexOf('readInvoiceByCreateKey') !== -1, 'a replay is found before the document is sealed and stored');
  assert.ok(route.indexOf('ByCreateKey') < route.indexOf('sealAdapter.encrypt'), 'the replay check comes before the Seal and Walrus round trip');
  assert.doesNotMatch(route, /orgId:\s*input\./, 'the org is never the request body');
});

test('the dialog keeps one create key across retries, and a dropped connection does not leave it stuck', async () => {
  const dialog = await source('components/invoices/CreateInvoiceDialog.tsx');
  assert.match(dialog, /crypto\.randomUUID\(\)/, 'the key is made in the browser');
  assert.match(dialog, /createKey/, 'and sent with the invoice');
  assert.match(dialog, /useState\(\s*\(\)\s*=>\s*crypto\.randomUUID\(\)\s*\)|useRef/, 'made once per dialog, not once per click');
  assert.match(dialog, /finally/, 'the button comes back after a network error');
  assert.match(dialog, /will not be made twice|not be created twice/i, 'the retry is said to be safe');
  assert.match(dialog, /create_key_reused/, 'a changed retry gets its own message');
});

test('the migration adds the key with a partial unique index per org, journalled', async () => {
  const sql = await source('drizzle/0060_invoices_create_once.sql');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "create_key" text/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "create_fingerprint" text/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS "invoices_org_create_key_unique" ON "invoices" \("org_id", "create_key"\) WHERE "create_key" IS NOT NULL/);
  const journal = JSON.parse(await source('drizzle/meta/_journal.json'));
  assert.ok(journal.entries.some((e) => e.tag === '0060_invoices_create_once'));
  const schema = await source('lib/db/schema.ts');
  assert.match(schema, /createKey: text\('create_key'\)/);
  assert.match(schema, /invoices_org_create_key_unique/);
});
