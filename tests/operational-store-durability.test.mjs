import assert from 'node:assert/strict';
import test from 'node:test';

import { coldStart, migratedDb, attachDb } from './helpers/store-db.mjs';

/**
 * The first four WS8 slices — recipients, invoices, transfers with their audit
 * receipts, and the ledger — held to the two promises the workstream makes.
 *
 *   State survives a cold start. A serverless instance is thrown away and a new
 *   one evaluates every module again with empty `globalThis`. What a customer
 *   wrote before that must still be there after it.
 *
 *   One idempotency key, one row. Two requests carrying the same key that
 *   arrive together both look, both find nothing, and both write — unless the
 *   database refuses the second. A unique index refuses; a `Map` lookup does
 *   not, because each instance has its own `Map`.
 *
 * These stores moved to Postgres before WS8 was written down, so this file is
 * the proof that they meet the spec rather than the change that made them.
 * Each test goes through the store module a route uses, not the repository
 * beneath it, because the store is where a fallback to the in-process map
 * would hide.
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

test('a beneficiary survives a cold start', async () => {
  await withDb(async () => {
    const { buildRecipient } = await import('../lib/server/operations.ts');
    const store = await import('../lib/server/recipients-store.ts');
    const record = await store.persistRecipient(
      buildRecipient({ orgId: 'acme', name: 'Mabuhay Logistics', country: 'PH', bank: 'BDO', account: '0012' }),
    );

    const fresh = await coldStart('lib/server/recipients-store.ts');
    const read = await fresh.readRecipient('acme', record.id);
    assert.equal(read?.name, 'Mabuhay Logistics');
    assert.equal(read?.account, '0012');
    assert.equal(await fresh.readRecipient('northwind', record.id), null, 'and is still nobody else’s');
  });
});

test('an invoice survives a cold start, and its pay link still resolves', async () => {
  await withDb(async () => {
    const { buildInvoice } = await import('../lib/server/operations.ts');
    const store = await import('../lib/server/invoices-store.ts');
    const record = await store.persistInvoice(
      buildInvoice({
        orgId: 'acme',
        issuerOrg: 'Acme Trading',
        amountUsd: '1250.00',
        targetCurrency: 'PHP',
        dueDate: '2026-11-30',
        status: 'sent',
        payLinkSlug: 'acme-cold-start',
      }),
    );

    const fresh = await coldStart('lib/server/invoices-store.ts');
    // The amount is minor units in the row; compare the value, not its spelling.
    assert.equal(Number((await fresh.readInvoice('acme', record.id))?.amountUsd), 1250);
    assert.equal((await fresh.findInvoiceBySlug('acme-cold-start'))?.id, record.id);
  });
});

test('two invoices racing for one pay-link slug produce one row', async () => {
  await withDb(async ({ client }) => {
    const { buildInvoice } = await import('../lib/server/operations.ts');
    const store = await import('../lib/server/invoices-store.ts');
    const draft = () =>
      buildInvoice({
        orgId: 'acme',
        issuerOrg: 'Acme Trading',
        amountUsd: '10.00',
        targetCurrency: 'PHP',
        dueDate: '2026-11-30',
        status: 'draft',
        payLinkSlug: 'same-slug',
      });
    const results = await Promise.allSettled([store.persistInvoice(draft()), store.persistInvoice(draft())]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const { rows } = await client.query(`SELECT count(*)::int AS n FROM invoices WHERE pay_link_slug = 'same-slug'`);
    assert.equal(rows[0].n, 1);
  });
});

test('a transfer and its audit receipt survive a cold start, history included', async () => {
  await withDb(async () => {
    const { createTransferIntent } = await import('../lib/server/operations.ts');
    const store = await import('../lib/server/transfers-store.ts');
    const record = await store.persistTransfer(
      createTransferIntent({
        orgId: 'acme',
        recipientName: 'Mabuhay Logistics',
        targetCurrency: 'PHP',
        targetAmount: '56500.00',
        sourceAmountUsd: '1000.00',
        stablecoinAmountMicro: 1_000_000_000,
      }),
    );
    await store.patchTransfer(record.id, { state: 'SETTLED', suiTxDigest: 'DIGEST_COLD' });

    const fresh = await coldStart('lib/server/transfers-store.ts');
    const read = await fresh.readTransfer('acme', record.id);
    assert.equal(read?.state, 'SETTLED');
    const receipt = await fresh.readAuditReceipt('acme', record.id);
    assert.equal(receipt?.suiTxDigest, 'DIGEST_COLD');
    assert.deepEqual(receipt?.statusHistory.map((h) => h.state), ['AUTHORIZED', 'SETTLED']);
  });
});

test('a ledger balance survives a cold start', async () => {
  await withDb(async () => {
    const store = await import('../lib/server/ledger-store.ts');
    await store.recordMovement({ orgId: 'acme', direction: 'CREDIT', amountMinor: 5_000_000n, refType: 'FUNDING', refId: 'fund_cold' });
    await store.recordMovement({ orgId: 'acme', direction: 'DEBIT', amountMinor: 1_250_000n, refType: 'TRANSFER', refId: 'ti_cold' });

    const fresh = await coldStart('lib/server/ledger-store.ts');
    assert.equal(await fresh.accountBalance('acme'), 3_750_000n);
    assert.equal((await fresh.listMovements('acme')).length, 2);
  });
});

test('two payout runs racing with one idempotency key produce one row, and both answers agree', async () => {
  await withDb(async ({ client }) => {
    const { buildBatch } = await import('../lib/server/operations.ts');
    const store = await import('../lib/server/batches-store.ts');
    const draft = () =>
      buildBatch({ orgId: 'acme', rowCount: 3, acceptedRows: 3, blockedRows: 0, totalAmount: '300.00', idempotencyKey: 'payroll-race' });

    const [a, b] = await Promise.all([store.claimBatch(draft()), store.claimBatch(draft())]);
    assert.equal([a, b].filter((r) => r.claimed).length, 1, 'exactly one submission pays');
    assert.equal(a.batch.id, b.batch.id, 'the other is handed the same run');
    const { rows } = await client.query(`SELECT count(*)::int AS n FROM batch_runs WHERE idempotency_key = 'payroll-race'`);
    assert.equal(rows[0].n, 1);

    const fresh = await coldStart('lib/server/batches-store.ts');
    assert.equal(Number((await fresh.readBatch('acme', a.batch.id))?.totalAmount), 300);
  });
});
