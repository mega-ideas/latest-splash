import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/**
 * A treasury move above the approval threshold, carried out when it is approved.
 *
 * `/api/treasury` proposed its moves as kind PAYMENT. The executor replays a
 * PAYMENT through `/api/transfers/authorize`, which rejected the
 * `{ action, amountUsd }` body, so the move was recorded FAILED; in-app it was
 * held for compliance first, a PAYMENT naming no beneficiary. Proposed under
 * the treasury kinds, the moves are replayed through `/api/treasury` in
 * Phase 2, and the approval stands in for the maker's spent TOTP code there as
 * it does for a payroll run. In Phase 0 the route refuses every move and the
 * executor records an approved one as not executed
 * (tests/custody-phase-surfaces.test.mjs, tests/approval-execution.test.mjs).
 *
 * This file runs in Phase 2: a custody package is configured.
 */

process.env.SPLASH_CUSTODY_PACKAGE_ID = '0x' + 'cd'.repeat(32);
delete process.env.DATABASE_URL;

const { isTreasuryAction, treasuryApprovedMove, treasuryIdempotencyKey, treasuryProposalKind } = await import(
  '../lib/server/treasury-approval.ts'
);
const { proposeForApproval } = await import('../lib/server/dual-approval.ts');
const { resolveApprovalClaim } = await import('../lib/server/approved-proposal.ts');
const { executeApprovedProposal } = await import('../lib/server/approval-execution.ts');
const { getOxwalProposalStore } = await import('../lib/agent/oxwal.ts');
const { evaluatePolicy } = await import('../lib/policy/evaluate.ts');
const { serverDefaultOrgPolicy } = await import('../lib/policy/org-policy.ts');
const { resolveComplianceForProposal } = await import('../lib/compliance/proposal-screening.ts');
const { custodyPhaseEnabled } = await import('../lib/server/custody-phase.ts');
const { treasuryMoveSubstance } = await import('../lib/server/step-up-subjects.ts');

/** What the treasury route asks for above the threshold, built from the same helpers. */
async function proposeMove(orgId, action, amountUsd) {
  return proposeForApproval({
    orgId,
    createdBy: 'usr_maker',
    kind: treasuryProposalKind(action),
    amountUsd,
    targetCurrency: 'USD',
    recommendation: `${action === 'withdraw' ? 'Withdraw' : 'Allocate'} ${amountUsd} USD ${action === 'withdraw' ? 'from' : 'to'} Smart Treasury.`,
    passedChecks: [
      { source: 'COMPLIANCE', ref: 'KYB org state is ACTIVE, settlement not paused' },
      { source: 'BALANCE', ref: 'Ceilings, 0 USD spent today' },
      { source: 'TREASURY', ref: `Smart Treasury ${action}` },
    ],
    payload: { action, amountUsd },
    idempotencyKey: treasuryIdempotencyKey(orgId, action, amountUsd),
    approvalThresholdUsd: 50_000,
  });
}

/** The submit route's walk to SUBMITTED, with the one checker policy asks for. */
function approveAndSubmit(id) {
  const store = getOxwalProposalStore();
  const signedAt = new Date().toISOString();
  store.transition(id, { type: 'POLICY_EVALUATED', requiredApprovers: 1 });
  store.transition(id, { type: 'QUEUE_FOR_APPROVAL' });
  store.transition(id, { type: 'APPROVE', approval: { userId: 'usr_checker', role: 'APPROVER', signedAt } });
  store.transition(id, { type: 'SIGN', signatureRef: `sig:${id}`, signedBy: 'usr_checker', policyAuthorized: true, signedAt });
  return store.transition(id, { type: 'SUBMIT' });
}

function claimRequest(proposalId) {
  return new Request('http://localhost/api/treasury', {
    method: 'POST',
    headers: { 'x-splash-approved-proposal': proposalId },
  });
}

/** The route's claim, for a request carrying `body`. */
function resolveFor(proposalId, orgId, body) {
  return resolveApprovalClaim(claimRequest(proposalId), orgId, {
    kind: treasuryProposalKind(body.action),
    substance: treasuryMoveSubstance,
    body,
    consumer: 'treasury',
  });
}

function policyFor(proposal) {
  return evaluatePolicy({
    proposal,
    actor: 'APPROVER',
    policy: serverDefaultOrgPolicy(proposal.orgId),
    simulation: proposal.simulation,
    compliance: resolveComplianceForProposal(proposal),
  });
}

test('this file is Phase 2', () => {
  assert.equal(custodyPhaseEnabled(), true);
});

test('a move proposes TREASURY_ALLOCATE and a withdrawal TREASURY_REDEEM', () => {
  assert.equal(treasuryProposalKind('move'), 'TREASURY_ALLOCATE');
  assert.equal(treasuryProposalKind('withdraw'), 'TREASURY_REDEEM');
  assert.equal(isTreasuryAction('move'), true);
  assert.equal(isTreasuryAction('withdraw'), true);
  for (const action of ['cancel', 'MOVE', '', undefined, null, 1]) {
    assert.equal(isTreasuryAction(action), false, String(action));
  }
});

test('the treasury proposal can be approved; the same move as a PAYMENT could not', async () => {
  for (const action of ['move', 'withdraw']) {
    const proposal = await proposeMove(`org_policy_${action}`, action, '60000.00');
    assert.equal(proposal.kind, treasuryProposalKind(action));

    // A human approves it, and it is not a candidate for auto-execution: the
    // default policy whitelists TREASURY_ALLOCATE only for the agent's scoped
    // tier, never for a proposal the approval queue made.
    const decision = policyFor(proposal);
    assert.equal(decision.outcome, 'REQUIRE_APPROVAL', `${action}: ${JSON.stringify(decision)}`);
    assert.ok(decision.approvers >= 1);

    // As a PAYMENT it names no beneficiary, and approval stopped at the
    // compliance hold before any replay could even fail.
    assert.deepEqual(policyFor({ ...proposal, kind: 'PAYMENT' }), { outcome: 'BLOCK', reason: 'compliance hold' });
  }
});

test('the proposal keeps the move and not the spent TOTP code', async () => {
  const proposal = await proposeMove('org_payload', 'move', '75000.00');
  assert.deepEqual(proposal.executionPayload, { action: 'move', amountUsd: '75000.00' });
  assert.equal(proposal.idempotencyKey, 'treasury:org_payload:move:75000.00');
});

test('an approval stands in for the code on its own move, once', async () => {
  const orgId = 'org_cover';
  const proposal = await proposeMove(orgId, 'move', '80000.00');
  const replayBody = proposal.executionPayload;

  // Not approved yet: nothing stands in.
  assert.equal(treasuryApprovedMove(await resolveFor(proposal.id, orgId, replayBody)), null);

  approveAndSubmit(proposal.id);

  // Not another amount, direction or org — and trying does not spend it.
  for (const [name, body, org] of [
    ['another amount', { action: 'move', amountUsd: '80000.01' }, orgId],
    ['ten times the amount', { action: 'move', amountUsd: '800000.00' }, orgId],
    ['the other direction', { action: 'withdraw', amountUsd: '80000.00' }, orgId],
    ['another org', replayBody, 'org_other'],
  ]) {
    const claim = await resolveFor(proposal.id, org, body);
    assert.equal(claim.approved, false, name);
    assert.equal(treasuryApprovedMove(claim), null, name);
  }

  // Its own move, as the replay posts it: the approval stands in.
  const claim = await resolveFor(proposal.id, orgId, replayBody);
  assert.equal(claim.approved, true);
  assert.equal(treasuryApprovedMove(claim), proposal.id);

  // And it was spent doing so: the same move again needs its own code.
  const again = await resolveFor(proposal.id, orgId, replayBody);
  assert.equal(again.reason, 'already used');
  assert.equal(treasuryApprovedMove(again), null);
});

test('in Phase 2 an approved move is replayed through /api/treasury, not skipped, and then spent', async () => {
  const orgId = 'org_replay';
  const proposal = await proposeMove(orgId, 'move', '65000.00');
  const submitted = approveAndSubmit(proposal.id);
  const outcome = await executeApprovedProposal(submitted, submitted.executionPayload ?? null, {
    cookie: '',
    origin: 'http://localhost',
  });
  // Outside Next the route module cannot load, so the replay fails here. What
  // matters is where it went: this case used to fall through to "settle
  // through their own path", and the PAYMENT-kind proposal went to
  // /api/transfers/authorize.
  assert.notEqual(outcome.state, 'SKIPPED', outcome.detail);
  assert.doesNotMatch(outcome.detail, /own path/);
  assert.doesNotMatch(outcome.detail, /transfers[\\/]authorize|Invalid transfer authorization/);
  // The replay never reached a route, so nothing in it spent the approval —
  // and it is spent all the same: one approval, one attempt.
  assert.equal((await resolveFor(proposal.id, orgId, submitted.executionPayload)).reason, 'already used');
});

// ── Source: the route and the executor ──────────────────────────────────────

const withoutComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
async function source(file) {
  return withoutComments(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'));
}

test('the route proposes under the treasury kinds, with the move and nothing else', async () => {
  const route = await source('app/api/treasury/route.ts');
  assert.match(route, /kind: treasuryProposalKind\(action\),\s*amountUsd: move\.amountUsd,/);
  assert.doesNotMatch(route, /kind: 'PAYMENT'/);
  assert.match(route, /payload: move,/);
  assert.match(route, /const move = \{ action, amountUsd: amountUsd\.toFixed\(2\) \};/);
  assert.doesNotMatch(route, /totp: body\.totp/, 'a spent single-use code has no business in the payload');
  assert.match(route, /idempotencyKey: treasuryIdempotencyKey\(orgId, action, move\.amountUsd\)/);
});

test('the route settles the action before it spends TOTP or opens an approval', async () => {
  const route = await source('app/api/treasury/route.ts');
  const actionAt = route.indexOf('if (!isTreasuryAction(action))');
  assert.ok(actionAt > 0);
  for (const later of ['resolveApprovalClaim(', 'verifyPayoutTotp(', 'proposeForApproval(', 'moveToTreasury(']) {
    assert.ok(actionAt < route.indexOf(later), `the action is validated before ${later}`);
  }
});

test('the approval of this move stands in for the second factor, and the claim is read first', async () => {
  const route = await source('app/api/treasury/route.ts');
  assert.match(
    route,
    /const approvalClaim = await resolveApprovalClaim\(request, orgId, \{\s*kind: treasuryProposalKind\(action\),\s*substance: treasuryMoveSubstance,\s*body,\s*consumer: 'treasury',\s*\}\);/,
  );
  assert.match(route, /if \(!treasuryApprovedMove\(approvalClaim\)\) \{\s*const totpVerdict = verifyPayoutTotp\(/);
  assert.ok(route.indexOf('resolveApprovalClaim(') < route.indexOf('verifyPayoutTotp('));
  assert.match(route, /limits\.requiresSecondApproval && !approvalClaim\.approved/);
});

test('the executor carries the treasury kinds out through /api/treasury', async () => {
  const execution = await source('lib/server/approval-execution.ts');
  const treasuryCase = execution.slice(
    execution.indexOf("case 'TREASURY_ALLOCATE':"),
    execution.indexOf('default:', execution.indexOf("case 'TREASURY_ALLOCATE':")),
  );
  // Phase 0 is unchanged: recorded, not executed.
  assert.match(treasuryCase, /if \(!custodyPhaseEnabled\(\)\) \{\s*return \{ state: 'SKIPPED'/);
  assert.match(treasuryCase, /return await executeTreasuryMove\(proposal, payload, context\);/);
  assert.match(execution, /const \{ authorizeTreasuryForApproval \} = await import\('\.\/approval-replay\.ts'\);/);

  const replay = await source('lib/server/approval-replay.ts');
  assert.match(replay, /await import\('@\/app\/api\/treasury\/route'\)/);
  assert.match(replay, /return replayThroughRoute\(POST, '\/api\/treasury', input\)/);
});
