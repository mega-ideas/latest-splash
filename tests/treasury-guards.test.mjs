import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/**
 * The one money route nothing governed.
 *
 * `POST /api/treasury` moved customer principal into and out of a yield-bearing
 * treasury with no second factor, no per-transfer or daily ceiling, no
 * compliance pause check and no approval. Every ceiling an operator configured
 * in Settings simply did not apply to it.
 *
 * And it operated on a SHARED ledger: `getLedger(userId)` returned
 * `ledgers.get(userId) ?? seedDemo()`, and `seedDemo()` only ever writes the
 * `demo-business` key — so every org fell through to the demo ledger and every
 * mutation ran against `ledger.userId`, which was always `'demo-business'`.
 * One tenant could move or withdraw another tenant's principal.
 */

const withoutComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');

async function source(file) {
  return readFile(new URL(`../${file}`, import.meta.url), 'utf8');
}

test('an unknown org gets a treasury of its own, not the demo one', async () => {
  delete process.env.DATABASE_URL;
  const { getLedger } = await import('../lib/server/treasury.ts');

  const acme = await getLedger('acme');
  const northwind = await getLedger('northwind');

  assert.equal(acme.userId, 'acme');
  assert.equal(northwind.userId, 'northwind');
  // Zero is the honest opening balance for a treasury nobody has funded. The
  // alternative was showing them somebody else's money.
  assert.equal(acme.treasuryPrincipalMicro, 0);
  assert.equal(acme.availableMicro, 0);

  // And they are genuinely distinct objects, not one shared row.
  assert.notEqual(acme, northwind);
  const demo = await getLedger('demo-business');
  assert.notEqual(demo, acme);
  assert.ok(demo.treasuryPrincipalMicro > 0, 'the demo org keeps its seeded figures');
});

test('moving one org’s treasury does not move another’s', async () => {
  delete process.env.DATABASE_URL;
  const { getLedger } = await import('../lib/server/treasury.ts');

  const acme = await getLedger('acme');
  const northwind = await getLedger('northwind');
  const before = northwind.treasuryPrincipalMicro;

  acme.treasuryPrincipalMicro += 5_000_000_000;

  assert.equal((await getLedger('northwind')).treasuryPrincipalMicro, before);
  assert.equal((await getLedger('acme')).treasuryPrincipalMicro, 5_000_000_000);
});

test('the treasury route now carries the full payout guard stack', async () => {
  const route = withoutComments(await source('app/api/treasury/route.ts'));

  // Each of these was absent.
  assert.match(route, /verifyPayoutTotp\(/, 'a second factor');
  assert.match(route, /readComplianceControls\(\)/, 'the compliance pause');
  assert.match(route, /checkAuthorizationLimits\(/, 'the ceilings');
  assert.match(route, /proposeForApproval\(/, 'and human approval above the threshold');

  // The ceilings must read the same durable ledger the payment paths use, or a
  // daily cap can be walked around by routing money through the treasury.
  assert.match(route, /listMovementsSince\(orgId, startOfUtcDay/);
});

test('the treasury is keyed by org everywhere', async () => {
  const route = withoutComments(await source('app/api/treasury/route.ts'));
  assert.match(route, /getLedger\(orgId\)/);
  assert.match(route, /function snapshot\(orgId: string\)/);
  assert.doesNotMatch(route, /getLedger\(accountId\)/);
  assert.doesNotMatch(route, /snapshot\(accountId\)/);

  const store = withoutComments(await source('lib/server/treasury.ts'));
  // The fallthrough that merged every tenant.
  assert.doesNotMatch(store, /ledgers\.get\(userId\) \?\? seedDemo\(\)/);
  assert.match(store, /if \(userId === DEMO_USER\) return seedDemo\(\)/);
});

test('an approval lifts only the second approver and the spent code, not the other guards', async () => {
  const route = withoutComments(await source('app/api/treasury/route.ts'));
  // The claim is resolved against the store, bound to this move and spent
  // before anything reads it (lib/server/treasury-approval.ts).
  assert.match(route, /resolveApprovalClaim\(request, orgId, \{/);
  assert.match(route, /limits\.requiresSecondApproval && !approvalClaim\.approved/);

  // It stands in for the TOTP code its maker spent proposing the move, which
  // a replay could never present again — and for nothing else. The pause and
  // the ceilings are not conditional on it: they are statements of the
  // handler itself, after the TOTP check and before the approval branch.
  assert.match(route, /if \(!treasuryApprovedMove\(approvalClaim\)\) \{\s*const totpVerdict = verifyPayoutTotp\(/);
  assert.match(route, /^ {2}const controls = await readComplianceControls\(\);/m);
  assert.match(route, /^ {2}const limits = checkAuthorizationLimits\(\{/m);
  const claimAt = route.indexOf('resolveApprovalClaim(');
  const totpAt = route.indexOf('verifyPayoutTotp(');
  const pauseAt = route.indexOf('readComplianceControls(');
  const limitsAt = route.indexOf('checkAuthorizationLimits(');
  const branchAt = route.indexOf('limits.requiresSecondApproval && !approvalClaim.approved');
  assert.ok(
    claimAt < totpAt && totpAt < pauseAt && pauseAt < limitsAt && limitsAt < branchAt,
    'the claim, TOTP, the pause, the ceilings, then the approval branch',
  );
  assert.equal(route.match(/\bapprovalClaim\b/g).length, 3, 'defined once, read by the TOTP check and the approval branch only');
});
