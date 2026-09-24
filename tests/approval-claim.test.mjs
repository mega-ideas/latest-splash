import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

import * as schema from '../lib/db/schema.ts';
import { consumeApprovalRecord, upsertProposal } from '../lib/db/proposal-repo.ts';
import { InMemoryProposalStore } from '../lib/queue/proposal-state.ts';
import { replayThroughRoute } from '../lib/server/approval-replay.ts';
import { closeApprovalClaim, resolveApprovalClaim } from '../lib/server/approved-proposal.ts';
import { subjectDigest } from '../lib/server/step-up.ts';
import {
  batchPayoutSubstance,
  batchTargetCurrency,
  fiatPaymentSubstance,
  payableBatchRows,
  treasuryMoveSubstance,
} from '../lib/server/step-up-subjects.ts';

/**
 * The approved-proposal claim: `x-splash-approved-proposal: <id>`, which lifts
 * the second-approver requirement on the money routes when the approval queue
 * replays a payment its approvers signed off.
 *
 * Two holes, both closed here:
 *
 *   The batch route did not bind the claim to the run. Any member of the org
 *   could attach any approved proposal's id to a different batch and skip the
 *   second approver.
 *
 *   Claims were reusable. SUBMITTED, SETTLED and ANCHORED all counted as
 *   approved and nothing recorded a use, so the same approved payment could be
 *   sent again after it executed, with no second approver.
 */

// The in-process tests run without a database; the cross-process ones below
// set one up and put this back.
delete process.env.DATABASE_URL;

const ADDR_A = `0x${'a'.repeat(64)}`;
const ADDR_B = `0x${'b'.repeat(64)}`;
const ADDR_C = `0x${'c'.repeat(64)}`;

/** What the batch dashboard posts: every row of the file, two of them blocked. */
function batchBody(overrides = {}) {
  return {
    rows: [
      { name: 'Maria Santos', address: ADDR_A, amount: '12500.00', country: 'PH', purpose: 'payroll' },
      { name: 'Jose Rizal', address: ADDR_B, amount: '8000.00', country: 'PH', purpose: 'payroll' },
      { name: '', address: ADDR_C, amount: '500.00' },
      { name: 'Andres Bonifacio', address: ADDR_C, amount: '0' },
    ],
    targetCurrency: 'PHP',
    totp: '123456',
    ...overrides,
  };
}

/** What the batch route puts on the proposal: the payable rows and the currency. */
function approvedBatchPayload(body = batchBody()) {
  return { rows: payableBatchRows(body.rows), targetCurrency: batchTargetCurrency(body) };
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

const batchScope = (body) => ({ kind: 'BATCH_PAYOUT', substance: batchPayoutSubstance, body, consumer: 'batches/authorize' });
const payoutScope = (body) => ({ kind: 'PAYMENT', substance: fiatPaymentSubstance, body, consumer: 'transfers/authorize' });
const treasuryScope = (body) => ({
  kind: body.action === 'withdraw' ? 'TREASURY_REDEEM' : 'TREASURY_ALLOCATE',
  substance: treasuryMoveSubstance,
  body,
  consumer: 'treasury',
});

function claimRequest(proposalId) {
  return new Request('http://splash.test/api/batches/authorize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-splash-approved-proposal': proposalId },
  });
}

/** The store the routes resolve claims against, fresh for each test. */
function freshStore() {
  const store = new InMemoryProposalStore();
  globalThis.oxwalProposalStore = store;
  return store;
}

let sequence = 0;

/**
 * A proposal walked the way the submit route walks one: policy, the queue, two
 * distinct checkers, sign, submit. `until` stops short of SUBMITTED.
 */
function approvedProposal(store, { kind = 'BATCH_PAYOUT', payload, orgId = 'acme', id, until = 'SUBMITTED' } = {}) {
  const proposalId = id ?? `prop_claim_${++sequence}`;
  const now = new Date().toISOString();
  store.create({
    id: proposalId,
    idempotencyKey: `idem_${proposalId}`,
    kind,
    status: 'SIMULATED',
    tier: 'TIER_0_PROPOSE',
    orgId,
    corridor: 'PHP',
    unsignedTxBytes: 'deadbeef',
    createdBy: 'usr_maker',
    createdAt: now,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    approvals: [],
    explain: {
      recommendation: 'Pay the run',
      financialImpact: { amountIn: 20_500_000_000n, currencyIn: 'USD' },
      evidence: [],
      confidence: 1,
      risk: 'MEDIUM',
      requiredApprovers: 2,
      reasoningTraceRef: 'dual-approval:test',
    },
    simulation: { ok: true, balanceChanges: [], gasSponsored: false, simulatedAt: now },
    executionPayload: payload,
  });
  store.transition(proposalId, { type: 'POLICY_EVALUATED', requiredApprovers: 2 });
  store.transition(proposalId, { type: 'QUEUE_FOR_APPROVAL' });
  store.transition(proposalId, { type: 'APPROVE', approval: { userId: 'usr_checker_1', role: 'APPROVER', signedAt: now } });
  const approved = store.transition(proposalId, {
    type: 'APPROVE',
    approval: { userId: 'usr_checker_2', role: 'FINANCE_ADMIN', signedAt: now },
  });
  if (until === 'APPROVED') return approved;
  const signed = store.transition(proposalId, {
    type: 'SIGN',
    signatureRef: 'sig_test',
    signedBy: 'usr_checker_2',
    policyAuthorized: true,
    signedAt: now,
  });
  if (until === 'SIGNED') return signed;
  return store.transition(proposalId, { type: 'SUBMIT' });
}

const digest = (substance, payload) => subjectDigest(substance(payload));

// ── What a batch approval covers ────────────────────────────────────────────

test('a batch approval covers the rows the run pays and its currency, not the file around them', () => {
  const approved = digest(batchPayoutSubstance, approvedBatchPayload());

  // The full file the maker posted — blocked rows, the second factor, the
  // columns settlement never reads — is the same run.
  assert.equal(digest(batchPayoutSubstance, batchBody()), approved);
  assert.equal(digest(batchPayoutSubstance, batchBody({ totp: '654321' })), approved);
  const body = batchBody();
  assert.equal(
    digest(batchPayoutSubstance, {
      ...body,
      rows: body.rows.map((row) => ({ ...row, country: 'SG', purpose: 'bonus', memo: 'x' })),
    }),
    approved,
  );
  // And the approved payload is the same run after the replay's JSON round trip.
  assert.equal(digest(batchPayoutSubstance, JSON.parse(JSON.stringify(approvedBatchPayload()))), approved);
  // The route's default corridor is part of what was approved.
  const noCurrency = batchBody();
  delete noCurrency.targetCurrency;
  assert.equal(digest(batchPayoutSubstance, noCurrency), approved);
});

test('changing who is paid, where, how much, how many or in what currency voids it', () => {
  const approved = digest(batchPayoutSubstance, approvedBatchPayload());
  const body = batchBody();
  const [maria, jose, blocked, zero] = body.rows;
  const variants = {
    address: [{ ...maria, address: ADDR_C }, jose, blocked, zero],
    amount: [{ ...maria, amount: '125000.00' }, jose, blocked, zero],
    name: [{ ...maria, name: 'Someone Else' }, jose, blocked, zero],
    'a blocked row made payable': [maria, jose, blocked, { ...zero, amount: '900.00' }],
    'a payable row dropped': [maria, blocked, zero],
    'a payable row paid twice': [maria, maria, jose],
    order: [jose, maria, blocked, zero],
    // Compared as settlement receives it, so a respelling is a new approval.
    respelled: [{ ...maria, amount: '12500' }, jose, blocked, zero],
  };
  for (const [name, rows] of Object.entries(variants)) {
    assert.notEqual(digest(batchPayoutSubstance, { ...body, rows }), approved, `${name} must void the approval`);
  }
  assert.notEqual(digest(batchPayoutSubstance, batchBody({ targetCurrency: 'MYR' })), approved, 'currency');
});

test('a payable row is one settlement can pay, and a malformed file never throws', () => {
  const good = { name: 'Maria Santos', address: ADDR_A, amount: '10.00' };
  const whole = { name: 'Jose Rizal', address: ADDR_B, amount: 800 };
  const rows = [
    null,
    'row',
    42,
    [],
    { name: 'A', address: ADDR_B, amount: '-5' },
    { name: 'B', address: ADDR_B, amount: 'abc' },
    // parseFloat read this as 1.2; settlement refuses it, after the approval.
    { name: 'C', address: ADDR_B, amount: '1.2.3' },
    // Rounds to nothing at the micro-USD settlement pays in.
    { name: 'D', address: ADDR_B, amount: '0.0000001' },
    // A fractional JSON number has been through a float; settlement refuses it.
    { name: 'E', address: ADDR_B, amount: 100.5 },
    good,
    whole,
  ];
  assert.deepEqual(payableBatchRows(rows), [good, whole]);
  assert.deepEqual(batchPayoutSubstance({ rows: 'not rows' }).rows, []);
});

// ── The claim, resolved against the store ───────────────────────────────────

test('a batch approval lifts the second approver for its own run, once', async () => {
  const store = freshStore();
  const proposal = approvedProposal(store, { payload: approvedBatchPayload() });

  const first = await resolveApprovalClaim(claimRequest(proposal.id), 'acme', batchScope(batchBody()));
  assert.equal(first.approved, true);
  assert.equal(first.proposalId, proposal.id);
  assert.equal(store.get(proposal.id).approvalConsumedBy, 'batches/authorize');
  assert.ok(store.get(proposal.id).approvalConsumedAt);

  // The same run again — a fresh Idempotency-Key gets it past the batch
  // store's replay guard, so this is the only thing between it and a second
  // payout of every row.
  const again = await resolveApprovalClaim(claimRequest(proposal.id), 'acme', batchScope(batchBody()));
  assert.equal(again.approved, false);
  assert.equal(again.reason, 'already used');
});

test('an approval of one run cannot ride on another, and trying does not spend it', async () => {
  const store = freshStore();
  const proposal = approvedProposal(store, { payload: approvedBatchPayload() });
  const [maria, jose] = batchBody().rows;

  for (const rows of [
    [{ ...maria, address: ADDR_C }, jose],
    [maria, jose, { name: 'Extra Payee', address: ADDR_C, amount: '40000.00' }],
    [{ ...maria, amount: '99999.00' }, jose],
  ]) {
    const claim = await resolveApprovalClaim(claimRequest(proposal.id), 'acme', batchScope(batchBody({ rows })));
    assert.equal(claim.approved, false);
    assert.equal(claim.reason, 'it approved a different payment');
  }
  // Someone presenting it on the wrong run must not burn it for the real one.
  assert.equal(store.get(proposal.id).approvalConsumedAt, undefined);
  const real = await resolveApprovalClaim(claimRequest(proposal.id), 'acme', batchScope(approvedBatchPayload()));
  assert.equal(real.approved, true);
});

test('requests racing on one approval: exactly one wins', async () => {
  const store = freshStore();
  const proposal = approvedProposal(store, { payload: approvedBatchPayload() });
  const claims = await Promise.all(
    Array.from({ length: 5 }, () => resolveApprovalClaim(claimRequest(proposal.id), 'acme', batchScope(batchBody()))),
  );
  assert.equal(claims.filter((c) => c.approved).length, 1);
});

test('kind, org, status and signatures still hold, and a refusal spends nothing', async () => {
  const store = freshStore();
  const payload = approvedBatchPayload();

  // A payout approval is not a batch approval, whatever its payload says.
  const payout = approvedProposal(store, { kind: 'PAYMENT', payload });
  const wrongKind = await resolveApprovalClaim(claimRequest(payout.id), 'acme', batchScope(batchBody()));
  assert.equal(wrongKind.approved, false);
  assert.equal(wrongKind.reason, 'a PAYMENT approval does not cover a BATCH_PAYOUT');

  const batch = approvedProposal(store, { payload });
  const otherOrg = await resolveApprovalClaim(claimRequest(batch.id), 'northwind', batchScope(batchBody()));
  assert.equal(otherOrg.reason, 'proposal belongs to another org');

  // Before submission — APPROVED is before SIGN checks the canon — and after
  // the money moved, it is not a moment to carry a payment out.
  for (const until of ['APPROVED', 'SIGNED']) {
    const early = approvedProposal(store, { payload, until });
    const claim = await resolveApprovalClaim(claimRequest(early.id), 'acme', batchScope(batchBody()));
    assert.equal(claim.reason, `status is ${until}`);
  }
  const settled = approvedProposal(store, { payload });
  store.transition(settled.id, { type: 'SETTLE', settlement: { digest: '0xd1', walrusBlobId: 'blob', auditEventId: 'evt' } });
  assert.equal(
    (await resolveApprovalClaim(claimRequest(settled.id), 'acme', batchScope(batchBody()))).reason,
    'status is SETTLED',
  );
  store.transition(settled.id, { type: 'ANCHOR' });
  assert.equal(
    (await resolveApprovalClaim(claimRequest(settled.id), 'acme', batchScope(batchBody()))).reason,
    'status is ANCHORED',
  );

  // A canon revision after submission voids the signatures, and the claim
  // with them.
  const revised = approvedProposal(store, { payload });
  store.revise(revised.id, { expiresAt: new Date(Date.now() + 1000).toISOString() });
  assert.equal(
    (await resolveApprovalClaim(claimRequest(revised.id), 'acme', batchScope(batchBody()))).reason,
    '0 of 2 approvers signed',
  );

  assert.equal((await resolveApprovalClaim(claimRequest('prop_nope'), 'acme', batchScope(batchBody()))).reason, 'no such proposal');
  const noHeader = await resolveApprovalClaim(new Request('http://splash.test/'), 'acme', batchScope(batchBody()));
  assert.deepEqual(noHeader, { approved: false, proposalId: null });

  // None of that spent the batch approval; its own run still goes.
  assert.equal(store.get(batch.id).approvalConsumedAt, undefined);
  assert.equal((await resolveApprovalClaim(claimRequest(batch.id), 'acme', batchScope(batchBody()))).approved, true);
});

test('a single payout approval is bound to that payment and spent once', async () => {
  const store = freshStore();
  const proposal = approvedProposal(store, { kind: 'PAYMENT', payload: payoutBody() });

  const elsewhere = await resolveApprovalClaim(
    claimRequest(proposal.id),
    'acme',
    payoutScope(payoutBody({ recipient: { ...payoutBody().recipient, bank: { swift: 'BOPIPHMM', account: '009999999999' } } })),
  );
  assert.equal(elsewhere.reason, 'it approved a different payment');

  // What the wizard adds around the payment does not change it.
  const wizard = payoutBody({ quote: { netReceived: '1402000.00' }, fundingSessionId: 'fs_1', totp: '123456' });
  assert.equal((await resolveApprovalClaim(claimRequest(proposal.id), 'acme', payoutScope(wizard))).approved, true);
  assert.equal((await resolveApprovalClaim(claimRequest(proposal.id), 'acme', payoutScope(wizard))).reason, 'already used');
});

test('a treasury move takes only an approval of that move', async () => {
  const store = freshStore();
  // A payout approval does not lift the second approver on a withdrawal.
  const payout = approvedProposal(store, { kind: 'PAYMENT', payload: payoutBody() });
  const withdraw = { action: 'withdraw', amountUsd: '50000', totp: '123456' };
  assert.equal(
    (await resolveApprovalClaim(claimRequest(payout.id), 'acme', treasuryScope(withdraw))).reason,
    'a PAYMENT approval does not cover a TREASURY_REDEEM',
  );
  // Nor does a payout approval whose payload happens to read as the move.
  const lookalike = approvedProposal(store, { kind: 'PAYMENT', payload: withdraw });
  assert.equal((await resolveApprovalClaim(claimRequest(lookalike.id), 'acme', treasuryScope(withdraw))).approved, false);

  const move = approvedProposal(store, { kind: 'TREASURY_REDEEM', payload: withdraw });
  assert.equal(
    (await resolveApprovalClaim(claimRequest(move.id), 'acme', treasuryScope({ ...withdraw, action: 'move' }))).approved,
    false,
  );
  assert.equal(
    (await resolveApprovalClaim(claimRequest(move.id), 'acme', treasuryScope({ ...withdraw, amountUsd: '50001' }))).reason,
    'it approved a different payment',
  );
  assert.equal((await resolveApprovalClaim(claimRequest(move.id), 'acme', treasuryScope({ ...withdraw, totp: '000000' }))).approved, true);
  assert.equal((await resolveApprovalClaim(claimRequest(move.id), 'acme', treasuryScope(withdraw))).reason, 'already used');
});

// ── The replay presents a claim once ────────────────────────────────────────

const replayInput = (proposal) => ({
  orgId: proposal.orgId,
  approvedProposalId: proposal.id,
  body: proposal.executionPayload,
  cookie: '',
  origin: 'http://splash.test',
});

/** A stand-in for the batch route: resolves the claim the way the route does. */
async function batchRoute(request) {
  const body = await request.json();
  const claim = await resolveApprovalClaim(request, 'acme', batchScope(body));
  return claim.approved
    ? Response.json({ id: `batch_${sequence}` })
    : Response.json({ error: 'needs a second approver' }, { status: 409 });
}

test('a replay the route refused before reaching the claim still spends it', async () => {
  const store = freshStore();
  const proposal = approvedProposal(store, { payload: approvedBatchPayload() });

  // No session, a KYB or terms gate, a second factor: the route answers before
  // it ever reads the header.
  const result = await replayThroughRoute(
    async () => Response.json({ error: 'Authentication required' }, { status: 401 }),
    '/api/batches/authorize',
    replayInput(proposal),
  );
  assert.deepEqual(result, { ok: false, error: 'Authentication required' });
  assert.equal(store.get(proposal.id).approvalConsumedBy, 'execution');

  // So the approval record's "failed" stays true: nobody can carry it out later.
  const later = await resolveApprovalClaim(claimRequest(proposal.id), 'acme', batchScope(batchBody()));
  assert.equal(later.reason, 'already used');
});

test('a replay the route acted on is spent by the route, and a second replay pays nothing', async () => {
  const store = freshStore();
  const proposal = approvedProposal(store, { payload: approvedBatchPayload() });

  const first = await replayThroughRoute(batchRoute, '/api/batches/authorize', replayInput(proposal));
  assert.equal(first.ok, true);
  assert.equal(store.get(proposal.id).approvalConsumedBy, 'batches/authorize', 'the close does not overwrite who spent it');

  // A settle path run twice, a retried webhook: the second replay is refused.
  const second = await replayThroughRoute(batchRoute, '/api/batches/authorize', replayInput(proposal));
  assert.deepEqual(second, { ok: false, error: 'needs a second approver' });
});

test('a route that throws still leaves the claim closed', async () => {
  const store = freshStore();
  const proposal = approvedProposal(store, { payload: approvedBatchPayload() });
  await assert.rejects(
    replayThroughRoute(async () => { throw new Error('boom'); }, '/api/batches/authorize', replayInput(proposal)),
    /boom/,
  );
  assert.equal(store.get(proposal.id).approvalConsumedBy, 'execution');
  // And closing one this process never held does not throw.
  await closeApprovalClaim('prop_not_here', 'acme');
});

// ── Across processes, the database decides ──────────────────────────────────

async function applyMigrations(client, select = () => true) {
  const files = (await readdir(new URL('../drizzle', import.meta.url)))
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter(select);
  for (const file of files) {
    const sqlText = await readFile(new URL(`../drizzle/${file}`, import.meta.url), 'utf8');
    for (const statement of sqlText.split('--> statement-breakpoint')) {
      const trimmed = statement.trim();
      if (trimmed) await client.exec(trimmed);
    }
  }
}

async function migratedDb() {
  const client = new PGlite();
  await applyMigrations(client);
  await client.exec(`INSERT INTO organizations (id, name) VALUES ('acme', 'Acme Trading'), ('northwind', 'Northwind')`);
  return { client, db: drizzle(client, { schema }) };
}

/** Point the app's database at this PGlite for the length of `run`. */
async function withDatabase(db, run) {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'postgres://pglite.invalid/approval-claim';
  globalThis.splashDb = { pool: { end: async () => {} }, db };
  try {
    await run();
  } finally {
    delete globalThis.splashDb;
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
}

test('the migration: approvals already carried out start spent', async () => {
  const client = new PGlite();
  await applyMigrations(client, (file) => file < '0023');
  await client.exec(`
    INSERT INTO organizations (id, name) VALUES ('acme', 'Acme Trading');
    INSERT INTO proposals (id, org_id, idempotency_key, kind, status, tier, created_by, explain, execution_state, executed_at)
    VALUES
      ('p_submitted', 'acme', 'k1', 'BATCH_PAYOUT', 'SUBMITTED', 'TIER_0_PROPOSE', 'usr_maker', '{}', NULL, NULL),
      ('p_executed', 'acme', 'k2', 'PAYMENT', 'SUBMITTED', 'TIER_0_PROPOSE', 'usr_maker', '{}', 'EXECUTED', '2026-09-01T00:00:00Z'),
      ('p_settled', 'acme', 'k3', 'PAYMENT', 'SETTLED', 'TIER_0_PROPOSE', 'usr_maker', '{}', NULL, NULL),
      ('p_failed', 'acme', 'k4', 'PAYMENT', 'FAILED', 'TIER_0_PROPOSE', 'usr_maker', '{}', 'FAILED', NULL),
      ('p_pending', 'acme', 'k5', 'PAYMENT', 'PENDING_APPROVAL', 'TIER_0_PROPOSE', 'usr_maker', '{}', NULL, NULL);
  `);
  await applyMigrations(client, (file) => file.startsWith('0023'));

  const rows = await client.query(`SELECT proposal_id, consumed_by, consumed_at FROM consumed_approvals ORDER BY proposal_id`);
  assert.deepEqual(rows.rows.map((r) => r.proposal_id), ['p_executed', 'p_failed', 'p_settled', 'p_submitted']);
  assert.ok(rows.rows.every((r) => r.consumed_by === 'backfill'));
  assert.equal(new Date(rows.rows[0].consumed_at).toISOString(), '2026-09-01T00:00:00.000Z', 'when it executed, where known');
  await client.close();
});

test('the spend row: true exactly once, however many ask at once', async () => {
  const { client, db } = await migratedDb();
  const spend = (consumedBy) => consumeApprovalRecord(db, { proposalId: 'prop_row', orgId: 'acme', consumedBy });
  const results = await Promise.all([spend('batches/authorize'), spend('transfers/authorize'), spend('execution')]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(await spend('batches/authorize'), false);

  const row = await client.query(`SELECT consumed_by FROM consumed_approvals WHERE proposal_id = 'prop_row'`);
  assert.equal(row.rows.length, 1);
  // Scoped to a real org: a spend cannot be recorded against nobody.
  await assert.rejects(consumeApprovalRecord(db, { proposalId: 'prop_x', orgId: 'no_such_org', consumedBy: 'execution' }));
  await client.close();
});

test('two processes, one approval: the second is refused by the row, whatever its own copy says', async () => {
  const { client, db } = await migratedDb();
  await withDatabase(db, async () => {
    const payload = approvedBatchPayload();
    // Process A writes its proposals through; process B holds its own copy of
    // the same approved proposal.
    const processA = new InMemoryProposalStore((p) => upsertProposal(db, p));
    const processB = new InMemoryProposalStore((p) => upsertProposal(db, p));
    approvedProposal(processA, { payload, id: 'prop_shared' });
    approvedProposal(processB, { payload, id: 'prop_shared' });
    await processA.flush();
    await processB.flush();

    globalThis.oxwalProposalStore = processA;
    const inA = await resolveApprovalClaim(claimRequest('prop_shared'), 'acme', batchScope(batchBody()));
    assert.equal(inA.approved, true);

    // B's copy has no mark, and B writing its copy through changes nothing.
    processB.recordExecution('prop_shared', { state: 'FAILED', detail: 'stale', at: new Date().toISOString() });
    await processB.flush();
    globalThis.oxwalProposalStore = processB;
    const inB = await resolveApprovalClaim(claimRequest('prop_shared'), 'acme', batchScope(batchBody()));
    assert.equal(inB.approved, false);
    assert.equal(inB.reason, 'already used');

    const row = await client.query(`SELECT consumed_by FROM consumed_approvals WHERE proposal_id = 'prop_shared'`);
    assert.deepEqual(row.rows, [{ consumed_by: 'batches/authorize' }]);
  });
  await client.close();
});

test('a spend the database cannot record is refused, and closing never throws', async () => {
  const down = () => {
    throw new Error('connection refused');
  };
  await withDatabase({ select: down, insert: down }, async () => {
    const store = freshStore();
    const proposal = approvedProposal(store, { payload: approvedBatchPayload() });
    const claim = await resolveApprovalClaim(claimRequest(proposal.id), 'acme', batchScope(batchBody()));
    assert.equal(claim.approved, false);
    assert.equal(claim.reason, 'the spend could not be recorded');
    await closeApprovalClaim(proposal.id, 'acme');
  });
});

// ── Every route that honours the claim binds it ─────────────────────────────

function code(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
}

async function source(file) {
  return code(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'));
}

test('each money route names the kind it makes and what an approval of it covers', async () => {
  const expected = {
    'app/api/batches/authorize/route.ts': /resolveApprovalClaim\(request, orgId, \{\s*kind: 'BATCH_PAYOUT',\s*substance: batchPayoutSubstance,\s*body,/,
    'app/api/transfers/authorize/route.ts': /resolveApprovalClaim\(request, orgId, \{\s*kind: 'PAYMENT',\s*substance: fiatPaymentSubstance,\s*body: rawBody/,
    'app/api/treasury/route.ts': /resolveApprovalClaim\(request, orgId, \{\s*kind: treasuryProposalKind\(action\),\s*substance: treasuryMoveSubstance,\s*body,/,
  };
  for (const [file, pattern] of Object.entries(expected)) {
    const route = await source(file);
    assert.match(route, pattern, `${file} must bind the claim to its own payment`);
    assert.equal(route.match(/resolveApprovalClaim\(/g).length, 1, `${file} resolves the claim once`);
    assert.match(route, /limits\.requiresSecondApproval && !approvalClaim\.approved/);
  }
});

test('the batch route pays exactly the rows the binding covers', async () => {
  const route = await source('app/api/batches/authorize/route.ts');
  assert.match(route, /const acceptedRows = payableBatchRows\(rows\);/);
  assert.match(route, /const targetCurrency = batchTargetCurrency\(body\);/);
  assert.match(route, /payload: \{ rows: acceptedRows, targetCurrency \}/);
  assert.match(
    route,
    /recordBatchSettlementOnSui\(\{\s*batchId: batch\.id,\s*rows: acceptedRows,/,
    'settlement is handed the same rows',
  );
});

test('the replay closes what it presented, whatever the route did', async () => {
  const replay = await source('lib/server/approval-replay.ts');
  assert.match(replay, /finally \{\s*await closeApprovalClaim\(input\.approvedProposalId, input\.orgId\);\s*\}/);
  assert.match(replay, /return replayThroughRoute\(POST, '\/api\/transfers\/authorize', input\)/);
  assert.match(replay, /return replayThroughRoute\(POST, '\/api\/batches\/authorize', input\)/);
  assert.match(replay, /return replayThroughRoute\(POST, '\/api\/treasury', input\)/);

  // And the executor closes the ones no route saw: a Phase 0 treasury SKIP, a
  // failure before the replay ran.
  const execution = await source('lib/server/approval-execution.ts');
  assert.match(execution, /finally \{[\s\S]*?await closeApprovalClaim\(proposal\.id, proposal\.orgId\);\s*\}/);
});
