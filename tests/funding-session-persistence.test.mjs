import assert from 'node:assert/strict';
import test from 'node:test';

import { coldStart, migratedDb, attachDb } from './helpers/store-db.mjs';

/**
 * Funding sessions, out of `funding-sessions.ts`'s `globalThis` maps.
 *
 * A funding session is the record that a customer was given a deposit address
 * for an amount, and — once the deposit lands — that it was credited to their
 * balance. Three maps held it: the sessions, the source-transaction registry
 * that stops one on-chain deposit being credited to two sessions, and the
 * last-used funding source.
 *
 * On serverless every instance had its own copy. A deposit webhook answered by
 * a different instance from the one that opened the session found no session
 * at all; and the registry, the guard against crediting one deposit twice, only
 * guarded the instance it happened to live in.
 */

process.env.FUNDING_DEPOSIT_DERIVATION_SECRET = 'funding-session-persistence-test-secret';

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

const selection = {
  type: 'stablecoin',
  source: 'USDC',
  asset: 'USDC',
  rail: 'SUI_NATIVE',
  feeTier: 'DISCOUNT',
};

async function openSession(store, over = {}) {
  return store.createFundingSession({
    orgId: 'acme',
    businessAccountId: 'dashboard-primary',
    selection,
    amountExpectedMicro: 2_500_000_000,
    ...over,
  });
}

test('a funding session survives a cold start, its money in minor units', async () => {
  await withDb(async ({ client }) => {
    const store = await import('../lib/server/funding-sessions.ts');
    const session = await openSession(store);
    await store.updateFundingSession(session.id, { status: 'PENDING_KYT', receivedAmountMicro: 2_500_000_000 });

    const fresh = await coldStart('lib/server/funding-sessions.ts');
    const read = await fresh.readFundingSession(session.id);
    assert.equal(read?.status, 'PENDING_KYT');
    assert.equal(read?.orgId, 'acme');
    assert.equal(read?.amountExpectedMicro, 2_500_000_000);
    assert.equal(read?.receivedAmountMicro, 2_500_000_000);
    assert.equal(read?.depositAddress, session.depositAddress);
    assert.deepEqual(read?.selection, session.selection);
    assert.deepEqual((await fresh.listFundingSessions()).map((s) => s.id), [session.id]);

    const { rows } = await client.query(`SELECT pg_typeof(amount_expected_micro)::text AS t FROM funding_sessions`);
    assert.equal(rows[0].t, 'bigint', 'integer minor units, never a float');
  });
});

test('one deposit is assigned to one session, across a cold start', async () => {
  await withDb(async () => {
    const store = await import('../lib/server/funding-sessions.ts');
    const first = await openSession(store);
    const second = await openSession(store);
    await store.registerSourceTransaction('0xDEPOSIT', first.id);
    // The same session again is a retried webhook, not a second deposit.
    await store.registerSourceTransaction('0xDEPOSIT', first.id);

    const fresh = await coldStart('lib/server/funding-sessions.ts');
    await assert.rejects(
      () => fresh.registerSourceTransaction('0xDEPOSIT', second.id),
      /already assigned to another funding session/,
    );
  });
});

test('two sessions racing for one source transaction produce one assignment', async () => {
  await withDb(async ({ client }) => {
    const store = await import('../lib/server/funding-sessions.ts');
    const first = await openSession(store);
    const second = await openSession(store);
    const results = await Promise.allSettled([
      store.registerSourceTransaction('0xRACE', first.id),
      store.registerSourceTransaction('0xRACE', second.id),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, 'one deposit, one session');
    const { rows } = await client.query(`SELECT count(*)::int AS n FROM funding_source_transactions WHERE tx_digest = '0xRACE'`);
    assert.equal(rows[0].n, 1);
  });
});

test('the last-used funding source survives a cold start, per org', async () => {
  await withDb(async () => {
    const store = await import('../lib/server/funding-sessions.ts');
    await store.recordLastUsedFundingSource('acme', 'dashboard-primary', 'USDC');
    await store.recordLastUsedFundingSource('acme', 'dashboard-primary', 'BANK_USD');

    const fresh = await coldStart('lib/server/funding-sessions.ts');
    assert.equal(await fresh.readLastUsedFundingSource('acme', 'dashboard-primary'), 'BANK_USD');
    // `dashboard-primary` is the fallback account id every unprovisioned org
    // shares. Keyed by account alone, one org's choice was another's default.
    assert.equal(await fresh.readLastUsedFundingSource('northwind', 'dashboard-primary'), null);
  });
});

test('a deposit credited twice at once reaches the ledger once', async () => {
  await withDb(async ({ client }) => {
    const store = await import('../lib/server/funding-sessions.ts');
    const session = await openSession(store);
    await store.updateFundingSession(session.id, { status: 'CLEARED' });

    const credit = () =>
      store.creditFundingSession(session.id, {
        amountMinor: 2_500_000_000n,
        suiTxDigest: '0xDEPOSIT',
        patch: { normalizedAmountUsdcMicro: 2_500_000_000, normalizeVenue: 'PASSTHROUGH', effectiveSlippageBps: 0 },
      });
    const [a, b] = await Promise.all([credit(), credit()]);
    assert.equal(a.status, 'CREDITED');
    assert.equal(b.status, 'CREDITED');

    const { rows } = await client.query(`SELECT count(*)::int AS n FROM journal_entries WHERE ref_id = $1`, [session.id]);
    assert.equal(rows[0].n, 1, 'one deposit, one credit');
    const { accountBalance } = await import('../lib/server/ledger-store.ts');
    assert.equal(await accountBalance('acme'), 2_500_000_000n);
  });
});
