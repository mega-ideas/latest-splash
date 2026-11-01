/**
 * Leaving the team takes an owner's approval (v2 Phase 3, Sky's decision of 1 Nov).
 *
 *   ask        Any member can ask to leave, from their own settings. The
 *              request goes to the owners and NOTHING changes: the person keeps
 *              their access, any spending rule and any place in charge until an
 *              owner approves. The only owner of a business cannot ask.
 *   withdraw   The person can take the request back.
 *   decide     An owner alone (Sky's decision: the highest authority). The
 *              Finance lead sees the requests and decides none: approving ends
 *              access at once but only the wallet's owners can take the spending
 *              rule back, so a lead's approval would leave a live rule behind.
 *              Nobody decides their own request: an owner's leaving needs
 *              another owner. (One rule for the server and the page:
 *              lib/team/view.ts leaveDecisionRefusal.)
 *   approve    In one transaction: the membership ends, the person's place in
 *              charge, Finance lead role, Add funds and Withdraw access and
 *              sign-offs end (offboardMember), and their passkey addresses are
 *              recorded so the spending-rules revoke path can take their rule
 *              back. That revoke is a request the wallet's owners sign on their
 *              own devices; the route opens it after this commits
 *              (lib/server/team-leave-rules.ts). Until the owners sign it the
 *              rule still exists on the chain, and Settings shows it as
 *              belonging to a former member.
 *   decline    The person stays, and is told so in words.
 *
 * Every step is a line of the append-only trail. Every read and write takes the
 * business from the session and reads only its rows; another business's request
 * reads as absent. A repeat of any step changes nothing and writes no second
 * line.
 */
import { randomUUID } from 'node:crypto';

import { and, asc, desc, eq } from 'drizzle-orm';

import { memberships, teamLeaveRequests, users } from '../db/schema.ts';
import type { MembershipRole } from '../membership-roles.ts';
import { LAST_OWNER_SENTENCE, LEAVE_WHY_NOT, leaveDecisionRefusal, leaveSentence, type LeaveDecisionRefusal, type LeaveRequestWire, type LeaveStatusWire, type Manager } from '../team/view.ts';
import { fail, inTransaction, lockOwners, teamManager, type TeamFailure } from './team-admin.ts';
import { memberRole, offboardMember, passkeyAddressesOf, recordAuthorityEvent } from './wallet-authority.ts';
import type { DrizzleDb } from './wallet-signing-store.ts';

type Clock = () => Date;
const clock = (now?: Clock) => (now ?? (() => new Date()))();

const NOT_FOUND = () => fail(404, 'not_found', 'That request was not found.');
const NOT_PENDING = () => fail(409, 'not_pending', 'This request has already been answered, withdrawn or closed. Reload to see where it stands.');
const LAST_OWNER = () => fail(409, 'last_owner', LAST_OWNER_SENTENCE);

type Row = typeof teamLeaveRequests.$inferSelect;
const isFailure = (x: unknown): x is TeamFailure => typeof x === 'object' && x !== null && (x as { ok?: unknown }).ok === false;

/** The refusal a decision gets, as the service's own failure. */
function refusalFailure(reason: LeaveDecisionRefusal): TeamFailure {
  switch (reason) {
    case 'not_a_manager':
      return fail(403, 'not_allowed', 'Only an owner or the Finance lead can decide a request to leave.');
    case 'own_request':
      return fail(403, 'own_request', LEAVE_WHY_NOT.own_request);
    default:
      return fail(403, 'owner_only', LEAVE_WHY_NOT[reason]);
  }
}

// ─── The person's side ──────────────────────────────────────────────────────

/** Ask to leave. Nothing about the person changes. A second ask while one is open is the same request. */
export function requestToLeave(
  db: DrizzleDb,
  input: { orgId: string; actorUserId: string; now?: Clock },
): Promise<{ ok: true; created: boolean; request: { id: string } } | TeamFailure> {
  return inTransaction(db, async (tx) => {
    const owners = await lockOwners(tx, input.orgId);
    const role = await memberRole(tx, input.orgId, input.actorUserId);
    if (role === null) return fail(403, 'not_allowed', 'You are not on this team.');
    if (role === 'admin' && !owners.some((id) => id !== input.actorUserId)) return LAST_OWNER();
    const now = clock(input.now);
    const open = async () => (await tx.select().from(teamLeaveRequests).where(and(eq(teamLeaveRequests.orgId, input.orgId), eq(teamLeaveRequests.userId, input.actorUserId), eq(teamLeaveRequests.status, 'pending'))).limit(1))[0] as Row | undefined;
    const existing = await open();
    if (existing) return { ok: true as const, created: false, request: { id: existing.id } };
    const id = `lvr_${randomUUID()}`;
    const inserted = await tx
      .insert(teamLeaveRequests)
      .values({ id, orgId: input.orgId, userId: input.actorUserId, status: 'pending', createdAt: now })
      .onConflictDoNothing()
      .returning({ id: teamLeaveRequests.id });
    if (inserted.length === 0) {
      const theirs = await open();
      return { ok: true as const, created: false, request: { id: theirs?.id ?? id } };
    }
    await recordAuthorityEvent(tx, { orgId: input.orgId, actorUserId: input.actorUserId, action: 'leave_requested', subjectUserId: input.actorUserId, ref: id, detail: { role }, now: () => now });
    return { ok: true as const, created: true, request: { id } };
  });
}

/** The person takes their own open request back. */
export function withdrawLeaveRequest(
  db: DrizzleDb,
  input: { orgId: string; actorUserId: string; now?: Clock },
): Promise<{ ok: true } | TeamFailure> {
  return inTransaction(db, async (tx) => {
    if ((await memberRole(tx, input.orgId, input.actorUserId)) === null) return fail(403, 'not_allowed', 'You are not on this team.');
    const now = clock(input.now);
    const closed = await tx
      .update(teamLeaveRequests)
      .set({ status: 'withdrawn', decidedAt: now, decidedBy: input.actorUserId })
      .where(and(eq(teamLeaveRequests.orgId, input.orgId), eq(teamLeaveRequests.userId, input.actorUserId), eq(teamLeaveRequests.status, 'pending')))
      .returning({ id: teamLeaveRequests.id });
    if (closed.length === 0) return fail(404, 'no_request', 'You have no open request to leave.');
    await recordAuthorityEvent(tx, { orgId: input.orgId, actorUserId: input.actorUserId, action: 'leave_withdrawn', subjectUserId: input.actorUserId, ref: closed[0].id, now: () => now });
    return { ok: true as const };
  });
}

/** Where the person's own request stands, in words. */
export async function leaveStatusOf(db: DrizzleDb, input: { orgId: string; userId: string }): Promise<LeaveStatusWire> {
  // An open request always wins; otherwise the newest answered one (a withdrawn or closed one says nothing).
  const mine = (await db
    .select()
    .from(teamLeaveRequests)
    .where(and(eq(teamLeaveRequests.orgId, input.orgId), eq(teamLeaveRequests.userId, input.userId)))
    .orderBy(desc(teamLeaveRequests.createdAt), desc(teamLeaveRequests.id))) as Row[];
  const latest = mine.find((r) => r.status === 'pending') ?? (mine[0]?.status === 'declined' ? mine[0] : undefined);
  const role = await memberRole(db, input.orgId, input.userId);
  let onlyOwner = false;
  if (role === 'admin') {
    const owners = await db.select({ userId: memberships.userId }).from(memberships).where(and(eq(memberships.orgId, input.orgId), eq(memberships.role, 'admin')));
    onlyOwner = !(owners as Array<{ userId: string }>).some((o) => o.userId !== input.userId);
  }
  if (latest && latest.status === 'pending') {
    return { state: 'pending', canRequest: false, message: leaveSentence('pending'), requestedAt: latest.createdAt.toISOString(), decidedAt: null, decidedByName: null };
  }
  if (latest && latest.status === 'declined') {
    const [by] = latest.decidedBy ? await db.select({ name: users.name }).from(users).where(eq(users.id, latest.decidedBy)).limit(1) : [];
    return {
      state: 'declined',
      canRequest: role !== null && !onlyOwner,
      message: leaveSentence('declined', by?.name ?? null),
      requestedAt: latest.createdAt.toISOString(),
      decidedAt: latest.decidedAt?.toISOString() ?? null,
      decidedByName: by?.name ?? null,
    };
  }
  return { state: 'none', canRequest: role !== null && !onlyOwner, message: onlyOwner ? LAST_OWNER_SENTENCE : null, requestedAt: null, decidedAt: null, decidedByName: null };
}

// ─── The managers' side ─────────────────────────────────────────────────────

/** The open requests of this business, oldest first, for someone who manages the team; with whether they may decide each. */
export async function listLeaveRequests(db: DrizzleDb, input: { orgId: string; actorUserId: string }): Promise<LeaveRequestWire[]> {
  const manager: Manager = await teamManager(db, input.orgId, input.actorUserId);
  if (!manager) return [];
  const rows = await db
    .select({ id: teamLeaveRequests.id, userId: teamLeaveRequests.userId, createdAt: teamLeaveRequests.createdAt, name: users.name, email: users.email, role: memberships.role })
    .from(teamLeaveRequests)
    .innerJoin(users, eq(users.id, teamLeaveRequests.userId))
    .innerJoin(memberships, and(eq(memberships.userId, teamLeaveRequests.userId), eq(memberships.orgId, teamLeaveRequests.orgId)))
    .where(and(eq(teamLeaveRequests.orgId, input.orgId), eq(teamLeaveRequests.status, 'pending')))
    .orderBy(asc(teamLeaveRequests.createdAt), asc(teamLeaveRequests.id));
  const out: LeaveRequestWire[] = [];
  for (const r of rows as Array<{ id: string; userId: string; createdAt: Date; name: string; email: string; role: string }>) {
    const refusal = leaveDecisionRefusal({ manager, actorUserId: input.actorUserId, leaver: { userId: r.userId } });
    out.push({ id: r.id, userId: r.userId, name: r.name, email: r.email, role: r.role as MembershipRole, createdAt: r.createdAt.toISOString(), canDecide: refusal === null, whyNot: refusal ? LEAVE_WHY_NOT[refusal] : null });
  }
  return out;
}

type Gate = { row: Row; role: string; manager: NonNullable<Manager>; owners: string[] };

/** Who is deciding, which request (this business's only), and whether they may. */
async function gate(tx: DrizzleDb, input: { orgId: string; actorUserId: string; requestId: unknown }, owners: string[]): Promise<Gate | { done: { ok: true; changed: false } } | TeamFailure> {
  const manager = await teamManager(tx, input.orgId, input.actorUserId);
  if (!manager) return refusalFailure('not_a_manager');
  const [row] = (await tx.select().from(teamLeaveRequests).where(and(eq(teamLeaveRequests.id, String(input.requestId)), eq(teamLeaveRequests.orgId, input.orgId))).limit(1)) as Row[];
  if (!row) return NOT_FOUND();
  return { row, role: '', manager, owners };
}

/** Approve: the person leaves, in one transaction. Returns who left and the addresses the rule revoke needs. */
export function approveLeaveRequest(
  db: DrizzleDb,
  input: { orgId: string; actorUserId: string; requestId: string; now?: Clock },
): Promise<{ ok: true; changed: boolean; leaver: { userId: string; role: MembershipRole; addresses: string[] } | null } | TeamFailure> {
  return inTransaction(db, async (tx) => {
    const owners = await lockOwners(tx, input.orgId);
    const g = await gate(tx, input, owners);
    if (isFailure(g)) return g;
    if ('done' in g) return { ...g.done, leaver: null };
    const { row, manager } = g;
    if (row.status === 'approved') return { ok: true as const, changed: false, leaver: null };
    if (row.status !== 'pending') return NOT_PENDING();
    const role = await memberRole(tx, input.orgId, row.userId);
    const now = clock(input.now);
    if (role === null) {
      await tx.update(teamLeaveRequests).set({ status: 'closed', decidedAt: now, decidedBy: input.actorUserId }).where(and(eq(teamLeaveRequests.id, row.id), eq(teamLeaveRequests.status, 'pending')));
      return NOT_PENDING();
    }
    const refusal = leaveDecisionRefusal({ manager, actorUserId: input.actorUserId, leaver: { userId: row.userId } });
    if (refusal) return refusalFailure(refusal);
    if (role === 'admin' && !owners.some((id) => id !== row.userId)) return LAST_OWNER();

    const closed = await tx
      .update(teamLeaveRequests)
      .set({ status: 'approved', decidedAt: now, decidedBy: input.actorUserId })
      .where(and(eq(teamLeaveRequests.id, row.id), eq(teamLeaveRequests.status, 'pending')))
      .returning({ id: teamLeaveRequests.id });
    if (closed.length === 0) return { ok: true as const, changed: false, leaver: null };
    const addresses = await passkeyAddressesOf(tx, row.userId);
    const removed = await tx.delete(memberships).where(and(eq(memberships.orgId, input.orgId), eq(memberships.userId, row.userId))).returning({ id: memberships.id });
    if (removed.length === 0) return NOT_PENDING();
    await recordAuthorityEvent(tx, { orgId: input.orgId, actorUserId: input.actorUserId, action: 'leave_approved', subjectUserId: row.userId, ref: row.id, detail: { role }, now: () => now });
    await recordAuthorityEvent(tx, { orgId: input.orgId, actorUserId: input.actorUserId, action: 'member_removed', subjectUserId: row.userId, ref: row.id, detail: { role, reason: 'left' }, now: () => now });
    await offboardMember(tx, { orgId: input.orgId, userId: row.userId, by: input.actorUserId, addresses, now: () => now });
    return { ok: true as const, changed: true, leaver: { userId: row.userId, role: role as MembershipRole, addresses } };
  });
}

/** Decline: the person stays. */
export function declineLeaveRequest(
  db: DrizzleDb,
  input: { orgId: string; actorUserId: string; requestId: string; now?: Clock },
): Promise<{ ok: true; changed: boolean } | TeamFailure> {
  return inTransaction(db, async (tx) => {
    const g = await gate(tx, input, []);
    if (isFailure(g)) return g;
    if ('done' in g) return g.done;
    const { row, manager } = g;
    if (row.status === 'declined') return { ok: true as const, changed: false };
    if (row.status !== 'pending') return NOT_PENDING();
    const role = await memberRole(tx, input.orgId, row.userId);
    if (role === null) return NOT_PENDING();
    const refusal = leaveDecisionRefusal({ manager, actorUserId: input.actorUserId, leaver: { userId: row.userId } });
    if (refusal) return refusalFailure(refusal);
    const now = clock(input.now);
    const closed = await tx
      .update(teamLeaveRequests)
      .set({ status: 'declined', decidedAt: now, decidedBy: input.actorUserId })
      .where(and(eq(teamLeaveRequests.id, row.id), eq(teamLeaveRequests.status, 'pending')))
      .returning({ id: teamLeaveRequests.id });
    if (closed.length === 0) return { ok: true as const, changed: false };
    await recordAuthorityEvent(tx, { orgId: input.orgId, actorUserId: input.actorUserId, action: 'leave_declined', subjectUserId: row.userId, ref: row.id, detail: { role }, now: () => now });
    return { ok: true as const, changed: true };
  });
}
