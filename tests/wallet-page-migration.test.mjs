import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { migrationRows, scopeMigrationMembers } from '../lib/wallet-page/migration.ts';

/**
 * v2 Phase 3, brief 5.5 and 4.1: "Move to your business wallet". Owners and
 * the person in charge see every member's USDC that could move, because they
 * sign it off; anyone else sees their own only. The page words each row from
 * the server's facts and never offers a move the server would refuse.
 */

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const found = [
  { userId: 'u_owner', address: '0xa1', usdcMinor: '5000000', canMove: true, needsSignOff: false },
  { userId: 'u_staff', address: '0xb2', usdcMinor: '2500000', canMove: true, needsSignOff: true },
  { userId: 'u_old', address: '0xc3', usdcMinor: '1000000', canMove: false, needsSignOff: true },
];

test('an owner and the person in charge see every member; anyone else sees only their own', () => {
  assert.equal(scopeMigrationMembers(found, { userId: 'u_owner', authority: 'owner' }).length, 3);
  assert.equal(scopeMigrationMembers(found, { userId: 'u_pic', authority: 'person_in_charge' }).length, 3);
  assert.deepEqual(scopeMigrationMembers(found, { userId: 'u_staff', authority: null }).map((m) => m.address), ['0xb2']);
  assert.deepEqual(scopeMigrationMembers(found, { userId: 'u_nobody', authority: null }), [], 'a member with no funds sees nothing of anyone else');
});

test('a row says what the viewer can do: move, ask for a sign-off, sign off, or wait', () => {
  const rows = migrationRows(
    [
      { ...found[0], clearance: 'not_needed' },
      { ...found[1], clearance: 'needs_sign_off' },
      { ...found[1], address: '0xb3', clearance: 'signed_off' },
      { ...found[2], clearance: 'needs_sign_off' },
    ],
    { userId: 'u_owner', authority: 'owner' },
  );
  assert.deepEqual(rows.map((r) => r.action), ['move', 'sign_off', 'wait', 'other_site']);
  const own = migrationRows([{ ...found[1], clearance: 'needs_sign_off' }], { userId: 'u_staff', authority: null });
  assert.equal(own[0].action, 'ask', 'staff are told to ask an owner or the person in charge');
  const cleared = migrationRows([{ ...found[1], clearance: 'signed_off' }], { userId: 'u_staff', authority: null });
  assert.equal(cleared[0].action, 'move');
});

test('nobody signs off their own move, and a person in charge moving their own needs another sign-off', () => {
  const pic = migrationRows([{ userId: 'u_pic', address: '0xd4', usdcMinor: '1', canMove: true, needsSignOff: true, clearance: 'needs_sign_off' }], { userId: 'u_pic', authority: 'person_in_charge' });
  assert.equal(pic[0].action, 'ask', 'someone else signs it off');
});

test('no funds means no row, and an amount is shown as USDC to the cent', () => {
  assert.deepEqual(migrationRows([{ ...found[0], usdcMinor: '0', clearance: 'not_needed' }], { userId: 'u_owner', authority: 'owner' }), []);
  assert.equal(migrationRows([{ ...found[0], clearance: 'not_needed' }], { userId: 'u_owner', authority: 'owner' })[0].amount, '5.00');
});

test('GET /api/wallet/migration scopes members to the viewer before it answers', () => {
  const route = read('app/api/wallet/migration/route.ts');
  assert.match(route, /scopeMigrationMembers/);
  assert.match(route, /highestAuthority/);
  assert.match(route, /migrationClearance/);
});
