import assert from 'node:assert/strict';
import test from 'node:test';

import {
  executeOxwalTool,
  getRate,
  resetOxwalFixtures,
  resetOxwalProposalStore,
  upsertOxwalCounterpartyFixture,
} from '../lib/agent/oxwal.ts';
import { buildActionCardModel } from '../lib/agent/action-card.ts';
import { canonFromProposal, proposalApprovalHash } from '../lib/proposals/canonical-hash.ts';

/**
 * Zeke's FX rates come from Splash's corridor table. Proposals used to say
 * Pyth: evidence PYTH_RATE, a `pythPriceId` in the quote, "via Pyth" on the
 * card. New proposals name the corridor table; stored ones keep their field,
 * because it is inside the approval hash and their approvals must verify.
 */

const OBSERVED = '2026-09-20T09:00:00.000Z';

/** A proposal as stored before 2026-09-25, and its hash computed then. */
function legacyProposal() {
  return {
    id: 'prop_legacy_fx',
    version: 1,
    orgId: 'org_legacy',
    corridor: 'USD_PHP',
    expiresAt: '2026-09-20T10:00:00.000Z',
    explain: {
      financialImpact: {
        amountIn: 1_000_000_000n,
        amountOut: 56_420_000_000n,
        currencyIn: 'USD',
        currencyOut: 'PHP',
        feeBps: 80,
        fxRate: { value: '56.42', pythPriceId: '0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a', observedAt: OBSERVED },
      },
      evidence: [
        { source: 'COUNTERPARTY', ref: 'cp_acme_ph', observedAt: OBSERVED, trusted: true },
        { source: 'PYTH_RATE', ref: 'USD/PHP', observedAt: OBSERVED, trusted: true, status: 'DEMO' },
      ],
    },
  };
}
// Computed with the canon as it was at c1f59a6, before this change.
const LEGACY_HASH = 'f9e37da68116a7dc39ab2b77fc9bf3bfd209e40df638b5da33f19b8e45526057';

test('a proposal stored with the legacy pythPriceId hashes exactly as it did, so its approvals still verify', () => {
  const stored = legacyProposal();
  assert.equal(proposalApprovalHash(stored), LEGACY_HASH);
  assert.equal(canonFromProposal(stored).quoteId, `0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a@${OBSERVED}`);
});

async function newPayment() {
  resetOxwalFixtures();
  resetOxwalProposalStore();
  upsertOxwalCounterpartyFixture({ id: 'cp_fx_payee', name: 'FX Payee', kybStatus: 'VERIFIED', bankRefHash: 'fx-payee-bank-ref' });
  return executeOxwalTool('proposePayment', { orgId: 'demo-business', counterpartyId: 'cp_fx_payee', amountUsd: 100, currency: 'PHP' });
}

test('a new proposal names the corridor table, never Pyth, and says the rate is modelled', async () => {
  const proposal = await newPayment();
  const fx = proposal.explain.financialImpact.fxRate;
  assert.equal(fx.quoteRef, 'corridor:USD/PHP');
  assert.equal('pythPriceId' in fx, false);
  assert.equal(fx.value, '56.42');

  const rate = proposal.explain.evidence.find((item) => item.source === 'CORRIDOR_RATE');
  assert.ok(rate, 'the rate evidence names its source');
  assert.equal(rate.ref, 'USD/PHP');
  assert.equal(rate.status, 'MODELED', 'a configured reference rate is not a market reading');
  assert.equal(proposal.explain.evidence.some((item) => item.source === 'PYTH_RATE'), false);
  assert.doesNotMatch(JSON.stringify(proposal, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)), /pyth/i);
});

test('the new quote is in the canon: the stored hash verifies, and a different rate would not', async () => {
  const proposal = await newPayment();
  const fx = proposal.explain.financialImpact.fxRate;
  assert.equal(canonFromProposal(proposal).quoteId, `corridor:USD/PHP@${fx.observedAt}`);
  assert.equal(proposal.approvalHash, proposalApprovalHash(proposal));

  const swapped = structuredClone(proposal);
  swapped.explain.financialImpact.fxRate = { ...fx, quoteRef: 'corridor:USD/MYR' };
  assert.notEqual(proposalApprovalHash(swapped), proposal.approvalHash);
});

test('the card says where the rate came from, for new and stored proposals alike', async () => {
  const proposal = await newPayment();
  const fxRow = (p) => buildActionCardModel({ ...p, approvals: [] }).impactRows.find((r) => r.label === 'FX').value;
  assert.equal(fxRow(proposal), '56.42 (corridor reference rate)');

  const stored = legacyProposal();
  const legacyCard = fxRow({
    ...stored,
    kind: 'PAYMENT', status: 'SIMULATED', tier: 'T1', unsignedTxBytes: '', createdBy: 'OXWAL', createdAt: OBSERVED,
    explain: { ...stored.explain, recommendation: 'x', confidence: 0.5, risk: 'LOW', requiredApprovers: 1, reasoningTraceRef: 'r' },
    simulation: { ok: true, balanceChanges: [], gasSponsored: true, simulatedAt: OBSERVED },
  });
  assert.equal(legacyCard, '56.42 (corridor reference rate)', 'stored rows were never Pyth either');
});

test('getRate names its source: the corridor table, par for stablecoins, and no rate for anything else', async () => {
  const php = getRate({ pair: 'USD/PHP' });
  assert.deepEqual({ ...php, observedAt: 'x' }, { pair: 'USD/PHP', value: '56.4200', quoteRef: 'corridor:USD/PHP', observedAt: 'x', source: 'corridor_table' });
  assert.equal(getRate({ pair: 'USDC/USD' }).source, 'par_assumed');
  assert.throws(() => getRate({ pair: 'EUR/GBP' }), /no reference rate for EUR\/GBP/, 'it used to answer 1.0000, labelled Pyth');

  const envelope = await executeOxwalTool('getRate', { pair: 'USD/PHP' });
  assert.equal(envelope.source, 'model.corridor-table');
  assert.equal(envelope.status, 'MODELED');
});
