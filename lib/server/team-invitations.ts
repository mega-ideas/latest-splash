/**
 * Inviting people to the team (v2 Phase 3, Sky's decision of 1 Nov).
 *
 * An owner chooses how to add a person: DIRECTLY (lib/server/team-admin.ts
 * addTeamMember, no acceptance step) or by INVITATION, here.
 *
 *   send       An owner, or the Finance lead for a viewer, staff member or
 *              approver. Any email may be invited: an address with no account
 *              yet simply waits until it signs up and verifies, and the sender
 *              is told the same thing whatever the address is, so this cannot
 *              be used to learn who has an account or where.
 *   see        The invited person sees it after signing in with that VERIFIED
 *              email (`invitationsFor`). An unverified account is shown nothing.
 *   accept     Joins with the invited role. Refused, in plain words and naming
 *              no business, when the person already belongs to one: a person
 *              belongs to one business at a time.
 *   decline    Final. Withdraw is the sender's.
 *   ends       7 days after it was sent, to the millisecond. It is marked ended
 *              (and put on the trail once) the first time anyone looks after
 *              that.
 *
 * There is NO token, link or code. The signed-in person's own verified email
 * finds the invitation, so there is no secret to put in a URL, log, forward or
 * replay. The id is random but grants nothing: anyone else who knows it is told
 * "not found", exactly as for an id that does not exist. A repeat of any step
 * (accepting twice, declining twice) changes nothing and writes no second line.
 *
 * An invitation is honoured only while the person who sent it still manages the
 * team (an owner, or the Finance lead for a role below owner). If they were
 * removed or lost the role, the invitation is closed and says so on the trail.
 *
 * The trail (wallet_authority_events, append-only) never holds a full email:
 * it keeps a masked one, because a line there can never be deleted.
 */
import { randomUUID } from 'node:crypto';

import { and, asc, eq, lte, sql } from 'drizzle-orm';

import { memberships, organizations, teamInvitations, users } from '../db/schema.ts';
import { isMembershipRole, type MembershipRole } from '../membership-roles.ts';
import { INVITATION_DAYS, ON_A_BUSINESS, maskEmail, type InvitationWire, type MyInvitationWire } from '../team/view.ts';
import { fail, inTransaction, lockPerson, teamManager, type TeamFailure } from './team-admin.ts';
import { memberRole, recordAuthorityEvent } from './wallet-authority.ts';
import type { DrizzleDb } from './wallet-signing-store.ts';

type Clock = () => Date;
const clock = (now?: Clock) => (now ?? (() => new Date()))();

export const INVITATION_TTL_MS = INVITATION_DAYS * 24 * 60 * 60 * 1000;
/** Open invitations one business may have at once. */
export const MAX_OPEN_INVITATIONS = 25;
const EXPIRY_ACTOR = 'system:invitation_expiry';
const INVITER_GONE = 'system:inviter_gone';

type Row = typeof teamInvitations.$inferSelect;

class Rollback extends Error {
  failure: TeamFailure;
  constructor(failure: TeamFailure) {
    super(failure.code);
    this.failure = failure;
  }
}

/** One transaction. A `Rollback` thrown inside undoes everything and comes back as its failure. */
async function atomic<T>(db: DrizzleDb, fn: (tx: DrizzleDb) => Promise<T>): Promise<T | TeamFailure> {
  try {
    return await inTransaction(db, fn);
  } catch (error) {
    if (error instanceof Rollback) return error.failure;
    throw error;
  }
}

const NOT_FOUND = () => fail(404, 'not_found', 'That invitation was not found.');
const NO_LONGER_OPEN = () => fail(410, 'no_longer_open', 'This invitation is no longer open. Ask the person who sent it to send a new one.');
const EXPIRED = () => fail(410, 'expired', `This invitation ended after ${INVITATION_DAYS} days. Ask the person who sent it to send a new one.`);
const VERIFY_EMAIL = () => fail(403, 'verify_email', 'Verify your email address first. Then you can see and answer invitations sent to it.');

const normalizeEmail = (value: unknown): string => (typeof value === 'string' ? value.trim().toLowerCase() : '');

/** Does the person who sent this still manage the team in a way that covers its role? */
async function senderStillManages(tx: DrizzleDb, inv: Pick<Row, 'orgId' | 'invitedBy' | 'role'>): Promise<boolean> {
  const manager = await teamManager(tx, inv.orgId, inv.invitedBy);
  if (!manager) return false;
  return !(inv.role === 'admin' && manager !== 'owner');
}

/** Mark every open invitation past its end as ended, once each, with a trail line. */
async function expireDue(tx: DrizzleDb, scope: { orgId?: string; email?: string }, now: Date): Promise<number> {
  const conditions = [eq(teamInvitations.status, 'pending'), lte(teamInvitations.expiresAt, now)];
  if (scope.orgId) conditions.push(eq(teamInvitations.orgId, scope.orgId));
  if (scope.email) conditions.push(eq(teamInvitations.email, scope.email));
  const ended = await tx
    .update(teamInvitations)
    .set({ status: 'expired', decidedAt: now, decidedBy: EXPIRY_ACTOR })
    .where(and(...conditions))
    .returning({ id: teamInvitations.id, orgId: teamInvitations.orgId, email: teamInvitations.email, role: teamInvitations.role });
  for (const e of ended) {
    await recordAuthorityEvent(tx, { orgId: e.orgId, actorUserId: EXPIRY_ACTOR, action: 'team_invitation_expired', ref: e.id, detail: { role: e.role, emailMask: maskEmail(e.email) }, now: () => now });
  }
  return ended.length;
}

const nameOfUser = async (tx: DrizzleDb, id: string): Promise<string> => {
  const [u] = await tx.select({ name: users.name }).from(users).where(eq(users.id, id)).limit(1);
  return u?.name ?? 'A former member';
};

// ─── Sending ────────────────────────────────────────────────────────────────

export type SentInvitation = { id: string; email: string; role: MembershipRole; expiresAt: string };
const sentWire = (row: Pick<Row, 'id' | 'email' | 'role' | 'expiresAt'>): SentInvitation => ({ id: row.id, email: row.email, role: row.role as MembershipRole, expiresAt: row.expiresAt.toISOString() });

/** Invite an email. The answer is the same whether or not the address has an account, or belongs to another business. */
export function sendInvitation(
  db: DrizzleDb,
  input: { orgId: string; actorUserId: string; email: unknown; role: unknown; now?: Clock },
): Promise<{ ok: true; created: boolean; invitation: SentInvitation } | TeamFailure> {
  return atomic(db, async (tx) => {
    const manager = await teamManager(tx, input.orgId, input.actorUserId);
    if (!manager) return fail(403, 'not_allowed', 'Only an owner or the Finance lead can invite people.');
    if (!isMembershipRole(input.role)) return fail(400, 'bad_role', 'Choose viewer, staff, approver or owner.');
    const role = input.role;
    if (manager === 'finance_lead' && role === 'admin') return fail(403, 'owner_only', 'Only an owner can give someone the owner role.');
    const email = normalizeEmail(input.email);
    if (!email || email.length > 254 || !email.includes('@')) return fail(400, 'bad_email', 'Enter the person’s email address.');
    const now = clock(input.now);

    // This business's own team is this business's to know.
    const [account] = await tx.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (account && (await memberRole(tx, input.orgId, account.id)) !== null) return fail(409, 'already_on_team', 'That person is already on your team.');

    await expireDue(tx, { orgId: input.orgId, email }, now);
    const [open] = await tx
      .select()
      .from(teamInvitations)
      .where(and(eq(teamInvitations.orgId, input.orgId), eq(teamInvitations.email, email), eq(teamInvitations.status, 'pending')))
      .limit(1);
    if (open) {
      if (open.role === role) return { ok: true as const, created: false, invitation: sentWire(open) };
      return fail(409, 'already_invited', 'That email already has an open invitation with a different role. Withdraw it first to send a new one.');
    }
    const [{ n }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(teamInvitations)
      .where(and(eq(teamInvitations.orgId, input.orgId), eq(teamInvitations.status, 'pending')));
    if (Number(n) >= MAX_OPEN_INVITATIONS) return fail(409, 'too_many_invitations', `You have ${MAX_OPEN_INVITATIONS} open invitations. Withdraw one, or wait for answers, before sending more.`);

    const id = `inv_${randomUUID()}`;
    const inserted = await tx
      .insert(teamInvitations)
      .values({ id, orgId: input.orgId, email, role, invitedBy: input.actorUserId, status: 'pending', createdAt: now, expiresAt: new Date(now.getTime() + INVITATION_TTL_MS) })
      .onConflictDoNothing()
      .returning();
    if (inserted.length === 0) {
      // Another owner sent the same one at the same moment: theirs stands, this is the repeat.
      const [theirs] = await tx
        .select()
        .from(teamInvitations)
        .where(and(eq(teamInvitations.orgId, input.orgId), eq(teamInvitations.email, email), eq(teamInvitations.status, 'pending')))
        .limit(1);
      if (theirs && theirs.role === role) return { ok: true as const, created: false, invitation: sentWire(theirs) };
      return fail(409, 'already_invited', 'That email already has an open invitation with a different role. Withdraw it first to send a new one.');
    }
    await recordAuthorityEvent(tx, { orgId: input.orgId, actorUserId: input.actorUserId, action: 'team_invitation_sent', ref: id, detail: { role, emailMask: maskEmail(email) }, now: () => now });
    return { ok: true as const, created: true, invitation: sentWire(inserted[0]) };
  });
}

// ─── The business's side ────────────────────────────────────────────────────

/** This business's open invitations, oldest first. Past-end ones are closed first. */
export async function listInvitations(
  db: DrizzleDb,
  input: { orgId: string; now?: Clock; manager?: 'owner' | 'finance_lead' },
): Promise<InvitationWire[]> {
  const now = clock(input.now);
  return inTransaction(db, async (tx) => {
    await expireDue(tx, { orgId: input.orgId }, now);
    const rows = await tx
      .select()
      .from(teamInvitations)
      .where(and(eq(teamInvitations.orgId, input.orgId), eq(teamInvitations.status, 'pending')))
      .orderBy(asc(teamInvitations.createdAt), asc(teamInvitations.id));
    const out: InvitationWire[] = [];
    for (const r of rows as Row[]) {
      out.push({
        id: r.id,
        email: r.email,
        role: r.role as MembershipRole,
        invitedByName: await nameOfUser(tx, r.invitedBy),
        createdAt: r.createdAt.toISOString(),
        expiresAt: r.expiresAt.toISOString(),
        canWithdraw: input.manager === 'finance_lead' ? r.role !== 'admin' : true,
      });
    }
    return out;
  });
}

/** The sender takes an invitation back. A repeat, and one already answered or ended, changes nothing. */
export function withdrawInvitation(
  db: DrizzleDb,
  input: { orgId: string; actorUserId: string; invitationId: string; now?: Clock },
): Promise<{ ok: true; changed: boolean } | TeamFailure> {
  return atomic(db, async (tx) => {
    const manager = await teamManager(tx, input.orgId, input.actorUserId);
    if (!manager) return fail(403, 'not_allowed', 'Only an owner or the Finance lead can withdraw an invitation.');
    // Another business's invitation reads as absent.
    const [inv] = await tx.select().from(teamInvitations).where(and(eq(teamInvitations.id, String(input.invitationId)), eq(teamInvitations.orgId, input.orgId))).limit(1);
    if (!inv) return NOT_FOUND();
    if (manager === 'finance_lead' && inv.role === 'admin') return fail(403, 'owner_only', 'Only an owner can withdraw an invitation for an owner.');
    if (inv.status === 'accepted') return fail(409, 'already_accepted', 'This invitation was already accepted. Remove the person from the team if you no longer want them.');
    if (inv.status !== 'pending') return { ok: true as const, changed: false };
    const now = clock(input.now);
    const closed = await tx
      .update(teamInvitations)
      .set({ status: 'withdrawn', decidedAt: now, decidedBy: input.actorUserId })
      .where(and(eq(teamInvitations.id, inv.id), eq(teamInvitations.status, 'pending')))
      .returning({ id: teamInvitations.id });
    if (closed.length === 0) return { ok: true as const, changed: false };
    await recordAuthorityEvent(tx, { orgId: input.orgId, actorUserId: input.actorUserId, action: 'team_invitation_withdrawn', ref: inv.id, detail: { role: inv.role, emailMask: maskEmail(inv.email) }, now: () => now });
    return { ok: true as const, changed: true };
  });
}

// ─── The invited person's side ──────────────────────────────────────────────

/**
 * What the signed-in person is invited to. Only for a VERIFIED account, by its
 * own email; an unverified or unknown one is shown nothing. It names the
 * inviting business (the person must know whom they would join) and never any
 * business they already belong to.
 */
export function invitationsFor(db: DrizzleDb, input: { userId: string; now?: Clock }): Promise<MyInvitationWire[]> {
  const now = clock(input.now);
  return inTransaction(db, async (tx) => {
    const [user] = await tx.select({ email: users.email, verified: users.emailVerifiedAt }).from(users).where(eq(users.id, input.userId)).limit(1);
    if (!user || !user.verified) return [];
    await expireDue(tx, { email: user.email }, now);
    const held = (await tx.select({ orgId: memberships.orgId }).from(memberships).where(eq(memberships.userId, input.userId))) as Array<{ orgId: string }>;
    const rows = (await tx
      .select()
      .from(teamInvitations)
      .where(and(eq(teamInvitations.email, user.email), eq(teamInvitations.status, 'pending')))
      .orderBy(asc(teamInvitations.createdAt), asc(teamInvitations.id))) as Row[];
    const out: MyInvitationWire[] = [];
    for (const r of rows) {
      if (held.some((h) => h.orgId === r.orgId)) continue;
      if (!(await senderStillManages(tx, r))) continue;
      const [org] = await tx.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, r.orgId)).limit(1);
      out.push({
        id: r.id,
        businessName: org?.name ?? 'A business',
        role: r.role as MembershipRole,
        invitedByName: await nameOfUser(tx, r.invitedBy),
        expiresAt: r.expiresAt.toISOString(),
        canAccept: held.length === 0,
        blockedReason: held.length === 0 ? null : ON_A_BUSINESS,
      });
    }
    return out;
  });
}

/** The invitation, if it is this signed-in person's (their verified email); otherwise nothing, whatever the id. */
async function mineOrFailure(tx: DrizzleDb, userId: string, invitationId: unknown): Promise<{ row: Row; email: string } | TeamFailure> {
  const [user] = await tx.select({ email: users.email, verified: users.emailVerifiedAt }).from(users).where(eq(users.id, userId)).limit(1);
  if (!user) return NOT_FOUND();
  const [row] = await tx.select().from(teamInvitations).where(eq(teamInvitations.id, String(invitationId))).limit(1);
  if (!row || row.email !== user.email) return NOT_FOUND();
  if (!user.verified) return VERIFY_EMAIL();
  return { row, email: user.email };
}

const isFailure = (x: unknown): x is TeamFailure => typeof x === 'object' && x !== null && (x as { ok?: unknown }).ok === false;

/** Accept: join with the invited role. Once. A repeat by the same person is a harmless "already joined". */
export function acceptInvitation(
  db: DrizzleDb,
  input: { userId: string; invitationId: string; now?: Clock },
): Promise<{ ok: true; changed: boolean; orgId: string; role: MembershipRole } | TeamFailure> {
  return atomic(db, async (tx) => {
    // One person, one accept at a time: a second accept (another invitation, another tab) waits here and then reads this one's row.
    await lockPerson(tx, input.userId);
    const found = await mineOrFailure(tx, input.userId, input.invitationId);
    if (isFailure(found)) return found;
    const inv = found.row;
    const now = clock(input.now);

    if (inv.status === 'accepted') {
      const joined = inv.decidedBy === input.userId && (await memberRole(tx, inv.orgId, input.userId)) !== null;
      return joined ? { ok: true as const, changed: false, orgId: inv.orgId, role: inv.role as MembershipRole } : NO_LONGER_OPEN();
    }
    if (inv.status === 'expired') return EXPIRED();
    if (inv.status !== 'pending') return NO_LONGER_OPEN();
    if (inv.expiresAt.getTime() <= now.getTime()) {
      await expireDue(tx, { orgId: inv.orgId, email: inv.email }, now);
      return EXPIRED();
    }
    if (!(await senderStillManages(tx, inv))) {
      const closed = await tx
        .update(teamInvitations)
        .set({ status: 'withdrawn', decidedAt: now, decidedBy: INVITER_GONE })
        .where(and(eq(teamInvitations.id, inv.id), eq(teamInvitations.status, 'pending')))
        .returning({ id: teamInvitations.id });
      if (closed.length > 0) {
        await recordAuthorityEvent(tx, { orgId: inv.orgId, actorUserId: INVITER_GONE, action: 'team_invitation_withdrawn', ref: inv.id, detail: { role: inv.role, emailMask: maskEmail(inv.email), reason: 'inviter_no_longer_manages' }, now: () => now });
      }
      return NO_LONGER_OPEN();
    }

    const held = (await tx.select({ orgId: memberships.orgId }).from(memberships).where(eq(memberships.userId, input.userId))) as Array<{ orgId: string }>;
    if (held.length > 0) return fail(409, 'already_on_a_business', ON_A_BUSINESS);

    const closed = await tx
      .update(teamInvitations)
      .set({ status: 'accepted', decidedAt: now, decidedBy: input.userId })
      .where(and(eq(teamInvitations.id, inv.id), eq(teamInvitations.status, 'pending')))
      .returning({ id: teamInvitations.id });
    if (closed.length === 0) return NO_LONGER_OPEN();
    const inserted = await tx
      .insert(memberships)
      .values({ id: `mem_${input.userId}_${inv.orgId}`, userId: input.userId, orgId: inv.orgId, role: inv.role as MembershipRole, grantedBy: inv.invitedBy })
      .onConflictDoNothing()
      .returning({ id: memberships.id });
    // The unique index on memberships(user_id) turned the insert away: another business got there first. Nothing of this accept is kept.
    if (inserted.length === 0) throw new Rollback(fail(409, 'already_on_a_business', ON_A_BUSINESS));
    // And if a legacy second row somehow exists, the same answer.
    const now2 = (await tx.select({ orgId: memberships.orgId }).from(memberships).where(eq(memberships.userId, input.userId))) as Array<{ orgId: string }>;
    if (now2.some((m) => m.orgId !== inv.orgId)) throw new Rollback(fail(409, 'already_on_a_business', ON_A_BUSINESS));

    const detail = { role: inv.role, emailMask: maskEmail(inv.email) };
    await recordAuthorityEvent(tx, { orgId: inv.orgId, actorUserId: input.userId, action: 'team_invitation_accepted', subjectUserId: input.userId, ref: inv.id, detail, now: () => now });
    await recordAuthorityEvent(tx, { orgId: inv.orgId, actorUserId: inv.invitedBy, action: 'member_added', subjectUserId: input.userId, ref: inv.id, detail: { role: inv.role, via: 'invitation' }, now: () => now });
    return { ok: true as const, changed: true, orgId: inv.orgId, role: inv.role as MembershipRole };
  });
}

/** Decline: final. A person on another business can decline too. A repeat changes nothing. */
export function declineInvitation(
  db: DrizzleDb,
  input: { userId: string; invitationId: string; now?: Clock },
): Promise<{ ok: true; changed: boolean } | TeamFailure> {
  return atomic(db, async (tx) => {
    const found = await mineOrFailure(tx, input.userId, input.invitationId);
    if (isFailure(found)) return found;
    const inv = found.row;
    const now = clock(input.now);
    if (inv.status === 'declined') return { ok: true as const, changed: false };
    if (inv.status === 'expired') return EXPIRED();
    if (inv.status !== 'pending') return NO_LONGER_OPEN();
    if (inv.expiresAt.getTime() <= now.getTime()) {
      await expireDue(tx, { orgId: inv.orgId, email: inv.email }, now);
      return EXPIRED();
    }
    const closed = await tx
      .update(teamInvitations)
      .set({ status: 'declined', decidedAt: now, decidedBy: input.userId })
      .where(and(eq(teamInvitations.id, inv.id), eq(teamInvitations.status, 'pending')))
      .returning({ id: teamInvitations.id });
    if (closed.length === 0) return { ok: true as const, changed: false };
    await recordAuthorityEvent(tx, { orgId: inv.orgId, actorUserId: input.userId, action: 'team_invitation_declined', ref: inv.id, detail: { role: inv.role, emailMask: maskEmail(inv.email) }, now: () => now });
    return { ok: true as const, changed: true };
  });
}
