import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

import * as schema from '../lib/db/schema.ts';
import {
  __testing,
  findByIdempotencyKey,
  getTransfer,
  getTransferForStaff,
  insertTransfer,
  listTransfers,
  listTransitions,
  patchTransfer,
} from '../lib/server/repository/transfers.ts';

/**
 * Transfers, in Postgres, belonging to somebody.
 *
 * The operational record lived in a process-global `Map`. It did not survive a
 * restart, and — the part that matters more — it carried no org id at all. One
 * Map, every tenant, no scoping on read: `listTransfers()` returned everybody's.
 * That is a tenant-isolation bug that happened to be hidden by there being one
 * tenant.
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

const transfer = (over = {}) => ({
  id: 'ti_1',
  orgId: 'acme',
  state: 'AUTHORIZED',
  recipientName: 'Mabuhay Logistics Inc',
  targetCurrency: 'PHP',
  targetAmount: '5642.00',
  sourceAmountUsd: '100.00',
  quoteId: 'q_1',
  exchangeRate: '56.42',
  deliveryTier: 'PAYOUT_ONLY',
  suiTxDigest: null,
  receiptObjectId: null,
  failureReason: null,
  failedAtState: null,
  metadata: { sourceStablecoin: 'USDC', pegChecked: true },
  ...over,
});

// ── Durability ──────────────────────────────────────────────────────────────

test('a transfer survives, and comes back as the same numbers', async () => {
  const { client, db } = await migratedDb();
  await insertTransfer(db, transfer());

  const read = await getTransfer(db, 'acme', 'ti_1');
  assert.equal(read.recipientName, 'Mabuhay Logistics Inc');
  assert.equal(read.targetAmount, '5642', 'trailing zeros are not significant');
  assert.equal(read.sourceAmountUsd, '100');
  assert.equal(read.exchangeRate, '56.42');
  assert.equal(read.deliveryTier, 'PAYOUT_ONLY');
  assert.deepEqual(read.metadata, { sourceStablecoin: 'USDC', pegChecked: true });
  await client.close();
});

test('money round-trips through minor units without a float anywhere', () => {
  const { toMinor, fromMinor } = __testing;
  assert.equal(toMinor('100.00'), 100_000_000n);
  assert.equal(toMinor('0.000001'), 1n);
  assert.equal(toMinor('5642'), 5_642_000_000n);
  // The classic float failure: 0.1 + 0.2. Exact here because it never becomes one.
  assert.equal(toMinor('0.1') + toMinor('0.2'), toMinor('0.3'));
  // And a figure past 2^53, where a JS number silently stops being exact.
  assert.equal(fromMinor(9_007_199_254_740_993n), '9007199254.740993');
  assert.equal(fromMinor(toMinor('12345678.901234')), '12345678.901234');
});

test('more precision than the unit holds is truncated, not rounded up', () => {
  const { toMinor } = __testing;
  // 7 decimals into a 6-decimal unit. Truncating never credits a beneficiary
  // money the payer did not send.
  assert.equal(toMinor('1.0000009'), 1_000_000n);
});

// ── Tenant isolation ────────────────────────────────────────────────────────

test('one tenant cannot read another tenant’s transfer by id', async () => {
  const { client, db } = await migratedDb();
  await insertTransfer(db, transfer({ id: 'ti_acme', orgId: 'acme' }));

  assert.notEqual(await getTransfer(db, 'acme', 'ti_acme'), null);
  assert.equal(
    await getTransfer(db, 'northwind', 'ti_acme'),
    null,
    'an id is not authority',
  );
  await client.close();
});

test('a foreign id is indistinguishable from a missing one', async () => {
  const { client, db } = await migratedDb();
  await insertTransfer(db, transfer({ id: 'ti_acme', orgId: 'acme' }));

  // Both null. A 403 on the first and a 404 on the second would confirm which
  // ids exist, which is how an attacker enumerates a tenant.
  assert.equal(await getTransfer(db, 'northwind', 'ti_acme'), null);
  assert.equal(await getTransfer(db, 'northwind', 'ti_does_not_exist'), null);
  await client.close();
});

test('listing is scoped, and does not return everybody’s', async () => {
  const { client, db } = await migratedDb();
  await insertTransfer(db, transfer({ id: 'ti_a1', orgId: 'acme' }));
  await insertTransfer(db, transfer({ id: 'ti_a2', orgId: 'acme' }));
  await insertTransfer(db, transfer({ id: 'ti_n1', orgId: 'northwind' }));

  const acme = await listTransfers(db, 'acme');
  assert.equal(acme.length, 2);
  assert.deepEqual(acme.map((t) => t.orgId), ['acme', 'acme']);

  const northwind = await listTransfers(db, 'northwind');
  assert.equal(northwind.length, 1);
  assert.equal(northwind[0].id, 'ti_n1');
  await client.close();
});

test('the staff read is a separate, differently-named function', async () => {
  const { client, db } = await migratedDb();
  await insertTransfer(db, transfer({ id: 'ti_acme', orgId: 'acme' }));
  // Cross-tenant reach exists, and reaching for it is visible at the call site
  // rather than an argument someone forgot to pass.
  const staff = await getTransferForStaff(db, 'ti_acme');
  assert.equal(staff.orgId, 'acme');
  await client.close();
});

test('idempotency is scoped too — two tenants may use the same key', async () => {
  const { client, db } = await migratedDb();
  await insertTransfer(db, transfer({ id: 'ti_a', orgId: 'acme', idempotencyKey: 'payroll-friday' }));
  await insertTransfer(db, transfer({ id: 'ti_n', orgId: 'northwind', idempotencyKey: 'payroll-friday' }));

  assert.equal((await findByIdempotencyKey(db, 'acme', 'payroll-friday')).id, 'ti_a');
  assert.equal((await findByIdempotencyKey(db, 'northwind', 'payroll-friday')).id, 'ti_n');
  await client.close();
});

// ── The audit trail ─────────────────────────────────────────────────────────

test('every state change writes a transition, with a from, a to and a reason', async () => {
  const { client, db } = await migratedDb();
  await insertTransfer(db, transfer());

  await patchTransfer(db, 'ti_1', { state: 'SETTLING' }, 'operator@splash');
  await patchTransfer(
    db,
    'ti_1',
    { state: 'FAILED', failureReason: 'peg stale at settlement' },
    'system',
  );

  const trail = await listTransitions(db, 'ti_1');
  assert.equal(trail.length, 2);
  assert.equal(trail[0].fromState, 'AUTHORIZED');
  assert.equal(trail[0].toState, 'SETTLING');
  assert.equal(trail[0].actor, 'operator@splash');
  assert.equal(trail[1].toState, 'FAILED');
  assert.equal(
    trail[1].reason,
    'peg stale at settlement',
    'a FAILED transition that cannot say why sends an operator to a restarted process’s logs',
  );
  await client.close();
});

test('a patch that does not change state writes no transition', async () => {
  const { client, db } = await migratedDb();
  await insertTransfer(db, transfer());
  await patchTransfer(db, 'ti_1', { suiTxDigest: '0xabc' });
  assert.equal((await listTransitions(db, 'ti_1')).length, 0, 'nothing transitioned');
  assert.equal((await getTransfer(db, 'acme', 'ti_1')).suiTxDigest, '0xabc');
  await client.close();
});

test('a metadata patch merges rather than replacing the settlement record', async () => {
  const { client, db } = await migratedDb();
  await insertTransfer(db, transfer());
  await patchTransfer(db, 'ti_1', { metadata: { sealPolicyId: '0xseal' } });

  const read = await getTransfer(db, 'acme', 'ti_1');
  assert.deepEqual(read.metadata, {
    sourceStablecoin: 'USDC',
    pegChecked: true,
    sealPolicyId: '0xseal',
  });
  await client.close();
});

test('patching an id that does not exist returns null rather than creating one', async () => {
  const { client, db } = await migratedDb();
  assert.equal(await patchTransfer(db, 'ti_nope', { state: 'SETTLED' }), null);
  await client.close();
});

// ── The store this replaces ─────────────────────────────────────────────────

test('the repository carries an orgId on every read, not an optional filter', async () => {
  const source = await readFile(
    new URL('../lib/server/repository/transfers.ts', import.meta.url),
    'utf8',
  );
  // Both scoped reads take orgId positionally and non-optionally. A default or
  // an `orgId?` is how scoping quietly becomes advisory.
  assert.match(source, /export async function getTransfer\(\s*db: DrizzleDb,\s*orgId: string,/);
  assert.match(source, /export async function listTransfers\(\s*db: DrizzleDb,\s*orgId: string,/);
  assert.doesNotMatch(source, /orgId\?: string/, 'an optional orgId is an unscoped read');
});

// ── The audit receipt is a view, not a second record ──────────────────

test('the reconstructed history is the history that used to be appended', async () => {
  const { client, db } = await migratedDb();
  await insertTransfer(db, transfer());

  await patchTransfer(db, 'ti_1', { state: 'QUEUED' });
  await patchTransfer(db, 'ti_1', { state: 'SETTLING' });
  await patchTransfer(db, 'ti_1', { state: 'SETTLED', suiTxDigest: '0xabc' });

  const { __testing: store } = await import('../lib/server/transfers-store.ts');
  const row = await getTransfer(db, 'acme', 'ti_1');
  const history = store.statusHistoryFrom(row, await listTransitions(db, 'ti_1'));

  // `intent_transitions` records CHANGES, so it holds no row for the state a
  // transfer was created in. The opening entry comes back from the transfer's
  // own createdAt and the first transition's fromState — which is exactly what
  // the appended version wrote.
  assert.deepEqual(
    history.map((entry) => entry.state),
    ['AUTHORIZED', 'QUEUED', 'SETTLING', 'SETTLED'],
  );
  assert.equal(history[0].at, row.createdAt, 'the opening entry is dated by the transfer itself');
  assert.ok(
    history.every((entry) => typeof entry.at === 'string' && !Number.isNaN(Date.parse(entry.at))),
    'every entry carries a real timestamp — the tracker renders these',
  );
  await client.close();
});

test('a transfer that has not moved yet still has an opening entry', async () => {
  const { client, db } = await migratedDb();
  await insertTransfer(db, transfer());

  const { __testing: store } = await import('../lib/server/transfers-store.ts');
  const row = await getTransfer(db, 'acme', 'ti_1');
  const history = store.statusHistoryFrom(row, await listTransitions(db, 'ti_1'));

  // No transitions at all: the opening state is the state it is in.
  assert.deepEqual(history, [{ state: 'AUTHORIZED', at: row.createdAt }]);
  await client.close();
});

// ── What the customer sees while the payment moves ──────────────────────────

test('a state change advances the customer tracker, not only the database', async () => {
  // The in-process path: no DATABASE_URL, so the store writes to the map and
  // the mirror is the only thing keeping the receipt in step.
  delete process.env.DATABASE_URL;
  const { createTransferIntent } = await import('../lib/server/operations.ts');
  const { patchTransfer, persistTransfer, readAuditReceipt } = await import(
    '../lib/server/transfers-store.ts'
  );

  const record = await persistTransfer(
    createTransferIntent({
      orgId: 'acme',
      recipientName: 'Mabuhay Logistics Inc',
      targetCurrency: 'PHP',
      targetAmount: '5642.00',
      sourceAmountUsd: '100.00',
    }),
  );

  await patchTransfer(record.id, { state: 'SETTLED' });
  await patchTransfer(record.id, { state: 'SETTLED' }); // a retried write
  await patchTransfer(record.id, { state: 'DISBURSED', suiTxDigest: '0xabc' });

  const receipt = await readAuditReceipt('acme', record.id);
  assert.deepEqual(
    receipt.statusHistory.map((entry) => entry.state),
    ['AUTHORIZED', 'SETTLED', 'DISBURSED'],
    'the tracker reads this history for its stage timestamps — a frozen history ' +
      'shows a settled payment as stuck at the first step',
  );
  assert.equal(receipt.suiTxDigest, '0xabc', 'the digest reaches the receipt too');
});

test('a patch against an id nobody has leaves no history behind', async () => {
  delete process.env.DATABASE_URL;
  const { patchTransfer, readAuditReceipt } = await import(
    '../lib/server/transfers-store.ts'
  );

  await patchTransfer('ti_does_not_exist', { state: 'SETTLED' });
  assert.equal(await readAuditReceipt('acme', 'ti_does_not_exist'), null);
});

test('one tenant cannot read another tenant’s audit trail', async () => {
  delete process.env.DATABASE_URL;
  const { createTransferIntent } = await import('../lib/server/operations.ts');
  const { persistTransfer, readAuditReceipt } = await import(
    '../lib/server/transfers-store.ts'
  );

  const record = await persistTransfer(
    createTransferIntent({
      orgId: 'acme',
      recipientName: 'Mabuhay Logistics Inc',
      targetCurrency: 'PHP',
      targetAmount: '5642.00',
    }),
  );

  assert.notEqual(await readAuditReceipt('acme', record.id), null);
  assert.equal(
    await readAuditReceipt('northwind', record.id),
    null,
    'a trail is as sensitive as the payment it describes',
  );
});

test('receipt-only detail lands on the transfer, not in a second store', async () => {
  const { client, db } = await migratedDb();
  await insertTransfer(db, transfer());

  // `approvedBy` / `evidence` are the fields the receipt owns alone. They have
  // no column, so they ride in settlement_metadata alongside the settlement's
  // own detail — one row, one write, nothing to reconcile.
  await patchTransfer(db, 'ti_1', {
    metadata: { approvedBy: 'dashboard-operator', evidence: { walrusBlobId: 'blob_1' } },
  });

  const read = await getTransfer(db, 'acme', 'ti_1');
  assert.equal(read.metadata.approvedBy, 'dashboard-operator');
  assert.deepEqual(read.metadata.evidence, { walrusBlobId: 'blob_1' });
  assert.deepEqual(
    read.metadata.sourceStablecoin,
    'USDC',
    'and the settlement detail already there survives the merge',
  );
  await client.close();
});

test('the receipt-only fields reach the receipt without a database too', async () => {
  delete process.env.DATABASE_URL;
  const { createTransferIntent } = await import('../lib/server/operations.ts');
  const { patchAuditReceipt, persistTransfer, readAuditReceipt } = await import(
    '../lib/server/transfers-store.ts'
  );

  const record = await persistTransfer(
    createTransferIntent({
      orgId: 'acme',
      recipientName: 'Mabuhay Logistics Inc',
      targetCurrency: 'PHP',
      targetAmount: '5642.00',
    }),
  );
  await patchAuditReceipt(record.id, { approvedBy: 'dashboard-operator' });

  const receipt = await readAuditReceipt('acme', record.id);
  assert.equal(receipt.approvedBy, 'dashboard-operator');
});
