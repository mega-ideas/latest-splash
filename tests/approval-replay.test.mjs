import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

import * as schema from '../lib/db/schema.ts';
import {
  approvalReplayOf,
  checkReplayParticipants,
  issueApprovalReplay,
  replayIdentityFromProposal,
} from '../lib/server/approval-replay-identity.ts';
import { replayThroughHandler } from '../lib/server/approval-replay.ts';
import {
  approvalPaymentDigest,
  resolveApprovalClaim,
  verifyApprovalClaim,
} from '../lib/server/approved-proposal.ts';
import { claimProposalExecution, upsertProposal } from '../lib/db/proposal-repo.ts';

/**
 * Carrying out an approved payment, and what an approval may stand in for.
 *
 * Three defects, and each one on its own kept approved payments from going:
 *
 *   The batch route checked the authenticator code BEFORE it read the approval,
 *   and the replay body has no code — every approved batch failed totp_*. The
 *   transfer route replayed the maker's own code from a day earlier, already
 *   spent. A verified, payment-bound, single-use approval now stands in for the
 *   maker's second factor on a replay, and only on a replay.
 *
 *   A WhatsApp reply replays from a webhook, which has no session, and the
 *   route read one through `cookies()` — 401, every time. The replay now runs as
 *   the approval itself, bound to the Request object the replay builds.
 *
 *   The WhatsApp and code paths could not move a proposal out of SIMULATED at
 *   all, so no reply or code ever reached the replay.
 *
 * And two holes the old claim left open: a batch approval's id lifted the
 * second approver for ANY batch in the org, and nothing spent a claim.
 */

delete process.env.DATABASE_URL;

const ORG = 'org_acme';
const MAKER = 'usr_maker';
const APPROVER_A = 'usr_checker';
const APPROVER_B = 'usr_admin';

function code(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
}

async function source(file) {
  return readFile(new URL(`../${file}`, import.meta.url), 'utf8');
}

/** The body the transfer wizard sends, as the proposal stores it. */
function transferPayload(overrides = {}) {
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
    fundingSelection: { source: 'BANK_USD', type: 'fiat', provider: 'STRIPE', feeTier: 'STANDARD' },
    paymentRail: 'SWIFT',
    ...overrides,
  };
}

function batchPayload(overrides = {}) {
  return {
    rows: [
      { name: 'Ana Reyes', address: '0xaaa1', amount: '12000.00' },
      { name: 'Ben Cruz', address: '0xbbb2', amount: '13000.00' },
    ],
    targetCurrency: 'PHP',
    ...overrides,
  };
}

/** An approved proposal, the shape the money routes create and the queue signs. */
function approvedProposal(overrides = {}) {
  return {
    id: 'prop_1',
    idempotencyKey: 'transfer:org_acme:25000:Manila Parts Supply:PHP',
    kind: 'PAYMENT',
    status: 'SUBMITTED',
    tier: 'TIER_0_PROPOSE',
    orgId: ORG,
    corridor: 'PHP',
    unsignedTxBytes: 'abc',
    explain: {
      recommendation: 'Pay 25000 USD to Manila Parts Supply in PHP.',
      financialImpact: { amountIn: 25_000_000_000n, currencyIn: 'USD' },
      evidence: [],
      confidence: 1,
      risk: 'MEDIUM',
      requiredApprovers: 2,
      reasoningTraceRef: 'dual-approval:test',
    },
    createdBy: MAKER,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    approvals: [
      { userId: APPROVER_A, role: 'APPROVER', signedAt: new Date().toISOString() },
      { userId: APPROVER_B, role: 'OWNER', signedAt: new Date().toISOString() },
    ],
    executionPayload: transferPayload(),
    ...overrides,
  };
}

function verify(proposal, { replay, orgId = ORG, kind = proposal?.kind ?? 'PAYMENT', payment } = {}) {
  return verifyApprovalClaim({
    proposal,
    replay: replay ?? replayIdentityFromProposal(proposal, 'whatsapp'),
    orgId,
    expected: { kind, payment: payment ?? proposal.executionPayload },
  });
}

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
  await client.exec(`
    INSERT INTO organizations (id, name) VALUES ('${ORG}', 'Acme'), ('org_other', 'Other Co');
    INSERT INTO users (id, email, name) VALUES
      ('${MAKER}', 'maker@acme.test', 'Mo Maker'),
      ('${APPROVER_A}', 'checker@acme.test', 'Chen Checker'),
      ('${APPROVER_B}', 'admin@acme.test', 'Aisha Admin'),
      ('usr_outsider', 'admin@other.test', 'Olu Outsider');
    INSERT INTO memberships (id, user_id, org_id, role) VALUES
      ('m1', '${MAKER}', '${ORG}', 'maker'),
      ('m2', '${APPROVER_A}', '${ORG}', 'checker'),
      ('m3', '${APPROVER_B}', '${ORG}', 'admin'),
      ('m4', 'usr_outsider', 'org_other', 'admin');
  `);
  return { client, db };
}

// ── The replay identity cannot be sent, only bound ─────────────────────────

test('the identity rides on the exact request the replay built, and on nothing else', () => {
  const identity = replayIdentityFromProposal(approvedProposal(), 'whatsapp');
  const built = issueApprovalReplay(
    new Request('http://localhost/api/transfers/authorize', { method: 'POST', body: '{}' }),
    identity,
  );
  assert.deepEqual(approvalReplayOf(built), identity);

  // The same URL, the same body, and the header that used to carry the claim.
  // A client can send all of that. It is a different object, so it is nobody.
  const forged = new Request('http://localhost/api/transfers/authorize', {
    method: 'POST',
    body: '{}',
    headers: { 'x-splash-approved-proposal': identity.proposalId, cookie: 'splash_session=stolen' },
  });
  assert.equal(approvalReplayOf(forged), null);
  // A copy of the bound request is a new object too.
  assert.equal(approvalReplayOf(built.clone()), null);
});

test('a bound identity cannot be edited after the fact', () => {
  const built = issueApprovalReplay(new Request('http://localhost/x'), replayIdentityFromProposal(approvedProposal(), 'code'));
  const bound = approvalReplayOf(built);
  assert.throws(() => { bound.orgId = 'org_other'; }, TypeError);
  assert.throws(() => { bound.approverUserIds.push('usr_mallory'); }, TypeError);
});

test('the identity comes from the proposal: its org, its maker, its approvers — never the maker as one', () => {
  const identity = replayIdentityFromProposal(
    approvedProposal({
      approvals: [
        { userId: APPROVER_B, role: 'OWNER', signedAt: '' },
        { userId: MAKER, role: 'OWNER', signedAt: '' },
        { userId: APPROVER_A, role: 'APPROVER', signedAt: '' },
        { userId: APPROVER_A, role: 'APPROVER', signedAt: '' },
      ],
    }),
    'in-app',
  );
  assert.equal(identity.orgId, ORG);
  assert.equal(identity.makerUserId, MAKER);
  assert.deepEqual(identity.approverUserIds, [APPROVER_B, APPROVER_A].sort());
  // Treasury, FX and x402 settle elsewhere; they are never replayed as a payout.
  assert.throws(() => replayIdentityFromProposal(approvedProposal({ kind: 'TREASURY_ALLOCATE' }), 'code'));
});

// ── The replay: no cookie, no header, the identity bound ───────────────────

test('the route sees the approval, the payload, and no cookie or approval header', async () => {
  const identity = replayIdentityFromProposal(approvedProposal(), 'whatsapp');
  let seen;
  const route = async (request) => {
    seen = {
      identity: approvalReplayOf(request),
      cookie: request.headers.get('cookie'),
      header: request.headers.get('x-splash-approved-proposal'),
      body: await request.json(),
      url: request.url,
    };
    return Response.json({ transferIntentId: 'ti_1' });
  };

  const result = await replayThroughHandler(route, '/api/transfers/authorize', {
    identity,
    body: transferPayload(),
    origin: 'https://splash.example',
  });

  assert.deepEqual(result, { ok: true, ref: 'ti_1', alreadyMade: false });
  assert.deepEqual(seen.identity, identity);
  assert.equal(seen.cookie, null, 'a forwarded cookie was never read by the route, so none is sent');
  assert.equal(seen.header, null, 'anything in the request is something a client could send');
  assert.deepEqual(seen.body, transferPayload());
  assert.equal(seen.url, 'https://splash.example/api/transfers/authorize');
});

test('a refusal comes back with its code, and an idempotent run is not reported as new', async () => {
  const identity = replayIdentityFromProposal(approvedProposal({ kind: 'BATCH_PAYOUT', executionPayload: batchPayload() }), 'code');
  const refused = await replayThroughHandler(
    async () => Response.json({ error: 'This approval has already released its payment.', code: 'approval_already_used' }, { status: 409 }),
    '/api/batches/authorize',
    { identity, body: batchPayload(), origin: 'http://localhost' },
  );
  assert.deepEqual(refused, { ok: false, error: 'This approval has already released its payment.', code: 'approval_already_used' });

  const repeat = await replayThroughHandler(
    async () => Response.json({ id: 'batch_7', idempotentReplay: true }),
    '/api/batches/authorize',
    { identity, body: batchPayload(), origin: 'http://localhost' },
  );
  assert.deepEqual(repeat, { ok: true, ref: 'batch_7', alreadyMade: true });
});

// ── The claim: verified, bound to one payment ──────────────────────────────

test('an approved proposal backs a replay of exactly the payment it approved', () => {
  const claim = verify(approvedProposal());
  assert.equal(claim.approved, true);
  assert.equal(claim.proposalId, 'prop_1');
  assert.equal(claim.orgId, ORG);

  const batch = approvedProposal({ kind: 'BATCH_PAYOUT', executionPayload: batchPayload() });
  assert.equal(verify(batch).approved, true);
});

test('the claim is refused whenever it is not exactly this approval', () => {
  const base = approvedProposal();
  const cases = {
    'no proposal': verify(null, { replay: replayIdentityFromProposal(base, 'whatsapp'), kind: 'PAYMENT', payment: transferPayload() }),
    'another org’s route': verify(base, { orgId: 'org_other' }),
    'a replay issued for another org': verify(base, { replay: { ...replayIdentityFromProposal(base, 'code'), orgId: 'org_other' } }),
    'a replay of another proposal': verify(base, { replay: { ...replayIdentityFromProposal(base, 'code'), proposalId: 'prop_2' } }),
    'a batch approval on the transfer route': verify(
      approvedProposal({ kind: 'BATCH_PAYOUT', executionPayload: batchPayload() }),
      { kind: 'PAYMENT', payment: transferPayload() },
    ),
    'still pending': verify(approvedProposal({ status: 'PENDING_APPROVAL' })),
    'rejected': verify(approvedProposal({ status: 'REJECTED' })),
    'past its window': verify(approvedProposal({ expiresAt: new Date(Date.now() - 1000).toISOString() })),
    'a different maker': verify(base, { replay: { ...replayIdentityFromProposal(base, 'code'), makerUserId: 'usr_mallory' } }),
    'one approver of two': verify(approvedProposal({ approvals: [base.approvals[0]] })),
    'the maker’s own signature': verify(
      approvedProposal({ approvals: [base.approvals[0], { userId: MAKER, role: 'OWNER', signedAt: '' }] }),
    ),
    'approvals changed after the replay was issued': verify(base, {
      replay: { ...replayIdentityFromProposal(base, 'code'), approverUserIds: [APPROVER_A, 'usr_other'] },
    }),
    'no stored payment': verify(approvedProposal({ executionPayload: undefined }), { payment: transferPayload() }),
  };
  for (const [name, claim] of Object.entries(cases)) {
    assert.equal(claim.approved, false, `${name} must not be an approval`);
    assert.equal(claim.proposalId, null, name);
    assert.ok(claim.reason, `${name} says why`);
  }
});

test('an approval needs a human who is not the maker, even when policy asked for none', () => {
  const claim = verify(approvedProposal({
    explain: { ...approvedProposal().explain, requiredApprovers: 0 },
    approvals: [],
  }));
  assert.equal(claim.approved, false);
  assert.match(claim.reason, /0 of 1 approvers/);
});

test('a transfer claim covers who, where, how much, in what and from what — and nothing else', () => {
  const base = transferPayload();
  const approved = verify(approvedProposal(), { payment: base });
  assert.equal(approved.approved, true);

  // The code in the body is a second factor, not part of the payment.
  assert.equal(verify(approvedProposal(), { payment: { ...base, totp: '123456' } }).approved, true);

  const different = {
    amount: { ...base.amount, value: '250000' },
    currency: { ...base.amount, targetCurrency: 'MYR' },
    account: { ...base.recipient, bank: { ...base.recipient.bank, account: '009999999999' } },
    payee: { ...base.recipient, name: 'Someone Else Trading' },
    source: { source: 'SPLASH_BALANCE', type: 'held', feeTier: 'DISCOUNT' },
  };
  for (const [name, change] of Object.entries({
    amount: { amount: different.amount },
    currency: { amount: different.currency },
    account: { recipient: different.account },
    payee: { recipient: different.payee },
    source: { fundingSelection: different.source },
  })) {
    const claim = verify(approvedProposal(), { payment: { ...base, ...change } });
    assert.equal(claim.approved, false, `a different ${name} is a different payment`);
    assert.equal(claim.reason, 'the approval is for a different payment');
  }
});

test('a batch claim covers every row of the run it approved — the hole the batch route left open', () => {
  const proposal = approvedProposal({ kind: 'BATCH_PAYOUT', executionPayload: batchPayload() });
  // The batch route used to check existence, org and status only: this id
  // lifted the second approver for ANY batch in the org.
  const variants = {
    'an amount': batchPayload({ rows: [{ name: 'Ana Reyes', address: '0xaaa1', amount: '120000.00' }, batchPayload().rows[1]] }),
    'an address': batchPayload({ rows: [{ name: 'Ana Reyes', address: '0xmallory', amount: '12000.00' }, batchPayload().rows[1]] }),
    'an extra row': batchPayload({ rows: [...batchPayload().rows, { name: 'Mal', address: '0xccc3', amount: '1.00' }] }),
    'a missing row': batchPayload({ rows: [batchPayload().rows[0]] }),
    'the currency': batchPayload({ targetCurrency: 'MYR' }),
    'a whole other run': { rows: [{ name: 'Payroll', address: '0xself', amount: '900000.00' }], targetCurrency: 'PHP' },
  };
  for (const [name, payment] of Object.entries(variants)) {
    assert.equal(verify(proposal, { payment }).approved, false, `changing ${name} voids it`);
  }
  // Letter case and padding in the same run do not.
  assert.equal(
    approvalPaymentDigest('BATCH_PAYOUT', batchPayload({ targetCurrency: 'php' })),
    approvalPaymentDigest('BATCH_PAYOUT', batchPayload()),
  );
});

test('a request that arrived over HTTP carries no claim, whatever header it sends', async () => {
  const forged = new Request('http://localhost/api/batches/authorize', {
    method: 'POST',
    headers: { 'x-splash-approved-proposal': 'prop_1' },
  });
  const claim = await resolveApprovalClaim(forged, ORG, { kind: 'BATCH_PAYOUT', payment: batchPayload() });
  assert.deepEqual(claim, { approved: false, proposalId: null });
});

test('a route that cannot say what it pays cannot have it approved', async () => {
  const bound = issueApprovalReplay(new Request('http://localhost/api/treasury'), replayIdentityFromProposal(approvedProposal(), 'code'));
  const claim = await resolveApprovalClaim(bound, ORG);
  assert.equal(claim.approved, false);
});

test('end to end in memory: the replayed request resolves against the store; a copy of it does not', async () => {
  const { getOxwalProposalStore } = await import('../lib/agent/oxwal.ts');
  const store = getOxwalProposalStore();
  const proposal = approvedProposal({ id: 'prop_e2e', idempotencyKey: 'transfer:e2e' });
  store.hydrate([proposal]);

  // A stand-in route that asks the real resolver, as both money routes do.
  const route = async (request) => {
    const body = await request.json();
    const claim = await resolveApprovalClaim(request, ORG, { kind: 'PAYMENT', payment: body });
    return Response.json({ approved: claim.approved, reason: claim.reason ?? null });
  };

  const identity = replayIdentityFromProposal(store.get('prop_e2e'), 'whatsapp');
  let answer;
  await replayThroughHandler(async (request) => {
    const response = await route(request);
    answer = await response.clone().json();
    return response;
  }, '/api/transfers/authorize', { identity, body: transferPayload(), origin: 'http://localhost' });
  assert.deepEqual(answer, { approved: true, reason: null });

  // The same body and the old header, sent by a client.
  const client = await route(new Request('http://localhost/api/transfers/authorize', {
    method: 'POST',
    headers: { 'x-splash-approved-proposal': 'prop_e2e' },
    body: JSON.stringify(transferPayload()),
  }));
  assert.deepEqual(await client.json(), { approved: false, reason: null });

  // And the replay of an approval for a different amount.
  await replayThroughHandler(async (request) => {
    const response = await route(request);
    answer = await response.clone().json();
    return response;
  }, '/api/transfers/authorize', {
    identity,
    body: transferPayload({ amount: { value: '99000', targetCurrency: 'PHP' } }),
    origin: 'http://localhost',
  });
  assert.deepEqual(answer, { approved: false, reason: 'the approval is for a different payment' });
});

// ── Single-use, in the database ─────────────────────────────────────────────

test('an approval is spent once: the second replay finds it spent', async () => {
  const { client, db } = await migratedDb();
  await upsertProposal(db, approvedProposal({ id: 'prop_once' }));

  const at = new Date();
  assert.equal(await claimProposalExecution(db, { proposalId: 'prop_once', orgId: ORG, at }), 'claimed');
  assert.equal(await claimProposalExecution(db, { proposalId: 'prop_once', orgId: ORG, at }), 'already-claimed');
  // Scoped by org: the same id in another tenant is not this approval.
  assert.equal(await claimProposalExecution(db, { proposalId: 'prop_once', orgId: 'org_other', at }), 'missing');
  // A row that is not there — a failed write-through — is not "unspent".
  assert.equal(await claimProposalExecution(db, { proposalId: 'prop_nowhere', orgId: ORG, at }), 'missing');
  await client.close();
});

test('two replays arriving together: exactly one spends it', async () => {
  const { client, db } = await migratedDb();
  await upsertProposal(db, approvedProposal({ id: 'prop_race' }));
  const at = new Date();
  const results = await Promise.all(
    Array.from({ length: 5 }, () => claimProposalExecution(db, { proposalId: 'prop_race', orgId: ORG, at })),
  );
  assert.equal(results.filter((r) => r === 'claimed').length, 1);
  assert.equal(results.filter((r) => r === 'already-claimed').length, 4);
  await client.close();
});

test('the write-through never clears the spent marker', async () => {
  const { client, db } = await migratedDb();
  const proposal = approvedProposal({ id: 'prop_marker' });
  await upsertProposal(db, proposal);
  await claimProposalExecution(db, { proposalId: 'prop_marker', orgId: ORG, at: new Date() });

  // The in-memory store writes through after every mutation, and the proposal
  // it holds knows nothing about executed_at. If that write carried it, the
  // next mutation would un-spend the approval.
  await upsertProposal(db, { ...proposal, execution: { state: 'EXECUTED', detail: 'Payment sent.', at: new Date().toISOString() } });
  const rows = await client.query(`SELECT executed_at, execution_state FROM proposals WHERE id = 'prop_marker'`);
  assert.ok(rows.rows[0].executed_at, 'still spent');
  assert.equal(rows.rows[0].execution_state, 'EXECUTED');
  assert.equal(await claimProposalExecution(db, { proposalId: 'prop_marker', orgId: ORG, at: new Date() }), 'already-claimed');
  await client.close();
});

// ── The people behind the replay, re-read now ──────────────────────────────

test('a replay runs only while its maker is a member and its approvers can still approve here', async () => {
  const { client, db } = await migratedDb();
  const identity = replayIdentityFromProposal(approvedProposal(), 'whatsapp');
  assert.deepEqual(await checkReplayParticipants(db, identity), { ok: true });

  // An approver demoted between signing and the last signature.
  await client.exec(`UPDATE memberships SET role = 'viewer' WHERE user_id = '${APPROVER_A}'`);
  const demoted = await checkReplayParticipants(db, identity);
  assert.equal(demoted.ok, false);
  assert.match(demoted.reason, /approving role/);
  await client.exec(`UPDATE memberships SET role = 'checker' WHERE user_id = '${APPROVER_A}'`);

  // An admin somewhere else is nobody here.
  const outsider = await checkReplayParticipants(db, { ...identity, approverUserIds: [APPROVER_A, 'usr_outsider'] });
  assert.equal(outsider.ok, false);

  // A maker whose membership was revoked does not get their payment sent on
  // the strength of other people's signatures.
  await client.exec(`DELETE FROM memberships WHERE user_id = '${MAKER}'`);
  const revoked = await checkReplayParticipants(db, identity);
  assert.equal(revoked.ok, false);
  assert.match(revoked.reason, /no longer a member/);

  // And the shapes that can never be an approval.
  assert.equal((await checkReplayParticipants(db, { ...identity, approverUserIds: [] })).ok, false);
  assert.equal((await checkReplayParticipants(db, { ...identity, approverUserIds: [MAKER, APPROVER_A] })).ok, false);
  await client.close();
});

// ── Code and reply approvals reach the replay, through the same policy ─────

/** A beneficiary record that clears: screened CLEAR by a provider, verified. */
const SCREENED = { verdict: 'CLEAR', reference: 'provider:test', screenedAt: new Date(), recipientKyb: 'full' };
/** One nobody has screened: the state of every bank beneficiary today. */
const UNSCREENED = { verdict: null, reference: null, screenedAt: null, recipientKyb: 'none' };

/** Compliance read the way both approval paths read it — the durable
 *  resolver — with the beneficiary's record supplied instead of Postgres. */
async function complianceFor(proposal, recorded) {
  const { resolveDurableComplianceForProposal } = await import('../lib/compliance/proposal-screening.ts');
  return resolveDurableComplianceForProposal(proposal, async (orgId, refs) => {
    assert.equal(orgId, proposal.orgId, 'read in the proposal’s own org');
    return new Map(refs.map((ref) => [ref, recorded]));
  });
}

async function queuedPayment(key, { amountUsd = '25000.00' } = {}) {
  const { proposeForApproval } = await import('../lib/server/dual-approval.ts');
  const recipientId = `rcpt_${key}`;
  // Exactly as the transfer route creates it.
  return proposeForApproval({
    orgId: ORG,
    createdBy: MAKER,
    kind: 'PAYMENT',
    amountUsd,
    targetCurrency: 'PHP',
    recommendation: `Pay ${amountUsd} USD to Manila Parts Supply in PHP.`,
    passedChecks: [
      { source: 'COMPLIANCE', ref: 'KYB org state is ACTIVE' },
      { source: 'BALANCE', ref: 'Per-transfer and daily ceilings' },
      { source: 'COUNTERPARTY', ref: recipientId },
    ],
    payload: transferPayload({ amount: { value: amountUsd, targetCurrency: 'PHP' } }),
    idempotencyKey: `transfer:${ORG}:${key}`,
    approvalThresholdUsd: 10_000,
  });
}

const ballot = (userId, role) => ({ userId, role, decidedAt: new Date() });

test('why no reply ever paid: a queued proposal accepts no approval until it is walked into the queue', async () => {
  const { getOxwalProposalStore } = await import('../lib/agent/oxwal.ts');
  const proposal = await queuedPayment('root_cause');
  assert.equal(proposal.status, 'SIMULATED');
  assert.throws(
    () => getOxwalProposalStore().transition(proposal.id, {
      type: 'APPROVE',
      approval: { userId: APPROVER_A, role: 'APPROVER', signedAt: new Date().toISOString() },
    }),
    /APPROVE is not allowed from SIMULATED/,
  );
});

test('every approver said yes: the proposal is evaluated, approved, signed and submitted once', async () => {
  const { getOxwalProposalStore } = await import('../lib/agent/oxwal.ts');
  const { advanceToSubmission } = await import('../lib/server/approval-settle.ts');
  const { loadOrgPolicy } = await import('../lib/policy/org-policy.ts');
  const store = getOxwalProposalStore();
  const policy = await loadOrgPolicy(null, ORG);
  const proposal = await queuedPayment('unanimous');

  const input = {
    proposalId: proposal.id,
    ballots: [ballot(APPROVER_A, 'APPROVER'), ballot(APPROVER_B, 'OWNER')],
    policy,
    compliance: await complianceFor(proposal, SCREENED),
    channel: 'whatsapp',
    now: new Date(),
  };
  const advance = advanceToSubmission(store, input);
  assert.equal(advance.kind, 'submitted');
  assert.equal(advance.proposal.status, 'SUBMITTED');
  assert.deepEqual(advance.proposal.approvals.map((a) => a.userId), [APPROVER_A, APPROVER_B]);

  // And what it submitted is exactly what the replay's claim accepts.
  const claim = verify(advance.proposal, { replay: replayIdentityFromProposal(advance.proposal, 'whatsapp') });
  assert.equal(claim.approved, true);

  // A duplicate delivery, or the other approver answering late: reported,
  // never carried out a second time.
  const again = advanceToSubmission(store, input);
  assert.equal(again.kind, 'stopped');
  assert.match(again.outcome.message, /Already approved/);
  assert.equal(store.get(proposal.id).status, 'SUBMITTED');
});

test('a reply is worth what a click is: the submit-time policy blocks an unscreened beneficiary', async () => {
  const { getOxwalProposalStore } = await import('../lib/agent/oxwal.ts');
  const { advanceToSubmission } = await import('../lib/server/approval-settle.ts');
  const { loadOrgPolicy } = await import('../lib/policy/org-policy.ts');
  const store = getOxwalProposalStore();
  const proposal = await queuedPayment('unscreened');

  const advance = advanceToSubmission(store, {
    proposalId: proposal.id,
    ballots: [ballot(APPROVER_A, 'APPROVER'), ballot(APPROVER_B, 'OWNER')],
    policy: await loadOrgPolicy(null, ORG),
    compliance: await complianceFor(proposal, UNSCREENED),
    channel: 'code',
    now: new Date(),
  });
  assert.equal(advance.kind, 'stopped');
  assert.match(advance.outcome.message, /compliance hold/);
  // And why, in words an approver can act on.
  assert.match(advance.outcome.message, /has not been screened/);
  // Nothing moved: no approval recorded, nothing submitted.
  assert.equal(store.get(proposal.id).status, 'SIMULATED');
  assert.deepEqual(store.get(proposal.id).approvals, []);
});

test('the maker’s ballot and a viewer’s ballot do not count toward it', async () => {
  const { getOxwalProposalStore } = await import('../lib/agent/oxwal.ts');
  const { advanceToSubmission } = await import('../lib/server/approval-settle.ts');
  const { loadOrgPolicy } = await import('../lib/policy/org-policy.ts');
  const store = getOxwalProposalStore();
  const proposal = await queuedPayment('not_counted');

  const advance = advanceToSubmission(store, {
    proposalId: proposal.id,
    ballots: [ballot(APPROVER_A, 'APPROVER'), ballot(MAKER, 'OWNER'), ballot('usr_viewer', 'VIEWER')],
    policy: await loadOrgPolicy(null, ORG),
    compliance: await complianceFor(proposal, SCREENED),
    channel: 'whatsapp',
    now: new Date(),
  });
  assert.equal(advance.kind, 'stopped');
  assert.match(advance.outcome.message, /still needs another approver/);
  const stored = store.get(proposal.id);
  assert.equal(stored.status, 'PENDING_APPROVAL');
  assert.deepEqual(stored.approvals.map((a) => a.userId), [APPROVER_A]);
});

// ── The routes, as source: they cannot be imported outside Next ─────────────

const TRANSFER = 'app/api/transfers/authorize/route.ts';
const BATCH = 'app/api/batches/authorize/route.ts';

function linesWith(text, needle) {
  return text.split('\n').map((line) => line.trim()).filter((line) => line.includes(needle));
}

test('both money routes: a session, or the bound approval — never a header', async () => {
  for (const file of [TRANSFER, BATCH]) {
    const text = code(await source(file));
    assert.match(text, /const auth = await requirePaymentRequest\(request\);/, file);
    assert.doesNotMatch(text, /requireCustomerRequest\(/, `${file} must not read the session alone`);
    assert.doesNotMatch(text, /x-splash-approved-proposal|headers\.get\('x-splash/i, file);
    // The same KYB gate and lane, and the same account resolution, either way.
    assert.match(text, /auth\.replay\s*\?\s*await requireActiveOrgId\(auth\.replay\.orgId, \{ lane: 'FIAT_OUT_LOCAL' \}\)\s*:\s*await requireActiveOrg\(auth\.session, \{ lane: 'FIAT_OUT_LOCAL' \}\)/, file);
    assert.match(text, /auth\.replay\s*\?\s*await requireOrgAccount\(auth\.replay\.orgId\)\s*:\s*await requireSessionAccount\(auth\.session\)/, file);
    // An unverified replay does nothing at all.
    assert.match(text, /if \(auth\.replay && !approvalClaim\.approved\) return approvalClaimRefusal\(approvalClaim\);/, file);
  }
});

test('batch: the approval is read before the second factor, and stands in for it', async () => {
  const text = code(await source(BATCH));
  const claimAt = text.indexOf('resolveApprovalClaim(request, orgId, {');
  const totpAt = text.indexOf('verifyPayoutTotp(');
  assert.ok(claimAt > 0 && totpAt > 0);
  assert.ok(claimAt < totpAt, 'the code check ran first, so every approved run failed totp_*');
  assert.match(text, /kind: 'BATCH_PAYOUT',\s*payment: \{ rows: body\.rows, targetCurrency: body\.targetCurrency \}/);
  // The whole second-factor block is conditional on there being no approval.
  const block = text.slice(text.indexOf('if (!approvalClaim.approved) {'), totpAt);
  assert.match(block, /consumeActionApproval\(/);
});

test('transfer: the maker’s stored code is neither replayed nor stored', async () => {
  const text = code(await source(TRANSFER));
  assert.match(text, /if \(totpRequiredForThisRail && !whatsappApproved && !approvalClaim\.approved\) \{/);
  assert.match(text, /payload: \{ \.\.\.body, businessAccountId: undefined, totp: undefined \}/);
  assert.match(text, /kind: 'PAYMENT',\s*payment: rawBody as Record<string, unknown>/);
  // The receipt names the approval that released the payment.
  assert.match(text, /approvedBy: approvalClaim\.approved \? `approval:\$\{approvalClaim\.proposalId\}` : 'dashboard-operator'/);
});

test('the approval lifts the second factor and the second approver — nothing else', async () => {
  const allowed = {
    [TRANSFER]: [
      /^if \(auth\.replay && !approvalClaim\.approved\) return approvalClaimRefusal\(approvalClaim\);$/,
      /^if \(settings\.whatsappEnabled && !approvalClaim\.approved\) \{$/,
      /^if \(totpRequiredForThisRail && !whatsappApproved && !approvalClaim\.approved\) \{$/,
      /^if \(limits\.requiresSecondApproval && !approvalClaim\.approved\) \{$/,
      // The replay reuses the beneficiary the approval named.
      /^const recipient = approvalClaim\.approved$/,
      /^if \(approvalClaim\.approved\) \{$/,
      /^approvedBy: approvalClaim\.approved \?/,
    ],
    [BATCH]: [
      /^if \(auth\.replay && !approvalClaim\.approved\) return approvalClaimRefusal\(approvalClaim\);$/,
      /^if \(!approvalClaim\.approved\) \{$/,
      /^if \(limits\.requiresSecondApproval && !approvalClaim\.approved\) \{$/,
      // An approved run is keyed by its approval, not its rows.
      /^const idempotencyKey = approvalClaim\.approved$/,
      /^if \(approvalClaim\.approved\) \{$/,
    ],
  };
  for (const [file, patterns] of Object.entries(allowed)) {
    const uses = linesWith(code(await source(file)), 'approvalClaim.approved');
    assert.equal(uses.length, patterns.length, `${file}: every use of the claim is accounted for`);
    for (const line of uses) {
      assert.ok(patterns.some((p) => p.test(line)), `${file}: unexpected use of the claim: ${line}`);
    }
  }
});

test('every guard that reads the world still runs on a replay, and the approval is spent after them', async () => {
  const transfer = code(await source(TRANSFER));
  const batch = code(await source(BATCH));

  // Mode appears only where the two differ in HOW, never in WHETHER, a guard runs.
  const modeLines = {
    [TRANSFER]: [
      /^const gate = auth\.replay$/,
      /^: await requireActiveOrg\(auth\.session, \{ lane: 'FIAT_OUT_LOCAL' \}\);$/,
      /^\? await requireActiveOrgId\(auth\.replay\.orgId, \{ lane: 'FIAT_OUT_LOCAL' \}\)$/,
      /^const accountCheck = auth\.replay$/,
      /^\? await requireOrgAccount\(auth\.replay\.orgId\)$/,
      /^: await requireSessionAccount\(auth\.session\);$/,
      /^if \(auth\.replay && !approvalClaim\.approved\) return approvalClaimRefusal\(approvalClaim\);$/,
      /^if \(!auth\.session\) return approvalClaimRefusal\(approvalClaim\);$/,
      /^session: auth\.session,$/,
      /^const maker = await resolveAuthorityForSession\(auth\.session\);$/,
    ],
  };
  modeLines[BATCH] = [
    ...modeLines[TRANSFER],
    /^const whatsappApproved = settings\.requireTotp && settings\.whatsappEnabled && auth\.session !== null$/,
  ];
  for (const [file, text] of [[TRANSFER, transfer], [BATCH, batch]]) {
    const lines = [...new Set([...linesWith(text, 'auth.replay'), ...linesWith(text, 'auth.session')])];
    for (const line of lines) {
      assert.ok(modeLines[file].some((p) => p.test(line)), `${file}: a guard became conditional on the caller: ${line}`);
    }
  }

  for (const guard of [
    'requireTermsAccepted(orgId)', 'readOrgSettings(orgId)', 'deliveryTierAllowed(', 'checkMinimumSettlement(',
    'missingTravelRuleFields(', 'checkAuthorizationLimits(', 'readComplianceControls()', 'resolveFundingSelection(',
    'accountBalance(orgId)', 'pythAdapter.getPegStatus()',
  ]) {
    assert.ok(transfer.includes(guard), `transfer runs ${guard}`);
    assert.ok(transfer.indexOf(guard) < transfer.indexOf('spendApprovalClaim('), `transfer spends only after ${guard}`);
  }
  assert.ok(transfer.indexOf('spendApprovalClaim(') < transfer.indexOf('await persistTransfer(intent)'));

  for (const guard of [
    'requireTermsAccepted(orgId)', 'readOrgSettings(orgId)', 'checkMinimumSettlement(', 'MAX_BATCH_ROWS',
    'checkAuthorizationLimits(', 'readComplianceControls()',
  ]) {
    assert.ok(batch.includes(guard), `batch runs ${guard}`);
    assert.ok(batch.indexOf(guard) < batch.indexOf('spendApprovalClaim('), `batch spends only after ${guard}`);
  }
  assert.ok(batch.indexOf('spendApprovalClaim(') < batch.indexOf('const claim = await claimBatch('));
});

test('the claim module never reads the claim from a request header', async () => {
  const text = code(await source('lib/server/approved-proposal.ts'));
  assert.doesNotMatch(text, /headers\.get\(/);
  assert.match(text, /const replay = approvalReplayOf\(request\);/);
});

test('the replay forwards no cookie and no approval header', async () => {
  const text = code(await source('lib/server/approval-replay.ts'));
  assert.doesNotMatch(text, /cookie/i);
  assert.doesNotMatch(text, /x-splash-approved-proposal/);
  assert.match(text, /issueApprovalReplay\(/);
  const exec = code(await source('lib/server/approval-execution.ts'));
  assert.match(exec, /identity: replayIdentityFromProposal\(proposal, context\.channel\)/);
});

test('code and reply approvals settle through the policy, the org’s roles, and one submission', async () => {
  const settle = code(await source('lib/server/approval-settle.ts'));
  assert.doesNotMatch(settle, /cookie/);
  assert.match(settle, /authorizeProposalSubmission\(\{/);
  // Read from the payees' durable screening record before the walk, which
  // never awaits (tests/beneficiary-screening.test.mjs has the record).
  assert.match(settle, /const compliance = await resolveDurableComplianceForProposal\(proposal\);/);
  assert.match(settle, /compliance: input\.compliance/);
  // Roles in THIS org, not whichever membership the user happened to hold.
  assert.match(settle, /eq\(memberships\.orgId, proposal\.orgId\)/);
  // A proposal already carried out is reported, never carried out again.
  assert.match(settle, /if \(CARRIED_OUT\.has\(proposal\.status\)\) return carriedOut\(proposal\);/);
  assert.ok(settle.indexOf('advanceToSubmission(store') < settle.indexOf('executeApprovedProposal('));

  const webhook = code(await source('app/api/webhooks/whatsapp/route.ts'));
  assert.match(webhook, /settleFullyApprovedProposal\(lookup\.token\.proposalId, \{ channel: 'whatsapp' \}\)/);
  const codeRoute = code(await source('app/api/approvals/code/route.ts'));
  assert.match(codeRoute, /settleFullyApprovedProposal\(lookup\.token\.proposalId, \{ channel: 'code' \}\)/);
  const submit = code(await source('app/api/proposals/[id]/submit/route.ts'));
  assert.match(submit, /channel: 'in-app'/);
  assert.doesNotMatch(submit, /cookie:/);
});
