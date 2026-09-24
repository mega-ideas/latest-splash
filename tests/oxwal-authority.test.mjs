import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';

import * as schema from '../lib/db/schema.ts';
import { createAccount, markEmailVerified } from '../lib/auth/accounts.ts';
import {
  grantMembership,
  resolveAuthorityFromDb,
  UnauthorizedError,
} from '../lib/auth/authority.ts';
import {
  assertCleanBody,
  FORBIDDEN_BODY_FIELDS,
  ProvenanceViolationError,
} from '../lib/auth/provenance-guard.ts';
import { resolveComplianceForProposal } from '../lib/compliance/proposal-screening.ts';
import { evaluatePolicy } from '../lib/policy/evaluate.ts';
import { serverDefaultOrgPolicy } from '../lib/policy/org-policy.ts';
import { canonFromProposal, canonicalApprovalHash, proposalApprovalHash } from '../lib/proposals/canonical-hash.ts';
import {
  InMemoryProposalStore,
  ProposalStateError,
  reviseProposalCanon,
  transitionProposal,
  withApprovalCanon,
} from '../lib/queue/proposal-state.ts';
import { authorizeProposalSubmission } from '../lib/safety/submit-guard.ts';
import { evidenceQualityOf, makeEnvelope, classify } from '../lib/agent/envelope.ts';
import {
  executeOxwalTool,
  proposeTreasuryAllocation,
  resetOxwalFixtures,
  runOxwalAgent,
} from '../lib/agent/oxwal.ts';

/**
 * Track A §14.10–14.16 — server-owned authority, canonical approval hash,
 * and truth-envelope acceptance tests.
 */

// Treasury proposals and treasury/balance reads exist only in the custody
// phase, and 14.15 exercises them, so this file runs with the custody package
// configured. The Phase 0 refusal is pinned in tests/custody-phase-surfaces.
process.env.SPLASH_CUSTODY_PACKAGE_ID = '0x' + 'cd'.repeat(32);

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
  return { client, db };
}

const nowIso = () => new Date().toISOString();

function proposalFixture(overrides = {}) {
  const base = {
    id: 'prop_authority_test',
    idempotencyKey: 'idem_authority_test',
    kind: 'PAYMENT',
    status: 'PENDING_APPROVAL',
    tier: 'TIER_0_PROPOSE',
    orgId: 'demo-business',
    corridor: 'USD_PHP',
    unsignedTxBytes: 'dW5zaWduZWQ=',
    createdBy: 'OXWAL',
    createdAt: nowIso(),
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    approvals: [],
    explain: {
      recommendation: 'test payment',
      financialImpact: { amountIn: BigInt(5_000_000_000), currencyIn: 'USD', amountOut: BigInt(282_100_000_000), currencyOut: 'PHP', feeBps: 80 },
      evidence: [{ source: 'COUNTERPARTY', ref: 'cp_acme_ph', observedAt: nowIso(), trusted: true, status: 'DEMO' }],
      confidence: 0.8,
      risk: 'MEDIUM',
      requiredApprovers: 2,
      reasoningTraceRef: 'trace_test',
      evidenceQuality: 'CONTAINS_DEMO_DATA',
    },
    simulation: {
      ok: true,
      balanceChanges: [
        { owner: 'org', coinType: 'USD', amount: '-5000000000' },
        { owner: 'cp_acme_ph', coinType: 'PHP', amount: '282100000000' },
      ],
      gasSponsored: true,
      simulatedAt: nowIso(),
    },
  };
  return { ...base, ...overrides };
}

// ── 14.10 PROVENANCE ────────────────────────────────────────────────────────

test('14.10 provenance — every authority-shaped body field is rejected with a ProvenanceViolation', () => {
  for (const field of FORBIDDEN_BODY_FIELDS) {
    assert.throws(
      () => assertCleanBody({ signatureRef: 'sig_1', [field]: 'APPROVER' }, 'test-route'),
      ProvenanceViolationError,
      `field ${field} must be rejected`,
    );
  }
});

test('14.10 provenance — a clean client body passes and non-objects are ignored', () => {
  assert.doesNotThrow(() => assertCleanBody({ signatureRef: 'sig_1', decision: 'APPROVE', approvalHash: 'abc' }));
  assert.doesNotThrow(() => assertCleanBody({ message: 'pay inv_demo_acme_5000', history: [] }));
  assert.doesNotThrow(() => assertCleanBody(null));
  assert.doesNotThrow(() => assertCleanBody('string'));
});

// ── 14.11 COMPLIANCE DEFAULT ────────────────────────────────────────────────

test('14.11 compliance default — a beneficiary with NO screening record is BLOCKED, never clear', () => {
  resetOxwalFixtures();
  const proposal = proposalFixture({
    explain: {
      ...proposalFixture().explain,
      evidence: [{ source: 'COUNTERPARTY', ref: 'cp_ghost_never_screened', observedAt: nowIso(), trusted: true, status: 'DEMO' }],
    },
  });

  const compliance = resolveComplianceForProposal(proposal);
  assert.equal(compliance.kytPassed, false);
  assert.equal(compliance.sanctionsClear, false);
  assert.ok(compliance.flags.includes('COUNTERPARTY_NOT_FOUND'));

  const decision = evaluatePolicy({
    proposal,
    actor: 'APPROVER',
    policy: serverDefaultOrgPolicy('demo-business'),
    simulation: proposal.simulation,
    compliance,
  });
  assert.deepEqual(decision, { outcome: 'BLOCK', reason: 'compliance hold' });
});

test('14.11 compliance default — outbound money with no counterparty evidence at all is BLOCKED', () => {
  const proposal = proposalFixture({
    explain: { ...proposalFixture().explain, evidence: [] },
  });
  const compliance = resolveComplianceForProposal(proposal);
  assert.equal(compliance.kytPassed, false);
  assert.ok(compliance.flags.includes('NO_SCREENING_RECORD'));
});

test('14.11 compliance — a verified, screened beneficiary still clears', () => {
  resetOxwalFixtures();
  const proposal = proposalFixture();
  const compliance = resolveComplianceForProposal(proposal);
  assert.equal(compliance.kytPassed, true);
  assert.equal(compliance.kybStatus, 'VERIFIED');
  assert.deepEqual(compliance.flags, []);
});

// ── 14.12 SESSION AUTHORITY ─────────────────────────────────────────────────

test('14.12 session authority — role is provably DB-derived and re-read on every request', async () => {
  const { client, db } = await migratedDb();
  const email = 'ops@splash.finance';

  // No membership row → unauthorized, not a permissive default.
  await assert.rejects(() => resolveAuthorityFromDb(db, email), UnauthorizedError);

  // A grant now requires an account with a proven mailbox (WS1, X5).
  await createAccount(db, { email, password: 'correct-horse-battery-staple-9', name: 'Ops' });
  await markEmailVerified(db, email);
  await grantMembership(db, { email, orgId: 'demo-business', role: 'maker' });
  const asMaker = await resolveAuthorityFromDb(db, email);
  assert.equal(asMaker.role, 'MAKER');
  assert.equal(asMaker.orgId, 'demo-business');
  assert.ok(asMaker.policy.tier1ThresholdUsd > BigInt(0));

  // Same request replayed after a DB role change resolves the NEW role.
  await db.update(schema.memberships).set({ role: 'checker' }).where(eq(schema.memberships.userId, asMaker.userId));
  const asChecker = await resolveAuthorityFromDb(db, email);
  assert.equal(asChecker.role, 'APPROVER');
  assert.equal(asChecker.userId, asMaker.userId);

  await client.close();
});

test('14.12 session authority — the org policy record round-trips through the database', async () => {
  const { client, db } = await migratedDb();
  await createAccount(db, { email: 'ops@splash.finance', password: 'correct-horse-battery-staple-9', name: 'Ops' });
  await markEmailVerified(db, 'ops@splash.finance');
  await grantMembership(db, { email: 'ops@splash.finance', orgId: 'demo-business', role: 'checker' });
  const first = await resolveAuthorityFromDb(db, 'ops@splash.finance');
  const again = await resolveAuthorityFromDb(db, 'ops@splash.finance');
  assert.equal(first.policy.dualApprovalThresholdUsd, again.policy.dualApprovalThresholdUsd);
  assert.deepEqual(again.policy.whitelistedAutoKinds, ['TREASURY_ALLOCATE']);
  await client.close();
});

// ── 14.13 APPROVAL HASH BINDING ─────────────────────────────────────────────

test('14.13 approval hash — server-side canon mutation voids prior approvals and old-hash re-approval is rejected', () => {
  const store = new InMemoryProposalStore();
  const created = store.create(proposalFixture());
  assert.equal(created.version, 1);
  assert.equal(typeof created.approvalHash, 'string');
  const v1Hash = created.approvalHash;

  const approvedOnce = store.transition(created.id, {
    type: 'APPROVE',
    approval: { userId: 'approver_1', role: 'APPROVER', signedAt: nowIso() },
  });
  assert.equal(approvedOnce.approvals.length, 1);

  // Simulate a route/quote refresh: the amount changes server-side.
  const revised = store.revise(created.id, { financialImpact: { amountOut: BigInt(283_000_000_000) } });
  assert.equal(revised.version, 2);
  assert.notEqual(revised.approvalHash, v1Hash);
  assert.deepEqual(revised.approvals, [], 'prior approvals never survive a canon mutation');
  assert.equal(revised.status, 'SIMULATED', 'the proposal re-enters the flow before the approval gate');

  // Re-approval against the OLD hash must be rejected (the submit route
  // compares the client's reviewed hash to a fresh recompute of the row).
  const currentHash = proposalApprovalHash(revised);
  assert.equal(currentHash, revised.approvalHash);
  assert.notEqual(v1Hash, currentHash);
});

test('14.13 approval hash — a canon mutation that skips versioning is caught at approval time', () => {
  const anchored = withApprovalCanon(proposalFixture());
  // Illegal direct mutation: amount changed, hash and version untouched.
  const tampered = {
    ...anchored,
    explain: {
      ...anchored.explain,
      financialImpact: { ...anchored.explain.financialImpact, amountOut: BigInt(1) },
    },
  };
  assert.throws(
    () => transitionProposal(tampered, {
      type: 'APPROVE',
      approval: { userId: 'approver_1', role: 'APPROVER', signedAt: nowIso() },
    }),
    (error) => error instanceof ProposalStateError && /hash mismatch/.test(error.message),
  );
});

test('14.13 approval hash — deterministic serialization: key order never changes the digest', () => {
  const canon = canonFromProposal(withApprovalCanon(proposalFixture()));
  const shuffled = Object.fromEntries(Object.entries(canon).reverse());
  assert.equal(canonicalApprovalHash(canon), canonicalApprovalHash(shuffled));
});

// ── 14.14 TOCTOU RE-EVAL ────────────────────────────────────────────────────

test('14.14 TOCTOU — submission after quote expiry is blocked and needs re-quote + re-approval', () => {
  resetOxwalFixtures();
  // Own org: the workspace circuit-breaker file may hold a paused demo org.
  const proposal = withApprovalCanon(proposalFixture({
    orgId: 'org_toctou_test',
    status: 'APPROVED',
    expiresAt: new Date(Date.now() - 1000).toISOString(),
    approvals: [
      { userId: 'approver_1', role: 'APPROVER', signedAt: nowIso() },
      { userId: 'approver_2', role: 'APPROVER', signedAt: nowIso() },
    ],
  }));

  // Approval happened while the quote was valid; execution is attempted after
  // expiry — the guard re-evaluates policy NOW and blocks.
  assert.throws(
    () => authorizeProposalSubmission({
      proposal,
      actor: 'APPROVER',
      policy: serverDefaultOrgPolicy('org_toctou_test'),
      simulation: proposal.simulation,
      compliance: resolveComplianceForProposal(proposal),
      signatureRef: 'sig_late',
      signedBy: 'approver_2',
    }),
    (error) => error instanceof ProposalStateError && /quote expired/.test(error.message),
  );

  // The recovery path is a re-quote: revising expiry bumps the version and
  // voids the stale approvals, forcing re-approval of the fresh quote.
  const requoted = reviseProposalCanon(proposal, { expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString() });
  assert.equal(requoted.version, 2);
  assert.deepEqual(requoted.approvals, []);
});

// ── 14.15 ENVELOPE HONESTY ──────────────────────────────────────────────────

test('14.15 envelope — fixture-backed tools return status DEMO, never LIVE', async () => {
  resetOxwalFixtures();
  const balances = await executeOxwalTool('getBalances', { orgId: 'demo-business' });
  assert.equal(balances.status, 'DEMO');
  assert.equal(balances.source, 'fixture.balances');
  assert.ok(balances.data.balances.length > 0);

  const netting = await executeOxwalTool('getNettingOpportunities', { orgId: 'demo-business' });
  assert.equal(netting.status, 'MODELED');

  assert.equal(classify('ledger.postgres', new Date()), 'LIVE');
  assert.equal(classify('ledger.postgres', new Date(Date.now() - 60_000), 30), 'STALE');
  assert.equal(makeEnvelope({ data: 1, source: 'demo.x' }).status, 'DEMO');
});

test('14.15 envelope — a proposal built from fixture evidence carries CONTAINS_DEMO_DATA and policy forces human approval', async () => {
  resetOxwalFixtures();
  const proposal = await proposeTreasuryAllocation({ orgId: 'demo-business', amountUsd: 100, corridor: 'MY_PH' });
  assert.equal(proposal.explain.evidenceQuality, 'CONTAINS_DEMO_DATA');

  // TIER_2 whitelisted treasury allocation would auto-execute — but demo
  // evidence forces a human into the loop, whatever the autonomy tier.
  const decision = evaluatePolicy({
    proposal: { ...proposal, status: 'SIMULATED' },
    actor: 'OWNER',
    policy: serverDefaultOrgPolicy('demo-business'),
    simulation: proposal.simulation ?? { ok: true, balanceChanges: [], gasSponsored: true, simulatedAt: nowIso() },
    compliance: resolveComplianceForProposal(proposal),
  });
  assert.equal(decision.outcome, 'REQUIRE_APPROVAL');

  // The same proposal with ALL_LIVE evidence would auto-execute (the flag is
  // the only difference) — proving the force-human condition is the envelope.
  const liveDecision = evaluatePolicy({
    proposal: { ...proposal, status: 'SIMULATED', explain: { ...proposal.explain, evidenceQuality: 'ALL_LIVE' } },
    actor: 'OWNER',
    policy: serverDefaultOrgPolicy('demo-business'),
    simulation: proposal.simulation ?? { ok: true, balanceChanges: [], gasSponsored: true, simulatedAt: nowIso() },
    compliance: resolveComplianceForProposal(proposal),
  });
  assert.equal(liveDecision.outcome, 'AUTO_EXECUTE');
});

test('14.15 envelope — evidenceQualityOf is ALL_LIVE only when every item is LIVE', () => {
  assert.equal(evidenceQualityOf([{ status: 'LIVE' }, { status: 'LIVE' }]), 'ALL_LIVE');
  assert.equal(evidenceQualityOf([{ status: 'LIVE' }, { status: 'DEMO' }]), 'CONTAINS_DEMO_DATA');
  assert.equal(evidenceQualityOf([{ status: 'LIVE' }, {}]), 'CONTAINS_DEMO_DATA');
  assert.equal(evidenceQualityOf([]), 'CONTAINS_DEMO_DATA');
});

test('14.15 envelope — the agent chat answer about balances says the figures are demo data', async () => {
  let text = '';
  for await (const event of runOxwalAgent({ message: 'What is my balance?', forceLocal: true })) {
    if (event.type === 'delta') text += event.text;
  }
  assert.match(text, /demo data/i);
});

// ── 14.16 MAKER ≠ CHECKER (regression) ──────────────────────────────────────

test('14.16 maker≠checker — the maker cannot approve their own proposal (DB-derived identity)', () => {
  const proposal = withApprovalCanon(proposalFixture({ createdBy: 'op_maker@splash.finance' }));
  assert.throws(
    () => transitionProposal(proposal, {
      type: 'APPROVE',
      approval: { userId: 'op_maker@splash.finance', role: 'APPROVER', signedAt: nowIso() },
    }),
    (error) => error instanceof ProposalStateError && /maker cannot approve/.test(error.message),
  );
});

test('14.16 maker≠checker — dual control requires two DISTINCT approver userIds', () => {
  const store = new InMemoryProposalStore();
  store.create(proposalFixture());
  store.transition('prop_authority_test', {
    type: 'APPROVE',
    approval: { userId: 'approver_1', role: 'APPROVER', signedAt: nowIso() },
  });
  assert.throws(
    () => store.transition('prop_authority_test', {
      type: 'APPROVE',
      approval: { userId: 'approver_1', role: 'APPROVER', signedAt: nowIso() },
    }),
    (error) => error instanceof ProposalStateError && /distinct approver/.test(error.message),
  );
  const done = store.transition('prop_authority_test', {
    type: 'APPROVE',
    approval: { userId: 'approver_2', role: 'APPROVER', signedAt: nowIso() },
  });
  assert.equal(done.status, 'APPROVED');
});
