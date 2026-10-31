/**
 * The team, run by the business (v2 Phase 3, Sky's decision of 31 Oct).
 *
 * Adding a person, changing their role and removing them are an OWNER's
 * actions in Settings, not a Splash support action. An owner can give ONE
 * person, the Finance lead, most of that and nothing else that is an owner's.
 * Who may use Add funds and Withdraw inside the dashboard is granted by an
 * owner, member by member.
 *
 *   Owner         membership role admin. May do everything here.
 *   Finance lead  an approver (role checker) an owner appointed, one per
 *                 business. May add, change and remove viewers, staff and
 *                 approvers. May NOT: give the owner role, touch an owner,
 *                 change or remove themselves, appoint or take back the
 *                 Finance lead, grant or take away Add funds or Withdraw
 *                 (their own included), or anything on the wallet beyond
 *                 starting a request to add a signer (app/api/wallet/
 *                 business/members). It carries no signing power: the chain
 *                 knows nobody as a Finance lead, and a wallet request is
 *                 signed only by its signers.
 *   Everyone else Refused on every function here (default deny).
 *
 * The Finance lead sits on top of a membership, as the person in charge does
 * (lib/server/wallet-authority.ts); it adds no value to the memberships role
 * enum, so every existing `role === 'admin'` check still means "owner" and a
 * Finance lead fails each one. It grants nothing unless the person is still
 * an approver of the business right now: a role change or a removal ends it.
 *
 * Every function takes the business and the actor from the caller (the
 * session, in the routes), reads and writes only that business, and writes a
 * line to the append-only trail (wallet_authority_events) for every change. A
 * person or row of another business reads as absent (404). A retry makes no
 * second change and no second line.
 */
import { randomUUID } from 'node:crypto';

import { and, desc, eq, inArray, isNull } from 'drizzle-orm';

import { GrantRefusedError, grantMembership } from '../auth/authority.ts';
import { memberships, users, walletAuthorityEvents, walletFinanceLeads, walletMemberAccess, walletPersonsInCharge } from '../db/schema.ts';
import { isMembershipRole, type MembershipRole } from '../membership-roles.ts';
import { TEAM_ACTIONS, activitySummary, type FundsAccessKind, type Manager, type TeamActivityWire, type TeamMemberWire } from '../team/view.ts';
import { endFinanceLead, memberRole, offboardMember, passkeyAddressesOf, recordAuthorityEvent } from './wallet-authority.ts';
import type { DrizzleDb } from './wallet-signing-store.ts';

type Clock = () => Date;
export type TeamFailure = { ok: false; status: number; code: string; error: string };
const fail = (status: number, code: string, error: string): TeamFailure => ({ ok: false, status, code, error });
const clock = (now?: Clock) => (now ?? (() => new Date()))();

export const FUNDS_ACCESS_KINDS: readonly FundsAccessKind[] = ['add_funds', 'withdraw'];
const isAccessKind = (v: unknown): v is FundsAccessKind => typeof v === 'string' && (FUNDS_ACCESS_KINDS as readonly string[]).includes(v);

const NOT_ALLOWED = (what: string) => fail(403, 'not_allowed', `Only an owner or the Finance lead can ${what}.`);
const OWNER_ONLY = (what: string) => fail(403, 'owner_only', `Only an owner can ${what}.`);

/** Refuses anyone who is not an owner: the Finance lead with `owner_only`, everyone else with `not_allowed`. */
function ownerOnly(manager: Manager, what: string): TeamFailure | null {
  if (manager === 'owner') return null;
  return manager === 'finance_lead' ? OWNER_ONLY(what) : fail(403, 'not_allowed', `Only an owner can ${what}.`);
}

// ─── Who holds what ─────────────────────────────────────────────────────────

/**
 * The Finance lead of a business, or null. An open appointment counts only
 * while that person is still an approver of this business.
 */
export async function financeLeadOf(db: DrizzleDb, orgId: string): Promise<string | null> {
  const [open] = await db
    .select({ userId: walletFinanceLeads.userId })
    .from(walletFinanceLeads)
    .where(and(eq(walletFinanceLeads.orgId, orgId), isNull(walletFinanceLeads.revokedAt)))
    .limit(1);
  if (!open) return null;
  return (await memberRole(db, orgId, open.userId)) === 'checker' ? open.userId : null;
}

/** Owner, Finance lead, or neither, in this business now. */
export async function teamManager(db: DrizzleDb, orgId: string, userId: string): Promise<Manager> {
  const role = await memberRole(db, orgId, userId);
  if (role === 'admin') return 'owner';
  if (role !== 'checker') return null;
  return (await financeLeadOf(db, orgId)) === userId ? 'finance_lead' : null;
}

/**
 * What this person may do with Add funds and Withdraw. Owners both. Staff and
 * approvers only what an owner granted and has not taken back. A viewer, a
 * stranger and a person of another business: neither, whatever rows exist.
 */
export async function fundsAccessOf(db: DrizzleDb, orgId: string, userId: string): Promise<{ addFunds: boolean; withdraw: boolean }> {
  const role = await memberRole(db, orgId, userId);
  if (role === 'admin') return { addFunds: true, withdraw: true };
  if (role !== 'maker' && role !== 'checker') return { addFunds: false, withdraw: false };
  const rows = await db
    .select({ access: walletMemberAccess.access })
    .from(walletMemberAccess)
    .where(and(eq(walletMemberAccess.orgId, orgId), eq(walletMemberAccess.userId, userId), isNull(walletMemberAccess.revokedAt)));
  const held = new Set(rows.map((r: { access: string }) => r.access));
  return { addFunds: held.has('add_funds'), withdraw: held.has('withdraw') };
}

// ─── Adding, changing, removing ─────────────────────────────────────────────

/** Add a person to the business by email, with a role. They must already have a verified Splash account. */
export async function addTeamMember(
  db: DrizzleDb,
  input: { orgId: string; actorUserId: string; email: unknown; role: unknown; now?: Clock },
): Promise<{ ok: true; member: { userId: string; role: MembershipRole } } | TeamFailure> {
  const manager = await teamManager(db, input.orgId, input.actorUserId);
  if (!manager) return NOT_ALLOWED('add people');
  if (!isMembershipRole(input.role)) return fail(400, 'bad_role', 'Choose viewer, staff, approver or owner.');
  const role = input.role;
  if (manager === 'finance_lead' && role === 'admin') return OWNER_ONLY('give someone the owner role');
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  // One answer for no account, an unverified one and a person already in another business: it does not say which.
  const cannot = fail(409, 'cannot_add', 'That email could not be added. The person needs a verified Splash account, and it cannot belong to another business. Check the address, or ask them to sign up and verify their email.');
  if (!email || email.length > 254 || !email.includes('@')) return cannot;

  const [account] = await db.select({ id: users.id, verified: users.emailVerifiedAt }).from(users).where(eq(users.email, email)).limit(1);
  if (!account || !account.verified) return cannot;
  const held = await db.select({ orgId: memberships.orgId }).from(memberships).where(eq(memberships.userId, account.id));
  if (held.some((m: { orgId: string }) => m.orgId === input.orgId)) return fail(409, 'already_on_team', 'That person is already on your team.');
  if (held.length > 0) return cannot;

  let created: boolean;
  try {
    ({ created } = await grantMembership(db, { email, orgId: input.orgId, role, grantedBy: input.actorUserId }));
  } catch (error) {
    if (error instanceof GrantRefusedError) return cannot;
    throw error;
  }
  if (!created) return fail(409, 'already_on_team', 'That person is already on your team.');
  // Two businesses adding the same person at once: the later one gives way and nothing is kept.
  const now = await db.select({ orgId: memberships.orgId }).from(memberships).where(eq(memberships.userId, account.id));
  if (now.some((m: { orgId: string }) => m.orgId !== input.orgId)) {
    await db.delete(memberships).where(and(eq(memberships.userId, account.id), eq(memberships.orgId, input.orgId)));
    return cannot;
  }
  await recordAuthorityEvent(db, { orgId: input.orgId, actorUserId: input.actorUserId, action: 'member_added', subjectUserId: account.id, detail: { role }, now: input.now });
  return { ok: true, member: { userId: account.id, role } };
}

/** Change a member's role. A move to viewer or owner ends what only staff and approvers hold. */
export async function changeTeamMemberRole(
  db: DrizzleDb,
  input: { orgId: string; actorUserId: string; userId: string; role: unknown; now?: Clock },
): Promise<{ ok: true; changed: boolean } | TeamFailure> {
  const manager = await teamManager(db, input.orgId, input.actorUserId);
  if (!manager) return NOT_ALLOWED('change a role');
  if (!isMembershipRole(input.role)) return fail(400, 'bad_role', 'Choose viewer, staff, approver or owner.');
  const role = input.role;
  if (manager === 'finance_lead' && role === 'admin') return OWNER_ONLY('give someone the owner role');
  const current = await memberRole(db, input.orgId, input.userId);
  if (current === null) return fail(404, 'not_a_member', 'No such member of this business.');
  if (input.userId === input.actorUserId) {
    return manager === 'owner' ? fail(409, 'self_change', 'You cannot change your own role. Another owner can.') : OWNER_ONLY('change the Finance lead’s own role');
  }
  if (manager === 'finance_lead' && current === 'admin') return OWNER_ONLY('change an owner');
  if (current === role) return { ok: true, changed: false };

  const now = clock(input.now);
  const updated = await db
    .update(memberships)
    .set({ role, updatedAt: now })
    .where(and(eq(memberships.orgId, input.orgId), eq(memberships.userId, input.userId), eq(memberships.role, current as MembershipRole)))
    .returning({ id: memberships.id });
  // Changed under us by someone else at the same moment: nothing was done here.
  if (updated.length === 0) return fail(409, 'changed_meanwhile', 'This person’s role changed while you were changing it. Reload and look again.');
  await recordAuthorityEvent(db, { orgId: input.orgId, actorUserId: input.actorUserId, action: 'member_role_changed', subjectUserId: input.userId, detail: { from: current, to: role }, now: () => now });
  if (role === 'viewer' || role === 'admin') {
    // Neither can be in charge, hold a Finance lead role or use Add funds or Withdraw by grant: all of it ends, and any spending rule they hold is shown as orphaned until the owners take it back.
    await offboardMember(db, { orgId: input.orgId, userId: input.userId, by: input.actorUserId, addresses: await passkeyAddressesOf(db, input.userId), now: () => now });
  } else if (role !== 'checker') {
    await endFinanceLead(db, { orgId: input.orgId, userId: input.userId, by: input.actorUserId, reason: 'role_changed', now: () => now });
  }
  return { ok: true, changed: true };
}

/** Remove a member. Their place in charge, Finance lead role, access and sign-offs end with it; spending rules they hold are shown as orphaned. */
export async function removeTeamMember(
  db: DrizzleDb,
  input: { orgId: string; actorUserId: string; userId: string; now?: Clock },
): Promise<{ ok: true } | TeamFailure> {
  const manager = await teamManager(db, input.orgId, input.actorUserId);
  if (!manager) return NOT_ALLOWED('remove people');
  const current = await memberRole(db, input.orgId, input.userId);
  if (current === null) return fail(404, 'not_a_member', 'No such member of this business.');
  if (input.userId === input.actorUserId) {
    return manager === 'owner' ? fail(409, 'self_change', 'You cannot remove yourself. Another owner can.') : OWNER_ONLY('remove the Finance lead');
  }
  if (manager === 'finance_lead' && current === 'admin') return OWNER_ONLY('remove an owner');

  const now = clock(input.now);
  const addresses = await passkeyAddressesOf(db, input.userId);
  const removed = await db
    .delete(memberships)
    .where(and(eq(memberships.orgId, input.orgId), eq(memberships.userId, input.userId)))
    .returning({ id: memberships.id });
  if (removed.length === 0) return fail(404, 'not_a_member', 'No such member of this business.');
  await recordAuthorityEvent(db, { orgId: input.orgId, actorUserId: input.actorUserId, action: 'member_removed', subjectUserId: input.userId, detail: { role: current }, now: () => now });
  await offboardMember(db, { orgId: input.orgId, userId: input.userId, by: input.actorUserId, addresses, now: () => now });
  return { ok: true };
}

// ─── The Finance lead ───────────────────────────────────────────────────────

/** An owner appoints the Finance lead: an approver of this business. One at a time. */
export async function appointFinanceLead(
  db: DrizzleDb,
  input: { orgId: string; actorUserId: string; userId: string; now?: Clock },
): Promise<{ ok: true } | TeamFailure> {
  const manager = await teamManager(db, input.orgId, input.actorUserId);
  const refused = ownerOnly(manager, 'appoint the Finance lead');
  if (refused) return refused;
  const role = await memberRole(db, input.orgId, input.userId);
  if (role === null) return fail(404, 'not_a_member', 'No such member of this business.');
  if (role !== 'checker') return fail(409, 'not_an_approver', 'The Finance lead is an approver. Change this person’s role to approver first.');
  const now = clock(input.now);
  if (await financeLeadOf(db, input.orgId)) return fail(409, 'finance_lead_exists', 'There is one Finance lead at a time. Take the role back from the current one first.');
  // An appointment left open for someone who stopped being an approver blocks nothing: close it.
  const [stale] = await db.select({ userId: walletFinanceLeads.userId }).from(walletFinanceLeads).where(and(eq(walletFinanceLeads.orgId, input.orgId), isNull(walletFinanceLeads.revokedAt))).limit(1);
  if (stale) await endFinanceLead(db, { orgId: input.orgId, userId: stale.userId, by: input.actorUserId, reason: 'no_longer_an_approver', now: () => now });
  try {
    await db.insert(walletFinanceLeads).values({ id: `wfl_${randomUUID()}`, orgId: input.orgId, userId: input.userId, grantedBy: input.actorUserId, grantedAt: now });
  } catch {
    // Two owners appointing at once: the partial unique index lets one in.
    return fail(409, 'finance_lead_exists', 'There is one Finance lead at a time. Take the role back from the current one first.');
  }
  await recordAuthorityEvent(db, { orgId: input.orgId, actorUserId: input.actorUserId, action: 'finance_lead_appointed', subjectUserId: input.userId, now: () => now });
  return { ok: true };
}

/** An owner takes the Finance lead role back from whoever holds it. */
export async function revokeFinanceLead(
  db: DrizzleDb,
  input: { orgId: string; actorUserId: string; now?: Clock },
): Promise<{ ok: true; userId: string } | TeamFailure> {
  const manager = await teamManager(db, input.orgId, input.actorUserId);
  const refused = ownerOnly(manager, 'take back the Finance lead role');
  if (refused) return refused;
  const now = clock(input.now);
  const revoked = await db
    .update(walletFinanceLeads)
    .set({ revokedAt: now, revokedBy: input.actorUserId })
    .where(and(eq(walletFinanceLeads.orgId, input.orgId), isNull(walletFinanceLeads.revokedAt)))
    .returning({ userId: walletFinanceLeads.userId });
  if (revoked.length === 0) return fail(404, 'no_finance_lead', 'There is no Finance lead to take the role back from.');
  await recordAuthorityEvent(db, { orgId: input.orgId, actorUserId: input.actorUserId, action: 'finance_lead_revoked', subjectUserId: revoked[0].userId, detail: { reason: 'owner' }, now: () => now });
  return { ok: true, userId: revoked[0].userId };
}

// ─── Add funds and Withdraw ─────────────────────────────────────────────────

/**
 * An owner lets a staff member or an approver use Add funds or Withdraw
 * (`allowed: true`), or takes it back (`false`). Owners have both already;
 * a viewer never. Nobody else, the Finance lead included, can change it.
 */
export async function setMemberAccess(
  db: DrizzleDb,
  input: { orgId: string; actorUserId: string; userId: string; access: unknown; allowed: boolean; now?: Clock },
): Promise<{ ok: true; changed: boolean } | TeamFailure> {
  const manager = await teamManager(db, input.orgId, input.actorUserId);
  const refused = ownerOnly(manager, 'give or take away Add funds and Withdraw');
  if (refused) return refused;
  if (!isAccessKind(input.access)) return fail(400, 'bad_access', 'Choose Add funds or Withdraw.');
  const access = input.access;
  const role = await memberRole(db, input.orgId, input.userId);
  if (role === null) return fail(404, 'not_a_member', 'No such member of this business.');
  const now = clock(input.now);

  if (!input.allowed) {
    const closed = await db
      .update(walletMemberAccess)
      .set({ revokedAt: now, revokedBy: input.actorUserId })
      .where(and(eq(walletMemberAccess.orgId, input.orgId), eq(walletMemberAccess.userId, input.userId), eq(walletMemberAccess.access, access), isNull(walletMemberAccess.revokedAt)))
      .returning({ id: walletMemberAccess.id });
    if (closed.length === 0) return { ok: true, changed: false };
    await recordAuthorityEvent(db, { orgId: input.orgId, actorUserId: input.actorUserId, action: 'member_access_revoked', subjectUserId: input.userId, detail: { access, reason: 'owner' }, now: () => now });
    return { ok: true, changed: true };
  }

  if (role === 'admin') return fail(409, 'not_needed', 'An owner can already add funds and withdraw.');
  if (role === 'viewer') return fail(409, 'cannot_hold_access', 'A viewer cannot add funds or withdraw. Change their role first.');
  const inserted = await db
    .insert(walletMemberAccess)
    .values({ id: `wma_${randomUUID()}`, orgId: input.orgId, userId: input.userId, access, grantedBy: input.actorUserId, grantedAt: now })
    .onConflictDoNothing()
    .returning({ id: walletMemberAccess.id });
  if (inserted.length === 0) return { ok: true, changed: false };
  await recordAuthorityEvent(db, { orgId: input.orgId, actorUserId: input.actorUserId, action: 'member_access_granted', subjectUserId: input.userId, detail: { access }, now: () => now });
  return { ok: true, changed: true };
}

// ─── Reading ────────────────────────────────────────────────────────────────

/** Everyone on the team with what they hold. Only this business's people: the join on the membership is the boundary. */
export async function listTeam(db: DrizzleDb, orgId: string): Promise<TeamMemberWire[]> {
  const rows = await db
    .select({ userId: users.id, name: users.name, email: users.email, role: memberships.role })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.orgId, orgId));
  const lead = await financeLeadOf(db, orgId);
  const charge = new Set(
    (await db.select({ userId: walletPersonsInCharge.userId }).from(walletPersonsInCharge).where(and(eq(walletPersonsInCharge.orgId, orgId), isNull(walletPersonsInCharge.revokedAt)))).map((r: { userId: string }) => r.userId),
  );
  const held = await db
    .select({ userId: walletMemberAccess.userId, access: walletMemberAccess.access })
    .from(walletMemberAccess)
    .where(and(eq(walletMemberAccess.orgId, orgId), isNull(walletMemberAccess.revokedAt)));
  const grants = new Map<string, Set<string>>();
  for (const g of held as Array<{ userId: string; access: string }>) grants.set(g.userId, (grants.get(g.userId) ?? new Set()).add(g.access));
  return (rows as Array<{ userId: string; name: string; email: string; role: string }>)
    .map((r) => {
      const role = r.role as MembershipRole;
      const owner = role === 'admin';
      const staff = role === 'maker' || role === 'checker';
      const mine = grants.get(r.userId);
      return {
        userId: r.userId,
        name: r.name,
        email: r.email,
        role,
        financeLead: lead === r.userId,
        inCharge: charge.has(r.userId) && staff,
        addFunds: owner || (staff && Boolean(mine?.has('add_funds'))),
        withdraw: owner || (staff && Boolean(mine?.has('withdraw'))),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId));
}

/** The latest team lines of the trail for one business, oldest first, with names and a sentence. */
export async function listTeamActivity(db: DrizzleDb, orgId: string, limit = 50): Promise<TeamActivityWire[]> {
  const rows = await db
    .select()
    .from(walletAuthorityEvents)
    .where(and(eq(walletAuthorityEvents.orgId, orgId), inArray(walletAuthorityEvents.action, [...TEAM_ACTIONS])))
    .orderBy(desc(walletAuthorityEvents.seq))
    .limit(limit);
  const ids = [...new Set(rows.flatMap((r: { actorUserId: string; subjectUserId: string | null }) => [r.actorUserId, r.subjectUserId]).filter((x: string | null): x is string => Boolean(x) && !String(x).startsWith('operator:')))];
  const names = new Map<string, string>();
  if (ids.length > 0) {
    for (const u of (await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids))) as Array<{ id: string; name: string }>) names.set(u.id, u.name);
  }
  const nameOf = (id: string | null): string | null => (id === null ? null : id.startsWith('operator:') ? 'Splash support' : names.get(id) ?? 'A former member');
  return rows
    .map((r: { id: string; action: string; detail: unknown; createdAt: Date; actorUserId: string; subjectUserId: string | null }) => {
      const actorName = nameOf(r.actorUserId) ?? 'Someone';
      const subjectName = nameOf(r.subjectUserId);
      return { id: r.id, action: r.action, createdAt: r.createdAt.toISOString(), actorName, subjectName, summary: activitySummary({ action: r.action, detail: r.detail, actorName, subjectName }) };
    })
    .reverse();
}
