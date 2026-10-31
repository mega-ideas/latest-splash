import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import test from 'node:test';

/**
 * v2 Phase 3 (p3-d-custody): the v1 custody payout-run path is removed.
 *
 * `POST /api/batches/authorize` paid a payroll file out of the shared
 * SettlementPool (splash_custody), keyed by a hash of the rows, with a typed
 * authenticator code. v2 retired splash_custody from mainnet (D11) and moved
 * batch payouts to the business's own wallet: up to 20 payments in one
 * transaction its owners sign (`/api/wallet/batches`, docs/v2/phase3-batch.md).
 *
 * Evidence that nothing live used the old route, gathered before it was cut:
 *
 *   - No dashboard page, component, script, scheduled job or doc called it;
 *     the Batch payouts page uses /api/wallet/batches only.
 *   - Its one internal caller was the approval queue's replay, which can only
 *     replay a BATCH_PAYOUT proposal that carries an execution payload, and
 *     that payload was written by this route alone (Zeke's drafts carry none).
 *   - Its readers were a staff table on /admin/transactions and the staff
 *     transaction list, both of which read the same store.
 *
 * What stays, on purpose: the `batch_runs` table and its shipped migration
 * (history is not dropped), and the BATCH_PAYOUT proposal kind (Zeke's drafts
 * and old approvals still carry it). An approval of one is recorded and moves
 * nothing, and says so.
 */

const root = new URL('..', import.meta.url);
const at = (rel) => new URL(rel, root);
const exists = async (rel) => {
  try {
    await stat(at(rel));
    return true;
  } catch {
    return false;
  }
};

async function sourceFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(at(dir), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.next') continue;
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await sourceFiles(rel)));
    else if (/\.(ts|tsx|mjs|js|json|yml|yaml)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

// ── The old route, its store and its helpers are gone ───────────────────────

test('the custody payout-run route, its status route, store and helpers no longer exist', async () => {
  for (const gone of [
    'app/api/batches/authorize/route.ts',
    'app/api/batches/[id]/route.ts',
    'lib/server/batches-store.ts',
    'lib/server/repository/batches.ts',
    'lib/server/batch-approval.ts',
    'lib/policy/batch-limits.ts',
  ]) {
    assert.equal(await exists(gone), false, `${gone} must be removed`);
  }
  assert.equal(await exists('app/api/batches'), false, 'no route is left under /api/batches');
});

test('nothing in the code or the scripts names the removed path', async () => {
  const banned = [
    /api\/batches\//,
    /batches\/authorize/,
    /batches-store/,
    /repository\/batches/,
    /batch-approval/,
    /batch-limits/,
    /recordBatchSettlementOnSui/,
    /authorizeBatchForApproval/,
    /SUI_BATCH_SETTLEMENT_MODE/,
    /\bbuildBatch\b/,
  ];
  const found = [];
  for (const dir of ['app', 'lib', 'components', 'scripts', 'config', '.github']) {
    for (const file of await sourceFiles(dir)) {
      const text = await readFile(at(file), 'utf8');
      for (const pattern of banned) if (pattern.test(text)) found.push(`${file}: ${pattern}`);
    }
  }
  assert.deepEqual(found, []);
});

test('the Batch payouts page and the wallet batch routes are the only batch path, and stay tenant-scoped', async () => {
  const routes = [
    'app/api/wallet/batches/route.ts',
    'app/api/wallet/batches/review/route.ts',
    'app/api/wallet/batches/[id]/route.ts',
    'app/api/wallet/batches/[id]/receipts/route.ts',
    'app/api/wallet/batches/[id]/start/route.ts',
  ];
  for (const route of routes) {
    const text = await readFile(at(route), 'utf8');
    assert.match(text, /batchRoute\(/, `${route} goes through the session-scoped route wrapper`);
  }
  const wrapper = await readFile(at('lib/server/wallet-transfers-deps.ts'), 'utf8');
  assert.match(wrapper, /export async function batchRoute[\s\S]*?await walletRoute\(request\)/);
  const walletRoute = await readFile(at('lib/server/wallet-route.ts'), 'utf8');
  assert.match(walletRoute, /requireSessionAccount\(/, 'the org comes from the session, never the request');
});

test('the shipped migration and the history table stay: history is not dropped', async () => {
  assert.equal(await exists('drizzle/0011_batch_runs.sql'), true);
  const journal = JSON.parse(await readFile(at('drizzle/meta/_journal.json'), 'utf8'));
  assert.ok(journal.entries.some((entry) => entry.tag === '0011_batch_runs'));
  const schema = await readFile(at('lib/db/schema.ts'), 'utf8');
  assert.match(schema, /pgTable\('batch_runs'/);
});

// ── An old approval of a payout run moves nothing, and says so ──────────────

delete process.env.DATABASE_URL;
delete process.env.SPLASH_CUSTODY_PACKAGE_ID;

const { InMemoryProposalStore } = await import('../lib/queue/proposal-state.ts');
const { executeApprovedProposal, BATCH_PAYOUT_RETIRED_REASON } = await import('../lib/server/approval-execution.ts');
const { resolveApprovalClaim } = await import('../lib/server/approved-proposal.ts');
const { batchPayoutSubstance } = await import('../lib/server/step-up-subjects.ts');
const settlement = await import('../lib/server/sui-settlement.ts');
const operations = await import('../lib/server/operations.ts');

const context = { cookie: '', origin: 'http://splash.test' };
const PAYLOAD = { rows: [{ name: 'Maria Santos', address: `0x${'a'.repeat(64)}`, amount: '12500.00' }], targetCurrency: 'PHP' };

function approvedBatch(store, id, orgId = 'acme') {
  const now = new Date().toISOString();
  store.create({
    id,
    idempotencyKey: `idem_${id}`,
    kind: 'BATCH_PAYOUT',
    status: 'SIMULATED',
    tier: 'TIER_0_PROPOSE',
    orgId,
    corridor: 'USD',
    unsignedTxBytes: 'deadbeef',
    createdBy: 'usr_maker',
    createdAt: now,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    approvals: [],
    explain: {
      recommendation: 'Pay the run',
      financialImpact: { amountIn: 12_500_000_000n, currencyIn: 'USD' },
      evidence: [],
      confidence: 1,
      risk: 'MEDIUM',
      requiredApprovers: 1,
      reasoningTraceRef: 'dual-approval:test',
    },
    simulation: { ok: true, balanceChanges: [], gasSponsored: false, simulatedAt: now },
    executionPayload: PAYLOAD,
  });
  store.transition(id, { type: 'POLICY_EVALUATED', requiredApprovers: 1 });
  store.transition(id, { type: 'QUEUE_FOR_APPROVAL' });
  store.transition(id, { type: 'APPROVE', approval: { userId: 'usr_checker', role: 'APPROVER', signedAt: now } });
  store.transition(id, { type: 'SIGN', signatureRef: 'sig', signedBy: 'usr_checker', policyAuthorized: true, signedAt: now });
  return store.transition(id, { type: 'SUBMIT' });
}

const presented = (proposal, orgId) =>
  resolveApprovalClaim(
    new Request('http://splash.test/', { method: 'POST', headers: { 'x-splash-approved-proposal': proposal.id } }),
    orgId,
    { kind: 'BATCH_PAYOUT', substance: batchPayoutSubstance, body: PAYLOAD, consumer: 'test' },
  );

async function withEnv(vars, fn) {
  const before = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('approving an old payout-run proposal pays nothing, names why, and spends the approval', async () => {
  const store = new InMemoryProposalStore();
  globalThis.oxwalProposalStore = store;
  const proposal = approvedBatch(store, 'prop_retired_1');

  const outcome = await executeApprovedProposal(proposal, PAYLOAD, context);
  assert.equal(outcome.state, 'SKIPPED');
  assert.equal(outcome.ref, undefined, 'no payment reference is made up');
  assert.match(outcome.detail, /not executed/i);
  assert.match(outcome.detail, /Batch payouts/, 'it says where payout runs are paid now');
  assert.doesNotMatch(outcome.detail, /run started|payment sent/i, 'it never claims a run started');

  // One approval, one attempt: spent by the attempt, so nothing can present it later.
  assert.equal(store.get(proposal.id).approvalConsumedBy, 'execution');
  assert.equal((await presented(proposal, 'acme')).reason, 'already used');
});

test('the same approval carried out again is the same answer and changes nothing', async () => {
  const store = new InMemoryProposalStore();
  globalThis.oxwalProposalStore = store;
  const proposal = approvedBatch(store, 'prop_retired_2');

  const first = await executeApprovedProposal(proposal, PAYLOAD, context);
  const second = await executeApprovedProposal(proposal, PAYLOAD, context);
  assert.equal(first.state, 'SKIPPED');
  assert.deepEqual(second, first);
  assert.equal(store.get(proposal.id).approvalConsumedBy, 'execution', 'the first spend stays the record');
});

test('an approval from one business is no approval in another', async () => {
  const store = new InMemoryProposalStore();
  globalThis.oxwalProposalStore = store;
  const proposal = approvedBatch(store, 'prop_retired_3', 'acme');

  const other = await presented(proposal, 'northwind');
  assert.equal(other.approved, false);
  // And carrying it out for the owner does not make it available to anyone else.
  await executeApprovedProposal(proposal, PAYLOAD, context);
  assert.equal((await presented(proposal, 'northwind')).approved, false);
});

test('an old payout-run proposal with no payload is recorded as retired, never told to re-authorize', async () => {
  // Zeke's drafts never carried a payload, and the only writer of one was the
  // removed route, so a payload-less BATCH_PAYOUT is every real one. It must
  // reach the retired answer, not the "re-authorize the payment" one: there is
  // no route left to re-authorize through.
  for (const env of [{}, { NODE_ENV: 'production' }, { LAUNCH_SCOPE: 'stablecoin' }]) {
    await withEnv(env, async () => {
      const store = new InMemoryProposalStore();
      globalThis.oxwalProposalStore = store;
      const proposal = approvedBatch(store, `prop_retired_nopayload_${JSON.stringify(env).length}`);
      const outcome = await executeApprovedProposal(proposal, null, context);
      assert.equal(outcome.state, 'SKIPPED', JSON.stringify(env));
      assert.equal(outcome.ref, undefined);
      assert.equal(outcome.detail, BATCH_PAYOUT_RETIRED_REASON);
      assert.match(outcome.detail, /Batch payouts/);
      assert.doesNotMatch(outcome.detail, /re-authorize/i);
      assert.equal(store.get(proposal.id).approvalConsumedBy, 'execution', 'spent once, like any other attempt');
    });
  }
});

test('a payment with no payload on record still fails closed, naming nothing paid', async () => {
  const store = new InMemoryProposalStore();
  globalThis.oxwalProposalStore = store;
  const proposal = approvedBatch(store, 'prop_nopayload_payment');
  const outcome = await executeApprovedProposal({ ...proposal, kind: 'PAYMENT' }, null, context);
  assert.equal(outcome.state, 'FAILED');
  assert.match(outcome.detail, /nothing was sent/i);
});

test("Zeke's batch-payout draft points at Batch payouts and promises nothing a draft cannot do", async () => {
  process.env.FEATURE_KYB_GATE = 'false';
  const { executeOxwalTool } = await import('../lib/agent/oxwal.ts');
  const draft = await executeOxwalTool('proposeBatchPayout', {
    orgId: 'demo-business',
    corridor: 'MY_PH',
    payouts: [{ counterpartyId: 'cp_verified_payee', amountUsd: 600, currency: 'USDC' }],
  });
  assert.equal(draft.kind, 'BATCH_PAYOUT');
  assert.match(draft.explain.recommendation, /Batch payouts/);
  assert.match(draft.explain.recommendation, /sends nothing|nothing is sent/i);
  assert.doesNotMatch(draft.explain.recommendation, /Human approval is required in v1/);

  // And approving that very draft ends on the retired answer, with no payload.
  const outcome = await executeApprovedProposal(draft, draft.executionPayload ?? null, context);
  assert.equal(outcome.state, 'SKIPPED');
  assert.equal(outcome.detail, BATCH_PAYOUT_RETIRED_REASON);
});

test('no route asks approvers to approve a batch payout that cannot be carried out', async () => {
  const dual = await readFile(at('lib/server/dual-approval.ts'), 'utf8');
  assert.doesNotMatch(dual, /kind: Extract<ProposalKind, [^>]*'BATCH_PAYOUT'/);
  const requests = await readFile(at('lib/server/approval-requests.ts'), 'utf8');
  assert.doesNotMatch(requests, /a batch payout/);
});

test('in production, and in the stablecoin scope, the answer is the same: recorded, not carried out', async () => {
  for (const env of [{ NODE_ENV: 'production' }, { LAUNCH_SCOPE: 'stablecoin' }, { NODE_ENV: 'production', LAUNCH_SCOPE: 'stablecoin' }]) {
    await withEnv(env, async () => {
      const store = new InMemoryProposalStore();
      globalThis.oxwalProposalStore = store;
      const proposal = approvedBatch(store, `prop_retired_${JSON.stringify(env).length}`);
      const outcome = await executeApprovedProposal(proposal, PAYLOAD, context);
      assert.equal(outcome.state, 'SKIPPED', JSON.stringify(env));
      assert.equal(outcome.ref, undefined);
      assert.match(outcome.detail, /not executed/i);
    });
  }
});

test('there is no custody batch settlement left to call, so no simulated receipt is reachable either', async () => {
  assert.equal(settlement.recordBatchSettlementOnSui, undefined);
  assert.equal(operations.buildBatch, undefined);
  for (const mode of [{}, { NODE_ENV: 'production' }, { SUI_BATCH_SETTLEMENT_MODE: 'simulate' }]) {
    await withEnv(mode, async () => {
      assert.equal(settlement.recordBatchSettlementOnSui, undefined, JSON.stringify(mode));
    });
  }
});

test('the staff transaction list holds transfers only; no batch row can be made up', async () => {
  const rows = await operations.listTransactions();
  assert.equal(rows.some((row) => row.kind === 'batch' || row.functionName === 'settle_batch'), false);
  const admin = await readFile(at('app/admin/(console)/transactions/page.tsx'), 'utf8');
  assert.doesNotMatch(admin, /Batch payouts|listBatchesForStaff|No batch transactions/);
});

// ── Nothing outside the code scan points at what was removed ───────────────

async function allFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(at(dir), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === 'build' || entry.name === 'node_modules') continue;
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await allFiles(rel)));
    else out.push(rel);
  }
  return out;
}

test('the Move package, SECURITY.md and the docs do not point at the removed TypeScript', async () => {
  const targets = ['SECURITY.md'];
  for (const dir of ['docs', 'move']) {
    for (const file of await allFiles(dir)) if (/\.(md|move|toml)$/.test(file)) targets.push(file);
  }
  const found = [];
  for (const file of targets) {
    const text = await readFile(at(file), 'utf8');
    if (/batch-limits/.test(text)) found.push(`${file}: names lib/policy/batch-limits.ts`);
    if (/sui-settlement\.ts:1528/.test(text)) found.push(`${file}: cites the removed batch PTB by line`);
  }
  assert.deepEqual(found, []);
  const security = await readFile(at('SECURITY.md'), 'utf8');
  const a12 = security.split('\n').find((line) => line.startsWith('| A-12 |')) ?? '';
  assert.match(a12, /removed in v2 Phase 3/, 'A-12 says the batch PTB it describes is gone');
});

test('the approval replay does not word an idempotent answer as a payout run', async () => {
  const replay = await readFile(at('lib/server/approval-replay.ts'), 'utf8');
  assert.doesNotMatch(replay, /This run had already/);
  assert.doesNotMatch(replay, /payout[- ]run/i, 'no copy or comment still speaks of the removed route');
});

test('the operator and support copy no longer describe the removed flow', async () => {
  const support = await readFile(at('app/dashboard/customer-service/page.tsx'), 'utf8');
  assert.doesNotMatch(support, /confirm with your TOTP/);
  assert.match(support, /How do I authorize a batch payout\?/);
});
