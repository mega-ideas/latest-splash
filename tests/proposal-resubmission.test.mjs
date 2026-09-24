import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

import * as schema from '../lib/db/schema.ts';
import {
  claimProposalExecution,
  loadOpenProposals,
  loadProposalKeyFamily,
  upsertProposal,
} from '../lib/db/proposal-repo.ts';
import {
  absorbsResubmission,
  idempotencyKeyForGeneration,
  idempotencyKeyGeneration,
  nextIdempotencyKeyGeneration,
} from '../lib/queue/proposal-state.ts';

/**
 * Re-authorizing a payment whose approval can no longer carry it.
 *
 * `proposeForApproval` returned ANY proposal with the payment's key, whatever
 * its status, and the keys are deterministic per payment. So once an approved
 * payment's replay failed — balance, pause, peg, a ceiling — the retry the
 * failure asked for got the spent proposal back, and the route answered 409
 * "it is now in the approval queue and needs a second approver" when nothing
 * there could ever approve it. Rejected and expired payments were stuck the
 * same way, and next month's identical payroll could never be proposed.
 */

delete process.env.DATABASE_URL;

const ORG = 'org_resubmit';
const MAKER = 'usr_maker';
const T0 = new Date('2026-09-24T09:00:00.000Z');
const HOUR = 60 * 60 * 1000;

let keySeq = 0;
function baseKey(label) {
  keySeq += 1;
  return `transfer:${ORG}:25000:Manila Parts ${label} ${keySeq}:PHP`;
}

async function propose(key, { orgId = ORG, now = T0 } = {}) {
  const { proposeForApproval } = await import('../lib/server/dual-approval.ts');
  return proposeForApproval({
    orgId,
    createdBy: MAKER,
    kind: 'PAYMENT',
    amountUsd: '25000.00',
    targetCurrency: 'PHP',
    recommendation: 'Pay 25000 USD to Manila Parts Supply in PHP.',
    passedChecks: [{ source: 'COUNTERPARTY', ref: 'rcpt_manila' }],
    payload: { recipient: { name: 'Manila Parts Supply' }, amount: { value: '25000.00', targetCurrency: 'PHP' } },
    idempotencyKey: key,
    approvalThresholdUsd: 10_000,
    now,
  });
}

async function store() {
  const { getOxwalProposalStore } = await import('../lib/agent/oxwal.ts');
  return getOxwalProposalStore();
}

/** Walk a queued proposal as far as `to`, the way the approval paths do. */
async function walk(id, to) {
  const s = await store();
  const at = T0.toISOString();
  s.transition(id, { type: 'POLICY_EVALUATED', requiredApprovers: 2 });
  s.transition(id, { type: 'QUEUE_FOR_APPROVAL' });
  if (to === 'PENDING_APPROVAL') return s.get(id);
  s.transition(id, { type: 'APPROVE', approval: { userId: 'usr_checker', role: 'APPROVER', signedAt: at } });
  s.transition(id, { type: 'APPROVE', approval: { userId: 'usr_admin', role: 'OWNER', signedAt: at } });
  if (to === 'APPROVED') return s.get(id);
  s.transition(id, { type: 'SIGN', signatureRef: 'in-app:test', signedBy: 'usr_admin', policyAuthorized: true, signedAt: at });
  if (to === 'SIGNED') return s.get(id);
  s.transition(id, { type: 'SUBMIT' });
  return s.get(id);
}

// ── Key generations ─────────────────────────────────────────────────────────

test('a payment’s key generations: the bare key, then key#2, key#3', () => {
  const base = 'transfer:org:100:Acme:PHP';
  assert.equal(idempotencyKeyForGeneration(base, 1), base);
  assert.equal(idempotencyKeyForGeneration(base, 2), `${base}#2`);
  assert.throws(() => idempotencyKeyForGeneration(base, 0));
  assert.equal(idempotencyKeyGeneration(base, base), 1);
  assert.equal(idempotencyKeyGeneration(base, `${base}#7`), 7);
  // Not generations of this payment.
  for (const other of [`${base}#`, `${base}#0`, `${base}#1`, `${base}#02`, `${base}#2x`, `${base}x`, 'transfer:org:100:Acme:MYR']) {
    assert.equal(idempotencyKeyGeneration(base, other), null, other);
  }
  // A payee name with a '#' in it names a different payment, not a generation.
  assert.equal(idempotencyKeyGeneration('transfer:org:100:Acme', 'transfer:org:100:Acme #2 Ltd:PHP'), null);
  assert.equal(nextIdempotencyKeyGeneration(base, []), 1);
  assert.equal(nextIdempotencyKeyGeneration(base, [base, `${base}#3`, 'unrelated']), 4);
});

test('only a proposal that can still carry the payment absorbs a re-submission', () => {
  const live = { status: 'PENDING_APPROVAL', expiresAt: new Date(T0.getTime() + HOUR).toISOString() };
  for (const status of ['SIMULATED', 'POLICY_EVALUATED', 'PENDING_APPROVAL', 'APPROVED', 'SIGNED']) {
    assert.equal(absorbsResubmission({ ...live, status }, T0.getTime()), true, status);
  }
  for (const status of ['SUBMITTED', 'SETTLED', 'ANCHORED', 'REJECTED', 'FAILED', 'EXPIRED', 'REVERSED', 'DRAFTED']) {
    assert.equal(absorbsResubmission({ ...live, status }, T0.getTime()), false, status);
  }
  // Past its window, even while the status still reads pending.
  assert.equal(absorbsResubmission(live, T0.getTime() + 2 * HOUR), false);
});

// ── proposeForApproval ─────────────────────────────────────────────────────

test('a re-submission finds the proposal still awaiting approval', async () => {
  const key = baseKey('pending');
  const first = await propose(key);
  const again = await propose(key);
  assert.equal(again.id, first.id);
  assert.equal(first.idempotencyKey, key, 'the first generation is the bare key');
  assert.equal(first.status, 'SIMULATED');

  // Still true once an approver has signed, and once it is fully approved but
  // not yet handed to the executor.
  await walk(first.id, 'PENDING_APPROVAL');
  assert.equal((await propose(key)).id, first.id);
});

test('approved and not yet carried out: the re-submission finds it', async () => {
  const approvedKey = baseKey('approved');
  const approved = await propose(approvedKey);
  await walk(approved.id, 'APPROVED');
  assert.equal((await propose(approvedKey)).id, approved.id);

  const signedKey = baseKey('signed');
  const signed = await propose(signedKey);
  await walk(signed.id, 'SIGNED');
  assert.equal((await propose(signedKey)).id, signed.id);
});

test('a carried-out payment whose replay failed can be re-authorized, and the old proposal is left as it was', async () => {
  const key = baseKey('failed');
  const first = await propose(key);
  const submitted = await walk(first.id, 'SUBMITTED');
  (await store()).recordExecution(first.id, {
    state: 'FAILED',
    detail: 'Splash balance is insufficient for this payment source',
    at: T0.toISOString(),
  });

  const retry = await propose(key);
  assert.notEqual(retry.id, first.id, 'the spent proposal is not handed back');
  assert.equal(retry.idempotencyKey, `${key}#2`);
  assert.equal(retry.status, 'SIMULATED', 'the retry waits for approvals of its own');
  assert.deepEqual(retry.approvals, []);

  // The record of what was approved and what happened, untouched.
  const old = (await store()).get(first.id);
  assert.equal(old.status, 'SUBMITTED');
  assert.equal(old.execution.state, 'FAILED');
  assert.deepEqual(old.approvals, submitted.approvals);

  // And the retry is itself what a further re-submission finds.
  assert.equal((await propose(key)).id, retry.id);
});

test('a rejected payment can be proposed again, and the next generation follows the highest', async () => {
  const key = baseKey('rejected');
  const first = await propose(key);
  (await store()).transition(first.id, { type: 'REJECT', reason: 'wrong beneficiary' });
  const second = await propose(key);
  assert.equal(second.idempotencyKey, `${key}#2`);
  (await store()).transition(second.id, { type: 'REJECT', reason: 'still wrong' });
  const third = await propose(key);
  assert.equal(third.idempotencyKey, `${key}#3`);
  assert.equal((await store()).get(first.id).status, 'REJECTED');
});

test('an expired proposal is superseded, and marked expired rather than left looking approvable', async () => {
  const key = baseKey('expired');
  const first = await propose(key, { now: T0 });
  const later = new Date(T0.getTime() + 25 * HOUR);
  const fresh = await propose(key, { now: later });
  assert.notEqual(fresh.id, first.id);
  assert.equal(fresh.idempotencyKey, `${key}#2`);
  assert.equal((await store()).get(first.id).status, 'EXPIRED');
  assert.equal(Date.parse(fresh.expiresAt), later.getTime() + 24 * HOUR, 'a fresh approval window');
});

test('the same key string in another org is never handed across', async () => {
  const key = baseKey('tenancy');
  const mine = await propose(key, { orgId: ORG });
  // Real keys carry their org. If two orgs ever produced the same string, the
  // store's key index would point at the other org's proposal: refused, not
  // returned.
  const theirs = await propose(key, { orgId: 'org_someone_else' });
  assert.equal(theirs, null);
  assert.equal((await propose(key, { orgId: ORG })).id, mine.id);
});

// ── Postgres: the finished generations, and the outcome, survive a restart ──

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

function row(id, idempotencyKey, overrides = {}) {
  return {
    id,
    idempotencyKey,
    kind: 'PAYMENT',
    status: 'REJECTED',
    tier: 'TIER_0_PROPOSE',
    orgId: ORG,
    corridor: 'PHP',
    unsignedTxBytes: 'abc',
    explain: {
      recommendation: 'Pay 25000 USD.',
      financialImpact: { amountIn: 25_000_000_000n, currencyIn: 'USD' },
      evidence: [],
      confidence: 1,
      risk: 'MEDIUM',
      requiredApprovers: 2,
      reasoningTraceRef: 'test',
    },
    createdBy: MAKER,
    createdAt: T0.toISOString(),
    expiresAt: new Date(T0.getTime() + 24 * HOUR).toISOString(),
    approvals: [],
    ...overrides,
  };
}

test('the key family is read from Postgres: every generation, finished ones included, and nothing else', async () => {
  const { client, db } = await migratedDb();
  const base = 'transfer:org_resubmit:25000:A_b%c:PHP';
  for (const [id, key, org] of [
    ['p1', base, ORG],
    ['p2', `${base}#2`, ORG],
    ['p3', `${base}#3`, ORG],
    ['p_other_org', base, 'org_other'],
    // LIKE 'base#%' would read the `_` and `%` in the payee's name as
    // wildcards and match this other payment's second generation.
    ['p_wild', 'transfer:org_resubmit:25000:AXbYYc:PHP#2', ORG],
    ['p_prefix', `${base}x`, ORG],
  ]) {
    await upsertProposal(db, row(id, key, { orgId: org }));
  }

  const family = await loadProposalKeyFamily(db, ORG, base);
  assert.deepEqual(family.map((p) => p.id).sort(), ['p1', 'p2', 'p3']);
  // Which is what numbers the next generation after a restart, when boot
  // hydration has loaded none of these finished proposals.
  assert.equal(nextIdempotencyKeyGeneration(base, family.map((p) => p.idempotencyKey)), 4);
  await client.close();
});

test('a carried-out proposal’s outcome comes back after a restart', async () => {
  const { client, db } = await migratedDb();
  const failedAt = new Date(T0.getTime() + HOUR);
  await upsertProposal(db, row('p_failed', 'k_failed', {
    status: 'SUBMITTED',
    execution: { state: 'FAILED', detail: 'Settlement is paused by the compliance operator.', at: failedAt.toISOString() },
  }));
  await claimProposalExecution(db, { proposalId: 'p_failed', orgId: ORG, at: failedAt });

  const reloaded = (await loadOpenProposals(db)).find((p) => p.id === 'p_failed');
  assert.equal(reloaded.status, 'SUBMITTED');
  assert.deepEqual(reloaded.execution, {
    state: 'FAILED',
    detail: 'Settlement is paused by the compliance operator.',
    at: failedAt.toISOString(),
  });

  // Never written back from the store: the write-through leaves the spent
  // marker alone even while it now carries the restored outcome.
  await upsertProposal(db, reloaded);
  assert.equal(await claimProposalExecution(db, { proposalId: 'p_failed', orgId: ORG, at: new Date() }), 'already-claimed');
  await client.close();
});

// ── The routes, as source ───────────────────────────────────────────────────

test('proposeForApproval sees the finished generations before it picks one', async () => {
  const text = await readFile(new URL('../lib/server/dual-approval.ts', import.meta.url), 'utf8');
  const hydrateAt = text.indexOf('await hydrateKeyGenerations(store, input.orgId, input.idempotencyKey)');
  const pickAt = text.indexOf('nextIdempotencyKeyGeneration(');
  const createAt = text.indexOf('store.create(proposal)');
  assert.ok(hydrateAt > 0 && hydrateAt < pickAt && pickAt < createAt);
  // Nothing awaits between choosing and creating.
  assert.doesNotMatch(text.slice(hydrateAt + 10, createAt), /await /);
});

test('an approved payroll run is keyed by its approval, not its rows', async () => {
  const text = await readFile(new URL('../app/api/batches/authorize/route.ts', import.meta.url), 'utf8');
  assert.match(text, /const idempotencyKey = approvalClaim\.approved\s*\? `approval:\$\{approvalClaim\.proposalId\}`/);
  // Still spent once, before the run exists.
  assert.ok(text.indexOf('spendApprovalClaim(') < text.indexOf('const claim = await claimBatch('));
});
