import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

import * as schema from '../lib/db/schema.ts';
import { decodeJsonWithBigints, encodeJsonWithBigints, loadOpenProposals, upsertProposal } from '../lib/db/proposal-repo.ts';
import { InMemoryProposalStore } from '../lib/queue/proposal-state.ts';

/**
 * W1 PR-B acceptance — kill and cold-start the app mid-flow: a pending
 * approval survives. Simulated faithfully: store A (the "first process")
 * write-throughs to Postgres (pglite over the real checked-in migrations);
 * store B (the "restarted process") starts EMPTY and hydrates from the
 * database — the dual-control proposal must still be waiting with its
 * first approval intact.
 */

async function migratedDb() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  const files = (await readdir(new URL('../drizzle', import.meta.url))).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sqlText = await readFile(new URL(`../drizzle/${file}`, import.meta.url), 'utf8');
    for (const statement of sqlText.split('--> statement-breakpoint')) {
      const trimmed = statement.trim();
      if (trimmed) await client.exec(trimmed);
    }
  }
  // Proposals are booked under an org that already exists; writing one no
  // longer creates it.
  await client.exec(`INSERT INTO organizations (id, name) VALUES ('org_coldstart_test', 'Cold Start Test')`);
  return { client, db };
}

function draftProposal(id, overrides = {}) {
  return {
    id,
    idempotencyKey: `idem_${id}`,
    kind: 'PAYMENT',
    status: 'PENDING_APPROVAL',
    tier: 'TIER_0_PROPOSE',
    orgId: 'org_coldstart_test',
    corridor: 'MY_PH',
    unsignedTxBytes: 'dW5zaWduZWQ=',
    createdBy: 'maker_ops_1',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    approvals: [],
    explain: {
      recommendation: 'Release verified supplier payout',
      financialImpact: { amountOut: BigInt(4_200_000), currencyOut: 'USD', feeBps: 18 },
      evidence: [{ source: 'COUNTERPARTY', ref: 'cp_acme_ph', observedAt: new Date().toISOString(), trusted: true }],
      confidence: 0.91,
      risk: 'LOW',
      requiredApprovers: 2,
      reasoningTraceRef: 'walrus_reasoning_test',
    },
    simulation: {
      ok: true,
      balanceChanges: [
        { owner: 'org_treasury', coinType: 'USD', amount: '-4200000' },
        { owner: 'cp_acme_ph', coinType: 'USD', amount: '4200000' },
      ],
      gasSponsored: true,
      simulatedAt: new Date().toISOString(),
    },
    ...overrides,
  };
}

test('bigint money fields round-trip through the jsonb encoding losslessly', () => {
  const explain = { financialImpact: { amountOut: BigInt('9007199254740993'), currencyOut: 'USD' } };
  const decoded = decodeJsonWithBigints(encodeJsonWithBigints(explain));
  assert.equal(typeof decoded.financialImpact.amountOut, 'bigint');
  assert.equal(decoded.financialImpact.amountOut, BigInt('9007199254740993'));
});

test('cold start: a pending dual-control approval survives the restart', async () => {
  const { client, db } = await migratedDb();

  // "Process one": store with write-through persistence.
  const storeA = new InMemoryProposalStore(async (p) => upsertProposal(db, p));
  storeA.create(draftProposal('prop_survivor'));
  storeA.transition('prop_survivor', {
    type: 'APPROVE',
    approval: { userId: 'approver_1', role: 'APPROVER', signedAt: new Date().toISOString() },
  });
  await storeA.flush();

  // Kill the process: a brand-new empty store ("process two") hydrates from
  // the SAME database.
  const storeB = new InMemoryProposalStore();
  storeB.hydrate(await loadOpenProposals(db));

  const survivor = storeB.get('prop_survivor');
  assert.ok(survivor, 'pending proposal must survive the cold start');
  assert.equal(survivor.status, 'PENDING_APPROVAL');
  assert.equal(survivor.approvals.length, 1);
  assert.equal(survivor.approvals[0].userId, 'approver_1');
  assert.equal(typeof survivor.explain.financialImpact.amountOut, 'bigint');
  assert.equal(survivor.explain.financialImpact.amountOut, BigInt(4_200_000));

  // The restarted process can finish the maker-checker chain.
  const approved = storeB.transition('prop_survivor', {
    type: 'APPROVE',
    approval: { userId: 'approver_2', role: 'APPROVER', signedAt: new Date().toISOString() },
  });
  assert.equal(approved.status, 'APPROVED');

  await client.close();
});

test('terminal proposals stay out of boot hydration', async () => {
  const { client, db } = await migratedDb();
  const store = new InMemoryProposalStore(async (p) => upsertProposal(db, p));
  store.create(draftProposal('prop_done', { status: 'PENDING_APPROVAL', idempotencyKey: 'idem_done' }));
  store.transition('prop_done', { type: 'REJECT', reason: 'test' });
  await store.flush();

  const rehydrated = await loadOpenProposals(db);
  assert.equal(rehydrated.find((p) => p.id === 'prop_done'), undefined);
  await client.close();
});

test('persistence failures never break the in-memory flow (fail-open hot path)', async () => {
  const store = new InMemoryProposalStore(async () => { throw new Error('db down'); });
  const created = store.create(draftProposal('prop_dbdown', { idempotencyKey: 'idem_dbdown' }));
  assert.equal(created.id, 'prop_dbdown');
  await store.flush(); // must not throw — failure is logged, not raised
  assert.equal(store.get('prop_dbdown')?.status, 'PENDING_APPROVAL');
  // ...but it is not silent to a caller that asks. Moving money asks.
  assert.equal(await store.writeFailed('prop_dbdown'), true);
});

test('a failed write is reported until a later write of the same proposal lands', async () => {
  let down = true;
  const written = [];
  const store = new InMemoryProposalStore(async (p) => {
    if (down) throw new Error('db down');
    written.push(p);
  });
  store.create(draftProposal('prop_flaky', { idempotencyKey: 'idem_flaky' }));
  store.create(draftProposal('prop_steady', { idempotencyKey: 'idem_steady' }));
  assert.equal(await store.writeFailed('prop_flaky'), true);

  // Every write is the whole row, so the next one that lands makes Postgres
  // current again — and the flag is per proposal, not a store-wide alarm.
  down = false;
  store.transition('prop_flaky', {
    type: 'APPROVE',
    approval: { userId: 'approver_1', role: 'APPROVER', signedAt: new Date().toISOString() },
  });
  assert.equal(await store.writeFailed('prop_flaky'), false);
  assert.equal(written.at(-1).approvals.length, 1);
  assert.equal(await store.writeFailed('prop_steady'), true, 'its own write never landed');
});

test('with no writer nothing was attempted, so nothing failed', async () => {
  const store = new InMemoryProposalStore();
  store.create(draftProposal('prop_memory_only', { idempotencyKey: 'idem_memory_only' }));
  assert.equal(await store.writeFailed('prop_memory_only'), false);
});

test('writing a proposal never creates the org it is booked under', async () => {
  const { client, db } = await migratedDb();
  // An org id that exists nowhere: what a model-chosen or injected id was.
  await assert.rejects(
    upsertProposal(db, draftProposal('prop_ghost', { orgId: 'org-not-a-tenant', idempotencyKey: 'idem_ghost' })),
    // drizzle wraps the driver error; the refusal itself is the cause.
    (error) => /violates foreign key constraint "proposals_org_id_organizations_id_fk"/.test(String(error?.cause?.message)),
  );
  const orgs = await client.query(`SELECT id FROM organizations WHERE id = 'org-not-a-tenant'`);
  assert.equal(orgs.rows.length, 0, 'a proposal write must not mint a tenant');
  const rows = await client.query(`SELECT id FROM proposals WHERE id = 'prop_ghost'`);
  assert.equal(rows.rows.length, 0);
  await client.close();
});
