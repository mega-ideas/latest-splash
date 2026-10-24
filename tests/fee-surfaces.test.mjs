/**
 * The A1 review's fee-surface Lows (L7): what a customer reads about
 * Splash's fee, on the screens around the quote.
 *
 * What is pinned here:
 *   * no screen shows a funding-source fee tier: A1 removed the
 *     STANDARD/DISCOUNT funding discount, and the quote ignores it, so a
 *     selector or a record that still says "Applied fee: DISCOUNT" tells
 *     the payer about a price that does not exist (L7c).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(path, 'utf8');

// ─── L7c: no retired funding fee tier ──────────────────────────────────────

test('the funding selector shows no retired fee tier', () => {
  const selector = read('components/funding/FundingSelector.tsx');
  assert.doesNotMatch(selector, /Applied fee/, 'no "Applied fee" badge');
  assert.doesNotMatch(selector, /\{selection\.feeTier\}/, 'the selection tier is not rendered');
  assert.doesNotMatch(selector, /'(?:STANDARD|DISCOUNT) fee'/, 'no tier named as a fee on a button');
});

test("the audit record's funding line names the method and asset, not a retired fee tier", () => {
  const audit = read('app/dashboard/audit/[intentId]/page.tsx');
  assert.doesNotMatch(audit, /funding\.feeTier/, 'the record does not print the tier');
  assert.doesNotMatch(audit, /Legacy USD \/ STANDARD/, 'nor a tier for a legacy record');
});
