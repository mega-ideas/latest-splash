import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

import * as schema from '../lib/db/schema.ts';
import {
  consumeApprovalRecord,
  loadApprovalSpends,
  loadOpenProposals,
  loadSavedStates,
  upsertProposal,
} from '../lib/db/proposal-repo.ts';
import { ensureProposalStoreHydrated } from '../lib/queue/proposal-persistence.ts';
import { InMemoryProposalStore } from '../lib/queue/proposal-state.ts';
import {
  STUCK_AFTER_MS,
  classifySpend,
  isStuckSubmission,
  savedOutcome,
  stuckFrom,
  stuckPaymentItem,
} from '../lib/queue/stuck-payments.ts';
import {
  findingText,
  interpretReconcileResponse,
  leavesLane,
  outcomesAllowed,
  reconcilePath,
  reconcileRequestBody,
  recordsShowNotSent,
  whereToCheck,
} from '../lib/queue/stuck-payment-view.ts';
import {
  findStuckPayments,
  liveSpendRecorder,
  liveStuckRecords,
  reconcileStuckPayment,
} from '../lib/server/stuck-payments.ts';
import { resolveApprovalClaim } from '../lib/server/approved-proposal.ts';
import { fiatPaymentSubstance } from '../lib/server/step-up-subjects.ts';

/**
 * Approved payments whose outcome nobody recorded.
 *
 * Carrying out an approval is SUBMIT, then the payment route's replay, then
 * recording what happened. A process that stops between the last two leaves
 * the proposal SUBMITTED with no outcome: the payment may have gone or not, it
 * holds its payment's idempotency key, and no lane of /queue showed it. Now the
 * queue lists it with what the records show, and an approver records whether
 * it went, which frees the payment or closes it.
 */

// The in-process tests run without a database; the Postgres ones set one up
// and put this back.
delete process.env.DATABASE_URL;

const MINUTE = 60 * 1000;
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();

/** A single payout as the transfer route stores it. */
function payoutBody() {
  return {
    recipient: { name: 'Manila Parts Supply', country: 'PH', bank: { swift: 'BOPIPHMM', account: '001234567890' } },
    amount: { value: '25000', targetCurrency: 'PHP' },
    deliveryTier: 'PAYOUT_ONLY',
    fundingSelection: { source: 'SPLASH_BALANCE', type: 'held', feeTier: 'DISCOUNT' },
  };
}

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
    expiresAt: iso(NOW + 24 * 60 * MINUTE),
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
    executionPayload: payoutBody(),
    ...overrides,
  };
}

/** A store whose clock the test turns. */
function clockedStore(onWrite) {
  const clock = { now: NOW };
  return { store: new InMemoryProposalStore(onWrite, { now: () => clock.now }), clock };
}

/** Two checkers approve, one signs, and it goes to the payment route. */
function submit(store, id) {
  store.transition(id, { type: 'POLICY_EVALUATED', requiredApprovers: 2 });
  store.transition(id, { type: 'QUEUE_FOR_APPROVAL' });
  store.transition(id, { type: 'APPROVE', approval: { userId: 'usr_priya', role: 'APPROVER', signedAt: iso(NOW) } });
  store.transition(id, { type: 'APPROVE', approval: { userId: 'usr_nadia', role: 'OWNER', signedAt: iso(NOW) } });
  store.transition(id, { type: 'SIGN', signatureRef: 'sig_test', signedBy: 'usr_nadia', policyAuthorized: true, signedAt: iso(NOW) });
  return store.transition(id, { type: 'SUBMIT' });
}

const priya = { orgId: 'acme', userId: 'usr_priya', role: 'APPROVER' };
/** The maker holds an approving role too: it is who they are on this payment that bars them. */
const maker = { orgId: 'acme', userId: 'usr_maker', role: 'FINANCE_ADMIN' };
const tom = { orgId: 'acme', userId: 'usr_tom', role: 'VIEWER' };

/** A payment submitted at NOW, and a clock already past the time it could still be sending. */
function stuckStore(overrides = {}) {
  const { store, clock } = clockedStore();
  store.create(proposal('stuck', { idempotencyKey: 'transfer:acme:same', ...overrides }));
  submit(store, 'stuck');
  clock.now = NOW + STUCK_AFTER_MS + MINUTE;
  return { store, clock };
}

/** No saved rows: one process, whose store is the record. */
const nothingSaved = async () => new Map();

function fakeDeps(store, clock, { spend = null, recordSpend, readSpends, readSaved } = {}) {
  const spent = [];
  return {
    spent,
    deps: {
      store,
      readSpends: readSpends ?? (async (ids) => new Map(ids.map((id) => [id, spend]))),
      readSaved: readSaved ?? nothingSaved,
      recordSpend:
        recordSpend ??
        (async (p) => {
          spent.push(p.id);
          return true;
        }),
      now: () => new Date(clock.now),
    },
  };
}

// ── When it went to the payment route ───────────────────────────────────────

test('the store stamps when a proposal went to the payment route, on its own clock', () => {
  const { store, clock } = clockedStore();
  store.create(proposal('p1'));
  clock.now = NOW + 5 * MINUTE;
  assert.equal(submit(store, 'p1').submittedAt, iso(NOW + 5 * MINUTE));

  // Nothing before SUBMIT stamps it.
  store.create(proposal('p2', { idempotencyKey: 'k2' }));
  store.transition('p2', { type: 'POLICY_EVALUATED', requiredApprovers: 2 });
  assert.equal(store.get('p2').submittedAt, undefined);
});

test('stuck means SUBMITTED, no outcome, and past the time any request could still be sending it', () => {
  const base = { status: 'SUBMITTED', submittedAt: iso(NOW - 11 * MINUTE) };
  assert.equal(isStuckSubmission(base, NOW), true);
  assert.equal(isStuckSubmission({ ...base, submittedAt: iso(NOW - 5 * MINUTE) }, NOW), false, 'it may still be going');
  assert.equal(isStuckSubmission({ ...base, submittedAt: iso(NOW - STUCK_AFTER_MS) }, NOW), false, 'the margin itself');
  assert.equal(isStuckSubmission({ status: 'SUBMITTED' }, NOW), true, 'submitted before times were recorded');
  assert.equal(isStuckSubmission({ ...base, execution: { state: 'FAILED', detail: 'x', at: iso(NOW) } }, NOW), false, 'an outcome is on it');
  for (const status of ['APPROVED', 'SIGNED', 'SETTLED', 'REJECTED', 'EXPIRED']) {
    assert.equal(isStuckSubmission({ ...base, status }, NOW), false, status);
  }
});

test('a route that took the approval up in the last ten minutes may still be paying, whenever the proposal says it went', () => {
  const routeAt = (ms) => ({ kind: 'route-used', route: 'transfers/authorize', at: iso(ms) });
  const long = { status: 'SUBMITTED', submittedAt: iso(NOW - 30 * MINUTE) };
  assert.equal(isStuckSubmission(long, NOW, routeAt(NOW - 3 * MINUTE)), false, 'the route took it up three minutes ago');
  assert.equal(isStuckSubmission(long, NOW, routeAt(NOW - 11 * MINUTE)), true);
  assert.equal(stuckFrom(long, routeAt(NOW - 3 * MINUTE)), NOW - 3 * MINUTE + STUCK_AFTER_MS, 'the later of the two');
  assert.equal(stuckFrom(long), NOW - 30 * MINUTE + STUCK_AFTER_MS);

  // Submitted by code from before submission times were recorded (drizzle/0026),
  // during a rolling deploy: the route's time is the only one on record.
  const untimed = { status: 'SUBMITTED' };
  assert.equal(isStuckSubmission(untimed, NOW, routeAt(NOW - 2 * MINUTE)), false);
  assert.equal(isStuckSubmission(untimed, NOW, routeAt(NOW - 11 * MINUTE)), true);
  assert.equal(stuckFrom(untimed), null);

  // Nothing else is a route at work: no spend, a closed approval, the backfill.
  const recent = iso(NOW - MINUTE);
  for (const evidence of [
    { kind: 'never-used' },
    { kind: 'closed-unused', at: recent },
    { kind: 'backfilled', at: recent },
    { kind: 'unreadable' },
  ]) {
    assert.equal(isStuckSubmission(untimed, NOW, evidence), true, evidence.kind);
    assert.equal(isStuckSubmission({ status: 'SUBMITTED', submittedAt: iso(NOW - 11 * MINUTE) }, NOW, evidence), true, evidence.kind);
  }
});

test('the saved row says when a payment is finished, whatever this process’s copy says', () => {
  const row = (status, executionState = null, executionError = null) => ({ status, executionState, executionError });
  assert.equal(savedOutcome(undefined), null, 'nothing saved');
  assert.equal(savedOutcome(row('SUBMITTED')), null, 'still waiting for an outcome');
  assert.equal(savedOutcome(row('SUBMITTED', 'EXECUTED')), 'sent');
  assert.equal(savedOutcome(row('SUBMITTED', 'FAILED', 'The recipient bank refused it.')), 'not sent (The recipient bank refused it.)');
  assert.equal(savedOutcome(row('SUBMITTED', 'FAILED')), 'not sent');
  assert.equal(savedOutcome(row('SUBMITTED', 'SKIPPED')), 'nothing sent');
  assert.equal(savedOutcome(row('SETTLED')), 'settled');
});

// ── What the records show ───────────────────────────────────────────────────

test("an approval's spend says whether the route could have paid with it, and what an approver may record", () => {
  const at = iso(NOW - 20 * MINUTE);
  const cases = [
    [null, 'never-used', ['NOT_SENT'], true],
    [{ consumedBy: 'execution', consumedAt: at }, 'closed-unused', ['NOT_SENT'], true],
    [{ consumedBy: 'reconciliation', consumedAt: at }, 'closed-unused', ['NOT_SENT'], true],
    [{ consumedBy: 'transfers/authorize', consumedAt: at }, 'route-used', ['SENT', 'NOT_SENT'], false],
    [{ consumedBy: 'batches/authorize', consumedAt: at }, 'route-used', ['SENT', 'NOT_SENT'], false],
    [{ consumedBy: 'treasury', consumedAt: at }, 'route-used', ['SENT', 'NOT_SENT'], false],
    [{ consumedBy: 'backfill', consumedAt: at }, 'backfilled', ['SENT', 'NOT_SENT'], false],
  ];
  for (const [spend, kind, allowed, settled] of cases) {
    const evidence = classifySpend(spend);
    const label = spend?.consumedBy ?? 'no spend';
    assert.equal(evidence.kind, kind, label);
    assert.deepEqual(outcomesAllowed(evidence), allowed, label);
    assert.equal(recordsShowNotSent(evidence), settled, label);
  }
  assert.equal(classifySpend({ consumedBy: 'transfers/authorize', consumedAt: at }).route, 'transfers/authorize');
  assert.deepEqual(outcomesAllowed({ kind: 'unreadable' }), [], 'no answer without the records');

  assert.equal(findingText({ kind: 'never-used' }, String), 'The payment route never used this approval, so nothing was sent.');
  assert.equal(
    findingText({ kind: 'route-used', route: 'transfers/authorize', at }, () => '14:02 UTC on 25 Sep'),
    'The payment route accepted this approval at 14:02 UTC on 25 Sep. Whether it then paid is not on record.',
  );
});

test('a lane row says what happened, where to look, and whether this viewer may answer', () => {
  const now = new Date(NOW);
  const submitted = { ...proposal('p'), status: 'SUBMITTED', submittedAt: iso(NOW - (3 * 60 + 12) * MINUTE) };
  const routeUsed = { kind: 'route-used', route: 'transfers/authorize', at: iso(NOW - 3 * 60 * MINUTE) };

  const row = stuckPaymentItem(submitted, routeUsed, priya, now);
  assert.equal(row.waitingLabel, 'Sent for payment 3h 12m ago');
  assert.equal(row.amountLabel, 'USD 25,000.00');
  assert.deepEqual(row.outcomes, ['SENT', 'NOT_SENT']);
  assert.deepEqual(row.checkHint, { label: 'Check payment history', href: '/dashboard/history' });
  assert.equal(row.blockedReason, null);
  assert.doesNotThrow(() => JSON.stringify(row), 'it crosses to the browser: no bigint, no Date');

  // Settled by the records: nothing to go and check.
  const never = stuckPaymentItem(submitted, { kind: 'never-used' }, priya, now);
  assert.equal(never.checkHint, null);
  assert.deepEqual(never.outcomes, ['NOT_SENT']);

  assert.equal(
    stuckPaymentItem(submitted, routeUsed, maker, now).blockedReason,
    'You requested this payment, so another approver records what happened.',
  );
  assert.equal(stuckPaymentItem(submitted, routeUsed, tom, now).blockedReason, 'Only an approver can record what happened.');

  assert.deepEqual(whereToCheck('BATCH_PAYOUT'), { label: 'Check payroll runs', href: '/dashboard/batch' });
  assert.deepEqual(whereToCheck('TREASURY_REDEEM'), { label: 'Check Smart Treasury', href: '/dashboard/treasury' });
  assert.equal(whereToCheck('X402_PAYMENT'), null);
});

test("the lane reads the reconcile route's answers for what they are", () => {
  assert.deepEqual(interpretReconcileResponse(200, {}, 'NOT_SENT'), {
    kind: 'recorded',
    outcome: 'NOT_SENT',
    message: 'Recorded as not sent. The payment can be requested again, and it will need new approvals.',
  });
  assert.equal(interpretReconcileResponse(200, {}, 'SENT').message, 'Recorded as sent. It is closed, and nothing more will be sent.');
  assert.deepEqual(interpretReconcileResponse(409, { code: 'PROPOSAL_CLOSED', error: 'Already recorded.' }, 'SENT'), {
    kind: 'closed',
    message: 'Already recorded.',
  });
  assert.equal(interpretReconcileResponse(409, { code: 'STILL_SENDING', error: 'Wait.' }, 'SENT').kind, 'still-sending');
  assert.deepEqual(interpretReconcileResponse(409, { code: 'NEVER_REACHED_ROUTE', error: 'Not by this approval.' }, 'SENT'), {
    kind: 'refused',
    message: 'Not by this approval.',
  });
  assert.equal(interpretReconcileResponse(404, {}, 'SENT').message, 'This payment is no longer available to you.');
  assert.equal(interpretReconcileResponse(401, null, 'SENT').kind, 'signed-out');
  assert.equal(interpretReconcileResponse(0, null, 'NOT_SENT').kind, 'unreachable', 'no answer is not a refusal');

  assert.equal(leavesLane({ kind: 'recorded' }), true);
  assert.equal(leavesLane({ kind: 'closed' }), true);
  assert.equal(leavesLane({ kind: 'refused' }), false);
  assert.equal(leavesLane({ kind: 'unreachable' }), false);

  assert.deepEqual(reconcileRequestBody('SENT', '  tr_123 '), { outcome: 'SENT', reference: 'tr_123' });
  assert.deepEqual(reconcileRequestBody('NOT_SENT', 'tr_123'), { outcome: 'NOT_SENT' }, 'a reference only means something for a payment that went');
  assert.equal(reconcilePath('prop 1'), '/api/proposals/prop%201/reconcile');
});

// ── Recording what happened ─────────────────────────────────────────────────

test('not sent, where the route never used the approval: spent first, recorded, and the payment can be requested again', async () => {
  const { store, clock } = stuckStore();
  const { deps, spent } = fakeDeps(store, clock);
  const answer = await reconcileStuckPayment(deps, { proposalId: 'stuck', actor: priya, outcome: 'NOT_SENT' });

  assert.equal(answer.status, 200);
  assert.equal(answer.body.execution.state, 'FAILED');
  assert.equal(
    answer.body.execution.detail,
    'Recorded as not sent by usr_priya, after its outcome went missing. The payment route never used this approval, so nothing was sent.',
  );
  assert.deepEqual(spent, ['stuck'], 'the approval is spent before the outcome is recorded');
  assert.equal(store.get('stuck').execution.state, 'FAILED');

  // Its key is free: the same payment requested again is a new proposal.
  assert.equal(store.create(proposal('again', { idempotencyKey: 'transfer:acme:same' })).id, 'again');
});

test('sent, where a route used the approval: recorded with its reference', async () => {
  const { store, clock } = stuckStore();
  // The route took it up as it was submitted, eleven minutes ago.
  const at = iso(NOW);
  const { deps } = fakeDeps(store, clock, { spend: { consumedBy: 'transfers/authorize', consumedAt: at } });
  const answer = await reconcileStuckPayment(deps, { proposalId: 'stuck', actor: priya, outcome: 'SENT', reference: ' tr_8812 ' });

  assert.equal(answer.status, 200);
  assert.equal(answer.body.execution.state, 'EXECUTED');
  assert.equal(answer.body.execution.ref, 'tr_8812');
  assert.equal(
    answer.body.execution.detail,
    `Recorded as sent by usr_priya, reference tr_8812, after its outcome went missing. The payment route accepted this approval at ${at}. Whether it then paid is not on record.`,
  );
});

test('sent is refused when the route never used the approval, and nothing is spent or recorded', async () => {
  const { store, clock } = stuckStore();
  const { deps, spent } = fakeDeps(store, clock);
  const answer = await reconcileStuckPayment(deps, { proposalId: 'stuck', actor: priya, outcome: 'SENT' });
  assert.equal(answer.status, 409);
  assert.equal(answer.body.code, 'NEVER_REACHED_ROUTE');
  assert.deepEqual(spent, []);
  assert.equal(store.get('stuck').execution, undefined);
});

test('only an approver in the payment’s org who did not request it may answer', async () => {
  for (const [actor, status, code] of [
    [{ ...priya, orgId: 'northwind' }, 404, 'NOT_FOUND'],
    [tom, 403, 'NOT_AN_APPROVER'],
    [maker, 403, 'MAKER'],
  ]) {
    const { store, clock } = stuckStore();
    const { deps, spent } = fakeDeps(store, clock);
    const answer = await reconcileStuckPayment(deps, { proposalId: 'stuck', actor, outcome: 'NOT_SENT' });
    assert.equal(answer.status, status, code);
    assert.equal(answer.body.code, code);
    assert.deepEqual(spent, [], `${code}: nothing spent`);
    assert.equal(store.get('stuck').execution, undefined, `${code}: nothing recorded`);
  }
});

test('a payment that may still be going, or already has an outcome, is not reconciled', async () => {
  // Five minutes after it went: the request carrying it may still be running.
  const early = stuckStore();
  early.clock.now = NOW + 5 * MINUTE;
  const tooEarly = await reconcileStuckPayment(fakeDeps(early.store, early.clock).deps, {
    proposalId: 'stuck',
    actor: priya,
    outcome: 'NOT_SENT',
  });
  assert.equal(tooEarly.status, 409);
  assert.equal(tooEarly.body.code, 'STILL_SENDING');
  assert.match(tooEarly.body.error, /Check again in 5 minutes\./);

  const done = stuckStore();
  done.store.recordExecution('stuck', { state: 'EXECUTED', detail: 'Payment sent.', at: iso(NOW) });
  const closed = await reconcileStuckPayment(fakeDeps(done.store, done.clock).deps, {
    proposalId: 'stuck',
    actor: priya,
    outcome: 'NOT_SENT',
  });
  assert.equal(closed.status, 409);
  assert.equal(closed.body.code, 'PROPOSAL_CLOSED');
  assert.equal(done.store.get('stuck').execution.detail, 'Payment sent.', 'the recorded outcome stands');

  // Never sent for payment at all.
  const { store, clock } = clockedStore();
  store.create(proposal('pending'));
  clock.now = NOW + STUCK_AFTER_MS + MINUTE;
  const pending = await reconcileStuckPayment(fakeDeps(store, clock).deps, { proposalId: 'pending', actor: priya, outcome: 'NOT_SENT' });
  assert.equal(pending.status, 409);
  assert.equal(pending.body.code, 'PROPOSAL_CLOSED');
});

test('nothing is recorded when the approval cannot be spent, or its spend cannot be read', async () => {
  const unspendable = stuckStore();
  const refusedSpend = await reconcileStuckPayment(
    fakeDeps(unspendable.store, unspendable.clock, {
      recordSpend: async () => {
        throw new Error('connection refused');
      },
    }).deps,
    { proposalId: 'stuck', actor: priya, outcome: 'NOT_SENT' },
  );
  assert.equal(refusedSpend.status, 503);
  assert.equal(refusedSpend.body.code, 'SPEND_NOT_RECORDED');
  assert.equal(unspendable.store.get('stuck').execution, undefined);

  const unreadable = stuckStore();
  const refusedRead = await reconcileStuckPayment(
    fakeDeps(unreadable.store, unreadable.clock, {
      readSpends: async () => {
        throw new Error('connection refused');
      },
    }).deps,
    { proposalId: 'stuck', actor: priya, outcome: 'NOT_SENT' },
  );
  assert.equal(refusedRead.status, 503);
  assert.equal(refusedRead.body.code, 'RECORDS_UNREADABLE');
  assert.equal(unreadable.store.get('stuck').execution, undefined);
});

test('an outcome recorded while the approver was deciding wins', async () => {
  const { store, clock } = stuckStore();
  const { deps } = fakeDeps(store, clock, {
    recordSpend: async (p) => {
      // Another request records the outcome during the spend.
      store.recordExecution(p.id, { state: 'EXECUTED', detail: 'Payment sent.', at: iso(NOW) });
      return false;
    },
  });
  const answer = await reconcileStuckPayment(deps, { proposalId: 'stuck', actor: priya, outcome: 'NOT_SENT' });
  assert.equal(answer.status, 409);
  assert.equal(answer.body.code, 'PROPOSAL_CLOSED');
  assert.equal(store.get('stuck').execution.detail, 'Payment sent.');
});

test('a payment a route took up in the last ten minutes is not reconciled, and nothing is spent', async () => {
  // Submitted eleven minutes ago; the transfer route took its approval up three minutes ago.
  const { store, clock } = stuckStore();
  const { deps, spent } = fakeDeps(store, clock, {
    spend: { consumedBy: 'transfers/authorize', consumedAt: iso(clock.now - 3 * MINUTE) },
  });
  const answer = await reconcileStuckPayment(deps, { proposalId: 'stuck', actor: priya, outcome: 'NOT_SENT' });
  assert.equal(answer.status, 409);
  assert.equal(answer.body.code, 'STILL_SENDING');
  assert.match(answer.body.error, /Check again in 7 minutes\./);
  assert.deepEqual(spent, []);
  assert.equal(store.get('stuck').execution, undefined);
});

test('an outcome another process saved is not overwritten, and the refusal says what it was', async () => {
  // This process's copy has it SUBMITTED with no outcome; the saved row says it went.
  const { store, clock } = stuckStore();
  const asked = [];
  const { deps } = fakeDeps(store, clock, {
    spend: { consumedBy: 'transfers/authorize', consumedAt: iso(NOW) },
    readSaved: async (orgId, ids) => {
      asked.push([orgId, ids]);
      return new Map([['stuck', { status: 'SUBMITTED', executionState: 'EXECUTED', executionError: null }]]);
    },
  });
  const answer = await reconcileStuckPayment(deps, { proposalId: 'stuck', actor: priya, outcome: 'NOT_SENT' });
  assert.equal(answer.status, 409);
  assert.equal(answer.body.code, 'PROPOSAL_CLOSED');
  assert.equal(answer.body.error, 'An outcome for this payment is already on record: sent. Nothing was changed.');
  assert.deepEqual(asked, [['acme', ['stuck']]], 'read within the approver’s org');
  assert.equal(store.get('stuck').execution, undefined, 'nothing recorded from the copy');
  const shown = interpretReconcileResponse(answer.status, answer.body, 'NOT_SENT');
  assert.equal(shown.kind, 'closed');
  assert.equal(shown.message, answer.body.error, 'the lane shows what is on record');

  // A saved row that cannot be read stops it too.
  const blind = stuckStore();
  const unreadable = await reconcileStuckPayment(
    fakeDeps(blind.store, blind.clock, {
      readSaved: async () => {
        throw new Error('connection refused');
      },
    }).deps,
    { proposalId: 'stuck', actor: priya, outcome: 'NOT_SENT' },
  );
  assert.equal(unreadable.status, 503);
  assert.equal(unreadable.body.code, 'RECORDS_UNREADABLE');
  assert.equal(blind.store.get('stuck').execution, undefined);
});

test('the lane lists the org’s stuck payments, oldest first, and never guesses when the records cannot be read', async () => {
  const { store, clock } = clockedStore();
  for (const [id, orgId, at] of [
    ['p_newer', 'acme', NOW + 2 * MINUTE],
    ['p_older', 'acme', NOW],
    ['p_theirs', 'northwind', NOW],
    ['p_recent', 'acme', NOW + 30 * MINUTE],
  ]) {
    store.create(proposal(id, { idempotencyKey: `k_${id}`, orgId }));
    clock.now = at;
    submit(store, id);
  }
  store.create(proposal('p_pending', { idempotencyKey: 'k_pending' }));
  clock.now = NOW + 35 * MINUTE;

  const spends = new Map([['p_newer', { consumedBy: 'transfers/authorize', consumedAt: iso(NOW + 2 * MINUTE) }]]);
  const found = await findStuckPayments(store, 'acme', new Date(clock.now), {
    readSpends: async (ids) => new Map(ids.map((id) => [id, spends.get(id) ?? null])),
    readSaved: nothingSaved,
  });
  assert.deepEqual(
    found.map(({ proposal: p, evidence }) => [p.id, evidence.kind]),
    [
      ['p_older', 'never-used'],
      ['p_newer', 'route-used'],
    ],
    'the one sent five minutes ago may still be going; the pending one was never sent; another org’s is not listed',
  );

  const blind = await findStuckPayments(store, 'acme', new Date(clock.now), {
    readSpends: async () => {
      throw new Error('connection refused');
    },
    readSaved: nothingSaved,
  });
  assert.deepEqual(blind.map(({ evidence }) => evidence.kind), ['unreadable', 'unreadable']);
  assert.deepEqual(outcomesAllowed(blind[0].evidence), [], 'no answer is offered without the records');
});

test('the lane leaves out a payment finished in its saved row, or taken up by a route in the last ten minutes', async () => {
  const { store, clock } = clockedStore();
  for (const id of ['p_saved', 'p_busy', 'p_stuck']) {
    store.create(proposal(id, { idempotencyKey: `k_${id}` }));
    submit(store, id);
  }
  clock.now = NOW + 30 * MINUTE;
  const asked = [];
  const records = {
    readSpends: async (ids) =>
      new Map(ids.map((id) => [id, id === 'p_busy' ? { consumedBy: 'transfers/authorize', consumedAt: iso(clock.now - 4 * MINUTE) } : null])),
    readSaved: async (orgId, ids) => {
      asked.push(orgId);
      const saved = { status: 'SUBMITTED', executionState: 'EXECUTED', executionError: null };
      return new Map(ids.filter((id) => id === 'p_saved').map((id) => [id, saved]));
    },
  };
  const found = await findStuckPayments(store, 'acme', new Date(clock.now), records);
  assert.deepEqual(found.map(({ proposal: p }) => p.id), ['p_stuck']);
  assert.deepEqual(asked, ['acme']);

  // Without the saved rows, no answer is offered: this copy may be out of date.
  const blind = await findStuckPayments(store, 'acme', new Date(clock.now), {
    ...records,
    readSaved: async () => {
      throw new Error('connection refused');
    },
  });
  assert.deepEqual(blind.map(({ proposal: p, evidence }) => [p.id, evidence.kind]), [
    ['p_saved', 'unreadable'],
    ['p_busy', 'unreadable'],
    ['p_stuck', 'unreadable'],
  ]);
});

test('once recorded, the approval cannot be presented again', async () => {
  const { store, clock } = stuckStore();
  globalThis.oxwalProposalStore = store;
  const answer = await reconcileStuckPayment(
    {
      store,
      ...liveStuckRecords(store),
      recordSpend: liveSpendRecorder(store, () => new Date(clock.now)),
      now: () => new Date(clock.now),
    },
    { proposalId: 'stuck', actor: priya, outcome: 'NOT_SENT' },
  );
  assert.equal(answer.status, 200);

  const claim = await resolveApprovalClaim(
    new Request('http://splash.test/api/transfers/authorize', {
      method: 'POST',
      headers: { 'x-splash-approved-proposal': 'stuck' },
    }),
    'acme',
    { kind: 'PAYMENT', substance: fiatPaymentSubstance, body: payoutBody(), consumer: 'transfers/authorize' },
  );
  assert.equal(claim.approved, false);
  assert.equal(claim.reason, 'already used');
});

// ── Postgres ────────────────────────────────────────────────────────────────

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
  process.env.DATABASE_URL = 'postgres://pglite.invalid/stuck-payments';
  globalThis.splashDb = { pool: { end: async () => {} }, db };
  try {
    await run();
  } finally {
    delete globalThis.splashDb;
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
}

test('the migration records when payments already submitted went to the route', async () => {
  const { client } = await migratedDb((file) => file < '0026');
  await client.exec(`
    INSERT INTO proposals (id, org_id, idempotency_key, kind, status, tier, created_by, explain, updated_at)
    VALUES
      ('p_submitted', 'acme', 'k1', 'PAYMENT', 'SUBMITTED', 'TIER_0_PROPOSE', 'usr_maker', '{}', '2026-09-20T08:00:00Z'),
      ('p_pending', 'acme', 'k2', 'PAYMENT', 'PENDING_APPROVAL', 'TIER_0_PROPOSE', 'usr_maker', '{}', '2026-09-20T08:00:00Z');
  `);
  await applyMigrations(client, (file) => file.startsWith('0026'));
  const { rows } = await client.query(`SELECT id, submitted_at FROM proposals ORDER BY id`);
  assert.deepEqual(
    rows.map((row) => [row.id, row.submitted_at ? new Date(row.submitted_at).toISOString() : null]),
    [
      ['p_pending', null],
      ['p_submitted', '2026-09-20T08:00:00.000Z'],
    ],
  );
  await client.close();
});

test('a stuck payment survives a restart, is found with its evidence, and is reconciled in Postgres', async () => {
  const { client, db } = await migratedDb();
  await withDatabase(db, async () => {
    const writer = (p) => upsertProposal(db, p);

    // Process A: two approved payments go to the payment route. The transfer
    // route spends the first approval at its claim check; the second never
    // reaches the route. Then the process stops, before any outcome is saved.
    const a = clockedStore(writer);
    a.store.create(proposal('p_route', { idempotencyKey: 'transfer:acme:route' }));
    submit(a.store, 'p_route');
    await consumeApprovalRecord(db, { proposalId: 'p_route', orgId: 'acme', consumedBy: 'transfers/authorize', consumedAt: new Date(NOW) });
    a.clock.now = NOW + MINUTE;
    a.store.create(proposal('p_never', { idempotencyKey: 'transfer:acme:never' }));
    submit(a.store, 'p_never');
    await a.store.flush();

    // Process B boots eleven minutes later.
    const b = clockedStore(writer);
    b.clock.now = NOW + STUCK_AFTER_MS + 2 * MINUTE;
    assert.equal(await ensureProposalStoreHydrated(b.store), true);
    assert.equal(b.store.get('p_route').submittedAt, iso(NOW), 'when it went, from Postgres');
    const found = await findStuckPayments(b.store, 'acme', new Date(b.clock.now), liveStuckRecords(b.store));
    assert.deepEqual(found.map(({ proposal: p, evidence }) => [p.id, evidence.kind]), [
      ['p_route', 'route-used'],
      ['p_never', 'never-used'],
    ]);
    assert.equal(found[0].evidence.route, 'transfers/authorize');
    assert.deepEqual(await findStuckPayments(b.store, 'northwind', new Date(b.clock.now), liveStuckRecords(b.store)), []);

    const deps = {
      store: b.store,
      ...liveStuckRecords(b.store),
      recordSpend: liveSpendRecorder(b.store, () => new Date(b.clock.now)),
      now: () => new Date(b.clock.now),
    };

    // Nothing was sent with the second: closed as not sent, and its spend recorded.
    const notSent = await reconcileStuckPayment(deps, { proposalId: 'p_never', actor: priya, outcome: 'NOT_SENT' });
    assert.equal(notSent.status, 200, notSent.body.error);
    // The first did go, the approver found: its route's spend stands.
    const sent = await reconcileStuckPayment(deps, { proposalId: 'p_route', actor: priya, outcome: 'SENT', reference: 'tr_8812' });
    assert.equal(sent.status, 200, sent.body.error);
    await b.store.flush();

    const spends = await loadApprovalSpends(db, ['p_never', 'p_route']);
    assert.equal(spends.get('p_never').consumedBy, 'reconciliation');
    assert.equal(spends.get('p_route').consumedBy, 'transfers/authorize', 'an existing spend is the same guarantee');
    const { rows } = await client.query(`SELECT id, status, execution_state FROM proposals ORDER BY id`);
    assert.deepEqual(rows.map((row) => [row.id, row.status, row.execution_state]), [
      ['p_never', 'SUBMITTED', 'FAILED'],
      ['p_route', 'SUBMITTED', 'EXECUTED'],
    ]);

    // Finished: not loaded after another restart, and the payment not sent can
    // be requested again, stored under the same key.
    assert.deepEqual((await loadOpenProposals(db)).map((p) => p.id), []);
    const c = new InMemoryProposalStore(writer);
    c.create(proposal('p_again', { idempotencyKey: 'transfer:acme:never' }));
    await c.flush();
    assert.equal(await c.writeFailed('p_again'), false);
  });
  await client.close();
});

/** Reconcile in `side`'s process, against the database. */
function liveDeps(side) {
  return {
    store: side.store,
    ...liveStuckRecords(side.store),
    recordSpend: liveSpendRecorder(side.store, () => new Date(side.clock.now)),
    now: () => new Date(side.clock.now),
  };
}

test('a process whose copy is out of date neither lists nor overwrites an outcome another process saved', async () => {
  const { client, db } = await migratedDb();
  await withDatabase(db, async () => {
    const writer = (p) => upsertProposal(db, p);

    // Process A sends a payment: it goes to the route, which takes up its approval.
    const a = clockedStore(writer);
    a.store.create(proposal('p_sent', { idempotencyKey: 'transfer:acme:sent' }));
    submit(a.store, 'p_sent');
    await consumeApprovalRecord(db, { proposalId: 'p_sent', orgId: 'acme', consumedBy: 'transfers/authorize', consumedAt: new Date(NOW) });
    await a.store.flush();

    // Process B starts while it is being sent (a rolling deploy) and loads it with no outcome.
    const b = clockedStore(writer);
    b.clock.now = NOW + MINUTE;
    assert.equal(await ensureProposalStoreHydrated(b.store), true);

    // A records that it went. B's copy never hears of it.
    a.store.recordExecution('p_sent', { state: 'EXECUTED', detail: 'Payment sent.', ref: 'tr_4471', at: iso(NOW + MINUTE) });
    await a.store.flush();
    assert.equal(b.store.get('p_sent').execution, undefined);

    b.clock.now = NOW + 2 * STUCK_AFTER_MS;
    assert.deepEqual(await findStuckPayments(b.store, 'acme', new Date(b.clock.now), liveStuckRecords(b.store)), [], 'not listed');

    const answer = await reconcileStuckPayment(liveDeps(b), { proposalId: 'p_sent', actor: priya, outcome: 'NOT_SENT' });
    assert.equal(answer.status, 409);
    assert.equal(answer.body.error, 'An outcome for this payment is already on record: sent. Nothing was changed.');
    await b.store.flush();
    const { rows } = await client.query(`SELECT execution_state FROM proposals WHERE id = 'p_sent'`);
    assert.equal(rows[0].execution_state, 'EXECUTED', 'what A saved stands');
    assert.equal((await loadApprovalSpends(db, ['p_sent'])).get('p_sent').consumedBy, 'transfers/authorize');

    // Saved states are read within one org.
    assert.equal((await loadSavedStates(db, 'acme', ['p_sent'])).get('p_sent').executionState, 'EXECUTED');
    assert.equal((await loadSavedStates(db, 'northwind', ['p_sent'])).size, 0);
  });
  await client.close();
});

test('a payment submitted by code from before 0026 is not called stuck while its route may still be paying', async () => {
  const { client, db } = await migratedDb();
  await withDatabase(db, async () => {
    const writer = (p) => upsertProposal(db, p);

    // Process A, on the old code, submits without a time, and the route takes the approval up.
    const a = clockedStore(writer);
    a.store.create(proposal('p_old', { idempotencyKey: 'transfer:acme:old' }));
    submit(a.store, 'p_old');
    await a.store.flush();
    await client.exec(`UPDATE proposals SET submitted_at = NULL WHERE id = 'p_old'`);
    await consumeApprovalRecord(db, { proposalId: 'p_old', orgId: 'acme', consumedBy: 'transfers/authorize', consumedAt: new Date(NOW) });

    // Process B, on this code, starts two minutes later.
    const b = clockedStore(writer);
    b.clock.now = NOW + 2 * MINUTE;
    assert.equal(await ensureProposalStoreHydrated(b.store), true);
    assert.equal(b.store.get('p_old').submittedAt, undefined);
    assert.deepEqual(await findStuckPayments(b.store, 'acme', new Date(b.clock.now), liveStuckRecords(b.store)), []);
    const early = await reconcileStuckPayment(liveDeps(b), { proposalId: 'p_old', actor: priya, outcome: 'NOT_SENT' });
    assert.equal(early.body.code, 'STILL_SENDING');
    assert.match(early.body.error, /Check again in 8 minutes\./);

    // Ten minutes after the route took it up, with no outcome, it is stuck.
    b.clock.now = NOW + STUCK_AFTER_MS + MINUTE;
    const found = await findStuckPayments(b.store, 'acme', new Date(b.clock.now), liveStuckRecords(b.store));
    assert.deepEqual(found.map(({ proposal: p, evidence }) => [p.id, evidence.kind]), [['p_old', 'route-used']]);
  });
  await client.close();
});

// ── The route, the page and the lane ────────────────────────────────────────

const code = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, ' ').split(/\r?\n/).map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
const source = async (file) => code(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'));

test('the reconcile route takes the answer from the body and everything else from the session', async () => {
  const route = await source('app/api/proposals/[id]/reconcile/route.ts');
  assert.match(route, /assertCleanBody\(body, `proposals\/\$\{id\}\/reconcile`\)/, 'authority-shaped fields refused');
  assert.match(route, /resolveAuthorityForSession\(auth\.session\)/);
  assert.match(route, /actor: \{ userId: ctx\.userId, role: ctx\.role, orgId: ctx\.orgId \}/);
  assert.match(route, /await ensureProposalStoreHydrated\(store\)/, 'a stuck payment is in Postgres after a restart');
  assert.match(route, /\.\.\.liveStuckRecords\(store\)/, 'reads the saved rows, not only this process’s copy');
  assert.match(route, /outcome: z\.enum\(\['SENT', 'NOT_SENT'\]\)/);
  assert.doesNotMatch(route, /parsed\.data\.(userId|role|orgId)/);
});

test('the queue shows the lane for the viewer’s own workspace, ahead of ready-to-send', async () => {
  const page = await source('app/queue/page.tsx');
  const lane = page.indexOf('<StuckPaymentsSection viewer={viewer} />');
  assert.ok(lane > 0);
  assert.ok(lane < page.indexOf('<ReadyToSendLane'), 'exceptions first');

  const section = await source('components/queue/StuckPaymentsSection.tsx');
  assert.match(section, /if \(!viewer\) return null;/);
  assert.match(section, /findStuckPayments\(store, viewer\.orgId, now, liveStuckRecords\(store\)\)/);
});

test('the lane confirms before recording, announces what happened, and stays out of server code', async () => {
  const lane = await readFile(new URL('../components/queue/StuckPaymentsLane.tsx', import.meta.url), 'utf8');
  assert.match(lane, /^'use client';/);
  assert.match(lane, /window\.confirm\(confirmation\(item, outcome\)\)/);
  assert.match(lane, /aria-live="polite"/);
  assert.match(lane, /Only confirm after checking the payment itself\. If it did go, requesting it again would pay it twice\./);
  // Imports only what the browser can load: the store's module reaches node:crypto.
  const imports = [...lane.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(imports.filter((path) => /proposal-state|lib\/server|queue\/stuck-payments'?$/.test(path)), []);
  assert.doesNotMatch(lane, /\p{Extended_Pictographic}/u, 'no emoji');
  // Every action is a 44px target.
  for (const button of lane.match(/<button[\s\S]*?className="([^"]+)"/g) ?? []) assert.match(button, /\bh-11\b/);
});
