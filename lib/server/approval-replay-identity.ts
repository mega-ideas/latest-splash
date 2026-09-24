/**
 * Who a replayed payment runs as: the approval, never a person's cookie.
 *
 * ─── The gap this closes ────────────────────────────────────────────────────
 *
 * Carrying out an approved payment replays the real authorize route
 * in-process (approval-replay.ts). The route asked `requireCustomerRequest`
 * who was calling, and that reads the session through `cookies()` — which
 * answers from the INCOMING request's scope, not from the Request object the
 * replay built. So the cookie the replay forwarded was decorative:
 *
 *   in-app and code approval — the replay ran as the approver's own ambient
 *     session, so the payment was attributed to whoever approved last;
 *   WhatsApp reply — a webhook has no session at all. Every replay answered
 *     401 and every reply-approved payment was recorded FAILED.
 *
 * ─── What replaces it ───────────────────────────────────────────────────────
 *
 * When the executor replays a proposal it binds an identity to the exact
 * Request object it constructs — the proposal, its org, its maker and the
 * approvers whose signatures it carries — and the route looks the identity up
 * by that object.
 *
 * Nothing a client sends can produce one. There is no header, cookie or body
 * field to forge: the binding lives in a process-local WeakMap keyed by object
 * identity, and a request that arrived over HTTP is a different object that
 * was never registered.
 *
 * And the identity is a claim the route re-verifies, not a credential it
 * trusts. `checkReplayParticipants` re-reads the membership table (the maker
 * is still a member, every approver still holds an approving role, both in
 * THIS org), and `resolveApprovalClaim` re-reads the proposal and binds it to
 * the payment in the body before anything moves.
 */
import 'server-only';

import { and, eq, inArray } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';

import type { ProposalKind, UnsignedProposal } from '@/lib/agent/types';
import { memberships } from '@/lib/db/schema';
import type * as schemaModule from '@/lib/db/schema';
import { canApprove, isMembershipRole } from '@/lib/membership-roles';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DrizzleDb = PgDatabase<any, typeof schemaModule, any>;

/** The proposal kinds that are carried out by replaying a money route. */
export type ReplayKind = Extract<ProposalKind, 'PAYMENT' | 'BATCH_PAYOUT'>;

/** How the final approval arrived. Recorded with the replay; it grants
 *  nothing, and no check reads it. */
export type ReplayChannel = 'in-app' | 'code' | 'whatsapp';

export type ApprovalReplayIdentity = Readonly<{
  proposalId: string;
  /** From the proposal: the one record that says whose money this is. */
  orgId: string;
  kind: ReplayKind;
  /** `createdBy` on the proposal — the session identity that proposed it. */
  makerUserId: string;
  /** The distinct approvers whose signatures the proposal carried when the
   *  replay was issued. The maker is never among them. */
  approverUserIds: readonly string[];
  channel: ReplayChannel;
}>;

/**
 * globalThis-anchored like every other store here: route handlers can get
 * separate module instances, and the route that looks an identity up must see
 * the registry the replay wrote to.
 */
type RegistryGlobal = typeof globalThis & {
  splashApprovalReplays?: WeakMap<Request, ApprovalReplayIdentity>;
};

function registry(): WeakMap<Request, ApprovalReplayIdentity> {
  const holder = globalThis as RegistryGlobal;
  holder.splashApprovalReplays ??= new WeakMap();
  return holder.splashApprovalReplays;
}

/**
 * Bind an identity to the Request the replay is about to hand to a route.
 * Returns the same request, so the call reads as construction.
 */
export function issueApprovalReplay(request: Request, identity: ApprovalReplayIdentity): Request {
  registry().set(
    request,
    Object.freeze({ ...identity, approverUserIds: Object.freeze([...identity.approverUserIds]) }),
  );
  return request;
}

/** The identity bound to this exact request object, or null — which is the
 *  answer for every request that arrived over HTTP. */
export function approvalReplayOf(request: Request): ApprovalReplayIdentity | null {
  return registry().get(request) ?? null;
}

/**
 * The identity a proposal replays as, derived from the proposal record at the
 * moment it is carried out — never from a request.
 */
export function replayIdentityFromProposal(
  proposal: UnsignedProposal,
  channel: ReplayChannel,
): ApprovalReplayIdentity {
  if (proposal.kind !== 'PAYMENT' && proposal.kind !== 'BATCH_PAYOUT') {
    throw new Error(`${proposal.kind} proposals are not carried out by replaying a money route`);
  }
  const approverUserIds = [...new Set(proposal.approvals.map((approval) => approval.userId))]
    .filter((userId) => userId !== proposal.createdBy)
    .sort();
  return {
    proposalId: proposal.id,
    orgId: proposal.orgId,
    kind: proposal.kind,
    makerUserId: proposal.createdBy,
    approverUserIds,
    channel,
  };
}

export type ParticipantVerdict = { ok: true } | { ok: false; reason: string };

/**
 * The replay's equivalent of "this session has a membership".
 *
 * Re-read NOW, from the membership table, scoped to the proposal's org:
 *
 *   the maker must still be a member — a session whose membership was revoked
 *   cannot pay, and a payment it proposed before the revocation does not go
 *   out afterwards on the strength of other people's signatures;
 *
 *   every approver must still hold an approving role — a role revoked between
 *   signing and the last signature must not still count toward releasing
 *   money. A reply is checked when it arrives; the earlier signatures on the
 *   same proposal are checked here.
 */
export async function checkReplayParticipants(
  db: DrizzleDb,
  identity: ApprovalReplayIdentity,
): Promise<ParticipantVerdict> {
  if (identity.approverUserIds.length === 0) {
    return { ok: false, reason: 'no approver signed this payment' };
  }
  if (identity.approverUserIds.includes(identity.makerUserId)) {
    return { ok: false, reason: 'the maker cannot approve their own payment' };
  }

  const rows = await db
    .select({ userId: memberships.userId, role: memberships.role })
    .from(memberships)
    .where(
      and(
        eq(memberships.orgId, identity.orgId),
        inArray(memberships.userId, [identity.makerUserId, ...identity.approverUserIds]),
      ),
    );
  const roleOf = new Map(rows.map((row) => [row.userId, row.role]));

  if (!roleOf.has(identity.makerUserId)) {
    return { ok: false, reason: 'the person who proposed this payment is no longer a member of this workspace' };
  }
  for (const userId of identity.approverUserIds) {
    const role = roleOf.get(userId);
    if (!isMembershipRole(role) || !canApprove(role)) {
      return { ok: false, reason: 'an approver no longer holds an approving role in this workspace' };
    }
  }
  return { ok: true };
}
