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
 *   recovery       the signature, the decline or the owner's answer is saved
 *                  FIRST, and the call that records it here can fail (a
 *                  database fault, a timeout) and is swallowed so it never
 *                  stops the decision. `sweepPaymentTrail` (run by the cron)
 *                  therefore derives any decision row that is missing from what
 *                  the signing layer and the asks already hold (a signer's
 *                  signed_at or declined_at; an owner's answer to an ask), with
 *                  the time it was made, then seals what is waiting. It makes
 *                  each row once (the unique index), for a payment whose own
 *                  record carries a trail, in its own business only.
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

import { and, asc, eq, inArray, isNotNull, isNull, notExists } from 'drizzle-orm';

import { memberships, paymentTrailEvents, users, walletApprovalAsks, walletSigningSigners, walletTransfers } from '../db/schema.ts';
import type { StaffRuleFacts } from '../transfer/plan.ts';
import type { PaymentTrail, RecordSealer } from './payment-record.ts';
import type { DrizzleDb } from './wallet-signing-store.ts';
import { memberRole } from './wallet-authority.ts';

export type DecisionKind = 'signed' | 'declined' | 'ask_accepted' | 'ask_declined';
export type TrailRole = 'owner' | 'approver' | 'staff' | 'viewer';

const ROLE: Record<string, TrailRole> = { admin: 'owner', checker: 'approver', maker: 'staff', viewer: 'viewer' };
const ACTOR_ROLE: Record<string, PaymentTrail['startedBy']['role']> = { OWNER: 'owner', APPROVER: 'approver', MAKER: 'staff' };

const orNull = (v: string | null | undefined) => (v && v.trim() ? v : null);

/**
 * A person's name and job title exactly as they are stored. The sealed record is encrypted evidence, not a screen: it keeps what was stored
 * (a digit, a symbol or an emoji in a name stays), whereas the display cleaning of lib/team/declined-by.ts belongs on screens. The user id is
 * kept beside it, so the person is identified whatever their name was. Null when nothing is stored.
 */
export async function rawPerson(db: Pick<DrizzleDb, 'select'>, orgId: string, userId: string): Promise<{ name: string | null; title: string | null }> {
  const [row] = await db
    .select({ name: users.name, title: memberships.title })
    .from(users)
    .leftJoin(memberships, and(eq(memberships.userId, users.id), eq(memberships.orgId, orgId)))
    .where(eq(users.id, userId))
    .limit(1);
  return { name: orNull(row?.name), title: orNull(row?.title) };
}

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
  const who = await rawPerson(db, input.orgId, input.actor.userId);
  const owners = await db
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(and(eq(memberships.orgId, input.orgId), eq(memberships.role, 'admin')));
  return {
    startedBy: { userId: input.actor.userId, role: ACTOR_ROLE[input.actor.role] ?? 'staff', name: who.name, title: who.title },
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

/**
 * The plain decision record. Keys in a fixed order; names are here, inside the encrypted record, and nowhere stored in plain text. The
 * name and title are read when the record is sealed: normally the moment of the decision, later only if sealing had to wait for the
 * services, and then the person's id (always in the record) is what identifies them, whatever they were called by then.
 */
async function plainDecision(db: DrizzleDb, row: Pick<TrailRow, 'orgId' | 'transferId' | 'baseHash' | 'kind' | 'userId' | 'role' | 'decidedAt'>): Promise<string> {
  const who = await rawPerson(db, row.orgId, row.userId);
  return JSON.stringify({
    schema: 'splash.payment-decision.v1',
    org: row.orgId,
    transfer: row.transferId,
    base: row.baseHash,
    event: row.kind,
    by: { userId: row.userId, role: row.role, name: who.name, title: who.title },
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

type Missing = { orgId: string; transferId: string; userId: string; kind: DecisionKind; at: Date; signingRequestId: string | null; askId: string | null };

/**
 * Decisions that happened but are not on record: every signature and decline of a payment's signing request, and every owner's answer to
 * an ask, for a payment whose own record carries a trail (it has a record hash), that has no row yet. Read straight from the signing layer
 * and the asks, per business (a signer's row joins only the payment of its own business). An ask is an answer only when it is declined, or
 * accepted with its signing request opened: a claim still being made is not one.
 */
async function missingDecisions(db: DrizzleDb, limit: number): Promise<Missing[]> {
  const out: Missing[] = [];
  const noRow = (kind: DecisionKind, userId: unknown) =>
    notExists(
      db
        .select({ id: paymentTrailEvents.id })
        .from(paymentTrailEvents)
        .where(and(eq(paymentTrailEvents.transferId, walletTransfers.id), eq(paymentTrailEvents.userId, userId as never), eq(paymentTrailEvents.kind, kind))),
    );
  for (const kind of ['signed', 'declined'] as const) {
    const when = kind === 'signed' ? walletSigningSigners.signedAt : walletSigningSigners.declinedAt;
    const rows = await db
      .select({ orgId: walletSigningSigners.orgId, requestId: walletSigningSigners.requestId, userId: walletSigningSigners.userId, at: when, transferId: walletTransfers.id })
      .from(walletSigningSigners)
      .innerJoin(walletTransfers, and(eq(walletTransfers.orgId, walletSigningSigners.orgId), eq(walletTransfers.signingRequestId, walletSigningSigners.requestId)))
      .where(and(isNotNull(when), isNotNull(walletTransfers.recordHash), noRow(kind, walletSigningSigners.userId)))
      .orderBy(asc(when))
      .limit(limit);
    for (const r of rows as Array<{ orgId: string; requestId: string; userId: string; at: Date | null; transferId: string }>) {
      if (r.at) out.push({ orgId: r.orgId, transferId: r.transferId, userId: r.userId, kind, at: r.at, signingRequestId: r.requestId, askId: null });
    }
  }
  for (const kind of ['ask_declined', 'ask_accepted'] as const) {
    const answered = kind === 'ask_declined' ? eq(walletApprovalAsks.status, 'declined') : and(inArray(walletApprovalAsks.status, ['signing', 'approved']), isNotNull(walletApprovalAsks.signingRequestId));
    const rows = await db
      .select({ orgId: walletApprovalAsks.orgId, askId: walletApprovalAsks.id, userId: walletApprovalAsks.decidedBy, at: walletApprovalAsks.decidedAt, transferId: walletTransfers.id })
      .from(walletApprovalAsks)
      .innerJoin(walletTransfers, and(eq(walletTransfers.orgId, walletApprovalAsks.orgId), eq(walletTransfers.askId, walletApprovalAsks.id)))
      .where(and(answered, isNotNull(walletApprovalAsks.decidedBy), isNotNull(walletApprovalAsks.decidedAt), isNotNull(walletTransfers.recordHash), noRow(kind, walletApprovalAsks.decidedBy)))
      .orderBy(asc(walletApprovalAsks.decidedAt))
      .limit(limit);
    for (const r of rows as Array<{ orgId: string; askId: string; userId: string | null; at: Date | null; transferId: string }>) {
      if (r.userId && r.at) out.push({ orgId: r.orgId, transferId: r.transferId, userId: r.userId, kind, at: r.at, signingRequestId: null, askId: r.askId });
    }
  }
  return out;
}

/**
 * Write the decision rows that are missing (see `missingDecisions`), each with the time it was made and bound to the payment's own record.
 * A person who is no longer a member of the business has no role to record, and none is invented: it is counted as skipped.
 */
export async function recoverMissingDecisions(deps: Pick<DecisionDeps, 'db'>, limit = 100): Promise<{ derived: number; skipped: number }> {
  const tally = { derived: 0, skipped: 0 };
  for (const m of await missingDecisions(deps.db, limit)) {
    const role = ROLE[(await memberRole(deps.db, m.orgId, m.userId)) ?? ''];
    if (!role) {
      tally.skipped += 1;
      continue;
    }
    const [transfer] = await deps.db.select({ recordHash: walletTransfers.recordHash }).from(walletTransfers).where(and(eq(walletTransfers.orgId, m.orgId), eq(walletTransfers.id, m.transferId))).limit(1);
    const made = await deps.db
      .insert(paymentTrailEvents)
      .values({
        id: `pte_${randomUUID()}`,
        orgId: m.orgId,
        transferId: m.transferId,
        signingRequestId: m.signingRequestId,
        askId: m.askId,
        userId: m.userId,
        role,
        kind: m.kind,
        decidedAt: m.at,
        baseHash: transfer?.recordHash ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: paymentTrailEvents.id });
    tally.derived += made.length;
  }
  return tally;
}

/**
 * The cron's pass over the audit trail: bring back any decision whose write failed, then seal everything that is waiting. Neither step
 * throws for a bad row; a failure to seal leaves the row on record for the next run.
 */
export async function sweepPaymentTrail(deps: Required<Pick<DecisionDeps, 'db' | 'seal'>> & Pick<DecisionDeps, 'now'>, limit = 50): Promise<{ derived: number; skipped: number; sealed: number; failed: number }> {
  const recovered = await recoverMissingDecisions(deps, limit * 2);
  const sealed = await sealPendingDecisions(deps, limit);
  return { ...recovered, ...sealed };
}
