/**
 * Who started a payment, who approved it, who declined it (v2 Phase 3, Sky's rule).
 *
 * The audit proof for a payment is the Seal-encrypted record on Walrus and the
 * Sui anchor that points at it. It must ALWAYS say who started the payment, who
 * approved it, who declined, the times and the rule, even when the business or
 * the person has switched name sharing off: those switches change only what an
 * exchange is told and what the confirmation shows (lib/server/exchange-names.ts),
 * and nothing in this file reads them.
 *
 *   at the start   the payment's own record carries a `trail` (lib/server/
 *                  payment-record.ts): the person who started it, their role,
 *                  the time, the route, the rule, and the owners who could
 *                  approve it. `buildPaymentTrail` makes it.
 *   afterwards     each signature, decline or answer to an ask is a decision.
 *                  `recordPaymentDecision` writes a row (internal ids, a time
 *                  and hashes, no name) and seals one more record, bound to
 *                  the payment's own record by its hash. If the services that
 *                  seal are down, the decision is still on record and the row
 *                  waits unsealed; `sealPendingDecisions` seals it later. A
 *                  decision is never stopped by a sealing failure.
 *
 * Names are inside the encrypted records only. Nothing stored in plain text
 * (these rows, the payment's record hash and blob id) or anchored on chain holds
 * one. SECURITY.md (A-13): one operator key can decrypt every sealed blob, so a
 * name inside an evidence record is only as private as that key policy.
 *
 * Every read and write names the business. A payment, a request or an ask of
 * another business reads as absent, and a person who is not a member of the
 * business is never recorded as having decided in it.
 */
import { randomUUID } from 'node:crypto';

import { and, asc, eq, isNull } from 'drizzle-orm';

import { memberships, paymentTrailEvents, walletApprovalAsks, walletTransfers } from '../db/schema.ts';
import type { StaffRuleFacts } from '../transfer/plan.ts';
import type { PaymentTrail, RecordSealer } from './payment-record.ts';
import { declineSnapshot, type DrizzleDb } from './wallet-signing-store.ts';
import { memberRole } from './wallet-authority.ts';

export type DecisionKind = 'signed' | 'declined' | 'ask_accepted' | 'ask_declined';
export type TrailRole = 'owner' | 'approver' | 'staff' | 'viewer';

const ROLE: Record<string, TrailRole> = { admin: 'owner', checker: 'approver', maker: 'staff', viewer: 'viewer' };
const ACTOR_ROLE: Record<string, PaymentTrail['startedBy']['role']> = { OWNER: 'owner', APPROVER: 'approver', MAKER: 'staff' };

const orNull = (v: string | null | undefined) => (v && v.trim() ? v : null);

/**
 * The trail for a payment that is being built: from what the server holds (the person, their role and their name and title as they are
 * now, the route, the rule the chain showed, the owners who can approve), never from the request.
 */
export async function buildPaymentTrail(
  db: DrizzleDb,
  input: {
    orgId: string;
    actor: { userId: string; role: string };
    route: PaymentTrail['route'];
    rule: StaffRuleFacts | null;
    spender: string | null;
    at: Date;
  },
): Promise<PaymentTrail> {
  const who = await declineSnapshot(db, input.orgId, input.actor.userId);
  const owners = await db
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(and(eq(memberships.orgId, input.orgId), eq(memberships.role, 'admin')));
  return {
    startedBy: { userId: input.actor.userId, role: ACTOR_ROLE[input.actor.role] ?? 'staff', name: orNull(who.name), title: orNull(who.title) },
    startedAt: input.at.toISOString(),
    route: input.route,
    rule: input.rule
      ? {
          spender: input.spender,
          status: input.rule.status,
          perPaymentMaxMinor: input.rule.perPaymentMaxMinor,
          spendableNowMinor: input.rule.spendableNowMinor,
          startsAtMs: input.rule.startsAtMs ?? null,
          expiresAtMs: input.rule.expiresAtMs ?? null,
        }
      : null,
    mayApprove: owners.map((o: { userId: string }) => o.userId).sort(),
  };
}

export type DecisionInput = { orgId: string; signingRequestId?: string; askId?: string; userId: string; kind: DecisionKind; at?: Date };
export type DecisionDeps = { db: DrizzleDb; seal?: RecordSealer | null; now?: () => Date };

export type TrailRow = typeof paymentTrailEvents.$inferSelect;

/** The payment this signing request or ask belongs to, for this business only. */
async function transferOf(db: DrizzleDb, input: Pick<DecisionInput, 'orgId' | 'signingRequestId' | 'askId'>): Promise<{ id: string; recordHash: string | null } | null> {
  const pick = { id: walletTransfers.id, recordHash: walletTransfers.recordHash };
  if (input.signingRequestId) {
    const [byRequest] = await db.select(pick).from(walletTransfers).where(and(eq(walletTransfers.orgId, input.orgId), eq(walletTransfers.signingRequestId, input.signingRequestId))).limit(1);
    if (byRequest) return byRequest;
    // A payment the owners were asked to approve: its request belongs to the ask they accepted.
    const [ask] = await db.select({ id: walletApprovalAsks.id }).from(walletApprovalAsks).where(and(eq(walletApprovalAsks.orgId, input.orgId), eq(walletApprovalAsks.signingRequestId, input.signingRequestId))).limit(1);
    if (!ask) return null;
    const [viaAsk] = await db.select(pick).from(walletTransfers).where(and(eq(walletTransfers.orgId, input.orgId), eq(walletTransfers.askId, ask.id))).limit(1);
    return viaAsk ?? null;
  }
  if (input.askId) {
    const [viaAsk] = await db.select(pick).from(walletTransfers).where(and(eq(walletTransfers.orgId, input.orgId), eq(walletTransfers.askId, input.askId))).limit(1);
    return viaAsk ?? null;
  }
  return null;
}

/** The plain decision record. Keys in a fixed order; names are here, inside the encrypted record, and nowhere stored in plain text. */
async function plainDecision(db: DrizzleDb, row: Pick<TrailRow, 'orgId' | 'transferId' | 'baseHash' | 'kind' | 'userId' | 'role' | 'decidedAt'>): Promise<string> {
  const who = await declineSnapshot(db, row.orgId, row.userId);
  return JSON.stringify({
    schema: 'splash.payment-decision.v1',
    org: row.orgId,
    transfer: row.transferId,
    base: row.baseHash,
    event: row.kind,
    by: { userId: row.userId, role: row.role, name: orNull(who.name), title: orNull(who.title) },
    at: row.decidedAt.toISOString(),
  });
}

async function seal(deps: Required<Pick<DecisionDeps, 'db' | 'seal'>>, row: TrailRow, now: Date): Promise<boolean> {
  try {
    const sealed = await (deps.seal as RecordSealer)(await plainDecision(deps.db, row), row.orgId);
    if (!sealed.ok) return false;
    const done = await deps.db
      .update(paymentTrailEvents)
      .set({ contentHash: Buffer.from(sealed.contentHash).toString('hex'), walrusBlobId: Buffer.from(new TextEncoder().encode(sealed.blobId)).toString('hex'), sealedAt: now })
      .where(and(eq(paymentTrailEvents.id, row.id), isNull(paymentTrailEvents.contentHash)))
      .returning({ id: paymentTrailEvents.id });
    return done.length === 1;
  } catch {
    return false;
  }
}

/**
 * Record one decision. Idempotent: the same person and kind on the same payment is one row. The decision is on record before anything is
 * sealed, and a failure to seal leaves it on record, unsealed, for `sealPendingDecisions`. Absent for anything that is not a wallet
 * payment of this business, and for a person who is not a member of it.
 */
export async function recordPaymentDecision(
  deps: DecisionDeps,
  input: DecisionInput,
): Promise<{ ok: true; recorded: boolean; sealed: boolean } | { ok: false; code: 'not_found' | 'not_a_member' }> {
  const now = (deps.now ?? (() => new Date()))();
  const transfer = await transferOf(deps.db, input);
  if (!transfer) return { ok: false, code: 'not_found' };
  const role = ROLE[(await memberRole(deps.db, input.orgId, input.userId)) ?? ''];
  if (!role) return { ok: false, code: 'not_a_member' };
  const [row] = await deps.db
    .insert(paymentTrailEvents)
    .values({
      id: `pte_${randomUUID()}`,
      orgId: input.orgId,
      transferId: transfer.id,
      signingRequestId: input.signingRequestId ?? null,
      askId: input.askId ?? null,
      userId: input.userId,
      role,
      kind: input.kind,
      decidedAt: input.at ?? now,
      baseHash: transfer.recordHash,
    })
    .onConflictDoNothing()
    .returning();
  if (!row) {
    // Already on record (a replay): nothing is written again, and it is said whether that record has been sealed.
    const [kept] = await deps.db
      .select({ contentHash: paymentTrailEvents.contentHash })
      .from(paymentTrailEvents)
      .where(and(eq(paymentTrailEvents.transferId, transfer.id), eq(paymentTrailEvents.userId, input.userId), eq(paymentTrailEvents.kind, input.kind)))
      .limit(1);
    return { ok: true, recorded: false, sealed: kept?.contentHash != null };
  }
  const sealed = deps.seal ? await seal({ db: deps.db, seal: deps.seal }, row, now) : false;
  return { ok: true, recorded: true, sealed };
}

/** The decisions recorded for one payment of this business, in the order they were made. */
export async function decisionsOf(db: DrizzleDb, orgId: string, transferId: string): Promise<TrailRow[]> {
  return db
    .select()
    .from(paymentTrailEvents)
    .where(and(eq(paymentTrailEvents.orgId, orgId), eq(paymentTrailEvents.transferId, transferId)))
    .orderBy(asc(paymentTrailEvents.decidedAt), asc(paymentTrailEvents.createdAt));
}

/** Seal the decisions that were recorded while sealing was unavailable (run by the cron, across businesses; each is sealed for its own). */
export async function sealPendingDecisions(deps: Required<Pick<DecisionDeps, 'db' | 'seal'>> & Pick<DecisionDeps, 'now'>, limit = 50): Promise<{ sealed: number; failed: number }> {
  const now = (deps.now ?? (() => new Date()))();
  const waiting = await deps.db.select().from(paymentTrailEvents).where(isNull(paymentTrailEvents.contentHash)).orderBy(asc(paymentTrailEvents.createdAt)).limit(limit);
  const tally = { sealed: 0, failed: 0 };
  for (const row of waiting as TrailRow[]) {
    if (await seal(deps, row, now)) tally.sealed += 1;
    else tally.failed += 1;
  }
  return tally;
}
