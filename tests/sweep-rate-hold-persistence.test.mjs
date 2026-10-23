import assert from 'node:assert/strict';
import test from 'node:test';

import { coldStart, migratedDb, attachDb } from './helpers/store-db.mjs';

/**
 * Sweep jobs and rate holds, out of `operations.ts`'s `globalThis` maps.
 *
 * A sweep job is the record that a stored balance is being paid out to a bank
 * through a partner. It is what `/api/transfers/:id` shows as the sweep, and
 * what an operator reads when a payout is stuck between EXECUTING and done. In
 * a `Map`, a cold start between "sweep opened" and "sweep completed" left the
 * transfer pointing at a `sweepJobId` that no instance had ever heard of.
 *
 * A rate hold is a commitment made to one customer: this corridor, this rate,
 * until then. In a `Map`, the instance that answered the next request either
 * had it or did not, and a cold start dropped every one.
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

async function aTransfer(orgId = 'acme') {
  const { createTransferIntent } = await import('../lib/server/operations.ts');
  const { persistTransfer } = await import('../lib/server/transfers-store.ts');
  return persistTransfer(
    createTransferIntent({
      orgId,
      recipientName: 'Acme PH',
      targetCurrency: 'PHP',
      targetAmount: '56500.00',
      sourceAmountUsd: '1000.00',
      stablecoinAmountMicro: 1_000_000_000,
      deliveryTier: 'SWEEP_ACCOUNT',
    }),
  );
}

test('a sweep job survives a cold start, with its money in minor units', async () => {
  await withDb(async ({ client }) => {
    const transfer = await aTransfer();
    const operations = await import('../lib/server/operations.ts');
    const job = await operations.createSweepJob({
      orgId: 'acme',
      transferIntentId: transfer.id,
      recipientId: 'rcpt_acme',
      partner: 'PDAX',
      amountUsdcMicro: 1_000_000_000,
      targetCurrency: 'PHP',
      fxRate: '56.5',
    });
    await operations.updateSweepJob(job.id, { state: 'EXECUTING' });

    const fresh = await coldStart('lib/server/operations.ts');
    const read = await fresh.readSweepJob(job.id);
    assert.equal(read?.state, 'EXECUTING');
    assert.equal(read?.amountUsdcMicro, 1_000_000_000);
    assert.equal(read?.fxRate, '56.5');
    assert.equal(read?.orgId, 'acme');

    const { rows } = await client.query(`SELECT pg_typeof(amount_usdc_micro)::text AS t FROM sweep_jobs`);
    assert.equal(rows[0].t, 'bigint', 'integer minor units, never a float');
  });
});

test('one transfer opens one sweep, however many times delivery is retried', async () => {
  await withDb(async ({ client }) => {
    const transfer = await aTransfer();
    const operations = await import('../lib/server/operations.ts');
    const open = () =>
      operations.createSweepJob({
        orgId: 'acme',
        transferIntentId: transfer.id,
        recipientId: 'rcpt_acme',
        partner: 'PDAX',
        amountUsdcMicro: 1_000_000_000,
        targetCurrency: 'PHP',
        fxRate: '56.5',
      });
    const results = await Promise.allSettled([open(), open()]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, 'the second sweep is refused');
    const { rows } = await client.query(`SELECT count(*)::int AS n FROM sweep_jobs WHERE transfer_intent_id = $1`, [transfer.id]);
    assert.equal(rows[0].n, 1, 'a second sweep would pay the beneficiary twice');
  });
});

test('a rate hold survives a cold start and still belongs to its org', async () => {
  await withDb(async () => {
    const operations = await import('../lib/server/operations.ts');
    const hold = await operations.createRateHold({ orgId: 'acme', corridorCurrency: 'PHP', rate: '56.5', feeBps: 80 });

    const fresh = await coldStart('lib/server/operations.ts');
    const read = await fresh.readRateHoldFor('acme', hold.id);
    assert.equal(read?.rate, '56.5');
    assert.equal(read?.state, 'ACTIVE');
    assert.deepEqual((await fresh.listRateHoldsFor('acme')).map((h) => h.id), [hold.id]);
    assert.equal(await fresh.readRateHoldFor('northwind', hold.id), null);
    assert.deepEqual(await fresh.listRateHoldsFor('northwind'), []);
  });
});

test('a rate hold past its time reads as expired, in the database too', async () => {
  await withDb(async ({ client }) => {
    const operations = await import('../lib/server/operations.ts');
    const hold = await operations.createRateHold({
      orgId: 'acme',
      corridorCurrency: 'PHP',
      rate: '56.5',
      feeBps: 80,
      holdUntil: new Date(Date.now() - 1000).toISOString(),
    });
    assert.equal((await operations.readRateHoldFor('acme', hold.id))?.state, 'EXPIRED');
    const { rows } = await client.query(`SELECT state FROM rate_holds WHERE id = $1`, [hold.id]);
    assert.equal(rows[0].state, 'EXPIRED');
  });
});

test('a rate hold without an owner is refused by the database store', async () => {
  await withDb(async () => {
    const operations = await import('../lib/server/operations.ts');
    await assert.rejects(() => operations.createRateHold({ corridorCurrency: 'PHP', rate: '56.5', feeBps: 80 }));
  });
});
