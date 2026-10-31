import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { roleLabel, personsInChargeView } from '../lib/wallet-page/members.ts';

/**
 * v2 Phase 3, brief 5.5: the Wallet page shows people by name, and an owner
 * can put a member in charge of signing off staff migration. A member is
 * only ever read inside the caller's own business.
 */

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('roles read as what a person is called in the business', () => {
  assert.equal(roleLabel('admin'), 'Owner');
  assert.equal(roleLabel('maker'), 'Staff');
  assert.equal(roleLabel('checker'), 'Approver');
  assert.equal(roleLabel('viewer'), 'Viewer');
  assert.equal(roleLabel('something'), 'Member');
});

test('only a member who makes or approves payments can be put in charge, and one already in charge is not offered again', () => {
  const view = personsInChargeView(
    [{ userId: 'u_owner', name: 'Aiko', role: 'admin' }, { userId: 'u_maker', name: 'Budi', role: 'maker' }, { userId: 'u_checker', name: 'Citra', role: 'checker' }, { userId: 'u_viewer', name: 'Dewi', role: 'viewer' }],
    [{ userId: 'u_checker' }],
  );
  assert.deepEqual(view.inCharge.map((p) => p.name), ['Citra']);
  assert.deepEqual(view.candidates.map((p) => p.name), ['Budi'], 'an owner has the authority already, a viewer is never in charge, and Citra is in charge');
});

test('members are read only inside the caller’s own business', () => {
  const orgModule = read('lib/server/org-member-names.ts');
  assert.match(orgModule, /eq\(memberships\.orgId, orgId\)/);
  assert.doesNotMatch(orgModule, /searchParams|request\./);
  const route = read('app/api/wallet/persons-in-charge/route.ts');
  assert.match(route, /orgMembers\(gate\.route\.db, gate\.route\.orgId\)/);
  assert.match(route, /role === 'OWNER'/, 'the list of people to choose from goes to an owner only');
});
