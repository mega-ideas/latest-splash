/**
 * The Low findings of the Phase 3 invitations-and-leaving review that are
 * cheap and worth doing (each is a sentence a person reads or a row that
 * lingers):
 *
 *   - The invited person sees WHO is asking beyond a chosen name: the sender's
 *     name and a masked address, so a business named like support does not pass
 *     for something it is not.
 *   - Adding a person directly closes their open invitation to the same
 *     business (it would otherwise sit in "Open invitations" until it ended),
 *     with a line on the trail.
 *   - A person already on the inviting business is told "You are already on
 *     this team", not that they belong to some other business.
 *   - A declined request to leave is said for 14 days and then stops being
 *     shown; the person can still ask again.
 *   - Copy and accessibility: the role is said once, dates read unambiguously,
 *     the destructive button is not the one that takes focus, state changes are
 *     announced, and the decline sentence promises only what happens.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { eq } from 'drizzle-orm';

import { migratedDb } from './helpers/store-db.mjs';
import * as schema from '../lib/db/schema.ts';
import { listAuthorityEvents } from '../lib/server/wallet-authority.ts';
import { addTeamMember, listTeamActivity } from '../lib/server/team-admin.ts';
import { acceptInvitation, invitationsFor, sendInvitation } from '../lib/server/team-invitations.ts';
import { approveLeaveRequest, declineLeaveRequest, leaveStatusOf, requestToLeave } from '../lib/server/team-leave.ts';
import { LEAVE_DECLINED_SHOWN_DAYS } from '../lib/team/view.ts';

const T0 = new Date('2026-11-02T09:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const VERIFIED = new Date('2026-10-01T00:00:00Z');
const base = { orgId: 'acme', now: () => T0 };

async function seeded() {
  const { client, db } = await migratedDb();
  const people = [
    ['u-owner', 'dana.owner@acme.test', 'Dana Owner', 'acme', 'admin'],
    ['u-owner2', 'owner2@acme.test', 'Second Owner', 'acme', 'admin'],
    ['u-maker', 'maker@acme.test', 'Mo Maker', 'acme', 'maker'],
    ['u-free', 'free@example.test', 'Fran Free', null, null],
  ];
  for (const [id, email, name, org, role] of people) {
    await db.insert(schema.users).values({ id, email, name, emailVerifiedAt: VERIFIED });
    if (org) await db.insert(schema.memberships).values({ id: `m-${id}`, userId: id, orgId: org, role });
  }
  return { client, db };
}

test('the invited person is shown the sender’s masked address next to the name', async () => {
  const { client, db } = await seeded();
  const sent = await sendInvitation(db, { ...base, actorUserId: 'u-owner', email: 'free@example.test', role: 'maker' });
  assert.equal(sent.ok, true);
  const [mine] = await invitationsFor(db, { userId: 'u-free', now: () => T0 });
  assert.equal(mine.invitedByName, 'Dana Owner');
  assert.match(mine.invitedByEmailMask, /^d\*+@acme\.test$/);
  assert.doesNotMatch(JSON.stringify(mine), /dana\.owner@acme\.test/, 'never the full address');
  await client.close();
});

test('adding a person directly closes their open invitation to the same business, with a line on the trail', async () => {
  const { client, db } = await seeded();
  const sent = await sendInvitation(db, { ...base, actorUserId: 'u-owner', email: 'free@example.test', role: 'maker' });
  const added = await addTeamMember(db, { ...base, actorUserId: 'u-owner', email: 'free@example.test', role: 'viewer' });
  assert.equal(added.ok, true, JSON.stringify(added));
  const [row] = await db.select().from(schema.teamInvitations).where(eq(schema.teamInvitations.id, sent.invitation.id));
  assert.equal(row.status, 'withdrawn');
  assert.equal(row.decidedBy, 'system:added_directly');
  const closed = (await listAuthorityEvents(db, 'acme')).filter((e) => e.action === 'team_invitation_withdrawn');
  assert.equal(closed.length, 1);
  assert.equal(closed[0].detail.reason, 'added_directly');
  const feed = await listTeamActivity(db, 'acme');
  assert.match(feed.find((e) => e.action === 'team_invitation_withdrawn').summary, /added directly/i);
  await client.close();
});

test('a person who is already on the inviting business is told they are already on this team', async () => {
  const { client, db } = await seeded();
  const sent = await sendInvitation(db, { ...base, actorUserId: 'u-owner', email: 'free@example.test', role: 'maker' });
  // They join by another way without the invitation being closed (for example an owner of another session added them).
  await db.insert(schema.memberships).values({ id: 'm-free', userId: 'u-free', orgId: 'acme', role: 'viewer' });
  const accepted = await acceptInvitation(db, { userId: 'u-free', invitationId: sent.invitation.id, now: () => T0 });
  assert.equal(accepted.ok, false);
  assert.equal(accepted.code, 'already_on_team');
  assert.match(accepted.error, /already on this team/i);
  await client.close();
});

test('a declined request to leave is said for 14 days and then stops being shown; they can still ask again', async () => {
  const { client, db } = await seeded();
  assert.equal(LEAVE_DECLINED_SHOWN_DAYS, 14);
  const asked = await requestToLeave(db, { ...base, actorUserId: 'u-maker' });
  assert.equal((await declineLeaveRequest(db, { ...base, actorUserId: 'u-owner', requestId: asked.request.id })).ok, true);
  const soon = await leaveStatusOf(db, { orgId: 'acme', userId: 'u-maker', now: () => new Date(T0.getTime() + 13 * DAY) });
  assert.equal(soon.state, 'declined');
  const later = await leaveStatusOf(db, { orgId: 'acme', userId: 'u-maker', now: () => new Date(T0.getTime() + 15 * DAY) });
  assert.equal(later.state, 'none');
  assert.equal(later.canRequest, true);
  assert.equal(later.message, null);
  await client.close();
});

test('the decline answer promises only what happens: the person sees it when they open Settings', () => {
  const text = readFileSync(new URL('../components/team/LeaveRequests.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(text, /was told so/);
  assert.match(text, /when they open Settings/);
});

test('the copy and the markup of the new components: role said once, unambiguous dates, safe focus, announced changes', () => {
  const banner = readFileSync(new URL('../components/team/InvitationBanner.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(banner, /\(\{ROLE_NAME\[i\.role\]\}\)/, 'the role is not repeated in brackets');
  assert.match(banner, /invitedByEmailMask/);
  const requests = readFileSync(new URL('../components/team/LeaveRequests.tsx', import.meta.url), 'utf8');
  const open = readFileSync(new URL('../components/team/OpenInvitations.tsx', import.meta.url), 'utf8');
  for (const [name, text] of [['banner', banner], ['requests', requests], ['open invitations', open]]) {
    for (const m of text.matchAll(/<LocalTime [^>]*format="date"[^>]*\/>/g)) assert.match(m[0], /month: 'short'/, `${name}: a date names its month`);
  }
  assert.doesNotMatch(requests, /<PrimaryButton[^>]*autoFocus/, 'the destructive button does not take focus');
  assert.match(requests, /<QuietButton[^>]*autoFocus/, 'the safe choice does');
  const section = readFileSync(new URL('../components/team/LeaveSection.tsx', import.meta.url), 'utf8');
  assert.match(section, /role="status"/, 'a change of state is announced');
});
