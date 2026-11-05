import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_MIN_SETTLEMENT_USD,
  checkMinimumSettlement,
  minSettlementMicro,
  minSettlementUsd,
} from '../lib/policy/limits.ts';
import { evaluatePolicy } from '../lib/policy/evaluate.ts';

/**
 * Minimum settlement size ($100 by default) — enforced at four layers:
 * the agent's propose tools, the API routes, the policy engine (this file),
 * and the contract (ComplianceConfig.min_settlement_amount).
 */

const nowIso = () => new Date().toISOString();

function proposal(kind, amountUsd, overrides = {}) {
  return {
    id: 'prop_min_test',
    idempotencyKey: 'idem_min_test',
    kind,
    status: 'SIMULATED',
    tier: 'TIER_0_PROPOSE',
    orgId: 'org_min_test',
    corridor: 'USD_PHP',
    unsignedTxBytes: 'dW5zaWduZWQ=',
    createdBy: 'OXWAL',
    createdAt: nowIso(),
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    approvals: [],
    explain: {
      recommendation: 'test',
      financialImpact: {
        amountIn: BigInt(Math.round(amountUsd * 1_000_000)),
        currencyIn: 'USD',
        amountOut: BigInt(Math.round(amountUsd * 1_000_000)),
        currencyOut: 'USD',
      },
      evidence: [{ source: 'COUNTERPARTY', ref: 'cp_acme_ph', observedAt: nowIso(), trusted: true, status: 'LIVE' }],
      confidence: 0.9,
      risk: 'LOW',
      requiredApprovers: 1,
      reasoningTraceRef: 'trace',
      evidenceQuality: 'ALL_LIVE',
    },
    simulation: {
      ok: true,
      balanceChanges: [{ owner: 'org', coinType: 'USD', amount: String(Math.round(amountUsd * 1_000_000)) }],
      gasSponsored: true,
      simulatedAt: nowIso(),
    },
    ...overrides,
  };
}

const policy = {
  orgId: 'org_min_test',
  tier1ThresholdUsd: BigInt(5_000_000),
  dualApprovalThresholdUsd: BigInt(50_000_000_000),
  whitelistedAutoKinds: ['TREASURY_ALLOCATE'],
  operatingMinimumByCorridor: {},
  perCorridorState: {},
  globalState: 'ARMED',
};
const clearCompliance = { kytPassed: true, kybStatus: 'VERIFIED', sanctionsClear: true, flags: [] };

function evaluate(p) {
  return evaluatePolicy({ proposal: p, actor: 'APPROVER', policy, simulation: p.simulation, compliance: clearCompliance });
}

// ── the rule itself ─────────────────────────────────────────────────────────

test('the default floor is $100 and is expressed consistently in micro-USD', () => {
  assert.equal(DEFAULT_MIN_SETTLEMENT_USD, 100);
  assert.equal(minSettlementUsd({}), 100);
  assert.equal(minSettlementMicro({}), 100_000_000);
});

test('amounts at or above the floor pass; below it fail', () => {
  assert.equal(checkMinimumSettlement(100, 'transfer').ok, true, '$100 exactly must pass');
  assert.equal(checkMinimumSettlement(100.01, 'transfer').ok, true);
  assert.equal(checkMinimumSettlement(99.99, 'transfer').ok, false);
  assert.equal(checkMinimumSettlement(0.01, 'transfer').ok, false);
});

test('the floor fails closed on junk input', () => {
  for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(checkMinimumSettlement(bad, 'transfer').ok, false, `${bad} must be rejected`);
  }
});

test('a malformed or non-positive override cannot silently disable the floor', () => {
  assert.equal(minSettlementUsd({ MIN_SETTLEMENT_USD: 'abc' }), 100);
  assert.equal(minSettlementUsd({ MIN_SETTLEMENT_USD: '0' }), 100);
  assert.equal(minSettlementUsd({ MIN_SETTLEMENT_USD: '-50' }), 100);
  // A legitimate override is honoured.
  assert.equal(minSettlementUsd({ MIN_SETTLEMENT_USD: '250' }), 250);
});

test('the message names the batch total rather than the transfer for batches', () => {
  const batch = checkMinimumSettlement(40, 'batch');
  assert.equal(batch.ok, false);
  assert.match(batch.message, /batch total/i);
  assert.match(batch.message, /\$100\.00/);
});

// ── policy engine: the choke point every approval path shares ───────────────

test('policy BLOCKS an outbound payment below the minimum', () => {
  const decision = evaluate(proposal('PAYMENT', 25));
  assert.equal(decision.outcome, 'BLOCK');
  assert.match(decision.reason, /below minimum/i);
});

test('policy allows the same payment once it clears the minimum', () => {
  const decision = evaluate(proposal('PAYMENT', 100));
  assert.notEqual(decision.outcome, 'BLOCK');
});

test('the floor does not block internal transfers or treasury moves', () => {
  // The floor exists because of corridor/settlement fixed costs, which
  // internal movements do not incur.
  assert.notEqual(evaluate(proposal('INTERNAL_TRANSFER', 10)).outcome, 'BLOCK');
  assert.notEqual(evaluate(proposal('TREASURY_ALLOCATE', 10)).outcome, 'BLOCK');
});
