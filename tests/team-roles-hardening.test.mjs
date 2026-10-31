/**
 * Team and roles, after the independent review (v2 Phase 3, section p3-d):
 *
 *   1. A business always keeps an owner, even when two owners demote or remove
 *      each other at the same moment, and when Splash support removes someone.
 *   2. The Finance lead cannot end an owner-granted access by moving or
 *      removing the person who holds it (in charge, Add funds, Withdraw).
 *   3. Changing a role is not an offboarding: it writes no offboarding line
 *      and no "removed" spender row. Removing a person still does.
 *   4. A change and its clean-up are one transaction: if the clean-up fails,
 *      the change is not kept.
 *
 * PGlite with every migration. The same functions the routes call.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { and, eq, isNull } from 'drizzle-orm';

import { migratedDb } from './helpers/store-db.mjs';
import * as schema from '../lib/db/schema.ts';
import { appointPersonInCharge, listAuthorityEvents } from '../lib/server/wallet-authority.ts';
import { readSpenderStanding } from '../lib/server/spend-standing.ts';
import { MembershipAdminError, revokeRole } from '../lib/server/memberships.ts';
import {
  addTeamMember,
  appointFinanceLead,
  changeTeamMemberRole,
  fundsAccessOf,
  removeTeamMember,
  setMemberAccess,
} from '../lib/server/team-admin.ts';

const T0 = new Date('2026-10-30T09:00:00Z');
const VERIFIED = new Date('2026-10-01T00:00:00Z');
const MAKER_ADDRESS = `0x${'ab'.repeat(32)}`;

async function seeded() {
  const { client, db } = await migratedDb();
  const people = [
    ['u-owner', 'owner@acme.test', 'acme', 'admin'],
    ['u-owner2', 'owner2@acme.test', 'acme', 'admin'],
    ['u-lead', 'lead@acme.test', 'acme', 'checker'],
    ['u-appr', 'approver@acme.test', 'acme', 'checker'],
    ['u-maker', 'maker@acme.test', 'acme', 'maker'],
    ['u-maker2', 'maker2@acme.test', 'acme', 'maker'],
    ['u-viewer', 'viewer@acme.test', 'acme', 'viewer'],
    ['u-solo', 'solo@solo.test', 'northwind', 'admin'],
    ['u-free', 'free@example.test', null, null],
  ];
  for (const [id, email, org, role] of people) {
    await db.insert(schema.users).values({ id, email, name: id, emailVerifiedAt: VERIFIED });
    if (org) await db.insert(schema.memberships).values({ id: `m-${id}`, userId: id, orgId: org, role });
  }
  // The maker holds a passkey wallet, so a spending rule at that address is theirs.
  await db.insert(schema.passkeyCredentials).values({ id: 'pk-maker', userId: 'u-maker', credentialId: 'cred-maker', publicKey: 'AAAA', suiAddress: MAKER_ADDRESS, rpId: 'localhost' });
  return { client, db };
}

const base = { orgId: 'acme', now: () => T0 };
const ownersOf = async (db, orgId = 'acme') => (await db.select().from(schema.memberships).where(and(eq(schema.memberships.orgId, orgId), eq(schema.memberships.role, 'admin')))).length;
const roleOf = async (db, orgId, userId) => (await db.select({ r: schema.memberships.role }).from(schema.memberships).where(and(eq(schema.memberships.orgId, orgId), eq(schema.memberships.userId, userId))))[0]?.r ?? null;
const trail = async (db, orgId = 'acme') => (await listAuthorityEvents(db, orgId)).map((e) => e.action);

/* ── 1. A business always keeps an owner ──────────────────────────────── */

test('two owners demoting each other at the same moment leave one owner, not none', async () => {
  const { client, db } = await seeded();
  const results = await Promise.all([
    changeTeamMemberRole(db, { ...base, actorUserId: 'u-owner', userId: 'u-owner2', role: 'viewer' }),
    changeTeamMemberRole(db, { ...base, actorUserId: 'u-owner2', userId: 'u-owner', role: 'viewer' }),
  ]);
  assert.equal(await ownersOf(db), 1, `owners left; results ${JSON.stringify(results)}`);
  assert.equal(results.filter((r) => r.ok).length, 1, JSON.stringify(results));
  await client.close();
});

test('two owners removing each other at the same moment leave one owner, not none', async () => {
  const { client, db } = await seeded();
  const results = await Promise.all([
    removeTeamMember(db, { ...base, actorUserId: 'u-owner', userId: 'u-owner2' }),
    removeTeamMember(db, { ...base, actorUserId: 'u-owner2', userId: 'u-owner' }),
  ]);
  assert.equal(await ownersOf(db), 1, `owners left; results ${JSON.stringify(results)}`);
  assert.equal(results.filter((r) => r.ok).length, 1, JSON.stringify(results));
  await client.close();
});

test('a demotion and a removal at the same moment also leave an owner', async () => {
  const { client, db } = await seeded();
  const results = await Promise.all([
    changeTeamMemberRole(db, { ...base, actorUserId: 'u-owner', userId: 'u-owner2', role: 'checker' }),
    removeTeamMember(db, { ...base, actorUserId: 'u-owner2', userId: 'u-owner' }),
  ]);
  assert.equal(await ownersOf(db), 1, JSON.stringify(results));
  await client.close();
});

test('a demotion is refused with last_owner when the target is the only other owner and the actor is no longer one', async () => {
  const { client, db } = await seeded();
  // The actor was an owner when the request was made and was demoted a moment before it ran.
  const first = await changeTeamMemberRole(db, { ...base, actorUserId: 'u-owner', userId: 'u-owner2', role: 'viewer' });
  assert.equal(first.ok, true);
  const second = await changeTeamMemberRole(db, { ...base, actorUserId: 'u-owner2', userId: 'u-owner', role: 'viewer' });
  assert.equal(second.ok, false);
  assert.equal(second.status, 403);
  assert.equal(await ownersOf(db), 1);
  await client.close();
});

test('Splash support cannot remove the last owner of a business, and says so', async () => {
  const { client, db } = await seeded();
  await assert.rejects(() => revokeRole(db, { email: 'solo@solo.test', by: 'operator:ops@splash.test' }), (e) => e instanceof MembershipAdminError && e.code === 'last_owner');
  assert.equal(await roleOf(db, 'northwind', 'u-solo'), 'admin');
  assert.deepEqual(await trail(db, 'northwind'), [], 'nothing was written');
  // One of two owners can still be removed, and a non-owner always can.
  await revokeRole(db, { email: 'owner2@acme.test', by: 'operator:ops@splash.test' });
  assert.equal(await ownersOf(db), 1);
  await revokeRole(db, { email: 'maker2@acme.test', by: 'operator:ops@splash.test' });
  assert.equal(await roleOf(db, 'acme', 'u-maker2'), null);
  await client.close();
});

/* ── 2. The Finance lead and what an owner granted ────────────────────── */

test('the Finance lead cannot move or remove someone who is in charge, or who holds Add funds or Withdraw', async () => {
  const { client, db } = await seeded();
  await appointFinanceLead(db, { ...base, actorUserId: 'u-owner', userId: 'u-lead' });
  await appointPersonInCharge(db, { orgId: 'acme', actorUserId: 'u-owner', userId: 'u-appr' });
  await setMemberAccess(db, { ...base, actorUserId: 'u-owner', userId: 'u-maker', access: 'withdraw', allowed: true });
  await setMemberAccess(db, { ...base, actorUserId: 'u-owner', userId: 'u-maker2', access: 'add_funds', allowed: true });
  const lead = { ...base, actorUserId: 'u-lead' };
  for (const userId of ['u-appr', 'u-maker', 'u-maker2']) {
    const change = await changeTeamMemberRole(db, { ...lead, userId, role: 'viewer' });
    const remove = await removeTeamMember(db, { ...lead, userId });
    for (const r of [change, remove]) {
      assert.equal(r.ok, false, userId);
      assert.equal(r.status, 403, userId);
      assert.equal(r.code, 'owner_only', userId);
    }
  }
  assert.equal(await roleOf(db, 'acme', 'u-appr'), 'checker');
  assert.equal(await roleOf(db, 'acme', 'u-maker'), 'maker');
  assert.deepEqual(await fundsAccessOf(db, 'acme', 'u-maker'), { addFunds: false, withdraw: true });
  assert.deepEqual(await fundsAccessOf(db, 'acme', 'u-maker2'), { addFunds: true, withdraw: false });

  // Moving a person who holds none of it is still the Finance lead's to do.
  assert.equal((await changeTeamMemberRole(db, { ...lead, userId: 'u-viewer', role: 'maker' })).ok, true);
  assert.equal((await removeTeamMember(db, { ...lead, userId: 'u-viewer' })).ok, true);

  // An owner takes the grant back first; then the Finance lead may move that person.
  await setMemberAccess(db, { ...base, actorUserId: 'u-owner', userId: 'u-maker', access: 'withdraw', allowed: false });
  assert.equal((await changeTeamMemberRole(db, { ...lead, userId: 'u-maker', role: 'checker' })).ok, true);
  // And an owner can always do it.
  assert.equal((await changeTeamMemberRole(db, { ...base, actorUserId: 'u-owner', userId: 'u-maker2', role: 'viewer' })).ok, true);
  assert.equal((await removeTeamMember(db, { ...base, actorUserId: 'u-owner', userId: 'u-appr' })).ok, true);
  await client.close();
});

/* ── 3. A role change is not an offboarding ───────────────────────────── */

const offboardedRows = async (db) => db.select().from(schema.walletOffboardedSpenders);

test('changing a role writes no offboarding line and no removed-spender row; the holds that cannot carry over still end', async () => {
  const { client, db } = await seeded();
  await appointPersonInCharge(db, { orgId: 'acme', actorUserId: 'u-owner', userId: 'u-maker' });
  await setMemberAccess(db, { ...base, actorUserId: 'u-owner', userId: 'u-maker', access: 'withdraw', allowed: true });

  assert.equal((await changeTeamMemberRole(db, { ...base, actorUserId: 'u-owner', userId: 'u-maker', role: 'viewer' })).ok, true);
  const actions = await trail(db);
  assert.ok(!actions.includes('member_offboarded'), 'a role change is logged as a role change');
  assert.deepEqual(await offboardedRows(db), []);
  assert.ok(actions.includes('member_role_changed'));
  assert.ok(actions.includes('person_in_charge_revoked'));
  assert.ok(actions.includes('member_access_revoked'));
  assert.deepEqual(await fundsAccessOf(db, 'acme', 'u-maker'), { addFunds: false, withdraw: false });

  // A viewer's rule shows as a viewer's, and once they are staff again it is theirs again: not "someone who left".
  assert.equal((await readSpenderStanding(db, 'acme'))(MAKER_ADDRESS), 'viewer');
  assert.equal((await changeTeamMemberRole(db, { ...base, actorUserId: 'u-owner', userId: 'u-maker', role: 'maker' })).ok, true);
  assert.equal((await readSpenderStanding(db, 'acme'))(MAKER_ADDRESS), 'member');
  await client.close();
});

test('making someone an owner is a promotion, not an offboarding', async () => {
  const { client, db } = await seeded();
  await setMemberAccess(db, { ...base, actorUserId: 'u-owner', userId: 'u-maker', access: 'add_funds', allowed: true });
  assert.equal((await changeTeamMemberRole(db, { ...base, actorUserId: 'u-owner', userId: 'u-maker', role: 'admin' })).ok, true);
  assert.ok(!(await trail(db)).includes('member_offboarded'));
  assert.deepEqual(await offboardedRows(db), []);
  assert.equal((await readSpenderStanding(db, 'acme'))(MAKER_ADDRESS), 'member', 'an owner\'s rule stays theirs');
  // The grant they held does not come back if they are ever moved down again.
  assert.deepEqual(await db.select().from(schema.walletMemberAccess).where(isNull(schema.walletMemberAccess.revokedAt)), []);
  await client.close();
});

test('removing a person still offboards them: the line, and a removed-spender row per passkey address', async () => {
  const { client, db } = await seeded();
  assert.equal((await removeTeamMember(db, { ...base, actorUserId: 'u-owner', userId: 'u-maker' })).ok, true);
  assert.ok((await trail(db)).includes('member_offboarded'));
  const rows = await offboardedRows(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reason, 'removed');
  assert.equal((await readSpenderStanding(db, 'acme'))(MAKER_ADDRESS), 'removed');
  await client.close();
});

/* ── 4. A change and its clean-up are one transaction ─────────────────── */

async function failingTrail(client, action) {
  await client.exec(`
    CREATE FUNCTION fail_trail() RETURNS trigger AS $$ BEGIN
      IF NEW.action = '${action}' THEN RAISE EXCEPTION 'trail write failed'; END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql;
    CREATE TRIGGER fail_trail_trg BEFORE INSERT ON wallet_authority_events FOR EACH ROW EXECUTE FUNCTION fail_trail();
  `);
}

test('if the clean-up fails, removing a person is not kept: they are still a member and still hold what they held', async () => {
  const { client, db } = await seeded();
  await setMemberAccess(db, { ...base, actorUserId: 'u-owner', userId: 'u-maker', access: 'withdraw', allowed: true });
  await failingTrail(client, 'member_access_revoked');
  await assert.rejects(() => removeTeamMember(db, { ...base, actorUserId: 'u-owner', userId: 'u-maker' }));
  assert.equal(await roleOf(db, 'acme', 'u-maker'), 'maker', 'the membership came back');
  assert.deepEqual(await fundsAccessOf(db, 'acme', 'u-maker'), { addFunds: false, withdraw: true });
  assert.ok(!(await trail(db)).includes('member_removed'));
  assert.deepEqual(await offboardedRows(db), []);
  await client.close();
});

test('if the clean-up fails, changing a role is not kept', async () => {
  const { client, db } = await seeded();
  await setMemberAccess(db, { ...base, actorUserId: 'u-owner', userId: 'u-maker', access: 'withdraw', allowed: true });
  await failingTrail(client, 'member_access_revoked');
  await assert.rejects(() => changeTeamMemberRole(db, { ...base, actorUserId: 'u-owner', userId: 'u-maker', role: 'viewer' }));
  assert.equal(await roleOf(db, 'acme', 'u-maker'), 'maker');
  assert.ok(!(await trail(db)).includes('member_role_changed'));
  await client.close();
});

test('if the trail line cannot be written, adding a person is not kept', async () => {
  const { client, db } = await seeded();
  await failingTrail(client, 'member_added');
  await assert.rejects(() => addTeamMember(db, { ...base, actorUserId: 'u-owner', email: 'free@example.test', role: 'viewer' }));
  assert.equal(await roleOf(db, 'acme', 'u-free'), null);
  await client.close();
});
