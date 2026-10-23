import assert from 'node:assert/strict';
import test from 'node:test';

import { coldStart, migratedDb, attachDb } from './helpers/store-db.mjs';

/**
 * Intercompany transfers, out of `intercompany.ts`'s `globalThis` map.
 *
 * One row per customer transfer that Splash US funds through Splash Labuan:
 * the USD sent, the USDC acquired, the Maybank and Labuan references. It is the
 * audit trail behind the daily reconciliation, and the reconciliation is only
 * as good as the rows it sums — in a `Map`, each instance reconciled its own
 * slice of the day and a cold start reconciled nothing.
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

test('an intercompany transfer survives a cold start, its amounts in minor units', async () => {
  await withDb(async ({ client }) => {
    const store = await import('../lib/server/intercompany.ts');
    const record = await store.createIntercompanyTransfer({
      orgId: 'acme',
      transferIntentId: 'ti_ic_1',
      amountUsd: '5000.00',
      usdToUsdcRate: '1.000',
    });
    await store.updateIntercompany(record.id, { state: 'USDC_ACQUIRED', amountUsdc: '4999.25', maybankRef: 'MBB-1' });

    const fresh = await coldStart('lib/server/intercompany.ts');
    const read = await fresh.getIntercompanyByTransfer('ti_ic_1');
    assert.equal(read?.state, 'USDC_ACQUIRED');
    assert.equal(read?.maybankRef, 'MBB-1');
    assert.equal(read?.amountUsd, '5000.000000');
    assert.equal(read?.amountUsdc, '4999.250000');
    assert.deepEqual((await fresh.listIntercompanyTransfers()).map((r) => r.id), [record.id]);

    const { rows } = await client.query(
      `SELECT pg_typeof(amount_usd_micro)::text AS t, amount_usd_micro::text AS usd FROM intercompany_transfers`,
    );
    assert.equal(rows[0].t, 'bigint', 'integer minor units, never a float');
    assert.equal(rows[0].usd, '5000000000');
  });
});

test('the daily reconciliation sums every instance’s rows, not this one’s', async () => {
  await withDb(async () => {
    const store = await import('../lib/server/intercompany.ts');
    const a = await store.createIntercompanyTransfer({ orgId: 'acme', transferIntentId: 'ti_ic_a', amountUsd: '0.10', usdToUsdcRate: '1' });
    const b = await store.createIntercompanyTransfer({ orgId: 'northwind', transferIntentId: 'ti_ic_b', amountUsd: '0.20', usdToUsdcRate: '1' });
    await store.updateIntercompany(a.id, { amountUsdc: '0.10' });
    await store.updateIntercompany(b.id, { amountUsdc: '0.19' });

    const fresh = await coldStart('lib/server/intercompany.ts');
    const today = new Date().toISOString().split('T')[0];
    const day = await fresh.getDailyReconciliation(today);
    assert.equal(day.transferCount, 2);
    assert.equal(day.totalUsdInMicro, 300_000n);
    assert.equal(day.totalUsdcSettledMicro, 290_000n);
    assert.equal(day.discrepancyMicro, 10_000n);
  });
});

test('one customer transfer has one intercompany leg', async () => {
  await withDb(async ({ client }) => {
    const store = await import('../lib/server/intercompany.ts');
    const open = () => store.createIntercompanyTransfer({ orgId: 'acme', transferIntentId: 'ti_ic_once', amountUsd: '10.00', usdToUsdcRate: '1' });
    const results = await Promise.allSettled([open(), open()]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const { rows } = await client.query(`SELECT count(*)::int AS n FROM intercompany_transfers WHERE transfer_intent_id = 'ti_ic_once'`);
    assert.equal(rows[0].n, 1, 'a second leg would send the USD twice');
  });
});
