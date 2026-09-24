import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';

import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';

import * as schema from '../lib/db/schema.ts';

/**
 * The store the app uses writes through to Postgres.
 *
 * W1 gave the proposal store a writer, and the app's store never got it.
 * lib/agent/oxwal.ts built a writer-less store at module load, so the lazy
 * getter that attaches makeProposalWriter() always found the global already
 * set. Only resetOxwalProposalStore() — which only tests call — attached the
 * writer, so the persistence tests passed while every running process kept its
 * approvals in memory and hydrated from an empty `proposals` table.
 *
 * Everything here goes through getOxwalProposalStore() and never resets it:
 * the store under test is the one a route gets.
 */

const ORG = 'org-acme-test';

let client;
let db;
let oxwal;

before(async () => {
  client = new PGlite();
  db = drizzle(client, { schema });
  const files = (await readdir(new URL('../drizzle', import.meta.url))).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sqlText = await readFile(new URL(`../drizzle/${file}`, import.meta.url), 'utf8');
    for (const statement of sqlText.split('--> statement-breakpoint')) {
      const trimmed = statement.trim();
      if (trimmed) await client.exec(trimmed);
    }
  }
  await client.exec(`
    INSERT INTO organizations (id, name) VALUES ('${ORG}', 'Acme Test');
    INSERT INTO users (id, email, name) VALUES ('usr_checker', 'checker@acme.test', 'Checker');
  `);

  // The app's own route to Postgres, in-process: makeProposalWriter() calls
  // getDb(), which returns the globalThis-anchored handle when there is one.
  // Anchoring pglite there runs the real writer; the URL is never dialled.
  globalThis.splashDb = { pool: null, db };
  process.env.DATABASE_URL = 'postgres://pglite.invalid/in-process';
  // Deterministic Zeke: the KYB lane gate is opt-in and compose stays mock.
  delete process.env.FEATURE_KYB_GATE;
  delete process.env.OXWAL_CHAIN_MODE;

  // Imported once the environment exists, as it does in a started process.
  oxwal = await import('../lib/agent/oxwal.ts');
});

after(async () => {
  await client?.close();
});

function draft(id, { explain, ...overrides } = {}) {
  const now = new Date().toISOString();
  return {
    id,
    idempotencyKey: `idem_${id}`,
    kind: 'PAYMENT',
    status: 'PENDING_APPROVAL',
    tier: 'TIER_0_PROPOSE',
    orgId: ORG,
    corridor: 'PHP',
    unsignedTxBytes: 'dW5zaWduZWQ=',
    createdBy: 'usr_maker',
    createdAt: now,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    approvals: [],
    explain: {
      recommendation: 'Pay 60000 USD to Acme Supplies in PHP.',
      financialImpact: { amountIn: 60_000_000_000n, currencyIn: 'USD' },
      evidence: [{ source: 'COUNTERPARTY', ref: 'rcpt_acme', observedAt: now, trusted: true, status: 'LIVE' }],
      confidence: 1,
      risk: 'MEDIUM',
      requiredApprovers: 2,
      reasoningTraceRef: `test:${id}`,
      ...explain,
    },
    simulation: {
      ok: true,
      balanceChanges: [{ owner: ORG, coinType: 'USDC', amount: '-60000000000' }],
      gasSponsored: false,
      simulatedAt: now,
    },
    ...overrides,
  };
}

async function proposalRow(id) {
  const rows = await db.select().from(schema.proposals).where(eq(schema.proposals.id, id));
  return rows[0] ?? null;
}

/** Writes fail and reads still work: a database that drops mid-request.
 *  upsertProposal is one transaction per write, so failing `transaction` fails
 *  every proposal write and nothing else. */
async function withProposalWritesFailing(fn) {
  db.transaction = async () => {
    throw new Error('Connection terminated unexpectedly');
  };
  try {
    return await fn();
  } finally {
    delete db.transaction;
  }
}

test('the store getOxwalProposalStore() returns writes through to Postgres', async () => {
  const store = oxwal.getOxwalProposalStore();
  store.create(draft('prop_app_store'));
  store.transition('prop_app_store', {
    type: 'APPROVE',
    approval: { userId: 'usr_first_approver', role: 'APPROVER', signedAt: new Date().toISOString() },
  });
  await store.flush();
  assert.equal(await store.writeFailed('prop_app_store'), false);

  const row = await proposalRow('prop_app_store');
  assert.ok(row, 'the app store must reach the proposals table');
  assert.equal(row.orgId, ORG);
  assert.equal(row.status, 'PENDING_APPROVAL');
  const approvals = await db.select().from(schema.approvals).where(eq(schema.approvals.proposalId, 'prop_app_store'));
  assert.deepEqual(approvals.map((a) => a.userId), ['usr_first_approver']);

  // And boot hydration now has something to find. A restarted process starts
  // with an empty store and the app's own hydration path fills it.
  const { InMemoryProposalStore } = await import('../lib/queue/proposal-state.ts');
  const { ensureProposalStoreHydrated } = await import('../lib/queue/proposal-persistence.ts');
  const restarted = new InMemoryProposalStore();
  await ensureProposalStoreHydrated(restarted);
  const survivor = restarted.get('prop_app_store');
  assert.equal(survivor?.status, 'PENDING_APPROVAL');
  assert.deepEqual(survivor?.approvals.map((a) => a.userId), ['usr_first_approver']);
  assert.equal(survivor?.explain.financialImpact.amountIn, 60_000_000_000n);
});

test('an approval request can be issued for it: approval_tokens needs that row', async () => {
  // approval_tokens.proposal_id references proposals.id. With no row, the
  // ballots for a dual-approval payment could never be inserted: the request
  // to approvers failed on the foreign key and was logged as "could not notify".
  const store = oxwal.getOxwalProposalStore();
  store.create(draft('prop_ballot'));
  assert.equal(await store.writeFailed('prop_ballot'), false);

  const { issueTokens } = await import('../lib/server/approval-tokens.ts');
  const tokens = await issueTokens({
    proposalId: 'prop_ballot',
    orgId: ORG,
    approvers: [{ userId: 'usr_checker', email: 'checker@acme.test', name: 'Checker', role: 'checker', whatsappE164: null }],
    channel: 'code',
    now: new Date(),
  });
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].userId, 'usr_checker');
});

test('Zeke books a proposal under the session org whatever the model wrote, and it persists there', async () => {
  // The model never learns its org id, so the one in its tool call is a guess
  // or an injection. Before write-through that misfiled a proposal in memory;
  // with it, the guess would have become an organizations row.
  const modelInput = { orgId: 'org-somebody-else-test', counterpartyId: 'cp_acme_ph', amountUsd: 500, currency: 'PHP' };
  const proposal = await oxwal.executeOxwalTool(
    'proposePayment',
    oxwal.scopeToolInputToOrg('proposePayment', modelInput, ORG),
  );
  assert.equal(proposal.orgId, ORG);

  const store = oxwal.getOxwalProposalStore();
  assert.equal(await store.writeFailed(proposal.id), false);
  const row = await proposalRow(proposal.id);
  assert.equal(row?.orgId, ORG);
  assert.equal(row?.status, 'SIMULATED', 'the state the operator saw in chat is the state on disk');

  const named = await client.query(`SELECT id FROM organizations WHERE id = 'org-somebody-else-test'`);
  assert.equal(named.rows.length, 0);
});

test('the org is the session’s for every org-scoped tool, and only for those', async () => {
  // A read tool too: findSavedRecipient reads Postgres under the org it is given.
  assert.deepEqual(
    oxwal.scopeToolInputToOrg('findSavedRecipient', { orgId: 'org-somebody-else-test', name: 'Acme' }, ORG),
    { orgId: ORG, name: 'Acme' },
  );
  // A tool that takes no org is left exactly as the model wrote it.
  const invoiceInput = { id: 'inv_demo_acme_5000' };
  assert.equal(oxwal.scopeToolInputToOrg('getInvoice', invoiceInput, ORG), invoiceInput);
  // No session org: an org-scoped tool refuses rather than trusting the model.
  assert.throws(
    () => oxwal.scopeToolInputToOrg('proposePayment', { orgId: ORG }, undefined),
    /no organization is in scope/,
  );

  // And the model's tool loop goes through it on every call.
  const source = await readFile(new URL('../lib/agent/oxwal.ts', import.meta.url), 'utf8');
  const loop = source.slice(source.indexOf('async function* runClaudeToolLoop'), source.indexOf('function isUnsignedProposal'));
  assert.match(loop, /executeOxwalTool\(name, scopeToolInputToOrg\(name, toolUse\.input, request\.orgId\)\)/);
  assert.doesNotMatch(loop, /executeOxwalTool\(name, toolUse\.input\)/);
});

test('an approval that did not reach Postgres moves no money', async () => {
  const store = oxwal.getOxwalProposalStore();
  // Approved while the database is up, with a real payment behind it: both
  // approvers answered by WhatsApp. A reply stops at APPROVED, and a signed-in
  // approver releases the payment (lib/server/approval-settle.ts).
  await client.exec(`
    INSERT INTO users (id, email, name) VALUES ('usr_second_checker', 'second@acme.test', 'Second Checker');
    INSERT INTO memberships (id, user_id, org_id, role) VALUES
      ('m_outage_checker', 'usr_checker', '${ORG}', 'checker'),
      ('m_outage_second', 'usr_second_checker', '${ORG}', 'admin');
  `);
  oxwal.upsertOxwalCounterpartyFixture({
    id: 'rcpt_acme',
    name: 'Acme Supplies',
    kybStatus: 'VERIFIED',
    kytPassed: true,
    sanctionsClear: true,
  });
  store.create(draft('prop_outage', {
    status: 'SIMULATED',
    executionPayload: { amount: { value: '60000', targetCurrency: 'PHP' }, recipient: { name: 'Acme Supplies' } },
  }));
  assert.equal(await store.writeFailed('prop_outage'), false);
  await client.exec(`
    INSERT INTO approval_tokens (id, proposal_id, org_id, user_id, code, channel, expires_at, decision, decided_at) VALUES
      ('atk_outage_1', 'prop_outage', '${ORG}', 'usr_checker', '111111', 'reply', now() + interval '30 minutes', 'APPROVE', now()),
      ('atk_outage_2', 'prop_outage', '${ORG}', 'usr_second_checker', '222222', 'reply', now() + interval '30 minutes', 'APPROVE', now());
  `);
  const { settleFullyApprovedProposal } = await import('../lib/server/approval-settle.ts');
  const voted = await settleFullyApprovedProposal('prop_outage', { channel: 'whatsapp', releaser: null });
  assert.equal(voted.stage, 'AWAITING_RELEASE');
  assert.equal(await store.writeFailed('prop_outage'), false);
  assert.equal((await proposalRow('prop_outage'))?.status, 'APPROVED');

  // Then the proposal writes start failing while a signed-in approver releases it.
  const { APPROVAL_NOT_SAVED } = await import('../lib/server/approval-execution.ts');
  const outcome = await withProposalWritesFailing(() =>
    settleFullyApprovedProposal('prop_outage', {
      channel: 'code',
      releaser: { userId: 'usr_second_checker', sessionOrgId: ORG, cookie: '', origin: 'http://splash.test' },
    }),
  );

  assert.equal(outcome.settled, false);
  assert.match(outcome.message, /could not be saved/);
  // The executor never ran: what was recorded is the refusal, not an attempt.
  assert.deepEqual(store.get('prop_outage')?.execution?.detail, APPROVAL_NOT_SAVED.detail);
  // Postgres still has it approved and not carried out — the state a restart
  // brings back. Had the payment gone, that row would be all that is left of
  // an approval with no signatures on file.
  assert.equal((await proposalRow('prop_outage'))?.status, 'APPROVED');
  // And the claim is closed, as the replay closes one a route refused: spent
  // in this process and on record, so no request can present it afterwards.
  assert.ok(store.get('prop_outage')?.approvalConsumedAt, 'spent in process');
  const spent = await client.query(`SELECT consumed_by FROM consumed_approvals WHERE proposal_id = 'prop_outage'`);
  assert.deepEqual(spent.rows.map((r) => r.consumed_by), ['execution']);

  // The submit route holds the same line, before its own executor call.
  const route = await readFile(new URL('../app/api/proposals/[id]/submit/route.ts', import.meta.url), 'utf8');
  const gate = route.indexOf('if (await store.writeFailed(submitted.id))');
  assert.ok(gate > 0, 'the submit route must ask whether the approval was saved');
  assert.ok(gate < route.search(/executeApprovedProposal\(\s*submitted/), 'and ask before it executes');
  const refusal = route.slice(gate, route.search(/executeApprovedProposal\(\s*submitted/));
  assert.match(refusal, /closeApprovalClaim\(submitted\.id, submitted\.orgId\)/);
  assert.match(refusal, /APPROVAL_NOT_SAVED[\s\S]*503\)/);
});

test('the queue lists the viewer’s own org, not every tenant hydration loaded', async () => {
  const page = await readFile(new URL('../app/queue/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /resolveAuthorityForSession\(session\)/);
  assert.match(page, /\.filter\(\(item\) => item\.orgId === orgId\)/);
});

test('a proposal for an org that does not exist stays out of Postgres, and says so', async (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  const store = oxwal.getOxwalProposalStore();
  const ghost = store.create(draft('prop_no_such_org', {
    orgId: 'org-not-a-tenant-test',
    executionPayload: { recipient: { name: 'Acme Supplies', accountNumber: '000123456789' } },
  }));
  assert.equal(ghost.status, 'PENDING_APPROVAL', 'the in-memory flow carries on');
  assert.equal(await store.writeFailed('prop_no_such_org'), true);
  assert.equal(await proposalRow('prop_no_such_org'), null);
  const orgs = await client.query(`SELECT id FROM organizations WHERE id = 'org-not-a-tenant-test'`);
  assert.equal(orgs.rows.length, 0, 'a proposal write must not mint a tenant');

  // Logged with its reason, and without the row: drizzle's own message is the
  // whole statement and its parameters, beneficiary included.
  const lines = logged.mock.calls.map((call) => call.arguments.map(String).join(' '));
  const line = lines.find((text) => text.includes('prop_no_such_org'));
  assert.match(line ?? '', /violates foreign key constraint "proposals_org_id_organizations_id_fk"/);
  assert.doesNotMatch(lines.join('\n'), /000123456789|Acme Supplies/);
});
