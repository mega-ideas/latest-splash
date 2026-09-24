import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

import * as schema from '../lib/db/schema.ts';
import { loadOpenProposalByKey, loadOpenProposals, upsertProposal } from '../lib/db/proposal-repo.ts';
import { ensureProposalStoreHydrated } from '../lib/queue/proposal-persistence.ts';
import { InMemoryProposalStore, isProposalInFlight, withApprovalCanon } from '../lib/queue/proposal-state.ts';
import { replayThroughRoute } from '../lib/server/approval-replay.ts';
import { subjectDigest } from '../lib/server/step-up.ts';
import { fiatPaymentSubstance } from '../lib/server/step-up-subjects.ts';

/**
 * Proposal idempotency and lifecycle, now that proposals outlive the process.
 *
 * An idempotency key names a payment, so a re-submission finds the proposal
 * already waiting instead of queueing a second. It held for as long as the
 * proposal existed, in memory and (as a unique index) in Postgres, which is
 * forever. Every finished proposal became a permanent block on its own
 * payment: after a restart, proposing it again was refused by the index; in
 * process, it was answered with the finished proposal. Nothing ever expired a
 * proposal either, so every stale draft came back on every boot, one query at a
 * time.
 *
 * The key now binds while the proposal is in flight. Finished (a terminal
 * status, SETTLED, or an execution outcome recorded) gives it back.
 */

// The store-only tests run without a database; the Postgres ones set one up
// and put this back.
delete process.env.DATABASE_URL;

const HOUR = 60 * 60 * 1000;
/** Fixtures are relative to now: the paths through the app's own store run on
 *  the wall clock. Tests that need time to pass turn a clock of their own. */
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();

const STATUSES = [
  'DRAFTED', 'SIMULATED', 'POLICY_EVALUATED', 'PENDING_APPROVAL', 'APPROVED', 'SIGNED', 'SUBMITTED',
  'SETTLED', 'ANCHORED', 'REJECTED', 'FAILED', 'EXPIRED', 'REVERSED',
];

function proposal(id, overrides = {}) {
  return {
    id,
    idempotencyKey: `key_${id}`,
    kind: 'PAYMENT',
    status: 'SIMULATED',
    tier: 'TIER_0_PROPOSE',
    orgId: 'acme',
    corridor: 'PHP',
    unsignedTxBytes: 'deadbeef',
    createdBy: 'usr_maker',
    createdAt: iso(NOW),
    expiresAt: iso(NOW + 24 * HOUR),
    approvals: [],
    explain: {
      recommendation: 'Pay 25000 USD to Manila Parts Supply in PHP.',
      financialImpact: { amountIn: 25_000_000_000n, currencyIn: 'USD' },
      evidence: [{ source: 'COUNTERPARTY', ref: 'rcpt_manila', observedAt: iso(NOW), trusted: true, status: 'LIVE' }],
      confidence: 1,
      risk: 'MEDIUM',
      requiredApprovers: 2,
      reasoningTraceRef: 'dual-approval:test',
    },
    simulation: { ok: true, balanceChanges: [], gasSponsored: false, simulatedAt: iso(NOW) },
    ...overrides,
  };
}

/** A store whose clock the test turns. */
function clockedStore(onWrite) {
  const clock = { now: NOW };
  return { store: new InMemoryProposalStore(onWrite, { now: () => clock.now }), clock };
}

const approval = (userId, role, at = NOW) => ({ userId, role, signedAt: iso(at) });

/** Two distinct checkers, as the submit route walks it: SIMULATED to APPROVED. */
function approve(store, id) {
  store.transition(id, { type: 'POLICY_EVALUATED', requiredApprovers: 2 });
  store.transition(id, { type: 'QUEUE_FOR_APPROVAL' });
  store.transition(id, { type: 'APPROVE', approval: approval('usr_checker_1', 'APPROVER', NOW) });
  return store.transition(id, { type: 'APPROVE', approval: approval('usr_checker_2', 'FINANCE_ADMIN', NOW + 1000) });
}

/** Approved, signed and submitted: the payment is being carried out. */
function submit(store, id) {
  approve(store, id);
  store.transition(id, { type: 'SIGN', signatureRef: 'sig_test', signedBy: 'usr_checker_2', policyAuthorized: true, signedAt: iso(NOW) });
  return store.transition(id, { type: 'SUBMIT' });
}

/** A single payout as the transfer route stores it (the parsed body). */
function payoutBody(overrides = {}) {
  return {
    recipient: {
      name: 'Manila Parts Supply',
      country: 'PH',
      bank: { swift: 'BOPIPHMM', account: '001234567890' },
      travelRule: { address: '12 Rizal Ave, Manila' },
    },
    travelRulePayment: { purpose: 'GOODS' },
    amount: { value: '25000', targetCurrency: 'PHP' },
    deliveryTier: 'PAYOUT_ONLY',
    fundingSelection: { source: 'SPLASH_BALANCE', type: 'held', feeTier: 'DISCOUNT' },
    ...overrides,
  };
}

/** What the transfer route hands proposeForApproval. */
function pendingApproval(overrides = {}) {
  const payload = payoutBody();
  return {
    orgId: 'acme',
    createdBy: 'usr_maker',
    kind: 'PAYMENT',
    amountUsd: '25000',
    targetCurrency: 'PHP',
    recommendation: 'Pay 25000 USD to Manila Parts Supply in PHP. Above the 10000 USD dual-approval threshold.',
    passedChecks: [{ source: 'COUNTERPARTY', ref: 'rcpt_manila' }],
    payload,
    idempotencyKey: `transfer:acme:${subjectDigest(fiatPaymentSubstance(payload))}`,
    approvalThresholdUsd: 10000,
    ...overrides,
  };
}

async function applyMigrations(client, include = () => true) {
  const files = (await readdir(new URL('../drizzle', import.meta.url))).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files.filter(include)) {
    const sqlText = await readFile(new URL(`../drizzle/${file}`, import.meta.url), 'utf8');
    for (const statement of sqlText.split('--> statement-breakpoint')) {
      const trimmed = statement.trim();
      if (trimmed) await client.exec(trimmed);
    }
  }
}

async function migratedDb(include) {
  const client = new PGlite();
  await applyMigrations(client, include);
  await client.exec(`INSERT INTO organizations (id, name) VALUES ('acme', 'Acme Trading'), ('northwind', 'Northwind')`);
  return { client, db: drizzle(client, { schema }) };
}

/** Point the app's database at this PGlite for the length of `run`. */
async function withDatabase(db, run) {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'postgres://pglite.invalid/proposal-idempotency';
  globalThis.splashDb = { pool: { end: async () => {} }, db };
  try {
    await run();
  } finally {
    delete globalThis.splashDb;
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
}

/** proposeForApproval asks the approvers in the background; let that finish
 *  before the database it reads goes away. */
const backgroundWork = () => new Promise((resolve) => setTimeout(resolve, 300));

async function rowsForKey(client, key) {
  const result = await client.query(
    `SELECT id, status, execution_state FROM proposals WHERE idempotency_key = $1 ORDER BY created_at, id`,
    [key],
  );
  return result.rows.map((row) => [row.id, row.status, row.execution_state]);
}

// ── The store ───────────────────────────────────────────────────────────────

test('a re-submission while the proposal is in flight gets it back, and only within its own org', () => {
  const { store } = clockedStore();
  store.create(proposal('first', { idempotencyKey: 'pay-manila-25k' }));

  const again = store.create(proposal('second', { idempotencyKey: 'pay-manila-25k' }));
  assert.equal(again.id, 'first');
  assert.equal(store.get('second'), null);

  // The key was compared on its own, across orgs: another org's identical key
  // was handed this org's proposal.
  const elsewhere = store.create(proposal('northwind_1', { idempotencyKey: 'pay-manila-25k', orgId: 'northwind' }));
  assert.equal(elsewhere.id, 'northwind_1');
  assert.equal(elsewhere.orgId, 'northwind');
});

test('a finished proposal gives its key back: rejected, expired or failed, the payment is proposed afresh', () => {
  const finishes = {
    rejected: (store, id) => store.transition(id, { type: 'REJECT', reason: 'wrong account' }),
    expired: (store, id) => store.transition(id, { type: 'EXPIRE' }),
    failed: (store, id) => store.transition(id, { type: 'FAIL', reason: 'screening' }),
  };
  for (const [label, finish] of Object.entries(finishes)) {
    const { store } = clockedStore();
    store.create(proposal('first', { idempotencyKey: 'k' }));
    finish(store, 'first');

    const next = store.create(proposal('next', { idempotencyKey: 'k' }));
    assert.equal(next.id, 'next', `${label}: the same payment again is a new attempt`);
    assert.equal(next.status, 'SIMULATED');
    assert.equal(store.get('first').status, label.toUpperCase(), `${label}: the old one keeps its history`);
    assert.equal(store.create(proposal('third', { idempotencyKey: 'k' })).id, 'next', `${label}: the new attempt holds the key`);
  }
});

test('a payment carried out gives its key back; one still being carried out keeps it', () => {
  const { store } = clockedStore();
  store.create(proposal('paid', { idempotencyKey: 'k' }));
  submit(store, 'paid');

  // SUBMITTED with no outcome: the replay may be moving the money right now,
  // and an outcome nobody recorded is unknown, not failed.
  assert.equal(store.create(proposal('during', { idempotencyKey: 'k' })).id, 'paid');

  store.recordExecution('paid', { state: 'EXECUTED', detail: 'Payment sent.', ref: 'tr_1', at: iso(NOW) });
  const repeat = store.create(proposal('repeat', { idempotencyKey: 'k' }));
  assert.equal(repeat.id, 'repeat', 'the identical payment again reaches the queue');
  assert.equal(store.get('paid').status, 'SUBMITTED', 'the executed one is untouched');

  // A failed replay finishes it too: "re-authorize the payment to try again"
  // used to find the spent proposal again.
  const second = clockedStore().store;
  second.create(proposal('refused', { idempotencyKey: 'k' }));
  submit(second, 'refused');
  second.recordExecution('refused', { state: 'FAILED', detail: 'Splash balance is insufficient.', at: iso(NOW) });
  assert.equal(second.create(proposal('retry', { idempotencyKey: 'k' })).id, 'retry');

  // And settling does.
  const third = clockedStore().store;
  third.create(proposal('settled', { idempotencyKey: 'k' }));
  submit(third, 'settled');
  third.transition('settled', { type: 'SETTLE', settlement: { digest: '0xabc', walrusBlobId: 'blob', auditEventId: 'evt' } });
  assert.equal(third.create(proposal('after_settle', { idempotencyKey: 'k' })).id, 'after_settle');
});

test('a holder past its expiry does not absorb the re-submission: it lapses and the new proposal takes the key', () => {
  const { store, clock } = clockedStore();
  store.create(proposal('stale', { idempotencyKey: 'k', expiresAt: iso(NOW + HOUR) }));

  // Policy still approves it until its expiry has passed, by the same comparison.
  clock.now = NOW + HOUR;
  assert.equal(store.create(proposal('early', { idempotencyKey: 'k' })).id, 'stale');

  clock.now = NOW + HOUR + 1;
  const fresh = store.create(proposal('fresh', { idempotencyKey: 'k' }));
  assert.equal(fresh.id, 'fresh');
  assert.equal(store.get('stale').status, 'EXPIRED');
  assert.equal(store.create(proposal('again', { idempotencyKey: 'k' })).id, 'fresh');
});

test('expireStale lapses what is past its expiry and not yet signed, and nothing else', () => {
  const { store, clock } = clockedStore();
  const soon = iso(NOW + HOUR);
  store.create(proposal('drafted', { status: 'DRAFTED', idempotencyKey: 'k1', expiresAt: soon, simulation: undefined }));
  store.create(proposal('simulated', { idempotencyKey: 'k2', expiresAt: soon }));
  store.create(proposal('pending', { idempotencyKey: 'k3', expiresAt: soon }));
  store.transition('pending', { type: 'POLICY_EVALUATED', requiredApprovers: 2 });
  store.transition('pending', { type: 'QUEUE_FOR_APPROVAL' });
  store.create(proposal('approved', { idempotencyKey: 'k4', expiresAt: soon }));
  approve(store, 'approved');
  store.create(proposal('submitted', { idempotencyKey: 'k5', expiresAt: soon }));
  submit(store, 'submitted');
  store.create(proposal('later', { idempotencyKey: 'k6', expiresAt: iso(NOW + 72 * HOUR) }));

  clock.now = NOW + 2 * HOUR;
  const lapsed = store.expireStale().map((p) => p.id).sort();
  assert.deepEqual(lapsed, ['drafted', 'pending', 'simulated']);
  assert.equal(store.get('submitted').status, 'SUBMITTED', 'signed and sent: "expired" would misdescribe money that may have moved');
  assert.equal(store.get('later').status, 'SIMULATED');
  assert.deepEqual(store.expireStale(), [], 'once is enough');

  // Approved by everyone and never sent: it stays in the queue's ready-to-send
  // lane, which says why it cannot go, rather than vanishing the moment its
  // window closes. Then it lapses too.
  assert.equal(store.get('approved').status, 'APPROVED');
  clock.now = NOW + HOUR + 24 * HOUR + 1;
  assert.deepEqual(store.expireStale().map((p) => p.id), ['approved']);
});

test('an approved payment past its window shows in the ready-to-send lane with the reason, until the same payment is proposed again', async () => {
  const { readyToSend } = await import('../lib/queue/ready-to-send.ts');
  const { store, clock } = clockedStore();
  store.create(proposal('approved', { idempotencyKey: 'k', expiresAt: iso(NOW + HOUR) }));
  approve(store, 'approved');

  clock.now = NOW + 2 * HOUR;
  await ensureProposalStoreHydrated(store);
  const viewer = { orgId: 'acme', userId: 'usr_checker_1', role: 'APPROVER' };
  assert.deepEqual(
    readyToSend(store.list(), viewer, new Date(clock.now)).map((item) => [item.proposal.id, item.blockedReason]),
    [['approved', 'Its approval window has closed, so it has to be requested again.']],
  );

  // Requesting it again is the way forward, and the new request is not handed
  // the lapsed approval: it gets a proposal of its own.
  const again = store.create(proposal('again', { idempotencyKey: 'k' }));
  assert.equal(again.id, 'again');
  assert.equal(store.get('approved').status, 'EXPIRED');
  assert.deepEqual(readyToSend(store.list(), viewer, new Date(clock.now)), []);
});

test('every read of the store lapses what has expired since the last one', async () => {
  const { store, clock } = clockedStore();
  store.create(proposal('lapsing', { expiresAt: iso(NOW + HOUR) }));

  assert.equal(await ensureProposalStoreHydrated(store), true, 'no database: nothing to hydrate, nothing failed');
  assert.equal(store.get('lapsing').status, 'SIMULATED');

  clock.now = NOW + 2 * HOUR;
  await ensureProposalStoreHydrated(store);
  assert.equal(store.get('lapsing').status, 'EXPIRED', 'out of the pending lane the queue page lists');
});

test('hydration lapses a loaded proposal past its expiry, and writes only the lapse back', async () => {
  const writes = [];
  const { store, clock } = clockedStore(async (p) => {
    writes.push([p.id, p.status]);
  });
  clock.now = NOW + 2 * HOUR;
  store.hydrate([
    proposal('stale', { idempotencyKey: 'k1', status: 'PENDING_APPROVAL', expiresAt: iso(NOW + HOUR) }),
    proposal('live', { idempotencyKey: 'k2' }),
  ]);
  await store.flush();

  assert.equal(store.get('stale').status, 'EXPIRED');
  assert.equal(store.get('live').status, 'SIMULATED');
  assert.deepEqual(writes, [['stale', 'EXPIRED']], 'loading is not a write; the lapse is');
  assert.equal(store.create(proposal('again_1', { idempotencyKey: 'k1' })).id, 'again_1', 'the lapsed key is free');
  assert.equal(store.create(proposal('again_2', { idempotencyKey: 'k2' })).id, 'live', 'the live key is held');
});

test('hydration meets a live duplicate: the stored proposal keeps the payment and the duplicate lapses', async () => {
  const writes = [];
  const { store } = clockedStore(async (p) => {
    writes.push([p.id, p.status]);
  });
  // Drafted while this process could not see Postgres. Its writes were
  // refused by the unique index from the start.
  store.create(proposal('live_duplicate', { idempotencyKey: 'k' }));
  // Then hydration loads the one Postgres has, which already has an approval.
  store.hydrate([
    proposal('stored', { idempotencyKey: 'k', status: 'PENDING_APPROVAL', approvals: [approval('usr_checker_1', 'APPROVER')] }),
  ]);
  await store.flush();

  assert.equal(store.get('stored').status, 'PENDING_APPROVAL');
  assert.equal(store.get('live_duplicate').status, 'EXPIRED');
  const cards = store.list().filter((p) => p.idempotencyKey === 'k' && isProposalInFlight(p));
  assert.deepEqual(cards.map((p) => p.id), ['stored'], 'one card for one payment');
  assert.equal(store.create(proposal('again', { idempotencyKey: 'k' })).id, 'stored');
  assert.deepEqual(writes.at(-1), ['live_duplicate', 'EXPIRED'], 'the lapse is recorded, so the duplicate is on file as finished');
});

test('a live duplicate that already has every approval keeps the payment; the stored one lapses', () => {
  const { store } = clockedStore();
  store.create(proposal('live', { idempotencyKey: 'k' }));
  approve(store, 'live');
  store.hydrate([proposal('stored', { idempotencyKey: 'k', status: 'PENDING_APPROVAL' })]);

  assert.equal(store.get('live').status, 'APPROVED');
  assert.equal(store.get('stored').status, 'EXPIRED');
  assert.equal(store.create(proposal('again', { idempotencyKey: 'k' })).id, 'live');
});

// ── Postgres ────────────────────────────────────────────────────────────────

test('Postgres and the store agree on which proposals hold their key, for every status', async () => {
  const { client, db } = await migratedDb();
  const expected = new Map();
  let n = 0;
  for (const status of STATUSES) {
    for (const executionState of [null, 'EXECUTED', 'FAILED']) {
      n += 1;
      const key = `mirror_${n}`;
      await client.query(
        `INSERT INTO proposals (id, org_id, idempotency_key, kind, status, tier, created_by, explain, execution_state)
         VALUES ($1, 'acme', $2, 'PAYMENT', $3, 'TIER_0_PROPOSE', 'usr_maker', '{}', $4)`,
        [`old_${n}`, key, status, executionState],
      );
      const inFlight = isProposalInFlight({
        status,
        execution: executionState ? { state: executionState, detail: '', at: iso(NOW) } : undefined,
      });
      let refused = false;
      try {
        await client.query(
          `INSERT INTO proposals (id, org_id, idempotency_key, kind, status, tier, created_by, explain)
           VALUES ($1, 'acme', $2, 'PAYMENT', 'PENDING_APPROVAL', 'TIER_0_PROPOSE', 'usr_maker', '{}')`,
          [`new_${n}`, key],
        );
      } catch (error) {
        assert.match(error.message, /proposals_open_idempotency_unique/);
        refused = true;
      }
      const label = `${status}${executionState ? ` with execution ${executionState}` : ''}`;
      assert.equal(refused, inFlight, `${label}: ${inFlight ? 'holds' : 'gives back'} its key in the store, so the index must ${inFlight ? 'refuse' : 'allow'} a second in flight`);
      expected.set(`old_${n}`, inFlight);
      if (!refused) expected.set(`new_${n}`, true);
    }
  }

  // Boot hydration loads exactly the proposals in flight.
  const loaded = new Set((await loadOpenProposals(db)).map((p) => p.id));
  for (const [id, inFlight] of expected) {
    assert.equal(loaded.has(id), inFlight, `${id} ${inFlight ? 'is' : 'is not'} in flight`);
  }

  // Two orgs, one key: two payments.
  await client.query(
    `INSERT INTO proposals (id, org_id, idempotency_key, kind, status, tier, created_by, explain)
     VALUES ('nw_1', 'northwind', 'mirror_1', 'PAYMENT', 'PENDING_APPROVAL', 'TIER_0_PROPOSE', 'usr_maker', '{}')`,
  );
  await client.close();
});

test('after a restart, a payment whose proposal was rejected can be proposed again, and the new one is stored', async () => {
  const run = async (include) => {
    const { client, db } = await migratedDb(include);
    const refused = [];
    const writer = (p) => upsertProposal(db, p).catch((error) => {
      refused.push(p.id);
      throw error;
    });
    const processA = new InMemoryProposalStore(writer);
    processA.create(proposal('first', { idempotencyKey: 'transfer:acme:same-payment' }));
    processA.transition('first', { type: 'REJECT', reason: 'wrong account' });
    await processA.flush();

    // Restart: terminal proposals stay out of hydration, so the store is empty.
    const processB = new InMemoryProposalStore(writer);
    processB.hydrate(await loadOpenProposals(db));
    const second = processB.create(proposal('second', { idempotencyKey: 'transfer:acme:same-payment' }));
    await processB.flush();
    const rows = await rowsForKey(client, 'transfer:acme:same-payment');
    await client.close();
    return { second, refused, rows };
  };

  // The defect, under the index as it was (migrations through 0024): the new
  // proposal existed only in memory, its write refused.
  const before = await run((file) => file < '0025');
  assert.equal(before.second.id, 'second');
  assert.deepEqual(before.refused, ['second']);
  assert.deepEqual(before.rows, [['first', 'REJECTED', null]]);

  const after = await run(() => true);
  assert.deepEqual(after.refused, []);
  assert.deepEqual(after.rows, [['first', 'REJECTED', null], ['second', 'SIMULATED', null]]);
});

test('Zeke drafting after a restart finds the draft in Postgres instead of making a second', async () => {
  const { client, db } = await migratedDb();
  await withDatabase(db, async () => {
    const { proposePayment } = await import('../lib/agent/oxwal.ts');
    const input = { orgId: 'acme', counterpartyId: 'cp_acme_ph', amountUsd: 2500, currency: 'USDC' };
    const writer = (p) => upsertProposal(db, p);

    globalThis.oxwalProposalStore = new InMemoryProposalStore(writer);
    const first = await proposePayment(input);
    await globalThis.oxwalProposalStore.flush();

    // Restart: an empty store, and the first thing that happens is the same
    // draft again. Drafting used to run before any hydration.
    const restarted = new InMemoryProposalStore(writer);
    globalThis.oxwalProposalStore = restarted;
    const again = await proposePayment(input);
    await restarted.flush();

    assert.equal(again.id, first.id);
    const cards = restarted.list().filter((p) => p.idempotencyKey === first.idempotencyKey);
    assert.deepEqual(cards.map((p) => p.id), [first.id], 'one card for one payment');
    assert.deepEqual(await rowsForKey(client, first.idempotencyKey), [[first.id, 'SIMULATED', null]]);

    // Rejected, the same draft is a new proposal, and it is stored.
    restarted.transition(first.id, { type: 'REJECT', reason: 'not this week' });
    const redrafted = await proposePayment(input);
    await restarted.flush();
    assert.notEqual(redrafted.id, first.id);
    assert.deepEqual(await rowsForKey(client, first.idempotencyKey), [
      [first.id, 'REJECTED', null],
      [redrafted.id, 'SIMULATED', null],
    ]);
  });
  await client.close();
});

test('an executed dual approval gives the payment back: the identical payment reaches the queue again', async () => {
  const { client, db } = await migratedDb();
  const input = pendingApproval();
  await withDatabase(db, async () => {
    const { proposeForApproval } = await import('../lib/server/dual-approval.ts');
    const writer = (p) => upsertProposal(db, p);
    globalThis.oxwalProposalStore = new InMemoryProposalStore(writer);

    const first = await proposeForApproval(input);
    assert.equal(first.status, 'SIMULATED');
    assert.equal((await proposeForApproval(input)).id, first.id, 'a re-submitted file finds its pending proposal');

    // Restart: still found, from Postgres.
    const store = new InMemoryProposalStore(writer);
    globalThis.oxwalProposalStore = store;
    assert.equal((await proposeForApproval(input)).id, first.id, 'and after a restart');

    // Approved and carried out. SUBMITTED is not terminal, so this is the
    // proposal every identical payment used to resolve to, forever.
    submit(store, first.id);
    store.recordExecution(first.id, { state: 'EXECUTED', detail: 'Payment sent.', ref: 'tr_1', at: iso(NOW) });
    await store.flush();

    const repeat = await proposeForApproval(input);
    assert.notEqual(repeat.id, first.id);
    assert.equal(repeat.status, 'SIMULATED', 'awaiting its own approvers');
    await store.flush();
    assert.deepEqual(await rowsForKey(client, input.idempotencyKey), [
      [first.id, 'SUBMITTED', 'EXECUTED'],
      [repeat.id, 'SIMULATED', null],
    ]);

    // After another restart the executed one stays out of hydration and the
    // repeat is what a re-submission finds.
    globalThis.oxwalProposalStore = new InMemoryProposalStore(writer);
    assert.equal((await proposeForApproval(input)).id, repeat.id);
    await backgroundWork();
  });
  await client.close();
});

test('a payment another process proposed after this one booted is found, not proposed twice', async () => {
  const { client, db } = await migratedDb();
  const input = pendingApproval({ idempotencyKey: 'transfer:acme:cross-process' });
  await withDatabase(db, async () => {
    const { proposeForApproval } = await import('../lib/server/dual-approval.ts');
    const writer = (p) => upsertProposal(db, p);
    const processA = new InMemoryProposalStore(writer);
    const processB = new InMemoryProposalStore(writer);

    // B booted (and hydrated) before A proposed anything.
    assert.equal(await ensureProposalStoreHydrated(processB), true);
    globalThis.oxwalProposalStore = processA;
    const inA = await proposeForApproval(input);

    globalThis.oxwalProposalStore = processB;
    const inB = await proposeForApproval(input);
    await processB.flush();
    assert.equal(inB.id, inA.id);
    assert.equal((await rowsForKey(client, input.idempotencyKey)).length, 1);
    await backgroundWork();
  });
  await client.close();
});

test('with Postgres unreadable, no proposal is made and the payment stays refused', async () => {
  const down = () => {
    throw new Error('connection refused');
  };
  await withDatabase({ select: down, insert: down, transaction: down }, async () => {
    const { proposeForApproval } = await import('../lib/server/dual-approval.ts');
    const store = new InMemoryProposalStore();
    globalThis.oxwalProposalStore = store;
    assert.equal(await proposeForApproval(pendingApproval()), null);
    assert.deepEqual(store.list(), [], 'nothing minted that Postgres could not be checked against');
  });
});

test('hydration lapses what has expired, writes it back, and does not load it on the next boot', async () => {
  const { client, db } = await migratedDb();
  await withDatabase(db, async () => {
    // A Zeke draft nobody acted on, from a process that stopped before it expired.
    await upsertProposal(db, withApprovalCanon(proposal('stale_draft', {
      idempotencyKey: 'zeke:stale',
      createdBy: 'OXWAL',
      createdAt: iso(NOW - 2 * HOUR),
      expiresAt: iso(NOW - HOUR),
    })));
    await upsertProposal(db, withApprovalCanon(proposal('waiting', { idempotencyKey: 'k_waiting' })));

    const store = new InMemoryProposalStore((p) => upsertProposal(db, p));
    assert.equal(await ensureProposalStoreHydrated(store), true);
    assert.equal(store.get('stale_draft').status, 'EXPIRED');
    assert.equal(store.get('waiting').status, 'SIMULATED');
    await store.flush();

    assert.deepEqual(await rowsForKey(client, 'zeke:stale'), [['stale_draft', 'EXPIRED', null]], 'the lapse is on file');
    assert.deepEqual((await loadOpenProposals(db)).map((p) => p.id), ['waiting'], 'the next boot loads only what is in flight');
  });
  await client.close();
});

test('hydration is one statement, however many proposals, and keeps each one\'s approvals in order', async () => {
  const { client, db } = await migratedDb();
  const store = new InMemoryProposalStore((p) => upsertProposal(db, p));
  for (let i = 0; i < 6; i += 1) store.create(proposal(`p${i}`, { idempotencyKey: `k${i}` }));
  approve(store, 'p2');
  submit(store, 'p4');
  store.recordExecution('p4', { state: 'EXECUTED', detail: 'Payment sent.', at: iso(NOW) });
  store.transition('p5', { type: 'REJECT', reason: 'no' });
  await store.flush();

  let selects = 0;
  const counted = new Proxy(db, {
    get(target, property) {
      if (property === 'select') selects += 1;
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const loaded = await loadOpenProposals(counted);
  assert.equal(selects, 1, 'was one query for the proposals plus one per proposal for its approvals');
  assert.deepEqual(loaded.map((p) => p.id), ['p0', 'p1', 'p2', 'p3'], 'the executed and the rejected are finished');
  assert.deepEqual(loaded.find((p) => p.id === 'p2').approvals.map((a) => a.userId), ['usr_checker_1', 'usr_checker_2']);
  assert.deepEqual(loaded.find((p) => p.id === 'p0').approvals, []);
  assert.equal(typeof loaded[0].explain.financialImpact.amountIn, 'bigint', 'money is still exact');

  assert.equal((await loadOpenProposalByKey(db, 'acme', 'k2'))?.id, 'p2');
  assert.equal(await loadOpenProposalByKey(db, 'acme', 'k4'), null, 'carried out: nothing in flight');
  assert.equal(await loadOpenProposalByKey(db, 'northwind', 'k2'), null, 'another org');
  await client.close();
});

test('hydration is per store: a second store is not taken as hydrated because the first was', async () => {
  const { client, db } = await migratedDb();
  await withDatabase(db, async () => {
    await upsertProposal(db, withApprovalCanon(proposal('on_file')));

    const first = new InMemoryProposalStore();
    assert.equal(await ensureProposalStoreHydrated(first), true);
    assert.ok(first.get('on_file'));

    const second = new InMemoryProposalStore();
    assert.equal(await ensureProposalStoreHydrated(second), true);
    assert.ok(second.get('on_file'), 'one flag for the module left the second store empty');
  });
  await client.close();
});

// ── Carrying approvals out ──────────────────────────────────────────────────

test('an idempotent replay of an earlier run is not reported as this approval carried out', async () => {
  globalThis.oxwalProposalStore = new InMemoryProposalStore();
  const replay = (body) => replayThroughRoute(
    async () => Response.json(body),
    '/api/batches/authorize',
    { orgId: 'acme', approvedProposalId: 'prop_repeat', body: {}, cookie: '', origin: 'http://splash.test' },
  );

  const swallowed = await replay({ id: 'batch_last_month', idempotentReplay: true });
  assert.equal(swallowed.ok, false);
  assert.match(swallowed.error, /already been carried out as batch_last_month; nothing new was paid/);

  assert.deepEqual(await replay({ id: 'batch_new', state: 'QUEUED' }), { ok: true, ref: 'batch_new' });
});

test('a late ballot on a lapsed payment is answered as closed, without reading a ballot or moving anything', async () => {
  const { settleBallots } = await import('../lib/server/approval-settle.ts');
  const { store, clock } = clockedStore();
  store.create(proposal('lapsing', { expiresAt: iso(NOW + HOUR) }));
  store.transition('lapsing', { type: 'POLICY_EVALUATED', requiredApprovers: 2 });
  store.transition('lapsing', { type: 'QUEUE_FOR_APPROVAL' });

  // The last ballot arrives after the approval window closed.
  // settleFullyApprovedProposal reads the store first, which lapses it.
  clock.now = NOW + 2 * HOUR;
  await ensureProposalStoreHydrated(store);
  assert.equal(store.get('lapsing').status, 'EXPIRED');

  // Before, it still read as pending here and went on to the ballots, the
  // policy check and the release.
  const untouched = () => {
    throw new Error('a lapsed payment must not get this far');
  };
  const outcome = await settleBallots(
    {
      store,
      db: new Proxy({}, { get: untouched }),
      compliance: untouched,
      canMoveMoney: untouched,
      execute: untouched,
      closeClaim: untouched,
      now: () => new Date(clock.now),
    },
    { proposalId: 'lapsing', channel: 'whatsapp', releaser: null },
  );
  assert.deepEqual(outcome, {
    settled: false,
    stage: 'CLOSED',
    message: 'This payment is expired and can no longer be approved.',
  });
});

// ── The routes ──────────────────────────────────────────────────────────────

function code(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
}

async function source(file) {
  return code(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'));
}

test('the submit route refuses a finished proposal before taking any decision on it', async () => {
  const route = await source('app/api/proposals/[id]/submit/route.ts');
  const closed = route.indexOf('if (!isProposalInFlight(proposal))');
  assert.ok(closed > 0, 'a finished proposal is answered, not walked through the state machine');
  assert.ok(closed < route.indexOf("parsed.data.decision === 'REJECT'"), 'before REJECT, which threw on a finished proposal: a 500');
  assert.ok(closed > route.indexOf('await ensureProposalStoreHydrated(store)'), 'after the read that lapses what has expired');
  assert.match(route, /code: 'PROPOSAL_CLOSED'/);
});

test('a transfer proposal is named by the payment its approval covers, not by the recipient\'s name', async () => {
  const route = await source('app/api/transfers/authorize/route.ts');
  assert.match(route, /idempotencyKey: `transfer:\$\{orgId\}:\$\{subjectDigest\(fiatPaymentSubstance\(approvalPayload\)\)\}`/);
  assert.match(route, /payload: approvalPayload,/, 'the payload replayed is the payload named');

  const key = (payload) => subjectDigest(fiatPaymentSubstance(payload));
  const payment = payoutBody();
  assert.equal(
    key({ ...payment, totp: '111111', fundingSessionId: 'fs_1', quote: { netReceived: '1' } }),
    key({ ...payment, totp: '222222', fundingSessionId: 'fs_2', quote: { netReceived: '2' } }),
    'a retry of the same payment is the same payment',
  );
  const otherAccount = { ...payment, recipient: { ...payment.recipient, bank: { swift: 'BOPIPHMM', account: '009999999999' } } };
  assert.notEqual(key(payment), key(otherAccount), 'same name, amount and currency, another account: another payment');
});
