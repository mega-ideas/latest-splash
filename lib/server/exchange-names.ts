/**
 * Whose name the exchange is told (v2 Phase 3, Sky's decision), read and changed
 * on the server from the database, never from the page.
 *
 * Two switches, both on by default (migration 0084):
 *
 *   the business's   organizations.share_names_with_exchange. Only an OWNER
 *                    changes it; instant, no cooldown, one line on the trail.
 *   the person's     memberships.share_name_with_exchange. Only the person
 *                    changes their own; nobody else, an owner included.
 *
 * If either is off, the Travel Rule message for a payment the person sends
 * reads "Sent by COMPANY NAME: purpose" and carries no person's name or title.
 * The switches change ONLY that: what the exchange is told and what the
 * confirmation shows. They never reach the audit proof (the sealed evidence
 * record and its anchor, lib/server/payment-trail.ts), which always holds who
 * started, approved and declined a payment.
 *
 * Every read and write names the business, taken from the session. A person of
 * another business reads as absent (404), and someone who is no member of the
 * business is refused (403). A person who is not a member of the business
 * shares nothing.
 */
import { and, eq } from 'drizzle-orm';

import { memberships, organizations } from '../db/schema.ts';
import { plainTitle } from '../team/declined-by.ts';
import type { TeamFailure } from './team-admin.ts';
import { memberRole, recordAuthorityEvent } from './wallet-authority.ts';
import type { DrizzleDb } from './wallet-signing-store.ts';

type Clock = () => Date;
const failWith = (status: number, code: string, error: string): TeamFailure => ({ ok: false, status, code, error });

export type NameSharing = {
  /** The business's switch. */
  business: boolean;
  /** This person's own switch. */
  person: boolean;
  /** Is this person's name sent to an exchange? Only when both allow it, and only for a member of the business. */
  shared: boolean;
  /** Their job title in this business as plain words, or null. */
  title: string | null;
};

/** The choices for this person in this business, now. Default for a member is to share; a stranger shares nothing. */
export async function nameSharingOf(db: DrizzleDb, orgId: string, userId: string): Promise<NameSharing> {
  const [org] = await db.select({ share: organizations.shareNamesWithExchange }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  const business = org ? org.share !== false : true;
  const [member] = await db
    .select({ share: memberships.shareNameWithExchange, title: memberships.title })
    .from(memberships)
    .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)))
    .limit(1);
  if (!member) return { business, person: false, shared: false, title: null };
  const person = member.share !== false;
  return { business, person, shared: business && person, title: plainTitle(member.title) };
}

/** Only the business's choice, for the page that shows the owners their switch. Unknown business: shares (the default). */
export async function businessNameSharing(db: DrizzleDb, orgId: string): Promise<boolean> {
  const [org] = await db.select({ share: organizations.shareNamesWithExchange }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  return org ? org.share !== false : true;
}

/**
 * An owner turns the business's switch on or off. Instant: no notice, no cooldown. Anyone else (the Finance lead, staff, a viewer,
 * an owner of another business) is refused. The same value again changes nothing and writes no line; a change writes one line on the trail.
 */
export function setBusinessNameSharing(
  db: DrizzleDb,
  input: { orgId: string; actorUserId: string; share: boolean; now?: Clock },
): Promise<{ ok: true; changed: boolean; share: boolean } | TeamFailure> {
  return db.transaction(async (raw) => {
    const tx = raw as unknown as DrizzleDb;
    const role = await memberRole(tx, input.orgId, input.actorUserId);
    if (role === null) return failWith(403, 'not_allowed', 'Only an owner of this business can change this.');
    if (role !== 'admin') return failWith(403, 'owner_only', 'Only an owner can choose whether people’s names go to exchanges.');
    if (typeof input.share !== 'boolean') return failWith(400, 'bad_value', 'Say whether to share names: on or off.');
    const [org] = await tx.select({ share: organizations.shareNamesWithExchange }).from(organizations).where(eq(organizations.id, input.orgId)).for('update');
    if (!org) return failWith(404, 'not_found', 'No such business.');
    if ((org.share !== false) === input.share) return { ok: true as const, changed: false, share: input.share };
    const now = (input.now ?? (() => new Date()))();
    await tx.update(organizations).set({ shareNamesWithExchange: input.share, updatedAt: now }).where(eq(organizations.id, input.orgId));
    await recordAuthorityEvent(tx, { orgId: input.orgId, actorUserId: input.actorUserId, action: 'exchange_name_sharing_changed', detail: { to: input.share }, now: () => now });
    return { ok: true as const, changed: true, share: input.share };
  });
}

/**
 * A person turns their own switch on or off, whatever their role. Nobody else does it for them, an owner included (403 `own_only`);
 * a person of another business reads as absent (404); someone who is no member of the business is refused (403). Instant.
 */
export function setOwnNameSharing(
  db: DrizzleDb,
  input: { orgId: string; actorUserId: string; userId: string; share: boolean; now?: Clock },
): Promise<{ ok: true; changed: boolean; share: boolean } | TeamFailure> {
  return db.transaction(async (raw) => {
    const tx = raw as unknown as DrizzleDb;
    if ((await memberRole(tx, input.orgId, input.actorUserId)) === null) return failWith(403, 'not_allowed', 'Only a member of this business can change this.');
    if (input.userId !== input.actorUserId) {
      return (await memberRole(tx, input.orgId, input.userId)) === null
        ? failWith(404, 'not_a_member', 'No such member of this business.')
        : failWith(403, 'own_only', 'Each person chooses this for themselves.');
    }
    if (typeof input.share !== 'boolean') return failWith(400, 'bad_value', 'Say whether to share your name: on or off.');
    const [row] = await tx
      .select({ share: memberships.shareNameWithExchange })
      .from(memberships)
      .where(and(eq(memberships.orgId, input.orgId), eq(memberships.userId, input.userId)))
      .for('update');
    if (!row) return failWith(404, 'not_a_member', 'No such member of this business.');
    if ((row.share !== false) === input.share) return { ok: true as const, changed: false, share: input.share };
    const now = (input.now ?? (() => new Date()))();
    await tx
      .update(memberships)
      .set({ shareNameWithExchange: input.share, updatedAt: now })
      .where(and(eq(memberships.orgId, input.orgId), eq(memberships.userId, input.userId)));
    return { ok: true as const, changed: true, share: input.share };
  });
}
