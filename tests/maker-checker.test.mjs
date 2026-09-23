import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/**
 * The other half of "this needs a second approver".
 *
 * Both money routes detected the case and neither did anything with it: a 409
 * saying "submit it through the approval queue", and nothing put in the
 * approval queue. A control that stops work without offering the sanctioned
 * path is one people route around — by splitting the payment under the
 * threshold, which is worse than having no threshold at all.
 */

const withoutComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');

async function source(file) {
  return readFile(new URL(`../${file}`, import.meta.url), 'utf8');
}

test('both money routes create a proposal instead of only refusing', async () => {
  for (const file of [
    'app/api/transfers/authorize/route.ts',
    'app/api/batches/authorize/route.ts',
  ]) {
    const text = await source(file);
    const block = text.slice(text.indexOf('requiresSecondApproval'));
    assert.match(block, /proposeForApproval\(/, `${file} must put the payment somewhere`);
    // And say where it went, so the client can link to it rather than telling
    // the operator to go looking.
    assert.match(block, /proposalId: proposal\?\.id/, `${file} must return the proposal id`);
  }
});

test('the maker is the session identity, never a request field', async () => {
  for (const file of [
    'app/api/transfers/authorize/route.ts',
    'app/api/batches/authorize/route.ts',
  ]) {
    const text = withoutComments(await source(file));
    // `createdBy` is what `proposals/[id]/submit` compares against the approver
    // to refuse self-approval. Sourced from the client, the control is
    // decorative.
    assert.match(text, /createdBy: maker\.userId/, `${file} must take the maker from the session`);
    assert.match(text, /resolveAuthorityForSession\(auth\.session\)/);
    assert.doesNotMatch(text, /createdBy: body\.|createdBy: parsed\./);
  }
});

test('a payment refused for approval is still refused when the queue is unreachable', async () => {
  const text = await source('lib/server/dual-approval.ts');
  // `proposeForApproval` returns null on failure and the routes still answer
  // 409. Failing to record the approval is not a reason to let an
  // over-threshold payment through.
  assert.match(text, /return null;/);
  for (const file of [
    'app/api/transfers/authorize/route.ts',
    'app/api/batches/authorize/route.ts',
  ]) {
    const route = await source(file);
    const block = route.slice(route.indexOf('requiresSecondApproval'));
    const refusal = block.slice(0, block.indexOf('{ status: 409 }') + 20);
    assert.match(refusal, /status: 409/, `${file} still refuses`);
    assert.doesNotMatch(
      withoutComments(refusal),
      /if \(!proposal\) [\s\S]{0,40}(continue|return NextResponse\.json\(\{ ok)/,
      `${file} must not proceed when the proposal could not be created`,
    );
  }
});

test('the proposal carries the checks that already passed, not just an amount', async () => {
  const text = await source('lib/server/dual-approval.ts');
  // An approver shown "dual approval required" and a number has to take the
  // rest on trust. Each gate that passed becomes an evidence line.
  assert.match(text, /passedChecks: PassedCheck\[\]/);
  assert.match(text, /trusted: true/);

  for (const file of [
    'app/api/transfers/authorize/route.ts',
    'app/api/batches/authorize/route.ts',
  ]) {
    const route = await source(file);
    const block = route.slice(route.indexOf('requiresSecondApproval'));
    assert.match(block, /source: 'COMPLIANCE'/);
    assert.match(block, /source: 'BALANCE'/);
    assert.match(block, /source: 'COUNTERPARTY'/);
  }
});

test('the proposal is simulated, because the submit route refuses one that is not', async () => {
  const submit = await source('app/api/proposals/[id]/submit/route.ts');
  assert.match(submit, /must be simulated before submission/);

  const text = await source('lib/server/dual-approval.ts');
  assert.match(text, /type: 'SIMULATION_COMPLETED'/);
  // Honest about what that simulation is: the gates already cleared and the
  // money movement, not a claim that a chain dry-run happened.
  assert.match(text, /not a chain dry-run|does not claim a chain dry-run/);
});

test('a re-submitted payment finds its pending proposal rather than queueing a second', async () => {
  const text = await source('lib/server/dual-approval.ts');
  assert.match(text, /ensureProposalStoreHydrated/, 'a cold start must see Postgres first');
  assert.match(text, /p\.orgId === input\.orgId && p\.idempotencyKey === input\.idempotencyKey/);

  const batch = await source('app/api/batches/authorize/route.ts');
  // The batch reuses the run's own derived key, so the queued proposal and the
  // run that would have been created share an identity.
  assert.match(batch, /idempotencyKey: `batch:\$\{deriveIdempotencyKey\(orgId, acceptedRows, targetCurrency\)\}`/);
});

test('the submit route still enforces maker ≠ checker against the DB identity', async () => {
  const submit = await source('app/api/proposals/[id]/submit/route.ts');
  // The control this whole path exists to reach. Unchanged, and asserted here
  // because the proposals now arriving at it come from the money routes.
  assert.match(submit, /Maker cannot approve their own proposal/);
  assert.match(submit, /proposal\.createdBy === ctx\.userId/);
  assert.match(submit, /a second approver must sign from the queue/);
});

test('the compliance gate can actually open once the beneficiary is screened', async () => {
  // Before this, the COUNTERPARTY evidence ref was the beneficiary's NAME.
  // `resolveComplianceForProposal` reads those refs as ids and looks the
  // screening record up by them, so a prose ref could never resolve — the gate
  // blocked forever rather than failing closed once. A control nobody can pass
  // is the same dead end this change exists to close.
  delete process.env.DATABASE_URL;
  const { resolveComplianceForProposal } = await import(
    '../lib/compliance/proposal-screening.ts'
  );
  const { upsertOxwalCounterpartyFixture } = await import('../lib/agent/oxwal.ts');

  const proposal = {
    kind: 'PAYMENT',
    explain: {
      evidence: [{ source: 'COUNTERPARTY', ref: 'rcpt_unscreened_1', observedAt: '', trusted: true }],
    },
  };

  const before = resolveComplianceForProposal(proposal);
  assert.equal(before.kytPassed, false, 'an unscreened beneficiary is blocked');
  assert.ok(before.flags.includes('COUNTERPARTY_NOT_FOUND'));

  upsertOxwalCounterpartyFixture({
    id: 'rcpt_unscreened_1',
    name: 'Davao Freight Co',
    country: 'PH',
    kybStatus: 'VERIFIED',
    kytPassed: true,
    sanctionsClear: true,
  });

  const after = resolveComplianceForProposal(proposal);
  assert.equal(after.kytPassed, true);
  assert.equal(after.kybStatus, 'VERIFIED');
  assert.deepEqual(after.flags, [], 'and it opens once the record exists');
});

test('the money route names the beneficiary by id, not by name', async () => {
  const text = await source('app/api/transfers/authorize/route.ts');
  const block = text.slice(text.indexOf('requiresSecondApproval'));
  assert.match(block, /source: 'COUNTERPARTY', ref: recipient\.id/);

  // Which means the beneficiary must be resolved BEFORE the ceiling check that
  // creates the proposal.
  const beneficiaryAt = text.indexOf('const recipient = await persistRecipient');
  const ceilingAt = text.indexOf('const limits = checkAuthorizationLimits');
  assert.ok(beneficiaryAt > 0 && beneficiaryAt < ceilingAt,
    'the beneficiary must exist before the proposal that names it');
});
