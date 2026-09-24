import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  InMemoryProposalStore,
  ProposalStateError,
  transitionProposal,
} from '../lib/queue/proposal-state.ts';

const now = new Date('2026-07-01T00:00:00.000Z').toISOString();
const later = new Date('2026-07-01T01:00:00.000Z').toISOString();

function simulation(overrides = {}) {
  return {
    ok: true,
    balanceChanges: [{ owner: '0xpayer', coinType: '0x2::sui::SUI', amount: '-1000' }],
    gasSponsored: true,
    simulatedAt: now,
    ...overrides,
  };
}

function proposal(overrides = {}) {
  return {
    id: 'proposal-1',
    idempotencyKey: 'idem-1',
    kind: 'PAYMENT',
    status: 'DRAFTED',
    tier: 'TIER_0_PROPOSE',
    orgId: 'org-1',
    corridor: 'MY_PH',
    unsignedTxBytes: 'dW5zaWduZWQ=',
    explain: {
      recommendation: 'Pay the verified counterparty.',
      financialImpact: {
        amountOut: BigInt(1000),
        currencyOut: 'USDC',
      },
      evidence: [{
        source: 'COUNTERPARTY',
        ref: 'counterparty-1',
        observedAt: now,
        trusted: true,
      }],
      confidence: 0.92,
      risk: 'LOW',
      requiredApprovers: 0,
      reasoningTraceRef: 'walrus-reasoning-1',
    },
    createdBy: 'maker-1',
    createdAt: now,
    expiresAt: later,
    approvals: [],
    ...overrides,
  };
}

function approval(userId = 'approver-1') {
  return { userId, role: 'APPROVER', signedAt: now };
}

test('proposal lifecycle rejects illegal state transitions', () => {
  assert.throws(
    () => transitionProposal(proposal(), { type: 'MARK_APPROVED' }),
    ProposalStateError,
  );

  const simulated = transitionProposal(proposal(), {
    type: 'SIMULATION_COMPLETED',
    simulation: simulation(),
  });
  assert.equal(simulated.status, 'SIMULATED');

  const policyEvaluated = transitionProposal(simulated, {
    type: 'POLICY_EVALUATED',
    requiredApprovers: 1,
  });
  assert.equal(policyEvaluated.status, 'POLICY_EVALUATED');
  assert.equal(policyEvaluated.explain.requiredApprovers, 1);
});

test('failed simulations stop the proposal before approval', () => {
  const failed = transitionProposal(proposal(), {
    type: 'SIMULATION_COMPLETED',
    simulation: simulation({ ok: false, error: 'dry run failed' }),
  });

  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.simulation?.error, 'dry run failed');
  assert.throws(
    () => transitionProposal(failed, { type: 'POLICY_EVALUATED', requiredApprovers: 1 }),
    ProposalStateError,
  );
});

test('idempotency key returns the existing proposal instead of duplicating work', () => {
  // The fixture's clock. A proposal past its expiry no longer absorbs a
  // re-submission (tests/proposal-idempotency.test.mjs), and on the wall clock
  // this fixture expired on 2026-07-01.
  const store = new InMemoryProposalStore(undefined, { now: () => Date.parse(now) });
  const first = store.create(proposal({ id: 'proposal-1', idempotencyKey: 'same-intent' }));
  const replay = store.create(proposal({ id: 'proposal-2', idempotencyKey: 'same-intent' }));

  assert.equal(replay.id, first.id);
  assert.equal(store.get('proposal-2'), null);
});

test('maker-checker approvals require authorized and distinct approvers', () => {
  const pending = transitionProposal(
    transitionProposal(
      transitionProposal(proposal(), {
        type: 'SIMULATION_COMPLETED',
        simulation: simulation(),
      }),
      { type: 'POLICY_EVALUATED', requiredApprovers: 2 },
    ),
    { type: 'QUEUE_FOR_APPROVAL' },
  );

  assert.throws(
    () => transitionProposal(pending, { type: 'APPROVE', approval: approval('maker-1') }),
    /maker cannot approve/,
  );
  assert.throws(
    () => transitionProposal(pending, {
      type: 'APPROVE',
      approval: { userId: 'viewer-1', role: 'VIEWER', signedAt: now },
    }),
    /cannot approve/,
  );

  const onceApproved = transitionProposal(pending, { type: 'APPROVE', approval: approval('approver-1') });
  assert.equal(onceApproved.status, 'PENDING_APPROVAL');
  assert.throws(
    () => transitionProposal(onceApproved, { type: 'APPROVE', approval: approval('approver-1') }),
    /distinct approver/,
  );

  const fullyApproved = transitionProposal(onceApproved, { type: 'APPROVE', approval: approval('approver-2') });
  assert.equal(fullyApproved.status, 'APPROVED');
});

test('third-party outbound proposal cannot be submitted without signed policy-approved approval', () => {
  const approved = transitionProposal(
    transitionProposal(
      transitionProposal(
        transitionProposal(proposal(), {
          type: 'SIMULATION_COMPLETED',
          simulation: simulation(),
        }),
        { type: 'POLICY_EVALUATED', requiredApprovers: 1 },
      ),
      { type: 'QUEUE_FOR_APPROVAL' },
    ),
    { type: 'APPROVE', approval: approval() },
  );

  assert.equal(approved.status, 'APPROVED');
  assert.throws(
    () => transitionProposal(approved, { type: 'SUBMIT' }),
    /signed before submission/,
  );
  assert.throws(
    () => transitionProposal(approved, {
      type: 'SIGN',
      signatureRef: '',
      signedBy: 'approver-1',
      policyAuthorized: true,
      signedAt: now,
    }),
    /human signature reference/,
  );
  assert.throws(
    () => transitionProposal(approved, {
      type: 'SIGN',
      signatureRef: 'sig-1',
      signedBy: 'approver-1',
      policyAuthorized: false,
      signedAt: now,
    }),
    /policy authorization/,
  );

  const signed = transitionProposal(approved, {
    type: 'SIGN',
    signatureRef: 'sig-1',
    signedBy: 'approver-1',
    policyAuthorized: true,
    signedAt: now,
  });
  const submitted = transitionProposal(signed, { type: 'SUBMIT' });
  assert.equal(submitted.status, 'SUBMITTED');
});

test('state module does not expose sign or submit tools to the agent surface', async () => {
  const source = await readFile(new URL('../lib/queue/proposal-state.ts', import.meta.url), 'utf8');
  assert.equal(/export\s+(async\s+)?function\s+signProposal\b/.test(source), false);
  assert.equal(/export\s+(async\s+)?function\s+submitProposal\b/.test(source), false);
});
