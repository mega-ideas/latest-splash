import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

import * as schema from '../lib/db/schema.ts';
import { upsertProposal } from '../lib/db/proposal-repo.ts';
import { upsertOxwalCounterpartyFixture } from '../lib/agent/oxwal.ts';
import { resolveComplianceForProposal } from '../lib/compliance/proposal-screening.ts';
import { serverDefaultOrgPolicy } from '../lib/policy/org-policy.ts';
import {
  evaluateAtApproval,
  recordApprovals,
  rejectUnlessReleased,
  releaseApproved,
} from '../lib/queue/approval-walk.ts';
import { canRoleApprove, InMemoryProposalStore } from '../lib/queue/proposal-state.ts';
import { applyDecision } from '../lib/server/approval-requests.ts';
import { readBallotRound, refuseWith, settleBallots } from '../lib/server/approval-settle.ts';
import { findLiveTokenForUser, findTokenByCode } from '../lib/server/approval-tokens.ts';
import { findApproverOrgsForNumber } from '../lib/server/approver-lookup.ts';
import { resolveApproverById, resolveApproverByNumber } from '../lib/server/approver-channels.ts';
import { proposeForApproval } from '../lib/server/dual-approval.ts';

/**
 * Approving a money-route payment by code or by WhatsApp reply.
 *
 * `proposeForApproval` leaves the proposal SIMULATED; only the in-app submit
 * route used to walk it on. The settle path the two ballot channels reach
 * applied APPROVE — accepted only from PENDING_APPROVAL — so every ballot was
 * refused and swallowed, SIGN threw from SIMULATED, and every approver was
 * told "Approved, but the payment could not be completed." It also skipped
 * the submit route's policy, expiry and compliance re-check, and the webhook
 * replayed the money route with no session, which the route refuses.
 *
 * Now both channels take the submit route's walk (lib/queue/approval-walk.ts),
 * a reply records votes and stops at APPROVED, and the money moves only for a
 * signed-in approver: the one whose code completes the vote, or one who
 * releases it in the app.
 */

// The pure tests run without a database; the channel tests set one up per
// test and put this back.
delete process.env.DATABASE_URL;

const DAY_MS = 24 * 60 * 60 * 1000;
const CLEAR = { kytPassed: true, kybStatus: 'VERIFIED', sanctionsClear: true, flags: [] };
const HOLD = { kytPassed: false, kybStatus: 'PENDING', sanctionsClear: false, flags: ['COUNTERPARTY_NOT_FOUND'] };
const ORG_POLICY = serverDefaultOrgPolicy('acme');

// ── The walk itself, on a store ─────────────────────────────────────────────

let sequence = 0;

/** A proposal shaped the way `proposeForApproval` shapes one, left SIMULATED. */
function simulatedPayment(store, overrides = {}) {
  const id = overrides.id ?? `prop_walk_${++sequence}`;
  const amountMicro = overrides.amountMicro ?? 25_000_000_000n;
  const now = new Date().toISOString();
  store.create({
    id,
    idempotencyKey: `idem_${id}`,
    kind: overrides.kind ?? 'PAYMENT',
    status: 'DRAFTED',
    tier: 'TIER_0_PROPOSE',
    orgId: 'acme',
    corridor: 'PHP',
    unsignedTxBytes: 'ab'.repeat(32),
    createdBy: overrides.createdBy ?? 'usr_ben',
    createdAt: now,
    expiresAt: overrides.expiresAt ?? new Date(Date.now() + DAY_MS).toISOString(),
    approvals: [],
    explain: {
      recommendation: 'Pay 25000 USD to Manila Parts Supply in PHP.',
      financialImpact: { amountIn: amountMicro, currencyIn: 'USD' },
      evidence: [{ source: 'COUNTERPARTY', ref: 'rcpt_walk', observedAt: now, trusted: true, status: 'LIVE' }],
      confidence: 1,
      risk: 'MEDIUM',
      requiredApprovers: 2,
      reasoningTraceRef: 'dual-approval:test',
    },
    executionPayload: { amount: { value: '25000', targetCurrency: 'PHP' } },
  });
  return store.transition(id, {
    type: 'SIMULATION_COMPLETED',
    simulation: {
      ok: true,
      balanceChanges: [{ owner: 'acme', coinType: 'USDC', amount: (-amountMicro).toString() }],
      gasSponsored: false,
      simulatedAt: now,
    },
  });
}

function gate(store, proposalId, overrides = {}) {
  return evaluateAtApproval(store, {
    proposalId,
    actor: { userId: 'usr_priya', role: 'APPROVER' },
    policy: ORG_POLICY,
    compliance: () => CLEAR,
    signatureRef: `code:${proposalId}`,
    now: new Date(),
    ...overrides,
  });
}

const vote = (userId, role) => ({ userId, role, signedAt: new Date().toISOString() });

test('approval re-runs policy and walks a simulated payment to the gate', () => {
  const store = new InMemoryProposalStore();
  const proposal = simulatedPayment(store);
  assert.equal(proposal.status, 'SIMULATED', 'what the money routes leave behind');

  const { proposal: gated, decision } = gate(store, proposal.id);
  assert.deepEqual(decision, { outcome: 'REQUIRE_APPROVAL', approvers: 2 });
  assert.equal(gated.status, 'PENDING_APPROVAL');
  assert.equal(gated.explain.requiredApprovers, 2);

  // Policy, not the channel, sets the count: above a higher dual threshold
  // the same payment needs one approver.
  const lenient = new InMemoryProposalStore();
  const other = simulatedPayment(lenient);
  const relaxed = { ...ORG_POLICY, dualApprovalThresholdUsd: 100_000_000_000n };
  const once = gate(lenient, other.id, { policy: relaxed });
  assert.deepEqual(once.decision, { outcome: 'REQUIRE_APPROVAL', approvers: 1 });
  assert.equal(once.proposal.explain.requiredApprovers, 1);
});

test('a policy block stops the walk before anything moves', () => {
  const blocked = {
    'quote expired': (store) => ({
      proposalId: simulatedPayment(store).id,
      now: new Date(Date.now() + 2 * DAY_MS),
    }),
    'compliance hold': (store) => ({ proposalId: simulatedPayment(store).id, compliance: () => HOLD }),
    'circuit breaker': (store) => ({
      proposalId: simulatedPayment(store).id,
      policy: { ...ORG_POLICY, perCorridorState: { PHP: 'PAUSED' } },
    }),
  };
  for (const [reason, setup] of Object.entries(blocked)) {
    const store = new InMemoryProposalStore();
    const input = setup(store);
    assert.throws(() => gate(store, input.proposalId, input), new RegExp(reason));
    assert.equal(store.get(input.proposalId).status, 'SIMULATED', `${reason} must leave it where it was`);
  }
});

test('a proposal policy asks nobody to approve is marked approved', () => {
  const store = new InMemoryProposalStore();
  const now = new Date().toISOString();
  store.create({
    id: 'prop_internal',
    idempotencyKey: 'idem_internal',
    kind: 'INTERNAL_TRANSFER',
    status: 'DRAFTED',
    tier: 'TIER_0_PROPOSE',
    orgId: 'acme',
    unsignedTxBytes: 'cd'.repeat(32),
    createdBy: 'usr_ben',
    createdAt: now,
    expiresAt: new Date(Date.now() + DAY_MS).toISOString(),
    approvals: [],
    explain: {
      recommendation: 'Move 2 USD between the org’s own accounts.',
      financialImpact: { amountIn: 2_000_000n, currencyIn: 'USD' },
      evidence: [],
      confidence: 1,
      risk: 'LOW',
      requiredApprovers: 1,
      reasoningTraceRef: 'test',
    },
  });
  store.transition('prop_internal', {
    type: 'SIMULATION_COMPLETED',
    simulation: {
      ok: true,
      balanceChanges: [{ owner: 'acme', coinType: 'USDC', amount: '-2000000' }],
      gasSponsored: false,
      simulatedAt: now,
    },
  });
  const { proposal, decision } = gate(store, 'prop_internal', { actor: { userId: 'usr_ben', role: 'MAKER' } });
  assert.deepEqual(decision, { outcome: 'AUTO_EXECUTE' });
  assert.equal(proposal.status, 'APPROVED');
  // No approvals were required, so the policy decision governs who releases.
  const submitted = releaseApproved(store, 'prop_internal', {
    releaser: { userId: 'usr_tom', role: 'MAKER' },
    signatureRef: 'sig',
    decision,
    now: new Date(),
  });
  assert.equal(submitted.status, 'SUBMITTED');
});

test('ballots count through the state machine: never the maker, never a viewer, never twice', () => {
  const store = new InMemoryProposalStore();
  const proposal = simulatedPayment(store);
  gate(store, proposal.id);

  const { proposal: counted, refused } = recordApprovals(store, proposal.id, [
    vote('usr_ben', 'OWNER'),
    vote('usr_tom', 'VIEWER'),
    vote('usr_priya', 'APPROVER'),
    vote('usr_priya', 'APPROVER'),
  ]);
  assert.deepEqual(
    refused.map((r) => [r.userId, r.reason]),
    [
      ['usr_ben', 'maker cannot approve their own proposal'],
      ['usr_tom', 'VIEWER cannot approve proposals'],
    ],
  );
  assert.equal(counted.status, 'PENDING_APPROVAL', 'one distinct approver of two');
  assert.deepEqual(counted.approvals.map((a) => a.userId), ['usr_priya']);

  // A finance admin's approval counts like any approver's.
  const done = recordApprovals(store, proposal.id, [vote('usr_fin', 'FINANCE_ADMIN'), vote('usr_nadia', 'OWNER')]);
  assert.equal(done.proposal.status, 'APPROVED');
  assert.deepEqual(done.proposal.approvals.map((a) => a.userId), ['usr_priya', 'usr_fin']);
  assert.deepEqual(done.refused, [], 'votes after the requirement is met are not refusals');
});

test('the roles an approval counts from are the state machine’s own', () => {
  for (const role of ['OWNER', 'FINANCE_ADMIN', 'APPROVER']) assert.equal(canRoleApprove(role), true, role);
  for (const role of ['MAKER', 'VIEWER', 'AUDITOR', 'DEVELOPER']) assert.equal(canRoleApprove(role), false, role);
});

test('release: an approver who is not the maker signs and submits, once approvals are in', () => {
  const store = new InMemoryProposalStore();
  const proposal = simulatedPayment(store);
  const { decision } = gate(store, proposal.id);
  const release = (releaser) => () =>
    releaseApproved(store, proposal.id, { releaser, signatureRef: 'sig_release', decision, now: new Date() });

  // Not yet approved: SIGN refuses from the gate.
  assert.throws(release({ userId: 'usr_priya', role: 'APPROVER' }), /SIGN is not allowed from PENDING_APPROVAL/);

  recordApprovals(store, proposal.id, [vote('usr_priya', 'APPROVER'), vote('usr_nadia', 'OWNER')]);
  assert.equal(store.get(proposal.id).status, 'APPROVED');

  assert.throws(release({ userId: 'usr_ben', role: 'OWNER' }), /maker cannot release their own proposal/);
  assert.throws(release({ userId: 'usr_tom', role: 'VIEWER' }), /VIEWER cannot release an approved payment/);
  assert.throws(release({ userId: 'usr_mia', role: 'MAKER' }), /MAKER cannot release an approved payment/);
  assert.throws(
    () =>
      releaseApproved(store, proposal.id, {
        releaser: { userId: 'usr_priya', role: 'APPROVER' },
        signatureRef: 'sig',
        decision: { outcome: 'BLOCK', reason: 'compliance hold' },
        now: new Date(),
      }),
    /policy blocked the release: compliance hold/,
  );
  assert.equal(store.get(proposal.id).status, 'APPROVED', 'none of those moved it');

  const submitted = release({ userId: 'usr_priya', role: 'APPROVER' })();
  assert.equal(submitted.status, 'SUBMITTED');
  assert.throws(release({ userId: 'usr_nadia', role: 'OWNER' }), /SIGN is not allowed from SUBMITTED/);
});

test('a release that stopped at SIGNED is finished, not signed again', () => {
  const store = new InMemoryProposalStore();
  const proposal = simulatedPayment(store);
  const { decision } = gate(store, proposal.id);
  recordApprovals(store, proposal.id, [vote('usr_priya', 'APPROVER'), vote('usr_nadia', 'OWNER')]);
  store.transition(proposal.id, {
    type: 'SIGN',
    signatureRef: 'sig_first',
    signedBy: 'usr_nadia',
    policyAuthorized: true,
    signedAt: new Date().toISOString(),
  });
  const submitted = releaseApproved(store, proposal.id, {
    releaser: { userId: 'usr_priya', role: 'APPROVER' },
    signatureRef: 'sig_second',
    decision,
    now: new Date(),
  });
  assert.equal(submitted.status, 'SUBMITTED');
});

test('one refusal closes the proposal, unless the payment already went', () => {
  const store = new InMemoryProposalStore();
  const pending = simulatedPayment(store);
  gate(store, pending.id);
  assert.equal(rejectUnlessReleased(store, pending.id, 'no').state, 'REJECTED');
  assert.equal(store.get(pending.id).status, 'REJECTED');
  // Nothing can release it afterwards, from any path. Policy still passes (it
  // does not read the status); there is simply nothing left to sign.
  const afterRefusal = gate(store, pending.id);
  assert.equal(afterRefusal.proposal.status, 'REJECTED', 'the walk does not reopen it');
  assert.throws(
    () =>
      releaseApproved(store, pending.id, {
        releaser: { userId: 'usr_priya', role: 'APPROVER' },
        signatureRef: 'sig',
        decision: afterRefusal.decision,
        now: new Date(),
      }),
    /SIGN is not allowed from REJECTED/,
  );
  assert.equal(rejectUnlessReleased(store, pending.id, 'no again').state, 'ALREADY_CLOSED');

  const sent = simulatedPayment(store);
  const { decision } = gate(store, sent.id);
  recordApprovals(store, sent.id, [vote('usr_priya', 'APPROVER'), vote('usr_nadia', 'OWNER')]);
  releaseApproved(store, sent.id, { releaser: { userId: 'usr_nadia', role: 'OWNER' }, signatureRef: 'sig', decision, now: new Date() });
  const late = rejectUnlessReleased(store, sent.id, 'too late');
  assert.equal(late.state, 'ALREADY_RELEASED');
  assert.equal(store.get(sent.id).status, 'SUBMITTED', 'a late refusal does not rewrite a released payment');

  assert.deepEqual(rejectUnlessReleased(store, 'prop_nowhere', 'no'), { state: 'NOT_FOUND' });
});

// ── The channels, against a database ────────────────────────────────────────

async function migratedDb() {
  const client = new PGlite();
  const files = (await readdir(new URL('../drizzle', import.meta.url))).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sqlText = await readFile(new URL(`../drizzle/${file}`, import.meta.url), 'utf8');
    for (const statement of sqlText.split('--> statement-breakpoint')) {
      const trimmed = statement.trim();
      if (trimmed) await client.exec(trimmed);
    }
  }
  // Acme: Ben makes payments, Priya (checker) and Nadia (admin) approve, Tom
  // only looks. Lin is an admin at Northwind and only a viewer at Acme.
  await client.exec(`
    INSERT INTO organizations (id, name, kyb_lifecycle) VALUES
      ('acme', 'Acme Trading', 'ACTIVE'), ('northwind', 'Northwind', 'ACTIVE');
    INSERT INTO users (id, email, name) VALUES
      ('usr_ben', 'ben@acme.test', 'Ben'),
      ('usr_priya', 'priya@acme.test', 'Priya'),
      ('usr_nadia', 'nadia@acme.test', 'Nadia'),
      ('usr_tom', 'tom@acme.test', 'Tom'),
      ('usr_lin', 'lin@northwind.test', 'Lin');
    INSERT INTO memberships (id, user_id, org_id, role) VALUES
      ('m_ben', 'usr_ben', 'acme', 'maker'),
      ('m_priya', 'usr_priya', 'acme', 'checker'),
      ('m_nadia', 'usr_nadia', 'acme', 'admin'),
      ('m_tom', 'usr_tom', 'acme', 'viewer'),
      ('m_lin_nw', 'usr_lin', 'northwind', 'admin'),
      ('m_lin_acme', 'usr_lin', 'acme', 'viewer');
  `);
  return { client, db: drizzle(client, { schema }) };
}

/** Point the app's database at this PGlite, and its proposal store at one
 *  that writes through to it, for the length of `run`. */
async function withChannelWorld(run) {
  const { client, db } = await migratedDb();
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'postgres://pglite.invalid/approval-channels';
  globalThis.splashDb = { pool: { end: async () => {} }, db };
  const store = new InMemoryProposalStore((proposal) => upsertProposal(db, proposal));
  globalThis.oxwalProposalStore = store;
  try {
    await run({ client, db, store });
  } finally {
    await store.flush();
    delete globalThis.splashDb;
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
    await client.close();
  }
}

const BENEFICIARY = 'rcpt_manila_parts';
upsertOxwalCounterpartyFixture({
  id: BENEFICIARY,
  name: 'Manila Parts Supply',
  country: 'PH',
  kybStatus: 'VERIFIED',
  kytPassed: true,
  sanctionsClear: true,
});

/**
 * What `/api/transfers/authorize` does when a payment crosses the threshold:
 * a proposal through the real `proposeForApproval`, which asks the approvers
 * in the background. Waits for their ballots.
 */
async function moneyRoutePayment(client, { beneficiary = BENEFICIARY, key = ++sequence } = {}) {
  const proposal = await proposeForApproval({
    orgId: 'acme',
    createdBy: 'usr_ben',
    kind: 'PAYMENT',
    amountUsd: '25000',
    targetCurrency: 'PHP',
    recommendation: 'Pay 25000 USD to Manila Parts Supply in PHP. Above the 10000 USD dual-approval threshold.',
    passedChecks: [
      { source: 'COMPLIANCE', ref: 'KYB org state is ACTIVE' },
      { source: 'BALANCE', ref: 'Per-transfer and daily ceilings, 0 USD spent today' },
      { source: 'COUNTERPARTY', ref: beneficiary },
    ],
    payload: {
      recipient: { name: 'Manila Parts Supply', country: 'PH', bank: { swift: 'BOPIPHMM', account: '001234567890' } },
      amount: { value: '25000', targetCurrency: 'PHP' },
      deliveryTier: 'PAYOUT_ONLY',
      fundingSelection: { source: 'SPLASH_BALANCE', type: 'held', feeTier: 'DISCOUNT' },
    },
    idempotencyKey: `transfer:acme:25000:Manila Parts Supply:PHP:${key}`,
    approvalThresholdUsd: 10_000,
  });
  assert.ok(proposal, 'the proposal was created');
  // The ballots are issued in the background, as in the app. Generous, because
  // a loaded machine is slow to load the module the first time.
  for (let i = 0; i < 2000; i += 1) {
    const { rows } = await client.query('SELECT 1 FROM approval_tokens WHERE proposal_id = $1', [proposal.id]);
    if (rows.length === 2) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const ballots = await client.query(
    'SELECT user_id, code, channel FROM approval_tokens WHERE proposal_id = $1 ORDER BY user_id',
    [proposal.id],
  );
  assert.deepEqual(
    ballots.rows.map((row) => row.user_id),
    ['usr_nadia', 'usr_priya'],
    'every approver but the maker is asked',
  );
  return { proposal, codes: Object.fromEntries(ballots.rows.map((row) => [row.user_id, row.code])) };
}

function recordingExecutor(result = { state: 'EXECUTED', detail: 'Payment sent.', ref: 'ti_1' }) {
  const calls = [];
  return {
    calls,
    execute: async (proposal, context) => {
      calls.push({ id: proposal.id, status: proposal.status, approvals: proposal.approvals.map((a) => a.userId), context });
      return result;
    },
  };
}

function settleDeps(db, store, overrides = {}) {
  return {
    store,
    db,
    compliance: resolveComplianceForProposal,
    canMoveMoney: async () => ({ ok: true }),
    execute: recordingExecutor().execute,
    closeClaim: async () => {},
    now: () => new Date(),
    ...overrides,
  };
}

const SESSION = { cookie: 'splash_session=signed', origin: 'http://splash.test' };

/** The code route's steps, as the route runs them (it cannot be imported under
 *  node --test; the source assertions below pin it to these calls). */
async function answerByCode(deps, { userId, sessionOrgId = 'acme', code, decision = 'APPROVE' }) {
  const now = new Date();
  const lookup = await findTokenByCode(userId, code, now);
  if (!lookup.ok) return { stoppedAt: 'code', reason: lookup.reason };
  const eligible = await resolveApproverById(userId, lookup.token.orgId);
  if (!eligible.ok) return { stoppedAt: 'role', reason: eligible.reason };
  const result = await applyDecision({
    tokenId: lookup.token.id,
    proposalId: lookup.token.proposalId,
    approver: eligible.approver,
    decision,
    now,
  });
  if (!result.ok) return { stoppedAt: 'decision', reason: result.message };
  if (result.tally.refused) return { refusal: refuseWith(deps.store, lookup.token.proposalId) };
  if (result.tally.unanimous) {
    return {
      settle: await settleBallots(deps, {
        proposalId: lookup.token.proposalId,
        channel: 'code',
        releaser: { userId, sessionOrgId, ...SESSION },
      }),
    };
  }
  return { tally: result.tally };
}

/** The webhook's steps, after the signature check. */
async function answerByReply(deps, { number, intent }) {
  const now = new Date();
  for (const orgId of await findApproverOrgsForNumber(number)) {
    const resolved = await resolveApproverByNumber(number, orgId);
    if (!resolved.ok) continue;
    const lookup = await findLiveTokenForUser(resolved.approver.userId, now, { orgId });
    if (!lookup.ok) continue;
    if (intent === 'APPROVE' && lookup.token.channel !== 'reply') return { stoppedAt: 'channel' };
    const result = await applyDecision({
      tokenId: lookup.token.id,
      proposalId: lookup.token.proposalId,
      approver: resolved.approver,
      decision: intent,
      now,
    });
    if (!result.ok) return { stoppedAt: 'decision', reason: result.message };
    if (result.tally.refused) return { refusal: refuseWith(deps.store, lookup.token.proposalId) };
    if (result.tally.unanimous) {
      return {
        settle: await settleBallots(deps, { proposalId: lookup.token.proposalId, channel: 'whatsapp', releaser: null }),
      };
    }
    return { tally: result.tally };
  }
  return { stoppedAt: 'no ballot' };
}

async function replyModeWithNumbers(client) {
  await client.exec(`
    INSERT INTO org_settings (org_id, approval_channel, whatsapp_enabled) VALUES ('acme', 'reply', true);
    INSERT INTO approver_channels (id, org_id, user_id, whatsapp_e164, verified_at) VALUES
      ('ac_priya', 'acme', 'usr_priya', '+60100000001', now()),
      ('ac_nadia', 'acme', 'usr_nadia', '+60100000002', now());
  `);
}

test('the reported path: a money-route payment approved by code is walked, counted, released and sent', async () => {
  await withChannelWorld(async ({ client, db, store }) => {
    const { proposal, codes } = await moneyRoutePayment(client);
    assert.equal(store.get(proposal.id).status, 'SIMULATED', 'proposeForApproval leaves it here');

    const executor = recordingExecutor();
    const deps = settleDeps(db, store, { execute: executor.execute });

    const first = await answerByCode(deps, { userId: 'usr_priya', code: codes.usr_priya });
    assert.deepEqual(first.tally, { total: 2, approved: 1, rejected: 0, unanimous: false, refused: false });
    assert.equal(store.get(proposal.id).status, 'SIMULATED', 'one of two ballots moves nothing');

    const last = await answerByCode(deps, { userId: 'usr_nadia', code: codes.usr_nadia });
    assert.deepEqual(last.settle, {
      settled: true,
      stage: 'SENT',
      message: 'Approved by everyone. The payment has been sent.',
    });

    // Walked, counted against the USERS, released by the signed-in approver.
    const after = store.get(proposal.id);
    assert.equal(after.status, 'SUBMITTED');
    assert.equal(after.explain.requiredApprovers, 2, 'the policy engine set the count');
    assert.deepEqual(
      after.approvals.map((a) => [a.userId, a.role]),
      [['usr_priya', 'APPROVER'], ['usr_nadia', 'OWNER']],
    );
    assert.deepEqual(after.execution && [after.execution.state, after.execution.ref], ['EXECUTED', 'ti_1']);

    // Carried out exactly once, submitted, with the releasing session.
    assert.equal(executor.calls.length, 1);
    assert.equal(executor.calls[0].status, 'SUBMITTED');
    assert.deepEqual(executor.calls[0].context, SESSION);

    // And durable: the row says what the store says.
    const row = await client.query('SELECT status, execution_state FROM proposals WHERE id = $1', [proposal.id]);
    assert.deepEqual(row.rows[0], { status: 'SUBMITTED', execution_state: 'EXECUTED' });
    const approvals = await client.query('SELECT user_id FROM approvals WHERE proposal_id = $1 ORDER BY user_id', [proposal.id]);
    assert.deepEqual(approvals.rows.map((r) => r.user_id), ['usr_nadia', 'usr_priya']);
  });
});

test('a WhatsApp reply records the vote and stops at approved; a signed-in approver sends it', async () => {
  await withChannelWorld(async ({ client, db, store }) => {
    await replyModeWithNumbers(client);
    const { proposal } = await moneyRoutePayment(client);
    const executor = recordingExecutor();
    const deps = settleDeps(db, store, { execute: executor.execute });

    const first = await answerByReply(deps, { number: '+60100000001', intent: 'APPROVE' });
    assert.equal(first.tally.approved, 1);
    const last = await answerByReply(deps, { number: '+60 10-000 0002', intent: 'APPROVE' });
    assert.deepEqual(last.settle, {
      settled: false,
      stage: 'AWAITING_RELEASE',
      message: 'Approved by everyone. A signed-in approver sends it from Splash; a WhatsApp reply cannot send a payment.',
    });
    assert.equal(executor.calls.length, 0, 'no session, no money');

    const approved = store.get(proposal.id);
    assert.equal(approved.status, 'APPROVED', 'policy evaluated and every ballot recorded');
    assert.deepEqual(approved.approvals.map((a) => a.userId), ['usr_priya', 'usr_nadia']);

    // The authenticated step: the submit route's walk, for a signed-in person.
    const release = (releaser) => {
      const { decision } = evaluateAtApproval(store, {
        proposalId: proposal.id,
        actor: releaser,
        policy: ORG_POLICY,
        compliance: resolveComplianceForProposal,
        signatureRef: 'sig_in_app',
        now: new Date(),
      });
      return releaseApproved(store, proposal.id, { releaser, signatureRef: 'sig_in_app', decision, now: new Date() });
    };
    assert.throws(() => release({ userId: 'usr_tom', role: 'VIEWER' }), /VIEWER cannot release/);
    assert.throws(() => release({ userId: 'usr_ben', role: 'MAKER' }), /maker cannot release/);
    assert.equal(release({ userId: 'usr_priya', role: 'APPROVER' }).status, 'SUBMITTED');
  });
});

test('in code mode a reply can stop a payment but cannot approve one', async () => {
  await withChannelWorld(async ({ client, db, store }) => {
    await client.exec(`
      INSERT INTO approver_channels (id, org_id, user_id, whatsapp_e164, verified_at) VALUES
        ('ac_priya', 'acme', 'usr_priya', '+60100000001', now());
    `);
    const { proposal } = await moneyRoutePayment(client);
    const deps = settleDeps(db, store);

    const approve = await answerByReply(deps, { number: '+60100000001', intent: 'APPROVE' });
    assert.deepEqual(approve, { stoppedAt: 'channel' });
    const untouched = await client.query(
      `SELECT decision FROM approval_tokens WHERE proposal_id = $1 AND user_id = 'usr_priya'`,
      [proposal.id],
    );
    assert.equal(untouched.rows[0].decision, null, 'the ballot is still unanswered');

    const reject = await answerByReply(deps, { number: '+60100000001', intent: 'REJECT' });
    assert.equal(reject.refusal.rejected, true);
    assert.match(reject.refusal.message, /no further approvals can change that/);
    assert.equal(store.get(proposal.id).status, 'REJECTED', 'closed on the proposal, not only in the tally');
  });
});

test('approval re-evaluates policy, expiry and compliance at the moment of the last ballot', async () => {
  await withChannelWorld(async ({ client, db, store }) => {
    const cases = [
      { name: 'expired', setup: {}, deps: { now: () => new Date(Date.now() + 2 * DAY_MS) }, reason: /quote expired/ },
      { name: 'unscreened', setup: { beneficiary: 'rcpt_never_screened' }, deps: {}, reason: /compliance hold/ },
    ];
    for (const item of cases) {
      const { proposal, codes } = await moneyRoutePayment(client, item.setup);
      const executor = recordingExecutor();
      const deps = settleDeps(db, store, { execute: executor.execute, ...item.deps });
      await answerByCode(deps, { userId: 'usr_priya', code: codes.usr_priya });
      const { settle } = await answerByCode(deps, { userId: 'usr_nadia', code: codes.usr_nadia });
      assert.equal(settle.stage, 'BLOCKED', item.name);
      assert.match(settle.message, item.reason, item.name);
      assert.equal(store.get(proposal.id).status, 'SIMULATED', `${item.name}: nothing moved`);
      assert.equal(executor.calls.length, 0, `${item.name}: nothing was carried out`);
    }

    // The circuit breaker the operator trips is read at approval time too.
    const { proposal, codes } = await moneyRoutePayment(client);
    const breakers = globalThis.oxwalCircuitBreakers;
    breakers.set('acme', {
      orgId: 'acme',
      globalState: 'PAUSED',
      perCorridorState: {},
      updatedAt: new Date().toISOString(),
      updatedBy: 'test',
    });
    try {
      const deps = settleDeps(db, store);
      await answerByCode(deps, { userId: 'usr_priya', code: codes.usr_priya });
      const { settle } = await answerByCode(deps, { userId: 'usr_nadia', code: codes.usr_nadia });
      assert.equal(settle.stage, 'BLOCKED');
      assert.match(settle.message, /circuit breaker/);
      assert.equal(store.get(proposal.id).status, 'SIMULATED');
    } finally {
      breakers.delete('acme');
    }
  });
});

test('maker ≠ checker and org-scoped roles hold for ballots, whoever issued them', async () => {
  await withChannelWorld(async ({ client, db, store }) => {
    const { proposal } = await moneyRoutePayment(client);
    // Ballots the request path would never issue — the maker's own, and one
    // from someone who approves at Northwind but only views at Acme — voted
    // alongside Priya's.
    await client.query(`DELETE FROM approval_tokens WHERE proposal_id = $1 AND user_id = 'usr_nadia'`, [proposal.id]);
    await client.query(
      `INSERT INTO approval_tokens (id, proposal_id, org_id, user_id, code, channel, expires_at, decision, decided_at)
       VALUES ('atk_maker', $1, 'acme', 'usr_ben', '111111', 'code', now() + interval '30 minutes', 'APPROVE', now()),
              ('atk_lin', $1, 'acme', 'usr_lin', '222222', 'code', now() + interval '30 minutes', 'APPROVE', now())`,
      [proposal.id],
    );
    await client.query(
      `UPDATE approval_tokens SET decision = 'APPROVE', decided_at = now() WHERE proposal_id = $1 AND user_id = 'usr_priya'`,
      [proposal.id],
    );

    const round = await readBallotRound(db, proposal);
    assert.equal(round.state, 'UNANIMOUS');
    assert.deepEqual(
      Object.fromEntries(round.ballots.map((b) => [b.userId, b.role])),
      { usr_ben: 'MAKER', usr_lin: 'VIEWER', usr_priya: 'APPROVER' },
      'each role is the one held in the proposal’s org',
    );

    const executor = recordingExecutor();
    const outcome = await settleBallots(settleDeps(db, store, { execute: executor.execute }), {
      proposalId: proposal.id,
      channel: 'code',
      releaser: { userId: 'usr_priya', sessionOrgId: 'acme', ...SESSION },
    });
    assert.equal(outcome.stage, 'NEEDS_APPROVER');
    assert.deepEqual(store.get(proposal.id).approvals.map((a) => a.userId), ['usr_priya']);
    assert.equal(executor.calls.length, 0);
  });
});

test('the code channel reads eligibility from the membership in the payment’s org', async () => {
  await withChannelWorld(async () => {
    const priya = await resolveApproverById('usr_priya', 'acme');
    assert.equal(priya.ok && priya.approver.role, 'checker');
    const nadia = await resolveApproverById('usr_nadia', 'acme');
    assert.equal(nadia.ok && nadia.approver.role, 'admin');

    assert.deepEqual(await resolveApproverById('usr_tom', 'acme'), { ok: false, reason: 'role viewer may not approve' });
    assert.deepEqual(await resolveApproverById('usr_ben', 'acme'), { ok: false, reason: 'role maker may not approve' });
    // An admin elsewhere is not an approver here.
    assert.deepEqual(await resolveApproverById('usr_lin', 'acme'), { ok: false, reason: 'role viewer may not approve' });
    assert.equal((await resolveApproverById('usr_lin', 'northwind')).ok, true);
    assert.deepEqual(await resolveApproverById('usr_nadia', 'northwind'), { ok: false, reason: 'not a member of this org' });
  });
  assert.deepEqual(await resolveApproverById('usr_priya', 'acme'), { ok: false, reason: 'no database configured' });
});

test('a reply answers a ballot only in the org the number was checked against', async () => {
  await withChannelWorld(async ({ client }) => {
    const { proposal } = await moneyRoutePayment(client);
    const now = new Date();
    assert.equal((await findLiveTokenForUser('usr_priya', now, { orgId: 'northwind' })).ok, false);
    const here = await findLiveTokenForUser('usr_priya', now, { orgId: 'acme' });
    assert.equal(here.ok && here.token.proposalId, proposal.id);
    assert.equal(here.ok && here.token.channel, 'code', 'the org default');
  });
});

test('the vote must be unanimous again when it is settled', async () => {
  await withChannelWorld(async ({ client, db, store }) => {
    const { proposal, codes } = await moneyRoutePayment(client);
    const executor = recordingExecutor();
    const deps = settleDeps(db, store, { execute: executor.execute });
    const settle = () => settleBallots(deps, {
      proposalId: proposal.id,
      channel: 'code',
      releaser: { userId: 'usr_priya', sessionOrgId: 'acme', ...SESSION },
    });

    await answerByCode(deps, { userId: 'usr_priya', code: codes.usr_priya });
    assert.equal((await settle()).stage, 'WAITING', 'called early, it counts the rows itself');

    const refused = await answerByCode(deps, { userId: 'usr_nadia', code: codes.usr_nadia, decision: 'REJECT' });
    assert.equal(refused.refusal.rejected, true);
    assert.equal((await settle()).stage, 'CLOSED');
    assert.equal(store.get(proposal.id).status, 'REJECTED');
    assert.equal(executor.calls.length, 0);
  });
});

test('the releaser must be an approver there, not the maker, signed in to that org, and the org able to move money', async () => {
  await withChannelWorld(async ({ client, db, store }) => {
    const { proposal, codes } = await moneyRoutePayment(client);
    const executor = recordingExecutor();
    const base = settleDeps(db, store, { execute: executor.execute });
    await answerByCode(base, { userId: 'usr_priya', code: codes.usr_priya });

    // Nadia completes the vote from a session in another workspace: the replay
    // would run as that session, in that workspace, so nothing is sent.
    const elsewhere = await answerByCode(base, { userId: 'usr_nadia', sessionOrgId: 'northwind', code: codes.usr_nadia });
    assert.equal(elsewhere.settle.stage, 'AWAITING_RELEASE');
    assert.match(elsewhere.settle.message, /only be sent from the workspace it belongs to/);
    assert.equal(store.get(proposal.id).status, 'APPROVED', 'the votes still count');

    const attempt = (releaser, overrides = {}) =>
      settleBallots({ ...base, ...overrides }, { proposalId: proposal.id, channel: 'code', releaser: { ...releaser, ...SESSION } });

    assert.match((await attempt({ userId: 'usr_ben', sessionOrgId: 'acme' })).message, /cannot send it themselves/);
    assert.match((await attempt({ userId: 'usr_tom', sessionOrgId: 'acme' })).message, /Only an approver/);
    const gated = await attempt(
      { userId: 'usr_nadia', sessionOrgId: 'acme' },
      { canMoveMoney: async () => ({ ok: false, reason: 'Verification is in review.' }) },
    );
    assert.deepEqual(gated, {
      settled: false,
      stage: 'AWAITING_RELEASE',
      message: 'Approved by everyone, but not sent. Verification is in review.',
    });
    assert.equal(executor.calls.length, 0);
    assert.equal(store.get(proposal.id).status, 'APPROVED');

    // The same approver, signed in to the right workspace, releases it.
    const sent = await attempt({ userId: 'usr_nadia', sessionOrgId: 'acme' });
    assert.equal(sent.stage, 'SENT');
    assert.equal(executor.calls.length, 1);
  });
});

test('a payment is carried out once, however many times the vote is settled', async () => {
  await withChannelWorld(async ({ client, db, store }) => {
    const { proposal, codes } = await moneyRoutePayment(client);
    const executor = recordingExecutor();
    const deps = settleDeps(db, store, { execute: executor.execute });
    await answerByCode(deps, { userId: 'usr_priya', code: codes.usr_priya });
    await client.query(
      `UPDATE approval_tokens SET decision = 'APPROVE', decided_at = now() WHERE proposal_id = $1 AND user_id = 'usr_nadia'`,
      [proposal.id],
    );

    // Two requests racing to settle the same completed vote.
    const settle = (userId) =>
      settleBallots(deps, { proposalId: proposal.id, channel: 'code', releaser: { userId, sessionOrgId: 'acme', ...SESSION } });
    const outcomes = await Promise.all([settle('usr_nadia'), settle('usr_priya')]);
    assert.deepEqual(outcomes.map((o) => o.stage).sort(), ['ALREADY_RELEASED', 'SENT']);
    assert.equal(executor.calls.length, 1);

    // A duplicate delivery afterwards reports, and does not send again.
    assert.deepEqual(await settle('usr_nadia'), {
      settled: true,
      stage: 'ALREADY_RELEASED',
      message: 'Already approved. The payment has been sent.',
    });
    assert.equal(executor.calls.length, 1);

    // Nor can a refusal arriving now rewrite what happened.
    const late = refuseWith(store, proposal.id);
    assert.equal(late.rejected, false);
    assert.match(late.message, /had already been released/);
    assert.equal(store.get(proposal.id).status, 'SUBMITTED');
  });
});

test('a release whose approval did not reach Postgres sends nothing and spends the claim', async () => {
  await withChannelWorld(async ({ client, db, store }) => {
    const { proposal, codes } = await moneyRoutePayment(client);
    const executor = recordingExecutor();
    const closed = [];
    const deps = settleDeps(db, store, {
      execute: executor.execute,
      closeClaim: async (proposalId, orgId) => {
        closed.push([proposalId, orgId]);
      },
    });
    await answerByCode(deps, { userId: 'usr_priya', code: codes.usr_priya });

    // Proposal writes fail (one transaction each) while reads and ballots work:
    // a database dropping mid-request, as the release is signed and submitted.
    db.transaction = async () => {
      throw new Error('Connection terminated unexpectedly');
    };
    let last;
    try {
      last = await answerByCode(deps, { userId: 'usr_nadia', code: codes.usr_nadia });
    } finally {
      delete db.transaction;
    }

    assert.equal(last.settle.stage, 'NOT_SENT');
    assert.match(last.settle.message, /could not be saved/);
    assert.equal(executor.calls.length, 0, 'the payment route was never asked');
    assert.deepEqual(closed, [[proposal.id, 'acme']], 'nothing can present the approval later');
    assert.equal(store.get(proposal.id).execution.state, 'FAILED');
  });
});

test('a payment route that refuses the release is reported, not claimed as sent', async () => {
  await withChannelWorld(async ({ client, db, store }) => {
    const { proposal, codes } = await moneyRoutePayment(client);
    const executor = recordingExecutor({ state: 'FAILED', detail: 'Splash balance is insufficient for this payment source' });
    const deps = settleDeps(db, store, { execute: executor.execute });
    await answerByCode(deps, { userId: 'usr_priya', code: codes.usr_priya });
    const { settle } = await answerByCode(deps, { userId: 'usr_nadia', code: codes.usr_nadia });
    assert.deepEqual(settle, {
      settled: false,
      stage: 'NOT_SENT',
      message: 'Approved, but the payment did not go: Splash balance is insufficient for this payment source',
    });
    assert.equal(store.get(proposal.id).execution.state, 'FAILED');
  });
});

// ── The routes, which cannot be imported under node --test ──────────────────

function code(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
}

async function source(file) {
  return code(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'));
}

test('the code route: eligibility from the membership in the payment’s org, released by this session', async () => {
  const route = await source('app/api/approvals/code/route.ts');
  // The lossy map back from the session's role is gone: it had no FINANCE_ADMIN.
  assert.doesNotMatch(route, /OWNER: 'admin'|APPROVER: 'checker'|\?\? 'viewer'/);
  assert.doesNotMatch(route, /ctx\.role/);
  assert.match(route, /findTokenByCode\(ctx\.userId, parsed\.data\.code, now\)/);
  assert.match(route, /resolveApproverById\(ctx\.userId, lookup\.token\.orgId\)/);
  assert.match(route, /approver: eligible\.approver/);

  // A refusal closes the proposal, and is handled before any settlement.
  const refusedAt = route.indexOf('result.tally.refused');
  const unanimousAt = route.indexOf('result.tally.unanimous');
  assert.ok(refusedAt > 0 && refusedAt < unanimousAt);
  assert.match(route, /refuseFromBallot\(lookup\.token\.proposalId\)/);

  // The signed-in approver releases, as the session the replay will run as.
  assert.match(
    route,
    /settleFullyApprovedProposal\(lookup\.token\.proposalId, \{\s*channel: 'code',\s*releaser: \{\s*userId: ctx\.userId,\s*sessionOrgId: ctx\.orgId,/,
  );
  assert.match(route, /requireCustomerRequest\(request\)/);
});

test('the webhook: a vote in the checked org, no approval by reply in code mode, never a release', async () => {
  const route = await source('app/api/webhooks/whatsapp/route.ts');
  const handler = route.slice(route.indexOf('export async function POST'));
  assert.match(handler, /findLiveTokenForUser\(resolved\.approver\.userId, now, \{ orgId \}\)/);

  const channelAt = handler.indexOf("lookup.token.channel !== 'reply'");
  const decisionAt = handler.indexOf('applyDecision({');
  assert.ok(channelAt > 0 && channelAt < decisionAt, 'the channel is checked before the vote is recorded');

  assert.match(handler, /refuseFromBallot\(lookup\.token\.proposalId\)/);
  assert.match(handler, /settleFullyApprovedProposal\(lookup\.token\.proposalId, \{\s*channel: 'whatsapp',\s*releaser: null,\s*\}\)/);
  // No session exists here, and none is invented.
  assert.doesNotMatch(handler, /releaser: \{|cookie/);
});

test('the submit route takes the same walk and the same release', async () => {
  const route = await source('app/api/proposals/[id]/submit/route.ts');
  assert.match(route, /evaluateAtApproval\(store, \{/);
  assert.match(route, /releaseApproved\(store, id, \{/);
  // The walk lives in one place, so it cannot drift from the ballot channels'.
  assert.doesNotMatch(route, /type: 'POLICY_EVALUATED'|type: 'QUEUE_FOR_APPROVAL'|type: 'MARK_APPROVED'|type: 'SIGN'/);
  assert.match(route, /proposal\.createdBy !== AGENT_ACTOR_ID && proposal\.createdBy === ctx\.userId/);
});

test('settlement walks, then counts, then releases, and never replays without a session', async () => {
  const settle = await source('lib/server/approval-settle.ts');
  const body = settle.slice(settle.indexOf('export async function settleBallots'));
  const walkAt = body.indexOf('evaluateAtApproval(');
  const countAt = body.indexOf('recordApprovals(');
  const releaseAt = body.indexOf('releaseApproved(');
  assert.ok(walkAt > 0 && walkAt < countAt && countAt < releaseAt, 'policy first, ballots second, release last');
  assert.doesNotMatch(settle, /cookie: ''/);
  assert.doesNotMatch(settle, /signedBy: 'approvers'/, 'a signature names a person');
});
