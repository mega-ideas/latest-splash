import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * Treasury names its partners only once their agreements are signed (brief
 * 5.7, copy rules): the fund manager is "a fund manager" and the issuer "a
 * tokenized treasury issuer" until SIGNED_PARTNERS lists them.
 *
 * The validated environment is read once per process, so the signed case
 * runs in this file (node --test gives every file its own process) and the
 * default case in tests/treasury-wallet-surfaces-default.test.mjs.
 */

process.env.SIGNED_PARTNERS = 'halogen,ondo';

test('once signed, the Treasury overview and the referral name the fund manager and the issuer', async () => {
  const { liveOverviewDeps, liveFundDeps } = await import('../lib/server/treasury-deps.ts');
  const overview = liveOverviewDeps();
  assert.equal(overview.fundManager, 'Halogen');
  assert.equal(overview.issuer, 'Ondo');
  assert.equal(liveFundDeps().label, 'Halogen');
});
