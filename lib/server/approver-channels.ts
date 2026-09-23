/**
 * Who may approve, and how to reach them.
 *
 * ─── The binding is the security boundary ───────────────────────────────────
 *
 * WhatsApp authenticates a handset. It says "a message arrived from
 * +60102651678" and nothing more — not who was holding the phone, not whether
 * they work here, not whether they are allowed to release money.
 *
 * So a reply is only ever acted on when its number resolves to a row in
 * `approver_channels` that is (a) verified, (b) attached to a user, and (c)
 * that user holds an approving role in the org the proposal belongs to. The
 * approval is then recorded against the USER — never the number, which is not
 * an identity and cannot appear in an audit trail as one.
 *
 * All three conditions are re-checked at reply time rather than at send time.
 * A person's role can be revoked between the request going out and the reply
 * coming back, and a revoked approver's answer must not still count.
 */
import 'server-only';

import { and, eq } from 'drizzle-orm';

import { APPROVING_ROLES, type MembershipRole } from '@/lib/membership-roles';
import { approverChannels, memberships, users } from '@/lib/db/schema';
import { normaliseE164 } from '@/lib/server/whatsapp';

export type Approver = {
  userId: string;
  email: string;
  name: string | null;
  role: MembershipRole;
  /** Null when they have no verified number — they can still approve in the app. */
  whatsappE164: string | null;
};

/**
 * Everyone in this org who may approve a payment.
 *
 * Includes approvers with no WhatsApp number. Reachability is a delivery
 * concern; eligibility is an authority concern, and conflating them would
 * quietly shrink the approver set to whoever happened to register a phone.
 */
export async function listApprovers(orgId: string): Promise<Approver[]> {
  if (!process.env.DATABASE_URL) return [];
  const { getDb } = await import('@/lib/db/client');
  const db = getDb();

  const rows = await db
    .select({
      userId: users.id,
      email: users.email,
      name: users.name,
      role: memberships.role,
      whatsappE164: approverChannels.whatsappE164,
      verifiedAt: approverChannels.verifiedAt,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .leftJoin(
      approverChannels,
      and(eq(approverChannels.userId, users.id), eq(approverChannels.orgId, memberships.orgId)),
    )
    .where(eq(memberships.orgId, orgId));

  return rows
    .filter((row) => (APPROVING_ROLES as readonly string[]).includes(row.role))
    .map((row) => ({
      userId: row.userId,
      email: row.email,
      name: row.name,
      role: row.role as MembershipRole,
      // An unverified number is a number somebody typed. Typos route approval
      // requests to strangers, so it does not count as reachable.
      whatsappE164: row.verifiedAt ? row.whatsappE164 : null,
    }));
}

export type ResolvedApprover =
  | { ok: true; approver: Approver; orgId: string }
  | { ok: false; reason: string };

/**
 * Turn an inbound number into a person who may approve — or refuse.
 *
 * `orgId` is supplied by the caller from the PROPOSAL, not inferred from the
 * number. A person can hold approver roles in two orgs; the question is never
 * "which org is this number in", it is "may this person approve THIS payment".
 */
export async function resolveApproverByNumber(
  rawNumber: string,
  orgId: string,
): Promise<ResolvedApprover> {
  const e164 = normaliseE164(rawNumber);
  if (!e164) return { ok: false, reason: 'not a valid E.164 number' };
  if (!process.env.DATABASE_URL) return { ok: false, reason: 'no database configured' };

  const { getDb } = await import('@/lib/db/client');
  const db = getDb();

  const rows = await db
    .select({
      userId: users.id,
      email: users.email,
      name: users.name,
      role: memberships.role,
      verifiedAt: approverChannels.verifiedAt,
    })
    .from(approverChannels)
    .innerJoin(users, eq(users.id, approverChannels.userId))
    .innerJoin(
      memberships,
      and(eq(memberships.userId, users.id), eq(memberships.orgId, orgId)),
    )
    .where(and(eq(approverChannels.whatsappE164, e164), eq(approverChannels.orgId, orgId)))
    .limit(1);

  const row = rows[0];
  if (!row) return { ok: false, reason: 'number is not registered to an approver in this org' };
  if (!row.verifiedAt) return { ok: false, reason: 'number has not been verified' };

  // Re-checked NOW, not at send time. A role revoked between the request going
  // out and the reply coming back must not still be able to release money.
  if (!(APPROVING_ROLES as readonly string[]).includes(row.role)) {
    return { ok: false, reason: `role ${row.role} may not approve` };
  }

  return {
    ok: true,
    orgId,
    approver: {
      userId: row.userId,
      email: row.email,
      name: row.name,
      role: row.role as MembershipRole,
      whatsappE164: e164,
    },
  };
}
