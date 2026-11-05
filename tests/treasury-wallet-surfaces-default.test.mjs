import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * The default deployment names no partner (SIGNED_PARTNERS is empty), so the
 * Treasury overview and the fund referral describe them by role. The signed
 * case is tests/treasury-wallet-signed.test.mjs, in its own process.
 */

delete process.env.SIGNED_PARTNERS;

test('unsigned, the Treasury overview and the referral describe the fund manager and the issuer by role', async () => {
  const { liveOverviewDeps, liveFundDeps } = await import('../lib/server/treasury-deps.ts');
  const overview = liveOverviewDeps();
  assert.equal(overview.fundManager, 'a fund manager');
  assert.equal(overview.issuer, 'a tokenized treasury issuer');
  assert.equal(liveFundDeps().label, 'a fund manager');
  assert.equal(overview.flags.fundReferral, false, 'the referral waits on legal sign-off: off by default');
  assert.equal(overview.flags.tokenizedStocks, false, 'tokenized stocks are hidden by default');
});
