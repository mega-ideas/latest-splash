import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

import * as schema from '../lib/db/schema.ts';
import {
  appendScreeningResult,
  latestScreenings,
  loadLatestScreenings,
  payeeScreeningRefs,
  screenPayees,
  screeningRef,
  screeningSubjectForRef,
} from '../lib/server/screening-record.ts';
import {
  complianceFromRecord,
  describeComplianceHold,
  resolveDurableComplianceForProposal,
} from '../lib/compliance/proposal-screening.ts';
import { approvedBeneficiary, beneficiaryMatches } from '../lib/server/approved-proposal.ts';
import { insertRecipient } from '../lib/server/repository/recipients.ts';
import { evaluatePolicy } from '../lib/policy/evaluate.ts';
import { serverDefaultOrgPolicy } from '../lib/policy/org-policy.ts';

/**
 * Screening a payment's payees where an approval can read it.
 *
 * The approval-time compliance check looked every beneficiary up in the
 * agent's in-memory fixture, which no real beneficiary is ever written to. A
 * bank beneficiary from `transfers/authorize` was not found; a payroll run
 * named its payees in prose. Every real dual-approval payment stopped at
 * "compliance hold" for a reason no screening could change — and the replay
 * minted a new beneficiary record, so the executed transfer named someone
 * other than the approved proposal did.
 */

delete process.env.DATABASE_URL;

const ORG = 'org_screen';
const OTHER = 'org_other';
const NOW = new Date('2026-09-24T10:00:00.000Z');

const CLEAR_ON_RECORD = { verdict: 'CLEAR', reference: 'provider:1', screenedAt: NOW, recipientKyb: 'full' };

// ── Refs ────────────────────────────────────────────────────────────────────

test('a proposal names a saved beneficiary by id and a payroll payee by address', () => {
  assert.deepEqual(screeningSubjectForRef('rcpt_mfc8a1_x9y8z7w6'), { kind: 'RECIPIENT', recipientId: 'rcpt_mfc8a1_x9y8z7w6' });
  assert.deepEqual(screeningSubjectForRef('wallet: 0xABC '), { kind: 'WALLET_ADDRESS', address: '0xabc' });
  assert.equal(screeningRef({ kind: 'WALLET_ADDRESS', address: '0xabc' }), 'wallet:0xabc');
  // The agent's fixture counterparties keep their own lookup.
  assert.equal(screeningSubjectForRef('cp_acme_ph'), null);
  // The prose a payroll run used to carry names nobody.
  assert.equal(screeningSubjectForRef('12 payable rows, 0 blocked'), null);
  assert.equal(screeningSubjectForRef('wallet:'), null);
});

test('one ref per distinct payee, in the order the run lists them', () => {
  assert.deepEqual(
    payeeScreeningRefs([{ address: '0xAAA' }, { address: '0xbbb' }, { address: ' 0xaaa ' }, { address: '' }, {}]),
    ['wallet:0xaaa', 'wallet:0xbbb'],
  );
});

// ── From what is on record to a compliance answer ──────────────────────────

test('only a provider’s CLEAR and a verified beneficiary clear a bank payee', () => {
  const beneficiary = { kind: 'RECIPIENT', recipientId: 'rcpt_1' };
  assert.deepEqual(complianceFromRecord(beneficiary, CLEAR_ON_RECORD), {
    kytPassed: true, kybStatus: 'VERIFIED', sanctionsClear: true, flags: [],
  });

  const cases = {
    'not on record': [null, ['COUNTERPARTY_NOT_FOUND']],
    'never screened': [{ ...CLEAR_ON_RECORD, verdict: null }, ['NOT_SCREENED']],
    'listed': [{ ...CLEAR_ON_RECORD, verdict: 'BLOCK' }, ['SANCTIONS_HIT']],
    'under review': [{ ...CLEAR_ON_RECORD, verdict: 'REVIEW' }, ['SCREENING_UNDER_REVIEW']],
    'provider failed': [{ ...CLEAR_ON_RECORD, verdict: 'ERROR' }, ['SCREENING_ERROR']],
    // Accountability, not screening — accepted by the capped wallet lane,
    // not by a payout nobody has decided it may release.
    'attested by an admin': [{ ...CLEAR_ON_RECORD, verdict: 'ATTESTED' }, ['ATTESTATION_IS_NOT_SCREENING']],
    'screened, not verified': [{ ...CLEAR_ON_RECORD, recipientKyb: 'none' }, ['BENEFICIARY_KYB_INCOMPLETE']],
    'screened, basic verification only': [{ ...CLEAR_ON_RECORD, recipientKyb: 'basic' }, ['BENEFICIARY_KYB_INCOMPLETE']],
  };
  for (const [name, [recorded, flags]] of Object.entries(cases)) {
    const result = complianceFromRecord(beneficiary, recorded);
    for (const flag of flags) assert.ok(result.flags.includes(flag), `${name}: ${flag}`);
    assert.ok(result.flags.length > 0, `${name} must hold`);
  }
  assert.equal(complianceFromRecord(beneficiary, { ...CLEAR_ON_RECORD, recipientKyb: 'rejected' }).kybStatus, 'FAILED');
});

test('a payroll payee screened CLEAR is still held: whether that suffices is compliance’s decision', () => {
  const result = complianceFromRecord({ kind: 'WALLET_ADDRESS', address: '0xaaa' }, { verdict: 'CLEAR', reference: 'chainalysis:x', screenedAt: NOW });
  assert.equal(result.sanctionsClear, true, 'the screening is recorded faithfully');
  assert.deepEqual(result.flags, ['PAYEE_KYB_NOT_ESTABLISHED'], 'and the one thing policy still requires is named');
});

test('an approver is told why a payment is held, each reason once', () => {
  const text = describeComplianceHold({ flags: ['NOT_SCREENED', 'BENEFICIARY_KYB_INCOMPLETE', 'NOT_SCREENED'] });
  assert.equal(text, "a payee has not been screened; a beneficiary's own verification is not complete");
});

// ── The approval paths' check, end to end in policy ─────────────────────────

function transferProposal(ref, overrides = {}) {
  return {
    id: 'prop_t',
    kind: 'PAYMENT',
    orgId: ORG,
    tier: 'TIER_0_PROPOSE',
    corridor: 'PHP',
    status: 'PENDING_APPROVAL',
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    explain: {
      financialImpact: { amountIn: 25_000_000_000n, currencyIn: 'USD' },
      evidence: [
        { source: 'COMPLIANCE', ref: 'KYB org state is ACTIVE', observedAt: '', trusted: true },
        { source: 'COUNTERPARTY', ref, observedAt: '', trusted: true },
      ],
      requiredApprovers: 2,
    },
    simulation: { ok: true, balanceChanges: [{ owner: ORG, coinType: 'USDC', amount: '-25000000000' }], gasSponsored: false, simulatedAt: '' },
    ...overrides,
  };
}

const recordLoader = (records) => async (orgId, refs) => {
  assert.equal(orgId, ORG, 'read in the proposal’s own org');
  return new Map(refs.map((ref) => [ref, records[ref] ?? null]));
};

function policyOutcome(proposal, compliance) {
  return evaluatePolicy({
    proposal,
    actor: 'APPROVER',
    policy: serverDefaultOrgPolicy(ORG),
    simulation: proposal.simulation,
    compliance,
  });
}

test('the gate opens for a bank payee once the record says screened CLEAR and verified — and not before', async () => {
  const proposal = transferProposal('rcpt_abc_123');
  const clear = await resolveDurableComplianceForProposal(proposal, recordLoader({ rcpt_abc_123: CLEAR_ON_RECORD }));
  assert.deepEqual(policyOutcome(proposal, clear), { outcome: 'REQUIRE_APPROVAL', approvers: 2 });

  const unscreened = await resolveDurableComplianceForProposal(
    proposal,
    recordLoader({ rcpt_abc_123: { verdict: null, reference: null, screenedAt: null, recipientKyb: 'none' } }),
  );
  assert.deepEqual(policyOutcome(proposal, unscreened), { outcome: 'BLOCK', reason: 'compliance hold' });

  // Deleted, or another org's id: not on record here.
  const missing = await resolveDurableComplianceForProposal(proposal, recordLoader({}));
  assert.ok(missing.flags.includes('COUNTERPARTY_NOT_FOUND'));
});

test('a payroll run is held until every payee is screened, and then by the flagged decision', async () => {
  const proposal = transferProposal('wallet:0xaaa', {
    kind: 'BATCH_PAYOUT',
    explain: {
      financialImpact: { amountIn: 25_000_000_000n, currencyIn: 'USD' },
      evidence: [
        { source: 'COUNTERPARTY', ref: 'wallet:0xaaa', observedAt: '', trusted: true },
        { source: 'COUNTERPARTY', ref: 'wallet:0xbbb', observedAt: '', trusted: true },
      ],
      requiredApprovers: 2,
    },
  });
  const half = await resolveDurableComplianceForProposal(proposal, recordLoader({
    'wallet:0xaaa': { verdict: 'CLEAR', reference: 'c', screenedAt: NOW },
  }));
  assert.ok(half.flags.includes('COUNTERPARTY_NOT_FOUND'), 'one payee has no screening on record');
  const both = await resolveDurableComplianceForProposal(proposal, recordLoader({
    'wallet:0xaaa': { verdict: 'CLEAR', reference: 'c', screenedAt: NOW },
    'wallet:0xbbb': { verdict: 'CLEAR', reference: 'c', screenedAt: NOW },
  }));
  assert.equal(both.sanctionsClear, true);
  assert.deepEqual([...new Set(both.flags)], ['PAYEE_KYB_NOT_ESTABLISHED']);
  assert.deepEqual(policyOutcome(proposal, both), { outcome: 'BLOCK', reason: 'compliance hold' });
});

test('the agent’s own counterparties keep their fixture lookup beside the durable one', async () => {
  const { upsertOxwalCounterpartyFixture } = await import('../lib/agent/oxwal.ts');
  upsertOxwalCounterpartyFixture({ id: 'cp_screen_ok', name: 'Screened Co', kybStatus: 'VERIFIED', kytPassed: true, sanctionsClear: true });
  const proposal = transferProposal('cp_screen_ok');
  const compliance = await resolveDurableComplianceForProposal(proposal, async () => {
    throw new Error('a fixture ref must not reach the database');
  });
  assert.deepEqual(compliance.flags, []);
});

test('with no database there is no record, so nothing is clear', async () => {
  const lookup = await loadLatestScreenings(ORG, ['rcpt_abc_123', 'wallet:0xaaa', 'cp_acme_ph']);
  assert.deepEqual([...lookup.entries()], [['rcpt_abc_123', null], ['wallet:0xaaa', null]]);
});

// ── The record, in Postgres ─────────────────────────────────────────────────

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
  await client.exec(`INSERT INTO organizations (id, name) VALUES ('${ORG}', 'Screen Co'), ('${OTHER}', 'Other Co')`);
  return { client, db };
}

function bankRecipient(id, orgId, overrides = {}) {
  return {
    id,
    orgId,
    name: 'Manila Parts Supply',
    country: 'PH',
    bank: 'BPI',
    swift: 'BOPIPHMM',
    account: '001234567890',
    tier: 'PAYOUT_ONLY',
    kybStatus: 'full',
    createdVia: 'manual',
    ...overrides,
  };
}

test('a verdict is appended to the history and becomes the beneficiary’s latest — in its own org only', async () => {
  const { client, db } = await migratedDb();
  await insertRecipient(db, bankRecipient('rcpt_saved_1', ORG));
  await insertRecipient(db, bankRecipient('rcpt_theirs_1', OTHER));

  await appendScreeningResult(db, ORG, { kind: 'RECIPIENT', recipientId: 'rcpt_saved_1' }, {
    provider: 'test-provider', verdict: 'REVIEW', reference: 'case-1', screenedAt: NOW,
  });
  await appendScreeningResult(db, ORG, { kind: 'RECIPIENT', recipientId: 'rcpt_saved_1' }, {
    provider: 'test-provider', verdict: 'CLEAR', reference: 'case-1-closed', screenedAt: new Date(NOW.getTime() + 1000),
  });
  // Recorded under the wrong org: lands on nobody's row.
  await appendScreeningResult(db, ORG, { kind: 'RECIPIENT', recipientId: 'rcpt_theirs_1' }, {
    provider: 'test-provider', verdict: 'CLEAR', reference: 'x', screenedAt: NOW,
  });

  const lookup = await latestScreenings(db, ORG, ['rcpt_saved_1', 'rcpt_theirs_1', 'rcpt_nobody']);
  assert.equal(lookup.get('rcpt_saved_1').verdict, 'CLEAR');
  assert.equal(lookup.get('rcpt_saved_1').reference, 'case-1-closed');
  assert.equal(lookup.get('rcpt_saved_1').recipientKyb, 'full');
  assert.equal(lookup.get('rcpt_theirs_1'), null, 'another org’s beneficiary is not on record here');
  assert.equal(lookup.get('rcpt_nobody'), null);

  const theirs = await client.query(`SELECT screening_verdict FROM suppliers WHERE id = 'rcpt_theirs_1'`);
  assert.equal(theirs.rows[0].screening_verdict, null, 'a verdict never lands on another tenant’s beneficiary');

  const history = await client.query(`SELECT verdict FROM screening_results WHERE subject_id = 'rcpt_saved_1' ORDER BY screened_at`);
  assert.deepEqual(history.rows.map((r) => r.verdict), ['REVIEW', 'CLEAR'], 'a later verdict never erases an earlier one');
  await client.close();
});

test('a payroll payee’s latest verdict is its newest, and per org', async () => {
  const { client, db } = await migratedDb();
  const payee = { kind: 'WALLET_ADDRESS', address: '0xaaa' };
  await appendScreeningResult(db, ORG, payee, { provider: 'chainalysis-sanctions', verdict: 'ERROR', reference: 'e', screenedAt: NOW });
  await appendScreeningResult(db, ORG, payee, { provider: 'chainalysis-sanctions', verdict: 'CLEAR', reference: 'c', screenedAt: new Date(NOW.getTime() + 60_000) });
  await appendScreeningResult(db, OTHER, { kind: 'WALLET_ADDRESS', address: '0xbbb' }, { provider: 'chainalysis-sanctions', verdict: 'CLEAR', reference: 'o', screenedAt: NOW });

  const lookup = await latestScreenings(db, ORG, ['wallet:0xaaa', 'wallet:0xbbb']);
  assert.equal(lookup.get('wallet:0xaaa').verdict, 'CLEAR');
  assert.equal(lookup.get('wallet:0xaaa').reference, 'c');
  assert.equal(lookup.get('wallet:0xbbb'), null, 'another org’s screening of the same address is not this org’s');
  await client.close();
});

test('payees are screened once each, and with no provider nothing is recorded', async () => {
  const { client, db } = await migratedDb();
  await appendScreeningResult(db, ORG, { kind: 'WALLET_ADDRESS', address: '0xdone' }, {
    provider: 'chainalysis-sanctions', verdict: 'CLEAR', reference: 'old', screenedAt: NOW,
  });
  const asked = [];
  const provider = async (address) => {
    asked.push(address);
    return { verdict: address === '0xlisted' ? 'BLOCK' : 'CLEAR', reference: `chainalysis:${address}`, screenedAt: NOW };
  };
  const refs = payeeScreeningRefs([{ address: '0xdone' }, { address: '0xnew' }, { address: '0xlisted' }, { address: '0xNEW' }]);
  const result = await screenPayees(db, ORG, refs, provider);
  assert.deepEqual(asked.sort(), ['0xlisted', '0xnew'], 'a settled verdict stands; each payee is asked once');
  assert.deepEqual(result, { screened: 2, recorded: 2 });
  const lookup = await latestScreenings(db, ORG, refs);
  assert.equal(lookup.get('wallet:0xlisted').verdict, 'BLOCK');

  // No provider configured: the screener answers nothing, and nothing is made up.
  const unconfigured = async () => ({ verdict: null, reference: null, screenedAt: null });
  const none = await screenPayees(db, ORG, ['wallet:0xfresh'], unconfigured);
  assert.deepEqual(none, { screened: 1, recorded: 0 });
  assert.equal((await latestScreenings(db, ORG, ['wallet:0xfresh'])).get('wallet:0xfresh'), null);
  await client.close();
});

// ── The replay pays the beneficiary the approval named ──────────────────────

const payee = {
  name: 'Manila Parts Supply',
  country: 'PH',
  bank: { swift: 'BOPIPHMM', account: '001234567890' },
  travelRule: { address: '12 Rizal Ave, Manila' },
};
const approvedClaim = { approved: true, proposalId: 'prop_t', orgId: ORG, beneficiaryIds: ['rcpt_saved_1'] };
const saved = { id: 'rcpt_saved_1', name: 'Manila Parts Supply', country: 'PH', swift: 'BOPIPHMM', account: '001234567890' };

test('a replay reuses the approved beneficiary record instead of minting another', async () => {
  const reads = [];
  const read = async (orgId, id) => {
    reads.push([orgId, id]);
    return id === 'rcpt_saved_1' ? saved : null;
  };
  assert.equal(await approvedBeneficiary(ORG, approvedClaim, payee, read), saved);
  assert.deepEqual(reads, [[ORG, 'rcpt_saved_1']], 'read in the approval’s org, by the id the approvers signed');
});

test('a deleted, changed or ambiguous beneficiary refuses the replay rather than paying someone else', async () => {
  const read = async (_orgId, id) => (id === 'rcpt_saved_1' ? saved : null);
  assert.equal(await approvedBeneficiary(ORG, { ...approvedClaim, beneficiaryIds: ['rcpt_deleted'] }, payee, read), null);
  assert.equal(await approvedBeneficiary(ORG, approvedClaim, { ...payee, bank: { ...payee.bank, account: '009999999999' } }, read), null);
  assert.equal(await approvedBeneficiary(ORG, approvedClaim, { ...payee, name: 'Someone Else Trading' }, read), null);
  assert.equal(await approvedBeneficiary(ORG, { ...approvedClaim, beneficiaryIds: ['rcpt_saved_1', 'rcpt_saved_2'] }, payee, read), null);
  assert.equal(await approvedBeneficiary(ORG, { ...approvedClaim, approved: false }, payee, read), null);
});

test('the record matches however the body spelled the same payee', () => {
  // Stored from a body whose travel-rule half carried the account and BIC.
  assert.equal(beneficiaryMatches(saved, {
    name: ' Manila Parts Supply ',
    country: 'ph',
    bank: { account: 'legacy-ref' },
    travelRule: { bankAccountNumber: '001234567890', bankIdScheme: 'SWIFT_BIC', bankIdValue: 'bopiphmm' },
  }), true);
  assert.equal(beneficiaryMatches(saved, { ...payee, country: 'MY' }), false);
  assert.equal(beneficiaryMatches(saved, { ...payee, bank: { swift: 'MBTCPHMM', account: '001234567890' } }), false);
});

// ── The routes, as source ───────────────────────────────────────────────────

function code(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
}

async function source(file) {
  return code(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'));
}

test('a payroll proposal names each payee, and screens them after answering', async () => {
  const batch = await source('app/api/batches/authorize/route.ts');
  const block = batch.slice(batch.indexOf('requiresSecondApproval'), batch.indexOf('const controls = await readComplianceControls()'));
  assert.match(block, /\.\.\.payeeScreeningRefs\(acceptedRows\)\.map\(\(ref\) => \(\{ source: 'COUNTERPARTY' as const, ref \}\)\)/);
  assert.doesNotMatch(block, /source: 'COUNTERPARTY', ref: `\$\{acceptedRows\.length\} payable rows/);
  assert.match(block, /if \(proposal\) after\(\(\) => screenRunPayees\(orgId, acceptedRows\)\);/);
});

test('a replayed transfer pays the approved beneficiary record, or nobody', async () => {
  const transfer = await source('app/api/transfers/authorize/route.ts');
  assert.match(transfer, /const recipient = approvalClaim\.approved\s*\? await approvedBeneficiary\(orgId, approvalClaim, body\.recipient\)\s*: await persistRecipient\(buildRecipient\(/);
  assert.match(transfer, /if \(!recipient\) return approvalBeneficiaryRefusal\(\);/);
});

test('both approval paths read the durable record, and say why a payment is held', async () => {
  const submit = await source('app/api/proposals/[id]/submit/route.ts');
  assert.match(submit, /const compliance = await resolveDurableComplianceForProposal\(proposal\);/);
  assert.match(submit, /code: 'compliance_hold'/);
  assert.doesNotMatch(submit, /resolveComplianceForProposal\(proposal\)/);

  const settle = await source('lib/server/approval-settle.ts');
  assert.match(settle, /const compliance = await resolveDurableComplianceForProposal\(proposal\);/);
  assert.match(settle, /describeComplianceHold\(input\.compliance\)/);
});
