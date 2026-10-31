/**
 * Team and roles, owned by the business (v2 Phase 3, Sky's decision):
 *
 *   - Adding a person, changing their role and removing them are an OWNER's
 *     actions in Settings. They are not a Splash support action.
 *   - An owner can give ONE person (the Finance lead) most of that, and
 *     nothing else that is owner-only: that person adds, changes and removes
 *     viewers, staff and approvers; they never touch an owner, the wallet's
 *     signers, bank accounts, Add funds or Withdraw access, their own limits
 *     or their own role.
 *   - Who may use Add funds and Withdraw inside the dashboard is granted by an
 *     owner, member by member. Nobody else can grant it.
 *   - Every grant, change and removal is a line in the append-only trail.
 *
 * PGlite with every migration. The same functions the routes call.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { and, eq, isNull } from 'drizzle-orm';

import { migratedDb } from './helpers/store-db.mjs';
import * as schema from '../lib/db/schema.ts';
import { listAuthorityEvents, appointPersonInCharge, highestAuthority } from '../lib/server/wallet-authority.ts';
import {
  addTeamMember,
  appointFinanceLead,
  changeTeamMemberRole,
  financeLeadOf,
  fundsAccessOf,
  listTeam,
  listTeamActivity,
  removeTeamMember,
  revokeFinanceLead,
  setMemberAccess,
  teamManager,
} from '../lib/server/team-admin.ts';

const T0 = new Date('2026-10-30T09:00:00Z');
const VERIFIED = new Date('2026-10-01T00:00:00Z');

/**
 * acme: two owners, an approver (the future Finance lead), another approver,
 * staff and a viewer. northwind: an owner and a staff member. Three accounts
 * with no membership: one verified, one not, and `u-new-north` who is already
 * a northwind member and so is not free to be added elsewhere.
 */
async function seeded() {
  const { client, db } = await migratedDb();
  const people = [
    ['u-owner', 'owner@acme.test', 'acme', 'admin', true],
    ['u-owner2', 'owner2@acme.test', 'acme', 'admin', true],
    ['u-lead', 'lead@acme.test', 'acme', 'checker', true],
    ['u-appr', 'approver@acme.test', 'acme', 'checker', true],
    ['u-maker', 'maker@acme.test', 'acme', 'maker', true],
    ['u-viewer', 'viewer@acme.test', 'acme', 'viewer', true],
    ['u-n-owner', 'owner@northwind.test', 'northwind', 'admin', true],
    ['u-n-maker', 'maker@northwind.test', 'northwind', 'maker', true],
    ['u-free', 'free@example.test', null, null, true],
    ['u-free2', 'free2@example.test', null, null, true],
    ['u-unverified', 'unverified@example.test', null, null, false],
  ];
  for (const [id, email, org, role, verified] of people) {
    await db.insert(schema.users).values({ id, email, name: id, emailVerifiedAt: verified ? VERIFIED : null });
    if (org) await db.insert(schema.memberships).values({ id: `m-${id}`, userId: id, orgId: org, role });
  }
  return { client, db };
}

const roleOf = async (db, orgId, userId) => (await db.select({ r: schema.memberships.role }).from(schema.memberships).where(and(eq(schema.memberships.orgId, orgId), eq(schema.memberships.userId, userId))))[0]?.r ?? null;
const trail = async (db, orgId = 'acme') => (await listAuthorityEvents(db, orgId)).map((e) => e.action);
const base = { orgId: 'acme', now: () => T0 };

test('an owner adds a person by email with a role; the trail names who did it, to whom, and the role', async () => {
  const { client, db } = await seeded();
  const added = await addTeamMember(db, { ...base, actorUserId: 'u-owner', email: '  Free@Example.test ', role: 'maker' });
  assert.equal(added.ok, true, JSON.stringify(added));
  assert.equal(await roleOf(db, 'acme', 'u-free'), 'maker');
  const [event] = (await listAuthorityEvents(db, 'acme')).filter((e) => e.action === 'member_added');
  assert.equal(event.actorUserId, 'u-owner');
  assert.equal(event.subjectUserId, 'u-free');
  assert.deepEqual(event.detail, { role: 'maker' });
  const [row] = await db.select().from(schema.memberships).where(eq(schema.memberships.userId, 'u-free'));
  assert.equal(row.grantedBy, 'u-owner', 'the membership row says who granted it');
  await client.close();
});

test('an owner can give any of the four roles, an owner included', async () => {
  const { client, db } = await seeded();
  for (const [email, role] of [['free@example.test', 'viewer'], ['free2@example.test', 'admin']]) {
    assert.equal((await addTeamMember(db, { ...base, actorUserId: 'u-owner', email, role })).ok, true);
  }
  assert.equal(await roleOf(db, 'acme', 'u-free2'), 'admin');
  await client.close();
});

test('adding someone twice makes one membership and one trail line (replay)', async () => {
  const { client, db } = await seeded();
  assert.equal((await addTeamMember(db, { ...base, actorUserId: 'u-owner', email: 'free@example.test', role: 'maker' })).ok, true);
  const again = await addTeamMember(db, { ...base, actorUserId: 'u-owner', email: 'free@example.test', role: 'maker' });
  assert.equal(again.ok, false);
  assert.equal(again.status, 409);
  assert.equal(again.code, 'already_on_team');
  assert.equal((await db.select().from(schema.memberships).where(eq(schema.memberships.userId, 'u-free'))).length, 1);
  assert.equal((await trail(db)).filter((a) => a === 'member_added').length, 1);
  await client.close();
});

test('two owners adding the same person at once make one membership', async () => {
  const { client, db } = await seeded();
  const results = await Promise.all([
    addTeamMember(db, { ...base, actorUserId: 'u-owner', email: 'free@example.test', role: 'maker' }),
    addTeamMember(db, { ...base, actorUserId: 'u-owner2', email: 'free@example.test', role: 'viewer' }),
  ]);
  assert.equal(results.filter((r) => r.ok).length, 1, JSON.stringify(results));
  assert.equal((await db.select().from(schema.memberships).where(eq(schema.memberships.userId, 'u-free'))).length, 1);
  assert.equal((await trail(db)).filter((a) => a === 'member_added').length, 1);
  await client.close();
});

test('an address with no account, an unverified one and one in another business all get the same answer, and nothing is written', async () => {
  const { client, db } = await seeded();
  const before = (await db.select().from(schema.memberships)).length;
  const answers = [];
  for (const email of ['nobody@example.test', 'unverified@example.test', 'maker@northwind.test']) {
    const r = await addTeamMember(db, { ...base, actorUserId: 'u-owner', email, role: 'viewer' });
    assert.equal(r.ok, false, email);
    answers.push([r.status, r.code, r.error]);
  }
  assert.deepEqual(answers[0], answers[1]);
  assert.deepEqual(answers[1], answers[2], 'the refusal does not say which of the three it was');
  assert.equal(answers[0][1], 'cannot_add');
  assert.equal((await db.select().from(schema.memberships)).length, before);
  assert.deepEqual((await trail(db)).filter((a) => a === 'member_added'), []);
  await client.close();
});

test('a role that is not one of the four is refused and nothing is written', async () => {
  const { client, db } = await seeded();
  for (const role of ['finance_lead', 'owner', 'superuser', '', undefined, 'ADMIN']) {
    const r = await addTeamMember(db, { ...base, actorUserId: 'u-owner', email: 'free@example.test', role });
    assert.equal(r.ok, false, String(role));
    assert.equal(r.status, 400);
    assert.equal(r.code, 'bad_role');
  }
  assert.equal(await roleOf(db, 'acme', 'u-free'), null);
  await client.close();
});

/* ── Default deny ─────────────────────────────────────────────────────── */

const NON_MANAGERS = [
  ['a staff member', 'acme', 'u-maker'],
  ['an approver who is not the Finance lead', 'acme', 'u-appr'],
  ['a viewer', 'acme', 'u-viewer'],
  ['an owner of another business', 'northwind', 'u-n-owner'],
  ['a person with no membership', 'acme', 'u-free'],
  ['a user id that does not exist', 'acme', 'u-ghost'],
];

test('everyone but an owner and the Finance lead is refused, on every team action, and nothing changes', async () => {
  const { client, db } = await seeded();
  const snapshot = async () => JSON.stringify([
    (await db.select().from(schema.memberships)).map((m) => [m.userId, m.orgId, m.role]).sort(),
    await db.select().from(schema.walletFinanceLeads),
    await db.select().from(schema.walletMemberAccess),
    await trail(db),
    await trail(db, 'northwind'),
  ]);
  const before = await snapshot();
  for (const [who, actingOrg, actorUserId] of NON_MANAGERS) {
    const base2 = { orgId: actingOrg === 'northwind' ? 'acme' : 'acme', actorUserId, now: () => T0 };
    const attempts = {
      add: await addTeamMember(db, { ...base2, email: 'free@example.test', role: 'viewer' }),
      change: await changeTeamMemberRole(db, { ...base2, userId: 'u-maker', role: 'checker' }),
      remove: await removeTeamMember(db, { ...base2, userId: 'u-maker' }),
      appoint: await appointFinanceLead(db, { ...base2, userId: 'u-lead' }),
      revoke: await revokeFinanceLead(db, base2),
      grant: await setMemberAccess(db, { ...base2, userId: 'u-maker', access: 'withdraw', allowed: true }),
    };
    for (const [name, r] of Object.entries(attempts)) {
      assert.equal(r.ok, false, `${who} must not ${name}`);
      assert.ok(r.status === 403 || r.status === 404, `${who} ${name}: ${r.status}`);
    }
  }
  assert.equal(await snapshot(), before, 'not one row moved');
  await client.close();
});

test('an owner of one business cannot read, change, remove or grant access to another business', async () => {
  const { client, db } = await seeded();
  const north = { orgId: 'northwind', actorUserId: 'u-n-owner', now: () => T0 };
  // Acting in their own business, naming acme people: they read as absent.
  for (const [name, r] of Object.entries({
    change: await changeTeamMemberRole(db, { ...north, userId: 'u-maker', role: 'viewer' }),
    remove: await removeTeamMember(db, { ...north, userId: 'u-maker' }),
    appoint: await appointFinanceLead(db, { ...north, userId: 'u-lead' }),
    grant: await setMemberAccess(db, { ...north, userId: 'u-maker', access: 'add_funds', allowed: true }),
  })) {
    assert.equal(r.ok, false, name);
    assert.equal(r.status, 404, name);
    assert.equal(r.code, 'not_a_member', name);
  }
  assert.equal(await roleOf(db, 'acme', 'u-maker'), 'maker');
  // Acting in acme with a northwind owner's id: they hold nothing there.
  const r = await removeTeamMember(db, { orgId: 'acme', actorUserId: 'u-n-owner', userId: 'u-maker', now: () => T0 });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
  assert.equal(await roleOf(db, 'acme', 'u-maker'), 'maker');
  // The team list of one business never holds the other's people.
  assert.deepEqual((await listTeam(db, 'northwind')).map((m) => m.userId).sort(), ['u-n-maker', 'u-n-owner']);
  assert.deepEqual((await listTeamActivity(db, 'northwind', 50)), []);
  await client.close();
});

/* ── Changing a role ──────────────────────────────────────────────────── */

test('an owner changes a role; the trail has the old and the new role; the same role again changes nothing', async () => {
  const { client, db } = await seeded();
  const r = await changeTeamMemberRole(db, { ...base, actorUserId: 'u-owner', userId: 'u-maker', role: 'checker' });
  assert.deepEqual([r.ok, r.changed], [true, true]);
  assert.equal(await roleOf(db, 'acme', 'u-maker'), 'checker');
  const [event] = (await listAuthorityEvents(db, 'acme')).filter((e) => e.action === 'member_role_changed');
  assert.deepEqual([event.actorUserId, event.subjectUserId, event.detail], ['u-owner', 'u-maker', { from: 'maker', to: 'checker' }]);

  const again = await changeTeamMemberRole(db, { ...base, actorUserId: 'u-owner', userId: 'u-maker', role: 'checker' });
  assert.deepEqual([again.ok, again.changed], [true, false]);
  assert.equal((await trail(db)).filter((a) => a === 'member_role_changed').length, 1, 'a replay writes no second line');
  await client.close();
});

test('nobody changes their own role or removes themselves, so a business always keeps an owner', async () => {
  const { client, db } = await seeded();
  for (const actor of ['u-owner', 'u-lead']) {
    const c = await changeTeamMemberRole(db, { ...base, actorUserId: actor, userId: actor, role: actor === 'u-lead' ? 'admin' : 'viewer' });
    assert.equal(c.ok, false, actor);
    assert.equal(c.code, actor === 'u-lead' ? 'not_allowed' : 'self_change', actor);
    const rm = await removeTeamMember(db, { ...base, actorUserId: actor, userId: actor });
    assert.equal(rm.ok, false, actor);
  }
  assert.equal(await roleOf(db, 'acme', 'u-owner'), 'admin');
  // One owner can still remove the other: the one who acts remains.
  assert.equal((await removeTeamMember(db, { ...base, actorUserId: 'u-owner', userId: 'u-owner2' })).ok, true);
  assert.equal((await removeTeamMember(db, { ...base, actorUserId: 'u-owner', userId: 'u-owner' })).ok, false);
  await client.close();
});

test('moving someone to viewer or owner ends what only staff and approvers hold: in charge, Finance lead, Add funds and Withdraw', async () => {
  const { client, db } = await seeded();
  assert.equal((await appointPersonInCharge(db, { orgId: 'acme', actorUserId: 'u-owner', userId: 'u-lead' })).ok, true);
  assert.equal((await appointFinanceLead(db, { ...base, actorUserId: 'u-owner', userId: 'u-lead' })).ok, true);
  for (const access of ['add_funds', 'withdraw']) assert.equal((await setMemberAccess(db, { ...base, actorUserId: 'u-owner', userId: 'u-lead', access, allowed: true })).ok, true);
  assert.equal(await highestAuthority(db, 'acme', 'u-lead'), 'person_in_charge');

  assert.equal((await changeTeamMemberRole(db, { ...base, actorUserId: 'u-owner', userId: 'u-lead', role: 'viewer' })).ok, true);
  assert.equal(await financeLeadOf(db, 'acme'), null);
  assert.deepEqual(await fundsAccessOf(db, 'acme', 'u-lead'), { addFunds: false, withdraw: false });
  assert.equal(await highestAuthority(db, 'acme', 'u-lead'), null);
  const actions = await trail(db);
  for (const a of ['member_role_changed', 'finance_lead_revoked', 'member_access_revoked', 'person_in_charge_revoked']) assert.ok(actions.includes(a), a);
  // Back to approver: nothing comes back by itself.
  assert.equal((await changeTeamMemberRole(db, { ...base, actorUserId: 'u-owner', userId: 'u-lead', role: 'checker' })).ok, true);
  assert.equal(await financeLeadOf(db, 'acme'), null);
  assert.deepEqual(await fundsAccessOf(db, 'acme', 'u-lead'), { addFunds: false, withdraw: false });
  assert.equal(await highestAuthority(db, 'acme', 'u-lead'), null);
  await client.close();
});

test('an approver moved to staff stops being the Finance lead (the role is an approver\'s)', async () => {
  const { client, db } = await seeded();
  await appointFinanceLead(db, { ...base, actorUserId: 'u-owner', userId: 'u-lead' });
  assert.equal(await teamManager(db, 'acme', 'u-lead'), 'finance_lead');
  await changeTeamMemberRole(db, { ...base, actorUserId: 'u-owner', userId: 'u-lead', role: 'maker' });
  assert.equal(await teamManager(db, 'acme', 'u-lead'), null);
  assert.equal(await financeLeadOf(db, 'acme'), null);
  await client.close();
});

/* ── Removing ─────────────────────────────────────────────────────────── */

test('an owner removes a person; their membership, Finance lead, access and place in charge go with it, and it is on the trail', async () => {
  const { client, db } = await seeded();
  await appointFinanceLead(db, { ...base, actorUserId: 'u-owner', userId: 'u-lead' });
  await setMemberAccess(db, { ...base, actorUserId: 'u-owner', userId: 'u-lead', access: 'withdraw', allowed: true });
  const r = await removeTeamMember(db, { ...base, actorUserId: 'u-owner', userId: 'u-lead' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(await roleOf(db, 'acme', 'u-lead'), null);
  assert.equal(await financeLeadOf(db, 'acme'), null);
  assert.deepEqual(await fundsAccessOf(db, 'acme', 'u-lead'), { addFunds: false, withdraw: false });
  const events = await listAuthorityEvents(db, 'acme');
  const removed = events.find((e) => e.action === 'member_removed');
  assert.deepEqual([removed.actorUserId, removed.subjectUserId, removed.detail.role], ['u-owner', 'u-lead', 'checker']);
  assert.ok(events.some((e) => e.action === 'member_offboarded'), 'the offboarding that already existed still runs');
  // Replaying it finds nobody and writes nothing more.
  const again = await removeTeamMember(db, { ...base, actorUserId: 'u-owner', userId: 'u-lead' });
  assert.equal(again.ok, false);
  assert.equal(again.status, 404);
  assert.equal((await trail(db)).filter((a) => a === 'member_removed').length, 1);
  await client.close();
});

test('removing a person leaves other businesses\' memberships alone (the delete is scoped to this business)', async () => {
  const { client, db } = await seeded();
  // A person who belongs to two businesses (the table allows it): removing them from acme keeps northwind.
  await db.insert(schema.memberships).values({ id: 'm-maker-north', userId: 'u-maker', orgId: 'northwind', role: 'viewer' });
  assert.equal((await removeTeamMember(db, { ...base, actorUserId: 'u-owner', userId: 'u-maker' })).ok, true);
  assert.equal(await roleOf(db, 'acme', 'u-maker'), null);
  assert.equal(await roleOf(db, 'northwind', 'u-maker'), 'viewer');
  await client.close();
});

/* ── The Finance lead ─────────────────────────────────────────────────── */

test('only an owner appoints the Finance lead, and only an approver of this business can be one', async () => {
  const { client, db } = await seeded();
  for (const [who, actorUserId] of [['the approver', 'u-lead'], ['staff', 'u-maker'], ['a viewer', 'u-viewer']]) {
    const r = await appointFinanceLead(db, { ...base, actorUserId, userId: 'u-lead' });
    assert.equal(r.ok, false, who);
    assert.equal(r.status, 403, who);
  }
  for (const [userId, status, code] of [['u-maker', 409, 'not_an_approver'], ['u-viewer', 409, 'not_an_approver'], ['u-owner2', 409, 'not_an_approver'], ['u-n-maker', 404, 'not_a_member'], ['u-free', 404, 'not_a_member']]) {
    const r = await appointFinanceLead(db, { ...base, actorUserId: 'u-owner', userId });
    assert.deepEqual([r.ok, r.status, r.code], [false, status, code], userId);
  }
  assert.equal(await financeLeadOf(db, 'acme'), null);
  assert.equal((await appointFinanceLead(db, { ...base, actorUserId: 'u-owner', userId: 'u-lead' })).ok, true);
  assert.equal(await financeLeadOf(db, 'acme'), 'u-lead');
  const [event] = (await listAuthorityEvents(db, 'acme')).filter((e) => e.action === 'finance_lead_appointed');
  assert.deepEqual([event.actorUserId, event.subjectUserId], ['u-owner', 'u-lead']);
  await client.close();
});

test('there is one Finance lead at a time: a second appointment is refused until the first is taken back; two at once make one', async () => {
  const { client, db } = await seeded();
  assert.equal((await appointFinanceLead(db, { ...base, actorUserId: 'u-owner', userId: 'u-lead' })).ok, true);
  const second = await appointFinanceLead(db, { ...base, actorUserId: 'u-owner2', userId: 'u-appr' });
  assert.deepEqual([second.ok, second.status, second.code], [false, 409, 'finance_lead_exists']);
  assert.equal(await financeLeadOf(db, 'acme'), 'u-lead');
  assert.equal((await revokeFinanceLead(db, { ...base, actorUserId: 'u-owner' })).ok, true);
  assert.equal((await appointFinanceLead(db, { ...base, actorUserId: 'u-owner', userId: 'u-appr' })).ok, true);
  assert.equal(await financeLeadOf(db, 'acme'), 'u-appr');
  assert.deepEqual((await trail(db)).filter((a) => a.startsWith('finance_lead')), ['finance_lead_appointed', 'finance_lead_revoked', 'finance_lead_appointed']);

  const { client: c2, db: db2 } = await seeded();
  const raced = await Promise.all([
    appointFinanceLead(db2, { ...base, actorUserId: 'u-owner', userId: 'u-lead' }),
    appointFinanceLead(db2, { ...base, actorUserId: 'u-owner2', userId: 'u-appr' }),
  ]);
  assert.equal(raced.filter((r) => r.ok).length, 1, JSON.stringify(raced));
  assert.equal((await db2.select().from(schema.walletFinanceLeads).where(isNull(schema.walletFinanceLeads.revokedAt))).length, 1);
  await client.close();
  await c2.close();
});

test('taking the role back when there is none changes nothing and writes nothing', async () => {
  const { client, db } = await seeded();
  const r = await revokeFinanceLead(db, { ...base, actorUserId: 'u-owner' });
  assert.deepEqual([r.ok, r.status, r.code], [false, 404, 'no_finance_lead']);
  assert.deepEqual((await trail(db)).filter((a) => a.startsWith('finance_lead')), []);
  await client.close();
});

test('the Finance lead adds, changes and removes viewers, staff and approvers', async () => {
  const { client, db } = await seeded();
  await appointFinanceLead(db, { ...base, actorUserId: 'u-owner', userId: 'u-lead' });
  const lead = { ...base, actorUserId: 'u-lead' };
  assert.equal(await teamManager(db, 'acme', 'u-lead'), 'finance_lead');

  for (const [email, role] of [['free@example.test', 'checker'], ['free2@example.test', 'viewer']]) {
    assert.equal((await addTeamMember(db, { ...lead, email, role })).ok, true, role);
  }
  assert.equal((await changeTeamMemberRole(db, { ...lead, userId: 'u-maker', role: 'checker' })).ok, true);
  assert.equal((await changeTeamMemberRole(db, { ...lead, userId: 'u-appr', role: 'viewer' })).ok, true);
  assert.equal((await removeTeamMember(db, { ...lead, userId: 'u-viewer' })).ok, true);
  assert.equal(await roleOf(db, 'acme', 'u-viewer'), null);

  // Each is on the trail under the lead's name, not the owner's.
  const events = (await listAuthorityEvents(db, 'acme')).filter((e) => ['member_added', 'member_role_changed', 'member_removed'].includes(e.action));
  assert.equal(events.length, 5);
  assert.ok(events.every((e) => e.actorUserId === 'u-lead'));
  await client.close();
});

test('the Finance lead cannot give the owner role, touch an owner, or change themselves', async () => {
  const { client, db } = await seeded();
  await appointFinanceLead(db, { ...base, actorUserId: 'u-owner', userId: 'u-lead' });
  const lead = { ...base, actorUserId: 'u-lead' };
  const refused = [
    ['add an owner', await addTeamMember(db, { ...lead, email: 'free@example.test', role: 'admin' })],
    ['make staff an owner', await changeTeamMemberRole(db, { ...lead, userId: 'u-maker', role: 'admin' })],
    ['demote an owner', await changeTeamMemberRole(db, { ...lead, userId: 'u-owner', role: 'viewer' })],
    ['remove an owner', await removeTeamMember(db, { ...lead, userId: 'u-owner' })],
    ['change their own role', await changeTeamMemberRole(db, { ...lead, userId: 'u-lead', role: 'maker' })],
    ['remove themselves', await removeTeamMember(db, { ...lead, userId: 'u-lead' })],
  ];
  for (const [what, r] of refused) {
    assert.equal(r.ok, false, `must not ${what}`);
    assert.equal(r.status, 403, what);
  }
  assert.equal(refused[0][1].code, 'owner_only');
  assert.equal(await roleOf(db, 'acme', 'u-owner'), 'admin');
  assert.equal(await roleOf(db, 'acme', 'u-lead'), 'checker');
  assert.equal(await roleOf(db, 'acme', 'u-maker'), 'maker');
  await client.close();
});

test('the Finance lead cannot appoint or take back a Finance lead, and cannot grant or take away Add funds or Withdraw, for anyone, themselves included', async () => {
  const { client, db } = await seeded();
  await appointFinanceLead(db, { ...base, actorUserId: 'u-owner', userId: 'u-lead' });
  const lead = { ...base, actorUserId: 'u-lead' };
  const refused = [
    await appointFinanceLead(db, { ...lead, userId: 'u-appr' }),
    await revokeFinanceLead(db, lead),
    await setMemberAccess(db, { ...lead, userId: 'u-lead', access: 'withdraw', allowed: true }),
    await setMemberAccess(db, { ...lead, userId: 'u-maker', access: 'add_funds', allowed: true }),
  ];
  for (const r of refused) {
    assert.equal(r.ok, false);
    assert.equal(r.status, 403);
    assert.equal(r.code, 'owner_only');
  }
  assert.equal(await financeLeadOf(db, 'acme'), 'u-lead');
  assert.deepEqual(await fundsAccessOf(db, 'acme', 'u-lead'), { addFunds: false, withdraw: false }, 'the role carries no money access of its own');
  await client.close();
});

test('the Finance lead\'s powers end the moment the role is taken back', async () => {
  const { client, db } = await seeded();
  await appointFinanceLead(db, { ...base, actorUserId: 'u-owner', userId: 'u-lead' });
  assert.equal((await addTeamMember(db, { ...base, actorUserId: 'u-lead', email: 'free@example.test', role: 'viewer' })).ok, true);
  await revokeFinanceLead(db, { ...base, actorUserId: 'u-owner' });
  const r = await addTeamMember(db, { ...base, actorUserId: 'u-lead', email: 'free2@example.test', role: 'viewer' });
  assert.deepEqual([r.ok, r.status], [false, 403]);
  assert.equal(await teamManager(db, 'acme', 'u-lead'), null);
  await client.close();
});

/* ── Add funds and Withdraw ───────────────────────────────────────────── */

test('owners can add funds and withdraw; nobody else can until an owner grants it, and a viewer never can', async () => {
  const { client, db } = await seeded();
  assert.deepEqual(await fundsAccessOf(db, 'acme', 'u-owner'), { addFunds: true, withdraw: true });
  for (const u of ['u-maker', 'u-appr', 'u-lead', 'u-viewer', 'u-free', 'u-ghost']) {
    assert.deepEqual(await fundsAccessOf(db, 'acme', u), { addFunds: false, withdraw: false }, u);
  }
  // A person of another business holds nothing here.
  assert.deepEqual(await fundsAccessOf(db, 'acme', 'u-n-owner'), { addFunds: false, withdraw: false });
  await client.close();
});

test('an owner grants Add funds and Withdraw separately; the trail has each, a replay writes nothing, taking back is the same', async () => {
  const { client, db } = await seeded();
  const owner = { ...base, actorUserId: 'u-owner' };
  const g = await setMemberAccess(db, { ...owner, userId: 'u-maker', access: 'add_funds', allowed: true });
  assert.deepEqual([g.ok, g.changed], [true, true]);
  assert.deepEqual(await fundsAccessOf(db, 'acme', 'u-maker'), { addFunds: true, withdraw: false });
  const replay = await setMemberAccess(db, { ...owner, userId: 'u-maker', access: 'add_funds', allowed: true });
  assert.deepEqual([replay.ok, replay.changed], [true, false]);
  assert.equal((await db.select().from(schema.walletMemberAccess).where(isNull(schema.walletMemberAccess.revokedAt))).length, 1);

  assert.equal((await setMemberAccess(db, { ...owner, userId: 'u-maker', access: 'withdraw', allowed: true })).ok, true);
  assert.deepEqual(await fundsAccessOf(db, 'acme', 'u-maker'), { addFunds: true, withdraw: true });

  const off = await setMemberAccess(db, { ...owner, userId: 'u-maker', access: 'add_funds', allowed: false });
  assert.deepEqual([off.ok, off.changed], [true, true]);
  assert.deepEqual(await fundsAccessOf(db, 'acme', 'u-maker'), { addFunds: false, withdraw: true });
  const offAgain = await setMemberAccess(db, { ...owner, userId: 'u-maker', access: 'add_funds', allowed: false });
  assert.deepEqual([offAgain.ok, offAgain.changed], [true, false]);

  const events = (await listAuthorityEvents(db, 'acme')).filter((e) => e.action.startsWith('member_access'));
  assert.deepEqual(events.map((e) => [e.action, e.actorUserId, e.subjectUserId, e.detail.access]), [
    ['member_access_granted', 'u-owner', 'u-maker', 'add_funds'],
    ['member_access_granted', 'u-owner', 'u-maker', 'withdraw'],
    ['member_access_revoked', 'u-owner', 'u-maker', 'add_funds'],
  ]);
  // Granted again after being taken back: a fresh grant.
  assert.equal((await setMemberAccess(db, { ...owner, userId: 'u-maker', access: 'add_funds', allowed: true })).changed, true);
  await client.close();
});

test('Add funds and Withdraw go to staff and approvers only: not a viewer, not an owner (who has it already), not someone unknown', async () => {
  const { client, db } = await seeded();
  const owner = { ...base, actorUserId: 'u-owner' };
  const cases = [['u-viewer', 409, 'cannot_hold_access'], ['u-owner2', 409, 'not_needed'], ['u-free', 404, 'not_a_member'], ['u-n-maker', 404, 'not_a_member']];
  for (const [userId, status, code] of cases) {
    const r = await setMemberAccess(db, { ...owner, userId, access: 'withdraw', allowed: true });
    assert.deepEqual([r.ok, r.status, r.code], [false, status, code], userId);
  }
  const bad = await setMemberAccess(db, { ...owner, userId: 'u-maker', access: 'everything', allowed: true });
  assert.deepEqual([bad.ok, bad.status, bad.code], [false, 400, 'bad_access']);
  assert.equal((await db.select().from(schema.walletMemberAccess)).length, 0);
  await client.close();
});

test('a grant does not survive its person leaving or being made a viewer, and a stale row grants nothing even if one is left behind', async () => {
  const { client, db } = await seeded();
  const owner = { ...base, actorUserId: 'u-owner' };
  await setMemberAccess(db, { ...owner, userId: 'u-maker', access: 'withdraw', allowed: true });
  // A row left behind for someone whose role no longer allows it (a bug elsewhere, a manual edit) still grants nothing.
  await db.update(schema.memberships).set({ role: 'viewer' }).where(eq(schema.memberships.userId, 'u-maker'));
  assert.deepEqual(await fundsAccessOf(db, 'acme', 'u-maker'), { addFunds: false, withdraw: false });
  await db.update(schema.memberships).set({ role: 'maker' }).where(eq(schema.memberships.userId, 'u-maker'));
  await removeTeamMember(db, { ...owner, userId: 'u-maker' });
  assert.deepEqual(await fundsAccessOf(db, 'acme', 'u-maker'), { addFunds: false, withdraw: false });
  assert.equal((await db.select().from(schema.walletMemberAccess).where(isNull(schema.walletMemberAccess.revokedAt))).length, 0);
  await client.close();
});

test('a grant in one business gives nothing in another', async () => {
  const { client, db } = await seeded();
  await setMemberAccess(db, { orgId: 'northwind', actorUserId: 'u-n-owner', userId: 'u-n-maker', access: 'withdraw', allowed: true, now: () => T0 });
  assert.deepEqual(await fundsAccessOf(db, 'northwind', 'u-n-maker'), { addFunds: false, withdraw: true });
  assert.deepEqual(await fundsAccessOf(db, 'acme', 'u-n-maker'), { addFunds: false, withdraw: false });
  await client.close();
});

/* ── Reading ──────────────────────────────────────────────────────────── */

test('the team list names each person, role, and what they hold; the activity list is this business\'s team lines only', async () => {
  const { client, db } = await seeded();
  await appointFinanceLead(db, { ...base, actorUserId: 'u-owner', userId: 'u-lead' });
  await setMemberAccess(db, { ...base, actorUserId: 'u-owner', userId: 'u-maker', access: 'add_funds', allowed: true });
  await appointPersonInCharge(db, { orgId: 'acme', actorUserId: 'u-owner', userId: 'u-appr' });
  const team = await listTeam(db, 'acme');
  assert.deepEqual(team.map((m) => m.userId).sort(), ['u-appr', 'u-lead', 'u-maker', 'u-owner', 'u-owner2', 'u-viewer']);
  const by = Object.fromEntries(team.map((m) => [m.userId, m]));
  assert.equal(by['u-lead'].financeLead, true);
  assert.equal(by['u-appr'].inCharge, true);
  assert.deepEqual([by['u-maker'].addFunds, by['u-maker'].withdraw], [true, false]);
  assert.deepEqual([by['u-owner'].addFunds, by['u-owner'].withdraw], [true, true]);
  assert.equal(by['u-owner'].email, 'owner@acme.test');
  const activity = await listTeamActivity(db, 'acme', 50);
  assert.deepEqual(activity.map((a) => a.action), ['finance_lead_appointed', 'member_access_granted', 'person_in_charge_appointed'], 'oldest first; the person in charge is a team grant too');
  assert.ok(activity.every((a) => typeof a.createdAt === 'string' && a.actorName && a.summary));
  assert.ok(!JSON.stringify(activity).includes('passwordHash'));
  await client.close();
});

test('who manages the team: owners and the Finance lead, nobody else', async () => {
  const { client, db } = await seeded();
  await appointFinanceLead(db, { ...base, actorUserId: 'u-owner', userId: 'u-lead' });
  const got = {};
  for (const u of ['u-owner', 'u-owner2', 'u-lead', 'u-appr', 'u-maker', 'u-viewer', 'u-free', 'u-n-owner']) got[u] = await teamManager(db, 'acme', u);
  assert.deepEqual(got, { 'u-owner': 'owner', 'u-owner2': 'owner', 'u-lead': 'finance_lead', 'u-appr': null, 'u-maker': null, 'u-viewer': null, 'u-free': null, 'u-n-owner': null });
  await client.close();
});
