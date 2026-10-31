import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { rulesSummary } from '../lib/wallet-page/rules.ts';

/**
 * v2 Phase 3, brief 5.5: the spending-rules summary on the Wallet page. It is
 * a reading of what the chain applies (GET /api/wallet/spending-rules); the
 * rules themselves are given, changed and taken back in Settings.
 */

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const view = {
  policy: { secondApprovalThresholdMinor: '10000000000', perPaymentMaxMinor: '5000000000' },
  reissueNeeded: false,
  orphaned: [],
  nearThreshold: [{ key: 'a' }, { key: 'b' }],
  rules: [
    { name: 'Budi', userId: 'u_b', status: 'active', perPaymentMaxMinor: '2000000000', allowances: [{ current: true, state: 'active', window: { period: 'day', limitMinor: '5000000000', spentMinor: '1250000000', remainingMinor: '3750000000' } }] },
    { name: 'Citra', userId: 'u_c', status: 'expired', perPaymentMaxMinor: '1000000000', allowances: [{ current: true, state: 'expired', window: null }] },
    { name: null, userId: null, status: 'no_allowance', perPaymentMaxMinor: '0', allowances: [] },
  ],
};

test('the summary names the second-approval threshold, counts the rules that can pay, and reads each rule from the chain', () => {
  const s = rulesSummary(view, { owner: true });
  assert.equal(s.threshold, '10,000.00 USDC');
  assert.equal(s.active, 1);
  assert.equal(s.rules.length, 3);
  assert.deepEqual([s.rules[0].name, s.rules[0].perPayment, s.rules[0].state, s.rules[0].tone], ['Budi', '2,000.00 USDC', 'Active', 'ok']);
  assert.equal(s.rules[0].window, '1,250.00 of 5,000.00 USDC used today');
  assert.equal(s.rules[1].state, 'Expired');
  assert.equal(s.rules[2].name, 'A staff member');
  assert.equal(s.rules[2].state, 'No allowance');
});

test('near-threshold flags are for owners only, and a rotation that left rules behind says to reissue them', () => {
  assert.equal(rulesSummary(view, { owner: true }).nearThreshold, 2);
  assert.equal(rulesSummary(view, { owner: false }).nearThreshold, 0);
  const rotated = rulesSummary({ ...view, reissueNeeded: true, orphaned: ['0xabc'] }, { owner: true });
  assert.equal(rotated.reissueNeeded, true);
  assert.equal(rotated.orphaned, 1);
});

test('a business with no policy yet says so, with nothing invented', () => {
  const s = rulesSummary({ policy: null, reissueNeeded: false, orphaned: [], rules: [] }, { owner: true });
  assert.equal(s.threshold, null);
  assert.equal(s.active, 0);
  assert.deepEqual(s.rules, []);
});

test('the rules route names each rule’s holder from the business’s own members', () => {
  const route = read('app/api/wallet/spending-rules/route.ts');
  assert.match(route, /orgMemberNames\(route\.db, route\.orgId/);
});
