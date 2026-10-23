import assert from 'node:assert/strict';
import test from 'node:test';

import { coldStart, migratedDb, attachDb } from './helpers/store-db.mjs';

/**
 * Daily audit batches, out of `audit-batches.ts`'s `globalThis` map.
 *
 * A batch is the day's settlements across every tenant, folded into a Merkle
 * root, sealed to Walrus and anchored on Sui. The cron job builds one per
 * business date, and the staff console verifies a transfer against it. In a
 * `Map`, the batch existed only on the instance the cron happened to hit: the
 * console on any other instance found nothing to verify, and a cold start lost
 * the record of a root that is already on chain — so the next cron run built
 * and anchored the same day a second time.
 *
 * The write itself (Seal, Walrus, the Sui anchor) needs a live network, so the
 * race is driven at the repository, which is where one-batch-per-date is
 * enforced; the readers and the cron's "already built?" check are driven
 * through the store after a cold start.
 */

async function withDb(run) {
  const { client, db } = await migratedDb();
  const undo = attachDb(db);
  try {
    await run({ client, db });
  } finally {
    undo();
    await client.close();
  }
}

function batchFor(date, variant = 'a') {
  return {
    id: `daily-audit:${date}`,
    date,
    merkleRoot: `root-${variant}`,
    settlementCount: 2,
    leaves: [
      { transferId: 'ti_acme_1', leafHash: 'leaf-1', proof: [{ side: 'right', hash: 'leaf-2' }] },
      { transferId: 'ti_northwind_1', leafHash: 'leaf-2', proof: [{ side: 'left', hash: 'leaf-1' }] },
    ],
    walrusBlobId: `DEMO_WALRUS_${variant}`,
    walrusMode: 'demo',
    sealPolicyId: `policy-${variant}`,
    sealMode: 'demo',
    ciphertextHash: `ciphertext-${variant}`,
    anchorObjectId: `0xanchor${variant}`,
    anchorDigest: `digest-${variant}`,
    createdAt: new Date().toISOString(),
  };
}

test('a daily audit batch survives a cold start, and the cron does not build the day again', async () => {
  await withDb(async ({ db }) => {
    const repo = await import('../lib/server/repository/audit-batches.ts');
    const recorded = await repo.recordDailyAuditBatch(db, batchFor('2026-10-21'));
    await repo.recordDailyAuditBatch(db, batchFor('2026-10-22', 'b'));

    const fresh = await coldStart('lib/server/audit-batches.ts');
    assert.deepEqual(
      (await fresh.listDailyAuditBatchesForStaff()).map((b) => b.date),
      ['2026-10-22', '2026-10-21'],
      'every batch, newest business date first',
    );
    const read = await fresh.readDailyAuditBatchForStaff('daily-audit:2026-10-21');
    assert.deepEqual(read, recorded, 'the batch reads back exactly as it was recorded');
    assert.deepEqual(read.leaves[1].proof, [{ side: 'left', hash: 'leaf-1' }], 'proofs and all');
    assert.equal(await fresh.readDailyAuditBatchForStaff('daily-audit:1999-01-01'), null);

    // No settlements exist in this database, so a rebuild would throw. The
    // cron finding the day already built is the only way this returns.
    const again = await fresh.buildDailyAuditBatch('2026-10-21');
    assert.equal(again.merkleRoot, 'root-a', 'the recorded batch, not a second anchor of the same day');

    // Verification finds the batch from Postgres; what it cannot find after a
    // cold start is the demo Walrus blob, which is process state by design.
    await assert.rejects(
      fresh.verifyDailyAuditBatchForStaff('daily-audit:2026-10-21', 'ti_acme_1'),
      /Walrus batch blob could not be retrieved/,
    );
    await assert.rejects(
      fresh.verifyDailyAuditBatchForStaff('daily-audit:2026-10-21', 'ti_other'),
      /not included in this daily audit batch/,
    );
    await assert.rejects(fresh.verifyDailyAuditBatchForStaff('daily-audit:1999-01-01', 'ti_acme_1'), /not found/);
  });
});

test('two instances writing the same business date leave one row, and both answer with it', async () => {
  await withDb(async ({ client, db }) => {
    const repo = await import('../lib/server/repository/audit-batches.ts');
    const results = await Promise.all([
      repo.recordDailyAuditBatch(db, batchFor('2026-10-21', 'a')),
      repo.recordDailyAuditBatch(db, batchFor('2026-10-21', 'b')),
    ]);
    const { rows } = await client.query(
      `SELECT count(*)::int AS n, min(merkle_root) AS root FROM daily_audit_batches WHERE business_date = '2026-10-21'`,
    );
    assert.equal(rows[0].n, 1, 'one batch per business date');
    assert.equal(results[0].merkleRoot, rows[0].root, 'the first caller gets the row that was kept');
    assert.equal(results[1].merkleRoot, rows[0].root, 'and so does the second: one answer for the day');
  });
});

test('the table carries no org: a batch spans every tenant', async () => {
  await withDb(async ({ client }) => {
    const { rows } = await client.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'daily_audit_batches'`,
    );
    const columns = rows.map((r) => r.column_name);
    assert.ok(columns.includes('business_date'), 'the table exists, keyed by business date');
    assert.ok(!columns.includes('org_id'), 'readers are staff-only by name; there is no tenant to scope by');
  });
});
