import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { InMemoryProposalStore } from '../lib/queue/proposal-state.ts';
import { resolveApprovalClaim } from '../lib/server/approved-proposal.ts';
import { APPROVAL_RUN_KEY_PREFIX, batchRunKey, batchSecondFactor } from '../lib/server/batch-approval.ts';
import { batchPayoutSubstance, batchTargetCurrency, payableBatchRows } from '../lib/server/step-up-subjects.ts';

/**
 * An approved payroll run, carried out.
 *
 * The approval queue replays an approved BATCH_PAYOUT through
 * /api/batches/authorize with the proposal's payload, `{ rows, targetCurrency }`.
 * The route verified TOTP before it read the approval, and the replay carries
 * no code — none could be valid, because the maker's was single-use and was
 * spent when the route made the proposal. With `requireTotp` on by default,
 * every approved payroll run was recorded FAILED: "The authorization code is
 * not valid."
 *
 * The route cannot be imported here (next/server), so the decision lives in
 * lib/server/batch-approval.ts and is exercised against real claims resolved
 * from a proposal store; the route's use of it is pinned from its source.
 */

delete process.env.DATABASE_URL;

const ADDR_A = `0x${'a'.repeat(64)}`;
const ADDR_B = `0x${'b'.repeat(64)}`;
const ADDR_C = `0x${'c'.repeat(64)}`;

/** What the batch dashboard posts: the file, a blocked row and the maker's code. */
function batchBody(overrides = {}) {
  return {
    rows: [
      { name: 'Maria Santos', address: ADDR_A, amount: '12500.00' },
      { name: 'Jose Rizal', address: ADDR_B, amount: '8000.00' },
      { name: '', address: ADDR_C, amount: '500.00' },
    ],
    targetCurrency: 'PHP',
    totp: '123456',
    ...overrides,
  };
}

/** What the route puts on the proposal, and so what the replay posts: no code. */
function approvedPayload(body = batchBody()) {
  return { rows: payableBatchRows(body.rows), targetCurrency: batchTargetCurrency(body) };
}

const batchScope = (body) => ({ kind: 'BATCH_PAYOUT', substance: batchPayoutSubstance, body, consumer: 'batches/authorize' });

function claimRequest(proposalId) {
  return new Request('http://splash.test/api/batches/authorize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-splash-approved-proposal': proposalId },
  });
}

function freshStore() {
  const store = new InMemoryProposalStore();
  globalThis.oxwalProposalStore = store;
  return store;
}

let sequence = 0;

/** A proposal walked the way the submit route walks one, two checkers signing. */
function approvedProposal(store, { kind = 'BATCH_PAYOUT', payload, orgId = 'acme', until = 'SUBMITTED' } = {}) {
  const id = `prop_batch_${++sequence}`;
  const now = new Date().toISOString();
  store.create({
    id,
    idempotencyKey: `idem_${id}`,
    kind,
    status: 'SIMULATED',
    tier: 'TIER_0_PROPOSE',
    orgId,
    corridor: 'PHP',
    unsignedTxBytes: 'deadbeef',
    createdBy: 'usr_maker',
    createdAt: now,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    approvals: [],
    explain: {
      recommendation: 'Pay the run',
      financialImpact: { amountIn: 20_500_000_000n, currencyIn: 'USD' },
      evidence: [],
      confidence: 1,
      risk: 'MEDIUM',
      requiredApprovers: 2,
      reasoningTraceRef: 'dual-approval:test',
    },
    simulation: { ok: true, balanceChanges: [], gasSponsored: false, simulatedAt: now },
    executionPayload: payload,
  });
  store.transition(id, { type: 'POLICY_EVALUATED', requiredApprovers: 2 });
  store.transition(id, { type: 'QUEUE_FOR_APPROVAL' });
  store.transition(id, { type: 'APPROVE', approval: { userId: 'usr_checker_1', role: 'APPROVER', signedAt: now } });
  store.transition(id, { type: 'APPROVE', approval: { userId: 'usr_checker_2', role: 'FINANCE_ADMIN', signedAt: now } });
  const signed = store.transition(id, { type: 'SIGN', signatureRef: 'sig', signedBy: 'usr_checker_2', policyAuthorized: true, signedAt: now });
  if (until === 'SIGNED') return signed;
  return store.transition(id, { type: 'SUBMIT' });
}

// The org's second-factor dials: the defaults, WhatsApp style, and TOTP off.
const CODE = { requireTotp: true, whatsappEnabled: false };
const WHATSAPP = { requireTotp: true, whatsappEnabled: true };
const OFF = { requireTotp: false, whatsappEnabled: true };

// ── The second factor ───────────────────────────────────────────────────────

test('the approval of this run stands in for the code its maker already spent', async () => {
  const store = freshStore();
  const proposal = approvedProposal(store, { payload: approvedPayload() });

  // The replay posts the approved payload exactly: the payable rows and the
  // currency, and no code.
  assert.equal(proposal.executionPayload.totp, undefined);
  const claim = await resolveApprovalClaim(claimRequest(proposal.id), 'acme', batchScope(proposal.executionPayload));
  assert.equal(claim.approved, true);

  for (const settings of [CODE, WHATSAPP, OFF]) {
    // Neither a code nor a WhatsApp approval is asked of it: the maker's
    // factor was checked, and spent, before the proposal existed.
    assert.deepEqual(batchSecondFactor(claim, settings), { by: 'approval', proposalId: proposal.id });
  }
});

test('anything short of an approval of this run leaves the second factor to the request', async () => {
  const store = freshStore();
  const payload = approvedPayload();
  const [maria, jose] = batchBody().rows;
  const claims = {};

  claims['no claim at all'] = await resolveApprovalClaim(
    new Request('http://splash.test/api/batches/authorize', { method: 'POST' }),
    'acme',
    batchScope(batchBody()),
  );

  const other = approvedProposal(store, { payload });
  claims['an approval of other rows'] = await resolveApprovalClaim(
    claimRequest(other.id),
    'acme',
    batchScope(batchBody({ rows: [{ ...maria, amount: '99999.00' }, jose] })),
  );
  claims['an approval in another currency'] = await resolveApprovalClaim(
    claimRequest(other.id),
    'acme',
    batchScope(batchBody({ targetCurrency: 'MYR' })),
  );

  const payout = approvedProposal(store, { kind: 'PAYMENT', payload });
  claims['a payout approval with the same payload'] = await resolveApprovalClaim(claimRequest(payout.id), 'acme', batchScope(payload));

  const foreign = approvedProposal(store, { payload, orgId: 'northwind' });
  claims["another org's approval"] = await resolveApprovalClaim(claimRequest(foreign.id), 'acme', batchScope(payload));

  const signed = approvedProposal(store, { payload, until: 'SIGNED' });
  claims['signed but not yet submitted'] = await resolveApprovalClaim(claimRequest(signed.id), 'acme', batchScope(payload));

  // Carried out once already: the first replay spent it. A second replay — a
  // settle path run twice, a retried webhook — gets no stand-in, so it cannot
  // run the payroll again without a code.
  const used = approvedProposal(store, { payload });
  assert.equal((await resolveApprovalClaim(claimRequest(used.id), 'acme', batchScope(payload))).approved, true);
  claims['an approval already used'] = await resolveApprovalClaim(claimRequest(used.id), 'acme', batchScope(payload));

  for (const [name, claim] of Object.entries(claims)) {
    assert.equal(claim.approved, false, name);
    assert.deepEqual(batchSecondFactor(claim, CODE), { by: 'request', whatsapp: false }, name);
    assert.deepEqual(batchSecondFactor(claim, WHATSAPP), { by: 'request', whatsapp: true }, name);
    // No second factor required, no WhatsApp approval spent.
    assert.deepEqual(batchSecondFactor(claim, OFF), { by: 'request', whatsapp: false }, name);
  }

  // Presenting another run's approval did not spend it: its own run still goes.
  assert.equal((await resolveApprovalClaim(claimRequest(other.id), 'acme', batchScope(payload))).approved, true);
});

test('a claim is only a stand-in when the store approved it for this request', () => {
  // The route never builds one of these; resolveApprovalClaim does. Anything
  // it did not approve — whatever else the object says — is not a stand-in.
  for (const claim of [
    { approved: false, proposalId: 'prop_x' },
    { approved: false, proposalId: null, reason: 'already used' },
    { approved: true, proposalId: null },
  ]) {
    assert.equal(batchSecondFactor(claim, CODE).by, 'request', JSON.stringify(claim));
    assert.equal(batchRunKey({ claim, headerKey: null, rowsKey: 'rows' }).key, 'rows', JSON.stringify(claim));
  }
});

// ── The run key ─────────────────────────────────────────────────────────────

test('an approved run is claimed under its approval, so identical payrolls approved apart are two runs', async () => {
  const store = freshStore();
  const payload = approvedPayload();
  const rowsKey = 'rows-digest-of-the-payroll';

  // September's payroll and October's: the same file, approved separately.
  const september = approvedProposal(store, { payload });
  const october = approvedProposal(store, { payload });
  const sep = batchRunKey({
    claim: await resolveApprovalClaim(claimRequest(september.id), 'acme', batchScope(payload)),
    headerKey: null,
    rowsKey,
  });
  const oct = batchRunKey({
    claim: await resolveApprovalClaim(claimRequest(october.id), 'acme', batchScope(payload)),
    headerKey: null,
    rowsKey,
  });

  assert.deepEqual(sep, { ok: true, key: `approval:${september.id}`, proposalId: september.id });
  assert.deepEqual(oct, { ok: true, key: `approval:${october.id}`, proposalId: october.id });
  // Keyed by the rows, October's approved run came back as September's run:
  // recorded as carried out, and nobody paid.
  assert.notEqual(sep.key, oct.key);
  assert.equal(APPROVAL_RUN_KEY_PREFIX, 'approval:');

  // A key the request carries does not displace the approval's.
  assert.equal(
    batchRunKey({ claim: { approved: true, proposalId: 'prop_nov' }, headerKey: 'client-key', rowsKey }).key,
    'approval:prop_nov',
  );
});

test("without an approval, the caller's key or the rows' — never an approval's", () => {
  const none = { approved: false, proposalId: null };
  const rowsKey = 'rows-digest';

  assert.deepEqual(batchRunKey({ claim: none, headerKey: 'payroll-2026-09', rowsKey }), {
    ok: true,
    key: 'payroll-2026-09',
    proposalId: null,
  });
  assert.deepEqual(batchRunKey({ claim: none, headerKey: '  payroll-2026-09  ', rowsKey }).key, 'payroll-2026-09');
  for (const absent of [null, undefined, '', '   ']) {
    assert.deepEqual(batchRunKey({ claim: none, headerKey: absent, rowsKey }), { ok: true, key: rowsKey, proposalId: null });
  }

  // Squatting an approval's run key would make the approved run come back as
  // the squatter's run. Refused, whether or not the request carried a claim.
  for (const [claim, headerKey] of [
    [none, 'approval:prop_123'],
    [none, '  approval:prop_123'],
    [none, 'approval:'],
    [{ approved: false, proposalId: null, reason: 'already used' }, 'approval:prop_123'],
  ]) {
    const refused = batchRunKey({ claim, headerKey, rowsKey });
    assert.equal(refused.ok, false, headerKey);
    assert.equal(refused.code, 'reserved_idempotency_key');
    assert.match(refused.error, /reserved/);
  }
});

// ── The route ───────────────────────────────────────────────────────────────

function code(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
}

async function source(file) {
  return code(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'));
}

/** The `{ ... }` block opening at the first brace at or after `from`. */
function block(text, from) {
  const open = text.indexOf('{', from);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    if (text[i] === '}' && --depth === 0) return text.slice(open, i + 1);
  }
  throw new Error('unbalanced block');
}

test('the route reads the approval before any second factor is asked for or spent', async () => {
  const route = await source('app/api/batches/authorize/route.ts');

  assert.match(
    route,
    /const approvalClaim = await resolveApprovalClaim\(request, orgId, \{\s*kind: 'BATCH_PAYOUT',\s*substance: batchPayoutSubstance,\s*body,\s*consumer: 'batches\/authorize',\s*\}\);/,
  );
  assert.equal(route.match(/resolveApprovalClaim\(/g).length, 1, 'resolved once');

  const rowsAt = route.indexOf('const acceptedRows = payableBatchRows(rows);');
  const rowsKeyAt = route.indexOf('const rowsKey = deriveIdempotencyKey(orgId, acceptedRows, targetCurrency);');
  const claimAt = route.indexOf('resolveApprovalClaim(');
  const runKeyAt = route.indexOf('batchRunKey(');
  const factorAt = route.indexOf('batchSecondFactor(');
  const whatsappAt = route.indexOf('consumeActionApproval(');
  const totpAt = route.indexOf('verifyPayoutTotp(');
  const proposeAt = route.indexOf('proposeForApproval(');
  assert.ok(rowsAt > 0 && rowsAt < claimAt, 'the rows the claim is bound to are the rows the run pays');
  assert.ok(rowsKeyAt > 0 && rowsKeyAt < runKeyAt);
  assert.ok(claimAt < runKeyAt, 'the claim, then the run key');
  assert.ok(runKeyAt < factorAt, 'a reserved key is refused before a code is spent on it');
  assert.ok(factorAt < whatsappAt && whatsappAt < totpAt, 'then the second factor');
  // A maker still clears the second factor before the run can become a proposal.
  assert.ok(totpAt < proposeAt);
});

test('the route skips the second factor only when the decision says the approval stands in', async () => {
  const route = await source('app/api/batches/authorize/route.ts');

  assert.match(route, /const secondFactor = batchSecondFactor\(approvalClaim, settings\);/);
  const branchAt = route.indexOf("if (secondFactor.by === 'request') {");
  assert.ok(branchAt > 0, 'the second factor sits behind the decision');
  const factor = block(route, branchAt);
  // Both factors, and the only WhatsApp spend, live inside that branch: an
  // approved replay spends neither.
  assert.match(factor, /const whatsappApproved = secondFactor\.whatsapp\s*&& await consumeActionApproval\(\{/);
  assert.match(factor, /verifyPayoutTotp\(\{ code: totp, accountId, requireTotp: settings\.requireTotp \}\)/);
  assert.equal(route.match(/consumeActionApproval\(/g).length, 1);
  assert.equal(route.match(/verifyPayoutTotp\(/g).length, 1);
});

test('the approval lifts the second factor and the second approver, and nothing else', async () => {
  const route = await source('app/api/batches/authorize/route.ts');

  // Read once more, by the second-approver branch.
  assert.equal(route.match(/approvalClaim\.approved/g).length, 1);
  assert.match(route, /if \(limits\.requiresSecondApproval && !approvalClaim\.approved\) \{/);

  // The minimum, the row cap, the ceilings and the compliance pause are
  // statements of the handler itself, not of any branch an approval decides.
  for (const guard of [
    /^ {2}const minimum = checkMinimumSettlement\(total, 'batch'\);/m,
    /^ {2}if \(!minimum\.ok\) \{/m,
    /^ {2}if \(acceptedRows\.length > MAX_BATCH_ROWS\) \{/m,
    /^ {2}const limits = checkAuthorizationLimits\(\{/m,
    /^ {2}if \(!limits\.ok\) \{/m,
    /^ {2}const controls = await readComplianceControls\(\);/m,
    /^ {2}if \(controls\.paused\) \{/m,
  ]) {
    assert.match(route, guard);
  }
});

test('the run is claimed under the key the decision chose, and names its approval', async () => {
  const route = await source('app/api/batches/authorize/route.ts');

  assert.match(
    route,
    /const runKey = batchRunKey\(\{ claim: approvalClaim, headerKey: request\.headers\.get\('idempotency-key'\), rowsKey \}\);/,
  );
  assert.match(route, /if \(!runKey\.ok\) return NextResponse\.json\(\{ error: runKey\.error, code: runKey\.code \}, \{ status: 400 \}\);/);
  assert.equal(route.match(/headers\.get\('idempotency-key'\)/g).length, 1, 'the caller key is read in one place');
  assert.match(route, /idempotencyKey: runKey\.key,\s*proposalId: runKey\.proposalId \?\? undefined,/);
  // The proposal is still named by its rows, so a re-submitted file finds it.
  assert.match(route, /idempotencyKey: `batch:\$\{rowsKey\}`/);
});
