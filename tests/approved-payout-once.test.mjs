import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { after as afterAll, before } from 'node:test';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

import * as schema from '../lib/db/schema.ts';

/**
 * An approved payout is paid once, on the real transfers route.
 *
 * A payout at or over the dual-approval threshold becomes a proposal. When its
 * approvers finish, lib/server/approval-execution.ts replays it through
 * app/api/transfers/authorize/route.ts with `x-splash-approved-proposal: <id>`,
 * and the route drops the second-approver requirement and the WhatsApp step-up
 * for it. The proposal stays SUBMITTED after it is carried out, so a route that
 * honoured the same claim twice would let anyone in the org post the same body
 * with the same header and send the payment again, with no second approver.
 *
 * tests/approval-claim.test.mjs pins the claim (lib/server/approved-proposal.ts)
 * and reads the routes' source. This file goes through the route: the maker's
 * payout becomes a proposal, two checkers approve it, the replay sends it, and
 * the same claim is then presented again — by the replay, the maker, an
 * approver, after a restart, and from another org. The payer's ledger is the
 * judge: one debit, whatever else is tried.
 *
 * Everything the route touches is real and on PGlite, except two Next APIs that
 * exist only inside a request: `cookies()`, where the route reads its session,
 * and `after()`, which starts settlement on chain. Settlement is recorded here,
 * not run. The peg check reads the app's own mock prices (USE_MOCK_APIS), so no
 * part of this reaches the network.
 *
 * The proposal store writes through to Postgres, as the app's does
 * (lib/agent/oxwal.ts). That is the harder case: an approval carried out before
 * a restart is back after it, SUBMITTED, without the in-process mark, and only
 * the `consumed_approvals` row stands between it and a second payment.
 */

process.env.DATABASE_URL = 'postgres://pglite.invalid/approved-payout-once';
process.env.CUSTOMER_SESSION_SECRET = 'approved-payout-once-session-secret-0123456789abcdef0123456789';
process.env.FEATURE_KYB_GATE = 'true';
// DeepBook and Pyth answer a mock $1.00, so the peg check passes offline.
process.env.USE_MOCK_APIS = 'true';
// And nothing else reaches out: no compliance object to read on chain, no
// contract file to find one in, no Redis for the quote cache.
process.env.SPLASH_DATA_DIR = path.join(os.tmpdir(), 'splash-approved-payout-once-no-data');
delete process.env.SPLASH_COMPLIANCE_CONFIG_ID;
delete process.env.REDIS_URL;

// ── A request scope outside Next ────────────────────────────────────────────

/** The request the route runs in: the session cookie it carries, and the work
 *  it handed to `after()`. */
const scope = { cookies: new Map(), deferred: [] };
globalThis.__approvedPayoutOnceScope = scope;

const stubModule = (source) => `data:text/javascript,${encodeURIComponent(source)}`;

const NEXT_HEADERS = stubModule(`
  const jar = () => globalThis.__approvedPayoutOnceScope.cookies;
  export async function cookies() {
    return {
      get: (name) => (jar().has(name) ? { name, value: jar().get(name) } : undefined),
      getAll: () => [...jar()].map(([name, value]) => ({ name, value })),
      has: (name) => jar().has(name),
      set: () => {},
      delete: () => {},
    };
  }
  export async function headers() {
    return new Headers();
  }
`);

const NEXT_SERVER = stubModule(`
  export * from 'next/server.js';
  export function after(task) {
    globalThis.__approvedPayoutOnceScope.deferred.push(task);
  }
`);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'next/headers') return { url: NEXT_HEADERS, shortCircuit: true };
    if (specifier === 'next/server') return { url: NEXT_SERVER, shortCircuit: true };
    // The stubs' own imports resolve from here: a data: URL has no node_modules.
    if (context.parentURL?.startsWith('data:')) {
      return nextResolve(specifier, { ...context, parentURL: import.meta.url });
    }
    return nextResolve(specifier, context);
  },
});

// ── The workspace ───────────────────────────────────────────────────────────

/** A maker and two checkers at Acme, and someone at another org. */
const PEOPLE = {
  maker: { id: 'usr_maker', email: 'maker@acme.test', orgId: 'acme', role: 'maker' },
  firstChecker: { id: 'usr_checker_1', email: 'checker1@acme.test', orgId: 'acme', role: 'checker' },
  secondChecker: { id: 'usr_checker_2', email: 'checker2@acme.test', orgId: 'acme', role: 'admin' },
  northwind: { id: 'usr_northwind', email: 'ops@northwind.test', orgId: 'northwind', role: 'admin' },
};

let client;
let db;
/** The modules under test, imported once the stubs are in place. */
let app;

async function applyMigrations() {
  const files = (await readdir(new URL('../drizzle', import.meta.url))).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sqlText = await readFile(new URL(`../drizzle/${file}`, import.meta.url), 'utf8');
    for (const statement of sqlText.split('--> statement-breakpoint')) {
      const trimmed = statement.trim();
      if (trimmed) await client.exec(trimmed);
    }
  }
}

async function loadApp() {
  const [route, execution, state, persistence, repo, oxwal, authority, ledger, session, legal] = await Promise.all([
    import('@/app/api/transfers/authorize/route'),
    import('@/lib/server/approval-execution'),
    import('@/lib/queue/proposal-state'),
    import('@/lib/queue/proposal-persistence'),
    import('@/lib/db/proposal-repo'),
    import('@/lib/agent/oxwal'),
    import('@/lib/auth/authority'),
    import('@/lib/server/ledger-store'),
    import('@/lib/auth/customer-session'),
    import('@/content/legal'),
  ]);
  return {
    POST: route.POST,
    executeApprovedProposal: execution.executeApprovedProposal,
    InMemoryProposalStore: state.InMemoryProposalStore,
    makeProposalWriter: persistence.makeProposalWriter,
    loadOpenProposals: repo.loadOpenProposals,
    getOxwalProposalStore: oxwal.getOxwalProposalStore,
    resolveAuthorityForSession: authority.resolveAuthorityForSession,
    recordMovement: ledger.recordMovement,
    listMovements: ledger.listMovements,
    CUSTOMER_SESSION_COOKIE: session.CUSTOMER_SESSION_COOKIE,
    createCustomerSessionFromIdentity: session.createCustomerSessionFromIdentity,
    createCustomerSessionToken: session.createCustomerSessionToken,
    TERMS_VERSION: legal.TERMS_VERSION,
  };
}

/** Two verified businesses that have accepted the terms, each with a funded
 *  Splash balance, and the people above as members. */
async function seed() {
  await client.exec(`
    INSERT INTO organizations (id, name, kyb_lifecycle, legal_name, registration_number, address_line1, address_city, address_country)
    VALUES
      ('acme', 'Acme Trading', 'ACTIVE', 'Acme Trading Sdn Bhd', '202401012345', 'Level 12, Menara Splash', 'Kuala Lumpur', 'MY'),
      ('northwind', 'Northwind Traders', 'ACTIVE', 'Northwind Traders Pte Ltd', '201912345K', '1 Raffles Place', 'Singapore', 'SG');
  `);
  for (const person of Object.values(PEOPLE)) {
    await client.query(`INSERT INTO users (id, email, name, email_verified_at) VALUES ($1, $2, $3, now())`, [
      person.id,
      person.email,
      person.email,
    ]);
    await client.query(`INSERT INTO memberships (id, user_id, org_id, role) VALUES ($1, $2, $3, $4)`, [
      `mem_${person.id}`,
      person.id,
      person.orgId,
      person.role,
    ]);
  }
  for (const [orgId, userId] of [['acme', PEOPLE.maker.id], ['northwind', PEOPLE.northwind.id]]) {
    await client.query(`INSERT INTO terms_acceptances (id, user_id, org_id, version) VALUES ($1, $2, $3, $4)`, [
      `terms_${orgId}`,
      userId,
      orgId,
      app.TERMS_VERSION,
    ]);
    // Paid from the Splash balance: no funding session, and this route asks
    // no authenticator code for it.
    await app.recordMovement({ orgId, direction: 'CREDIT', amountMinor: 500_000_000_000n, refType: 'SEED', refId: `seed_${orgId}` });
  }
}

before(async () => {
  client = new PGlite();
  await applyMigrations();
  db = drizzle(client, { schema });
  globalThis.splashDb = { pool: { end: async () => {} }, db };
  app = await loadApp();
  await seed();
});

afterAll(async () => {
  delete globalThis.splashDb;
  await client?.close();
});

// ── Acting in it ────────────────────────────────────────────────────────────

/** The app's proposal store, fresh, writing through to this database. */
function freshStore() {
  const store = new app.InMemoryProposalStore(app.makeProposalWriter());
  globalThis.oxwalProposalStore = store;
  return store;
}

/** Make `person` the one whose session the next request carries. */
function signIn(person) {
  const session = app.createCustomerSessionFromIdentity({ email: person.email, credentialVersion: 1 });
  const token = app.createCustomerSessionToken(session, process.env.CUSTOMER_SESSION_SECRET);
  scope.cookies = new Map([[app.CUSTOMER_SESSION_COOKIE, token]]);
  return { session, token };
}

/** A payout the transfer wizard would post: complete for the PH corridor, paid
 *  from the Splash balance, over the $10,000 dual-approval default. */
function payout(amount, { account = '1234567890' } = {}) {
  return {
    recipient: {
      name: 'Mabuhay Logistics Inc',
      country: 'PH',
      bank: { swift: 'BOPIPHMM', account },
      travelRule: {
        legalName: 'Mabuhay Logistics Incorporated',
        beneficiaryType: 'BUSINESS',
        registrationNumber: 'CS201812345',
        addressLine1: '12 Ayala Avenue',
        addressCity: 'Makati',
        addressCountry: 'PH',
        bankName: 'BPI',
        bankIdScheme: 'LOCAL_BANK_CODE',
        bankIdValue: '010040018',
        bankCountry: 'PH',
        bankAccountNumber: account,
        bankAccountName: 'Mabuhay Logistics Inc',
      },
    },
    travelRulePayment: { purposeCode: 'GSC', sourceOfFunds: 'Trading revenue', beneficiaryRelationship: 'Supplier' },
    amount: { value: amount, targetCurrency: 'PHP' },
    deliveryTier: 'PAYOUT_ONLY',
    fundingSelection: { source: 'SPLASH_BALANCE', type: 'held', feeTier: 'DISCOUNT' },
  };
}

/** POST /api/transfers/authorize as `person`, presenting an approval if given. */
async function authorize(person, body, approvedProposalId) {
  signIn(person);
  const headers = { 'Content-Type': 'application/json' };
  if (approvedProposalId) headers['x-splash-approved-proposal'] = approvedProposalId;
  const response = await app.POST(
    new Request('http://splash.test/api/transfers/authorize', { method: 'POST', headers, body: JSON.stringify(body) }),
  );
  return { status: response.status, body: await response.json() };
}

/** Presented again, the payment is filed for approval and nothing is paid. */
function assertSentForApproval(response) {
  assert.equal(response.status, 409, JSON.stringify(response.body));
  assert.equal(response.body.code, 'requires_second_approval');
}

/** The maker posts it; over the threshold, the route files it for approval. */
async function propose(body) {
  const response = await authorize(PEOPLE.maker, body);
  assertSentForApproval(response);
  assert.match(response.body.proposalId, /^prop_/);
  return response.body.proposalId;
}

/**
 * Two checkers sign it off, the way app/api/proposals/[id]/submit walks a
 * proposal: policy, the queue, two distinct approvers, sign, submit. Who they
 * are and what role they hold come from the database, as there.
 *
 * The submit route itself is not called. For a real beneficiary its compliance
 * re-check holds the payment today — getComplianceStatus reads the agent's
 * fixture counterparties, not the recipients store — which is a separate gap
 * from the one this file is about.
 */
async function approve(proposalId) {
  const store = app.getOxwalProposalStore();
  const signedAt = new Date().toISOString();
  const checkers = [];
  for (const person of [PEOPLE.firstChecker, PEOPLE.secondChecker]) {
    checkers.push(await app.resolveAuthorityForSession(signIn(person).session));
  }
  store.transition(proposalId, { type: 'POLICY_EVALUATED', requiredApprovers: 2 });
  store.transition(proposalId, { type: 'QUEUE_FOR_APPROVAL' });
  for (const checker of checkers) {
    store.transition(proposalId, { type: 'APPROVE', approval: { userId: checker.userId, role: checker.role, signedAt } });
  }
  store.transition(proposalId, {
    type: 'SIGN',
    signatureRef: 'sig_approved_payout_once',
    signedBy: checkers[1].userId,
    policyAuthorized: true,
    signedAt,
  });
  const submitted = store.transition(proposalId, { type: 'SUBMIT' });
  await store.flush();
  return submitted;
}

/** The replay, as the second checker's request, whose session it runs under. */
async function replay(proposalId) {
  const { token } = signIn(PEOPLE.secondChecker);
  const proposal = app.getOxwalProposalStore().get(proposalId);
  return app.executeApprovedProposal(proposal, proposal.executionPayload ?? null, {
    cookie: `${app.CUSTOMER_SESSION_COOKIE}=${token}`,
    origin: 'http://splash.test',
  });
}

/** What the submit route does once the proposal is SUBMITTED: confirm the
 *  approval reached Postgres, replay it, and record the outcome on it. */
async function carryOut(proposalId) {
  const store = app.getOxwalProposalStore();
  assert.equal(await store.writeFailed(proposalId), false, 'the approval is saved before anything moves');
  const outcome = await replay(proposalId);
  store.recordExecution(proposalId, { ...outcome, at: new Date().toISOString() });
  await store.flush();
  return outcome;
}

/** The payer's side of every transfer the route made for `orgId`. */
async function payoutDebits(orgId) {
  const lines = await app.listMovements(orgId, 1_000);
  return lines.filter((line) => line.direction === 'DEBIT' && line.refType === 'TRANSFER');
}

async function spendRecord(proposalId) {
  const { rows } = await client.query(`SELECT org_id, consumed_by FROM consumed_approvals WHERE proposal_id = $1`, [
    proposalId,
  ]);
  return rows;
}

// ── Once ────────────────────────────────────────────────────────────────────

test('an approved payout is paid once: the replay sends it, and the same claim sends nothing again', async () => {
  const store = freshStore();
  const body = payout('25000');
  const paidBefore = (await payoutDebits('acme')).length;

  const id = await propose(body);
  assert.equal((await payoutDebits('acme')).length, paidBefore, 'filing it for approval moves nothing');
  await approve(id);

  // The first execution, through lib/server/approval-replay.ts.
  const settlingBefore = scope.deferred.length;
  const first = await carryOut(id);
  assert.equal(first.state, 'EXECUTED', first.detail);
  const debits = await payoutDebits('acme');
  assert.equal(debits.length, paidBefore + 1);
  const paid = debits.find((line) => line.refId === first.ref);
  assert.ok(paid, 'the debit is the transfer the replay made');
  assert.equal(paid.amountMinor, 25_000_000_000n);
  assert.equal(scope.deferred.length, settlingBefore + 1, 'settlement started once');
  assert.equal(store.get(id).status, 'SUBMITTED', 'carried out, it is still SUBMITTED; the status alone would not stop a second');

  // The replay itself, again: a retried settle, a second click on Approve.
  assert.equal((await replay(id)).state, 'FAILED');
  // Anyone in the org re-posting the same body with the same header.
  assertSentForApproval(await authorize(PEOPLE.maker, body, id));
  assertSentForApproval(await authorize(PEOPLE.secondChecker, body, id));

  assert.equal((await payoutDebits('acme')).length, paidBefore + 1, 'still one payment');
  assert.equal(scope.deferred.length, settlingBefore + 1, 'and one settlement');
  // Spent by the route as it paid, in the row every process reads, not only by
  // the replay's clean-up afterwards.
  assert.deepEqual(await spendRecord(id), [{ org_id: 'acme', consumed_by: 'transfers/authorize' }]);
});

test('after a restart the approval is back, SUBMITTED and unmarked, and it still pays nothing', async () => {
  freshStore();
  const body = payout('26000');
  const id = await propose(body);
  await approve(id);
  assert.equal((await carryOut(id)).state, 'EXECUTED');
  const paidBefore = (await payoutDebits('acme')).length;
  const settlingBefore = scope.deferred.length;

  // A deploy: a new process, its store rebuilt from Postgres the way
  // ensureProposalStoreHydrated rebuilds it.
  const rebooted = freshStore();
  rebooted.hydrate(await app.loadOpenProposals(db));
  const back = rebooted.get(id);
  assert.equal(back.status, 'SUBMITTED');
  assert.equal(back.approvals.length, 2, 'its approvals survived the restart');
  assert.equal(back.approvalConsumedAt, undefined, 'the in-process mark did not: the row is all that is left');

  assertSentForApproval(await authorize(PEOPLE.maker, body, id));
  assert.equal((await replay(id)).state, 'FAILED');

  assert.equal((await payoutDebits('acme')).length, paidBefore);
  assert.equal(scope.deferred.length, settlingBefore);
});

// ── Only its own payment, only its own org ──────────────────────────────────

test('an approval does not cover another payment or another org, and presenting it there spends nothing', async () => {
  const store = freshStore();
  const body = payout('27000');
  const id = await propose(body);
  // Submitted and not yet carried out: the moment between the approvers'
  // submit and the replay, or a process that stopped in between.
  await approve(id);
  const acmeBefore = (await payoutDebits('acme')).length;
  const northwindBefore = (await payoutDebits('northwind')).length;

  // The maker, pointing it at another account.
  assertSentForApproval(await authorize(PEOPLE.maker, payout('27000', { account: '9999999999' }), id));
  // Someone at another org, on the identical payment.
  assertSentForApproval(await authorize(PEOPLE.northwind, body, id));

  assert.equal((await payoutDebits('acme')).length, acmeBefore);
  assert.equal((await payoutDebits('northwind')).length, northwindBefore);
  assert.equal(store.get(id).approvalConsumedAt, undefined, 'neither attempt spent it');
  assert.deepEqual(await spendRecord(id), []);

  // So the approvers' replay still pays it, once.
  const outcome = await carryOut(id);
  assert.equal(outcome.state, 'EXECUTED', outcome.detail);
  assert.equal((await payoutDebits('acme')).length, acmeBefore + 1);
  assert.deepEqual(await spendRecord(id), [{ org_id: 'acme', consumed_by: 'transfers/authorize' }]);
});
