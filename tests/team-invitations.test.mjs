/**
 * Inviting a person to the team (v2 Phase 3, Sky's decision of 1 Nov):
 *
 *   - Adding a person is the owner's choice: Send an invitation (the person
 *     accepts or declines after signing in; it ends after 7 days; the owner
 *     can withdraw it) or Add directly (no acceptance step; today's behaviour,
 *     tested in tests/team-roles.test.mjs).
 *   - An invitation for an email with no account waits until that email signs
 *     up and verifies.
 *   - A person who is already on another business is told plainly, and nothing
 *     about the other business leaks.
 *   - Every step is a line of the append-only trail, every read and write is
 *     the session's own business (cross-tenant tests), and there is no token to
 *     leak: the invitation is found by the signed-in person's verified email.
 *
 * PGlite with every migration. The same functions the routes call.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { and, eq } from 'drizzle-orm';

import { migratedDb } from './helpers/store-db.mjs';
import * as schema from '../lib/db/schema.ts';
import { listAuthorityEvents } from '../lib/server/wallet-authority.ts';
import { appointFinanceLead, listTeamActivity, removeTeamMember } from '../lib/server/team-admin.ts';
import {
  INVITATION_TTL_MS,
  acceptInvitation,
  declineInvitation,
  invitationsFor,
  listInvitations,
  sendInvitation,
  withdrawInvitation,
} from '../lib/server/team-invitations.ts';

const T0 = new Date('2026-11-02T09:00:00Z');
const VERIFIED = new Date('2026-10-01T00:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const at = (ms) => () => new Date(T0.getTime() + ms);

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
  assert.equal((await appointFinanceLead(db, { orgId: 'acme', actorUserId: 'u-owner', userId: 'u-lead', now: () => T0 })).ok, true);
  return { client, db };
}

const base = { orgId: 'acme', now: () => T0 };
const send = (db, over = {}) => sendInvitation(db, { ...base, actorUserId: 'u-owner', email: 'free@example.test', role: 'maker', ...over });
const trail = async (db, orgId = 'acme') => (await listAuthorityEvents(db, orgId)).map((e) => e.action);
const rowsOf = (db, orgId = 'acme') => db.select().from(schema.teamInvitations).where(eq(schema.teamInvitations.orgId, orgId));
const memberOf = async (db, userId) => (await db.select().from(schema.memberships).where(eq(schema.memberships.userId, userId)));

test('an owner sends an invitation: it waits, nobody is added, and the trail names who invited which role without the full address', async () => {
  const { client, db } = await seeded();
  const sent = await send(db);
  assert.equal(sent.ok, true, JSON.stringify(sent));
  assert.equal(sent.created, true);
  assert.equal((await memberOf(db, 'u-free')).length, 0, 'nothing is granted until the person accepts');
  const [row] = await rowsOf(db);
  assert.equal(row.status, 'pending');
  assert.equal(row.email, 'free@example.test');
  assert.equal(row.role, 'maker');
  assert.equal(row.invitedBy, 'u-owner');
  assert.equal(row.expiresAt.getTime(), T0.getTime() + INVITATION_TTL_MS, 'it ends after 7 days');
  assert.equal(INVITATION_TTL_MS, 7 * DAY);
  const [event] = (await listAuthorityEvents(db, 'acme')).filter((e) => e.action === 'team_invitation_sent');
  assert.equal(event.actorUserId, 'u-owner');
  assert.equal(event.ref, row.id);
  assert.equal(event.detail.role, 'maker');
  assert.doesNotMatch(JSON.stringify(event), /free@example\.test/, 'the append-only trail never holds the full address');
  assert.match(String(event.detail.emailMask), /^f\*+@example\.test$/);
  await client.close();
});

test('there is no token: the invitation table keeps no secret, and the id is long and random', async () => {
  const { client, db } = await seeded();
  await send(db);
  const cols = await db.execute(`select column_name from information_schema.columns where table_name = 'team_invitations'`);
  const names = cols.rows.map((r) => r.column_name);
  assert.ok(!names.some((n) => /token|secret|hash|code/.test(n)), `no token-like column: ${names.join(', ')}`);
  await send(db, { email: 'free2@example.test' });
  const ids = (await rowsOf(db)).map((r) => r.id);
  assert.equal(new Set(ids).size, 2);
  for (const id of ids) assert.match(id, /^inv_[0-9a-f-]{36}$/);
  await client.close();
});

test('the Finance lead may send an invitation for a viewer, staff or approver, never for an owner; everyone else is refused', async () => {
  const { client, db } = await seeded();
  for (const [email, role] of [['free@example.test', 'viewer'], ['free2@example.test', 'checker']]) {
    const ok = await send(db, { actorUserId: 'u-lead', email, role });
    assert.equal(ok.ok, true, `${role} ${JSON.stringify(ok)}`);
  }
  const owner = await send(db, { actorUserId: 'u-lead', email: 'other@example.test', role: 'admin' });
  assert.equal(owner.ok, false);
  assert.equal(owner.status, 403);
  assert.equal(owner.code, 'owner_only');
  for (const actorUserId of ['u-appr', 'u-maker', 'u-viewer', 'u-n-owner', 'nobody']) {
    const refused = await send(db, { actorUserId, email: 'x@example.test' });
    assert.equal(refused.ok, false, actorUserId);
    assert.equal(refused.status, 403, actorUserId);
  }
  assert.equal((await rowsOf(db)).length, 2);
  assert.equal((await rowsOf(db, 'northwind')).length, 0, 'another business’s owner invited nobody into acme');
  await client.close();
});

test('a bad role and a bad email are refused before anything is written', async () => {
  const { client, db } = await seeded();
  assert.equal((await send(db, { role: 'god' })).code, 'bad_role');
  for (const email of ['', 'no-at-sign', 'a@' + 'b'.repeat(260), 42, null]) {
    const r = await send(db, { email });
    assert.equal(r.ok, false);
    assert.equal(r.status, 400);
  }
  assert.equal((await rowsOf(db)).length, 0);
  await client.close();
});

test('sending the same invitation twice is one invitation and one trail line; a different role is refused until it is withdrawn', async () => {
  const { client, db } = await seeded();
  const first = await send(db);
  const again = await send(db, { email: '  FREE@example.test ', actorUserId: 'u-owner2' });
  assert.equal(again.ok, true);
  assert.equal(again.created, false);
  assert.equal(again.invitation.id, first.invitation.id);
  assert.equal((await rowsOf(db)).length, 1);
  assert.equal((await trail(db)).filter((a) => a === 'team_invitation_sent').length, 1);
  const other = await send(db, { role: 'viewer' });
  assert.equal(other.ok, false);
  assert.equal(other.status, 409);
  assert.equal(other.code, 'already_invited');
  await client.close();
});

test('two owners sending at once make one invitation', async () => {
  const { client, db } = await seeded();
  const results = await Promise.all([send(db), send(db, { actorUserId: 'u-owner2' })]);
  assert.ok(results.every((r) => r.ok), JSON.stringify(results));
  assert.equal(results.filter((r) => r.created).length, 1);
  assert.equal((await rowsOf(db)).length, 1);
  assert.equal((await trail(db)).filter((a) => a === 'team_invitation_sent').length, 1);
  await client.close();
});

test('an email that is already on this team is told so; there is a limit on open invitations', async () => {
  const { client, db } = await seeded();
  const same = await send(db, { email: 'maker@acme.test' });
  assert.equal(same.code, 'already_on_team');
  for (let i = 0; i < 25; i++) assert.equal((await send(db, { email: `person${i}@example.test` })).ok, true);
  const over = await send(db, { email: 'one-more@example.test' });
  assert.equal(over.ok, false);
  assert.equal(over.code, 'too_many_invitations');
  await client.close();
});

test('an invitation for an email with no account waits; it shows only once that email has signed up AND verified', async () => {
  const { client, db } = await seeded();
  const sent = await send(db, { email: 'later@example.test', role: 'checker' });
  assert.equal(sent.ok, true, 'no account is not an error, and not different from any other answer');
  await db.insert(schema.users).values({ id: 'u-later', email: 'later@example.test', name: 'Later', emailVerifiedAt: null });
  assert.deepEqual(await invitationsFor(db, { userId: 'u-later', now: base.now }), [], 'an unverified account is shown nothing: the address is not yet proof of who holds it');
  const early = await acceptInvitation(db, { userId: 'u-later', invitationId: sent.invitation.id, now: base.now });
  assert.equal(early.ok, false);
  assert.equal(early.code, 'verify_email');
  assert.equal((await memberOf(db, 'u-later')).length, 0);
  await db.update(schema.users).set({ emailVerifiedAt: VERIFIED }).where(eq(schema.users.id, 'u-later'));
  const shown = await invitationsFor(db, { userId: 'u-later', now: base.now });
  assert.equal(shown.length, 1);
  assert.equal(shown[0].role, 'checker');
  assert.equal(shown[0].businessName, 'Acme Trading');
  assert.equal(shown[0].canAccept, true);
  assert.equal((await acceptInvitation(db, { userId: 'u-later', invitationId: sent.invitation.id, now: base.now })).ok, true);
  await client.close();
});

test('the sender hears the same thing for an email with no account, a person on another business and a free account', async () => {
  const { client, db } = await seeded();
  const shape = (r) => JSON.stringify({ ok: r.ok, created: r.created, status: r.status, code: r.code, keys: Object.keys(r.invitation ?? {}).sort() });
  const none = await send(db, { email: 'nobody@example.test' });
  const elsewhere = await send(db, { email: 'maker@northwind.test' });
  const unverified = await send(db, { email: 'unverified@example.test' });
  const free = await send(db, { email: 'free@example.test' });
  assert.equal(shape(none), shape(elsewhere));
  assert.equal(shape(none), shape(unverified));
  assert.equal(shape(none), shape(free));
  await client.close();
});

test('a person already on another business is told plainly, can still decline, and nothing about the other business is in what they read', async () => {
  const { client, db } = await seeded();
  const sent = await send(db, { email: 'maker@northwind.test' });
  const shown = await invitationsFor(db, { userId: 'u-n-maker', now: base.now });
  assert.equal(shown.length, 1);
  assert.equal(shown[0].canAccept, false);
  assert.match(shown[0].blockedReason, /already belong to a business/i);
  const refused = await acceptInvitation(db, { userId: 'u-n-maker', invitationId: sent.invitation.id, now: base.now });
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 409);
  assert.equal(refused.code, 'already_on_a_business');
  assert.match(refused.error, /already belong to a business/i);
  for (const text of [JSON.stringify(shown), JSON.stringify(refused)]) {
    assert.doesNotMatch(text, /northwind/i, 'the other business is not named, hinted or linked');
  }
  const memberships = await memberOf(db, 'u-n-maker');
  assert.deepEqual(memberships.map((m) => m.orgId), ['northwind'], 'still only the one business');
  assert.equal((await declineInvitation(db, { userId: 'u-n-maker', invitationId: sent.invitation.id, now: base.now })).ok, true);
  await client.close();
});

test('accepting joins with the invited role, records who granted it, writes two trail lines, and a repeat changes nothing', async () => {
  const { client, db } = await seeded();
  const sent = await send(db, { role: 'checker' });
  const accepted = await acceptInvitation(db, { userId: 'u-free', invitationId: sent.invitation.id, now: at(DAY) });
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.equal(accepted.changed, true);
  const [m] = await memberOf(db, 'u-free');
  assert.equal(m.orgId, 'acme');
  assert.equal(m.role, 'checker');
  assert.equal(m.grantedBy, 'u-owner');
  const [row] = await rowsOf(db);
  assert.equal(row.status, 'accepted');
  assert.equal(row.decidedBy, 'u-free');
  const events = await listAuthorityEvents(db, 'acme');
  const accept = events.find((e) => e.action === 'team_invitation_accepted');
  assert.equal(accept.actorUserId, 'u-free');
  const added = events.find((e) => e.action === 'member_added');
  assert.equal(added.subjectUserId, 'u-free');
  assert.equal(added.detail.role, 'checker');
  const again = await acceptInvitation(db, { userId: 'u-free', invitationId: sent.invitation.id, now: at(DAY + 1000) });
  assert.equal(again.ok, true);
  assert.equal(again.changed, false);
  assert.equal((await memberOf(db, 'u-free')).length, 1);
  assert.equal((await trail(db)).filter((a) => a === 'team_invitation_accepted').length, 1);
  assert.equal((await trail(db)).filter((a) => a === 'member_added').length, 1);
  await client.close();
});

test('only the person the invitation was sent to can use it; another signed-in person gets "not found", never "not yours"', async () => {
  const { client, db } = await seeded();
  const sent = await send(db);
  for (const userId of ['u-free2', 'u-owner2', 'u-n-owner', 'nobody']) {
    for (const act of [acceptInvitation, declineInvitation]) {
      const r = await act(db, { userId, invitationId: sent.invitation.id, now: base.now });
      assert.equal(r.ok, false, userId);
      assert.equal(r.status, 404, userId);
      assert.equal(r.code, 'not_found', userId);
    }
  }
  assert.equal((await rowsOf(db))[0].status, 'pending');
  assert.equal((await memberOf(db, 'u-free2')).length, 0);
  assert.deepEqual(await invitationsFor(db, { userId: 'u-free2', now: base.now }), []);
  assert.deepEqual(await invitationsFor(db, { userId: 'nobody', now: base.now }), [], 'an unknown person is shown nothing');
  const guess = await acceptInvitation(db, { userId: 'u-free', invitationId: 'inv_00000000-0000-0000-0000-000000000000', now: base.now });
  assert.equal(guess.code, 'not_found');
  await client.close();
});

test('an invitation ends after 7 days: to the millisecond, it cannot be accepted, shows as ended once, and is written to the trail once', async () => {
  const { client, db } = await seeded();
  const sent = await send(db);
  const lastMoment = await invitationsFor(db, { userId: 'u-free', now: at(INVITATION_TTL_MS - 1) });
  assert.equal(lastMoment.length, 1, 'still open a millisecond before');
  assert.equal((await invitationsFor(db, { userId: 'u-free', now: at(INVITATION_TTL_MS) })).length, 0);
  const late = await acceptInvitation(db, { userId: 'u-free', invitationId: sent.invitation.id, now: at(INVITATION_TTL_MS) });
  assert.equal(late.ok, false);
  assert.equal(late.status, 410);
  assert.equal(late.code, 'expired');
  assert.match(late.error, /7 days/);
  await acceptInvitation(db, { userId: 'u-free', invitationId: sent.invitation.id, now: at(INVITATION_TTL_MS + 5000) });
  assert.equal((await memberOf(db, 'u-free')).length, 0);
  assert.equal((await rowsOf(db))[0].status, 'expired');
  assert.equal((await trail(db)).filter((a) => a === 'team_invitation_expired').length, 1);
  assert.equal((await listInvitations(db, { orgId: 'acme', now: at(INVITATION_TTL_MS + 9000) })).length, 0, 'the owner no longer sees it as open');
  await client.close();
});

test('declining is final: no membership, one trail line, a repeat is harmless, and the invitation can no longer be accepted', async () => {
  const { client, db } = await seeded();
  const sent = await send(db);
  const declined = await declineInvitation(db, { userId: 'u-free', invitationId: sent.invitation.id, now: base.now });
  assert.equal(declined.ok, true);
  assert.equal(declined.changed, true);
  const again = await declineInvitation(db, { userId: 'u-free', invitationId: sent.invitation.id, now: base.now });
  assert.equal(again.ok, true);
  assert.equal(again.changed, false);
  const late = await acceptInvitation(db, { userId: 'u-free', invitationId: sent.invitation.id, now: base.now });
  assert.equal(late.ok, false);
  assert.equal(late.status, 410);
  assert.equal(late.code, 'no_longer_open');
  assert.equal((await memberOf(db, 'u-free')).length, 0);
  assert.equal((await trail(db)).filter((a) => a === 'team_invitation_declined').length, 1);
  await client.close();
});

test('the owner withdraws an invitation; it can no longer be accepted; a repeat is harmless; an accepted one cannot be withdrawn', async () => {
  const { client, db } = await seeded();
  const sent = await send(db);
  const withdrawn = await withdrawInvitation(db, { ...base, actorUserId: 'u-owner2', invitationId: sent.invitation.id });
  assert.equal(withdrawn.ok, true);
  assert.equal(withdrawn.changed, true);
  assert.equal((await withdrawInvitation(db, { ...base, actorUserId: 'u-owner', invitationId: sent.invitation.id })).changed, false);
  const late = await acceptInvitation(db, { userId: 'u-free', invitationId: sent.invitation.id, now: base.now });
  assert.equal(late.code, 'no_longer_open');
  assert.equal((await trail(db)).filter((a) => a === 'team_invitation_withdrawn').length, 1);
  assert.deepEqual(await invitationsFor(db, { userId: 'u-free', now: base.now }), []);

  const second = await send(db, { email: 'free2@example.test' });
  assert.equal((await acceptInvitation(db, { userId: 'u-free2', invitationId: second.invitation.id, now: base.now })).ok, true);
  const tooLate = await withdrawInvitation(db, { ...base, actorUserId: 'u-owner', invitationId: second.invitation.id });
  assert.equal(tooLate.ok, false);
  assert.equal(tooLate.status, 409);
  assert.equal(tooLate.code, 'already_accepted');
  await client.close();
});

test('who may withdraw: an owner any, the Finance lead only below owner, nobody else; another business reads it as absent', async () => {
  const { client, db } = await seeded();
  const forOwner = await send(db, { email: 'free@example.test', role: 'admin' });
  const forStaff = await send(db, { email: 'free2@example.test', role: 'maker' });
  const lead = await withdrawInvitation(db, { ...base, actorUserId: 'u-lead', invitationId: forOwner.invitation.id });
  assert.equal(lead.code, 'owner_only');
  assert.equal((await withdrawInvitation(db, { ...base, actorUserId: 'u-lead', invitationId: forStaff.invitation.id })).ok, true);
  for (const actorUserId of ['u-appr', 'u-maker', 'u-viewer']) {
    const r = await withdrawInvitation(db, { ...base, actorUserId, invitationId: forOwner.invitation.id });
    assert.equal(r.status, 403, actorUserId);
  }
  const across = await withdrawInvitation(db, { orgId: 'northwind', actorUserId: 'u-n-owner', invitationId: forOwner.invitation.id, now: base.now });
  assert.equal(across.ok, false);
  assert.equal(across.status, 404);
  assert.equal(across.code, 'not_found');
  assert.equal((await rowsOf(db)).find((r) => r.id === forOwner.invitation.id).status, 'pending', 'untouched');
  const asAcme = await withdrawInvitation(db, { orgId: 'northwind', actorUserId: 'u-owner', invitationId: forOwner.invitation.id, now: base.now });
  assert.equal(asAcme.status, 403, 'an acme owner is nobody in northwind');
  await client.close();
});

test('listing is this business only, open ones only, and only for someone who manages the team', async () => {
  const { client, db } = await seeded();
  await send(db, { email: 'free@example.test' });
  await sendInvitation(db, { orgId: 'northwind', actorUserId: 'u-n-owner', email: 'free2@example.test', role: 'viewer', now: base.now });
  const mine = await listInvitations(db, { orgId: 'acme', now: base.now });
  assert.deepEqual(mine.map((i) => i.email), ['free@example.test']);
  assert.equal(mine[0].invitedByName, 'u-owner');
  assert.equal(mine[0].expiresAt, new Date(T0.getTime() + INVITATION_TTL_MS).toISOString());
  const theirs = await listInvitations(db, { orgId: 'northwind', now: base.now });
  assert.deepEqual(theirs.map((i) => i.email), ['free2@example.test']);
  await client.close();
});

test('two businesses inviting one person: whichever is accepted first wins, the other cannot be accepted, and one membership exists', async () => {
  const { client, db } = await seeded();
  const a = await send(db);
  const b = await sendInvitation(db, { orgId: 'northwind', actorUserId: 'u-n-owner', email: 'free@example.test', role: 'viewer', now: base.now });
  const results = await Promise.all([
    acceptInvitation(db, { userId: 'u-free', invitationId: a.invitation.id, now: base.now }),
    acceptInvitation(db, { userId: 'u-free', invitationId: b.invitation.id, now: base.now }),
  ]);
  assert.equal(results.filter((r) => r.ok).length, 1, JSON.stringify(results));
  assert.equal((await memberOf(db, 'u-free')).length, 1);
  await client.close();
});

test('an invitation from someone who no longer manages the team is not honoured, is closed, and says so on the trail', async () => {
  const { client, db } = await seeded();
  const sent = await send(db, { actorUserId: 'u-lead', email: 'free@example.test', role: 'maker' });
  // The inviter is removed before the person answers: the owner's decision to invite was theirs, but the lead no longer manages anything.
  assert.equal((await removeTeamMember(db, { ...base, actorUserId: 'u-owner', userId: 'u-lead' })).ok, true);
  const accepted = await acceptInvitation(db, { userId: 'u-free', invitationId: sent.invitation.id, now: base.now });
  assert.equal(accepted.ok, false, 'an invitation from someone who no longer manages the team is not honoured');
  assert.equal(accepted.code, 'no_longer_open');
  assert.equal((await memberOf(db, 'u-free')).length, 0);
  assert.equal((await rowsOf(db))[0].status, 'withdrawn');
  const [line] = (await listAuthorityEvents(db, 'acme')).filter((e) => e.action === 'team_invitation_withdrawn');
  assert.equal(line.detail.reason, 'inviter_no_longer_manages');
  assert.deepEqual(await invitationsFor(db, { userId: 'u-free', now: base.now }), []);
  await client.close();
});

test('each step reads as a sentence in the team’s recent changes, with no full address', async () => {
  const { client, db } = await seeded();
  const sent = await send(db, { email: 'free@example.test' });
  await acceptInvitation(db, { userId: 'u-free', invitationId: sent.invitation.id, now: base.now });
  const second = await send(db, { email: 'free2@example.test' });
  await withdrawInvitation(db, { ...base, actorUserId: 'u-owner', invitationId: second.invitation.id });
  const lines = (await listTeamActivity(db, 'acme')).map((a) => a.summary);
  assert.ok(lines.some((l) => /u-owner invited f\*+@example\.test as staff/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => /u-free accepted the invitation/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => /withdrew the invitation to f\*+2@example\.test/.test(l) || /withdrew the invitation/.test(l)), lines.join('\n'));
  assert.ok(lines.every((l) => !/@example\.test/.test(l.replace(/\*+@example\.test/g, ''))), 'no full address');
  await client.close();
});
