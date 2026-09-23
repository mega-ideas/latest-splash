import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { evaluatePolicy } from '../lib/policy/evaluate.ts';
import { resolveComplianceForProposal } from '../lib/compliance/proposal-screening.ts';

/**
 * x402 phase 2b — a pasted challenge becomes a proposal a human approves.
 *
 * Every assertion here is a control, not a feature: the proposal is Tier 0,
 * its payee is untrusted evidence, the payout minimum does not apply but the
 * approval rule always does, an unscreened EVM payee is held by compliance
 * like any other unscreened beneficiary, and execution refuses it by name.
 */

const now = '2026-07-01T00:00:00.000Z';
const future = '2026-07-01T01:00:00.000Z';

const CHALLENGE = JSON.stringify({
  x402Version: 1,
  accepts: [
    {
      scheme: 'exact',
      network: 'arbitrum-sepolia',
      maxAmountRequired: '10000',
      resource: 'https://api.example.com/reports/fx-summary',
      description: 'One FX summary report',
      payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
      maxTimeoutSeconds: 120,
      asset: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
    },
  ],
});

function x402Proposal(amountMicro = 10_000n, overrides = {}) {
  return {
    id: 'prop-x402-1',
    idempotencyKey: 'idem-x402-1',
    kind: 'X402_PAYMENT',
    status: 'SIMULATED',
    tier: 'TIER_0_PROPOSE',
    orgId: 'org-1',
    corridor: 'X402_ARBITRUM_SEPOLIA',
    unsignedTxBytes: 'dW5zaWduZWQ=',
    explain: {
      recommendation: 'x402',
      financialImpact: { amountIn: amountMicro, currencyIn: 'USDC' },
      evidence: [{ source: 'X402_CHALLENGE', ref: 'arbitrum-sepolia:0x2096:0.010000', observedAt: now, trusted: false, status: 'LIVE' }],
      confidence: 0.4,
      risk: 'HIGH',
      requiredApprovers: 0,
      reasoningTraceRef: 'pending-walrus:x402',
    },
    createdBy: 'OXWAL',
    createdAt: now,
    expiresAt: future,
    approvals: [],
    ...overrides,
  };
}

function sim(amountMicro) {
  return {
    ok: true,
    balanceChanges: [{ owner: 'payer', coinType: 'USDC', amount: `-${amountMicro}` }],
    gasSponsored: true,
    simulatedAt: now,
  };
}

const policy = {
  orgId: 'org-1',
  tier1ThresholdUsd: BigInt(5_000_000),
  dualApprovalThresholdUsd: BigInt(50_000_000),
  whitelistedAutoKinds: ['TREASURY_ALLOCATE', 'X402_PAYMENT'],
  operatingMinimumByCorridor: {},
  perCorridorState: {},
  globalState: 'ARMED',
};

const clear = { kytPassed: true, kybStatus: 'VERIFIED', sanctionsClear: true, flags: [] };

test('Zeke drafts an x402 proposal: Tier 0, exact USDC, untrusted payee, and it says approval does not pay', async () => {
  const { oxwalTools } = await import('../lib/agent/oxwal.ts');
  const proposal = await oxwalTools.proposeX402Payment({ orgId: 'org-1', challenge: CHALLENGE });

  assert.equal(proposal.kind, 'X402_PAYMENT');
  assert.equal(proposal.tier, 'TIER_0_PROPOSE', 'never auto-executable');
  assert.equal(proposal.corridor, 'X402_ARBITRUM_SEPOLIA');
  assert.equal(proposal.explain.financialImpact.amountIn, 10_000n, 'USDC base units are USD micro, exactly');
  assert.equal(proposal.explain.financialImpact.currencyIn, 'USDC');

  const ev = proposal.explain.evidence.find((item) => item.source === 'X402_CHALLENGE');
  assert.ok(ev, 'the payee travels as x402 challenge evidence');
  assert.equal(ev.trusted, false, 'a pasted challenge is never trusted');
  assert.equal(proposal.explain.evidence.some((item) => item.source === 'COUNTERPARTY'), false, 'an EVM payee is not a Splash counterparty');

  assert.match(proposal.explain.recommendation, /Approving records the decision; it does not pay/);
  assert.equal(proposal.createdBy, 'OXWAL', 'the persisted actor id, whatever the display name');
});

test('the payout minimum does not apply to a one-cent x402 payment — the approval rule does', () => {
  const amount = 10_000n; // $0.01
  const decision = evaluatePolicy({
    proposal: x402Proposal(amount, { simulation: sim(amount) }),
    actor: 'OWNER',
    policy,
    simulation: sim(amount),
    compliance: clear,
    now,
  });
  assert.equal(decision.outcome, 'REQUIRE_APPROVAL', 'not BLOCKed as below the payout minimum');
  assert.equal(decision.approvers, 1);
});

test('x402 never auto-executes, even when an org whitelists the kind', () => {
  const amount = 10_000n;
  const decision = evaluatePolicy({
    proposal: x402Proposal(amount, { tier: 'TIER_2_SCOPED_AUTO', simulation: sim(amount) }),
    actor: 'OWNER',
    policy, // whitelistedAutoKinds includes X402_PAYMENT on purpose
    simulation: sim(amount),
    compliance: clear,
    now,
  });
  assert.equal(decision.outcome, 'REQUIRE_APPROVAL');
});

test('above the dual threshold, two humans approve', () => {
  const amount = 60_000_000n; // $60 against a $50 dual threshold
  const decision = evaluatePolicy({
    proposal: x402Proposal(amount, { simulation: sim(amount) }),
    actor: 'OWNER',
    policy,
    simulation: sim(amount),
    compliance: clear,
    now,
  });
  assert.equal(decision.outcome, 'REQUIRE_APPROVAL');
  assert.equal(decision.approvers, 2);
});

test('an unscreened EVM payee is held by compliance, like any unscreened beneficiary', () => {
  const compliance = resolveComplianceForProposal(x402Proposal());
  assert.equal(compliance.kytPassed, false);
  assert.ok(compliance.flags.includes('NO_SCREENING_RECORD'));

  const amount = 10_000n;
  const decision = evaluatePolicy({
    proposal: x402Proposal(amount, { simulation: sim(amount) }),
    actor: 'OWNER',
    policy,
    simulation: sim(amount),
    compliance,
    now,
  });
  assert.equal(decision.outcome, 'BLOCK');
  assert.equal(decision.reason, 'compliance hold', 'compliance runs BEFORE the x402 branch');
});

test('a zero amount is blocked rather than approved', () => {
  const decision = evaluatePolicy({
    proposal: x402Proposal(0n, { simulation: sim(0n) }),
    actor: 'OWNER',
    policy,
    simulation: sim(0n),
    compliance: clear,
    now,
  });
  assert.equal(decision.outcome, 'BLOCK');
});

test('execution refuses x402 by name — recorded, not paid, and never "settles elsewhere"', async () => {
  const { executeApprovedProposal } = await import('../lib/server/approval-execution.ts');
  const outcome = await executeApprovedProposal(x402Proposal(), { challenge: CHALLENGE }, {});
  assert.equal(outcome.state, 'SKIPPED');
  assert.match(outcome.detail, /Approved and recorded — not paid/);
  assert.match(outcome.detail, /session mandate/);
  assert.doesNotMatch(outcome.detail, /their own path/, 'there is no path; the default message would be a lie');
});

test('the burst limits count x402 as outbound', async () => {
  const anomaly = await readFile(new URL('../lib/safety/anomaly.ts', import.meta.url), 'utf8');
  assert.match(anomaly, /OUTBOUND_KINDS = new Set\(\[[^\]]*'X402_PAYMENT'/);
});

test('the proposer is on the PROPOSE side, registered last, and the prompt says approval does not pay', async () => {
  const { OXWAL_TOOL_REGISTRY, PROPOSE_TOOL_NAMES } = await import('../lib/agent/oxwal.ts');
  assert.equal(PROPOSE_TOOL_NAMES[PROPOSE_TOOL_NAMES.length - 1], 'proposeX402Payment');
  const def = OXWAL_TOOL_REGISTRY.find((tool) => tool.name === 'proposeX402Payment');
  assert.equal(def.category, 'PROPOSE');
  assert.match(def.description, /never pays/);

  const agent = await readFile(new URL('../lib/agent/oxwal.ts', import.meta.url), 'utf8');
  assert.match(agent, /approving records the decision and does not pay/);
});
