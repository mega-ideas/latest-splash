/**
 * Postgres for withdrawals to the business's own bank (v2 §4.4, migration 0040).
 *
 * Every read and write takes the org: a row of another org reads as absent
 * (WS2). The lookups a partner webhook needs before it knows whose payout it
 * is (`withdrawalForWebhook`, `depositAddressForWebhook`, the event ledger)
 * return the row's own org for the caller to act within.
 */
import { randomUUID } from 'node:crypto';

import { and, desc, eq, inArray, sql } from 'drizzle-orm';

import { partnerDepositAddresses, payoutPartnerEvents, payoutPartnerUnknownEvents, walletDepositSync, withdrawalDestinations, withdrawalEvents, withdrawalReturns, withdrawals } from '../db/schema.ts';
import type { WithdrawalStatus } from '../payouts/withdrawal-rules.ts';
import type { DrizzleDb } from './wallet-signing-store.ts';

export type DestinationRow = typeof withdrawalDestinations.$inferSelect;
export type DepositAddressRow = typeof partnerDepositAddresses.$inferSelect;
export type WithdrawalRow = typeof withdrawals.$inferSelect;
export type WithdrawalInsert = typeof withdrawals.$inferInsert;
export type DepositAddressStatus = 'pending_test' | 'test_requested' | 'test_sent' | 'verified' | 'revoked';

// ─── Destinations ───────────────────────────────────────────────────────────

export async function listDestinations(db: DrizzleDb, orgId: string): Promise<DestinationRow[]> {
  return db.select().from(withdrawalDestinations).where(eq(withdrawalDestinations.orgId, orgId)).orderBy(desc(withdrawalDestinations.createdAt));
}

export async function getDestination(db: DrizzleDb, orgId: string, id: string): Promise<DestinationRow | null> {
  const [row] = await db.select().from(withdrawalDestinations).where(and(eq(withdrawalDestinations.orgId, orgId), eq(withdrawalDestinations.id, id))).limit(1);
  return row ?? null;
}

export async function liveDestinationByFingerprint(db: DrizzleDb, orgId: string, partner: string, fingerprints: string[]): Promise<DestinationRow | null> {
  if (fingerprints.length === 0) return null;
  const [row] = await db
    .select()
    .from(withdrawalDestinations)
    .where(and(eq(withdrawalDestinations.orgId, orgId), eq(withdrawalDestinations.partner, partner), inArray(withdrawalDestinations.fingerprint, fingerprints), eq(withdrawalDestinations.status, 'verified')))
    .limit(1);
  return row ?? null;
}

/** Insert once per live account; the live row when it is already there. */
export async function insertDestination(db: DrizzleDb, row: typeof withdrawalDestinations.$inferInsert): Promise<{ row: DestinationRow; created: boolean }> {
  const [inserted] = await db.insert(withdrawalDestinations).values(row).onConflictDoNothing().returning();
  if (inserted) return { row: inserted, created: true };
  const existing = await liveDestinationByFingerprint(db, row.orgId, row.partner, [row.fingerprint]);
  if (!existing) throw new Error('the withdrawal destination could not be stored');
  return { row: existing, created: false };
}

export async function revokeDestination(db: DrizzleDb, orgId: string, id: string, at: Date): Promise<DestinationRow | null> {
  const [row] = await db
    .update(withdrawalDestinations)
    .set({ status: 'revoked', revokedAt: at, updatedAt: at })
    .where(and(eq(withdrawalDestinations.orgId, orgId), eq(withdrawalDestinations.id, id), eq(withdrawalDestinations.status, 'verified')))
    .returning();
  return row ?? null;
}

/** Seal a destination's fields again (a key rotation). */
export async function resealDestination(db: DrizzleDb, orgId: string, id: string, set: { accountSealed: string; beneficiarySaltSealed: string; updatedAt: Date }): Promise<void> {
  await db.update(withdrawalDestinations).set(set).where(and(eq(withdrawalDestinations.orgId, orgId), eq(withdrawalDestinations.id, id)));
}

/** Withdrawals of a destination that have not moved money yet. */
export async function inFlightWithdrawalsFor(db: DrizzleDb, orgId: string, destinationId: string): Promise<WithdrawalRow[]> {
  return db
    .select()
    .from(withdrawals)
    .where(and(eq(withdrawals.orgId, orgId), eq(withdrawals.destinationId, destinationId), inArray(withdrawals.status, ['preparing', 'awaiting_signatures'])));
}

// ─── Partner deposit addresses ──────────────────────────────────────────────

export async function liveDepositAddress(db: DrizzleDb, orgId: string, partner: string): Promise<DepositAddressRow | null> {
  const [row] = await db
    .select()
    .from(partnerDepositAddresses)
    .where(and(eq(partnerDepositAddresses.orgId, orgId), eq(partnerDepositAddresses.partner, partner), sql`${partnerDepositAddresses.status} <> 'revoked'`))
    .limit(1);
  return row ?? null;
}

export async function getDepositAddress(db: DrizzleDb, orgId: string, id: string): Promise<DepositAddressRow | null> {
  const [row] = await db.select().from(partnerDepositAddresses).where(and(eq(partnerDepositAddresses.orgId, orgId), eq(partnerDepositAddresses.id, id))).limit(1);
  return row ?? null;
}

/** Whether another business already holds this address with the partner (a partner must never give two businesses one address). */
export async function depositAddressHeldElsewhere(db: DrizzleDb, orgId: string, partner: string, address: string): Promise<boolean> {
  const rows = await db
    .select({ orgId: partnerDepositAddresses.orgId })
    .from(partnerDepositAddresses)
    .where(and(eq(partnerDepositAddresses.partner, partner), eq(partnerDepositAddresses.address, address), sql`${partnerDepositAddresses.status} <> 'revoked'`));
  return rows.some((r) => r.orgId !== orgId);
}

export async function insertDepositAddress(db: DrizzleDb, row: typeof partnerDepositAddresses.$inferInsert): Promise<{ row: DepositAddressRow; created: boolean }> {
  const [inserted] = await db.insert(partnerDepositAddresses).values(row).onConflictDoNothing().returning();
  if (inserted) return { row: inserted, created: true };
  const existing = await liveDepositAddress(db, row.orgId, row.partner);
  if (!existing) throw new Error('the deposit address could not be stored');
  return { row: existing, created: false };
}

/** Move a deposit address on, only from one of `from` (compare-and-set). */
export async function moveDepositAddress(
  db: DrizzleDb,
  orgId: string,
  id: string,
  from: DepositAddressStatus[],
  set: Partial<typeof partnerDepositAddresses.$inferInsert> & { status: DepositAddressStatus; updatedAt: Date },
): Promise<DepositAddressRow | null> {
  const [row] = await db
    .update(partnerDepositAddresses)
    .set(set)
    .where(and(eq(partnerDepositAddresses.orgId, orgId), eq(partnerDepositAddresses.id, id), inArray(partnerDepositAddresses.status, from)))
    .returning();
  return row ?? null;
}

export async function depositAddressByTestRequest(db: DrizzleDb, orgId: string, requestId: string): Promise<DepositAddressRow | null> {
  const [row] = await db
    .select()
    .from(partnerDepositAddresses)
    .where(and(eq(partnerDepositAddresses.orgId, orgId), eq(partnerDepositAddresses.testRequestId, requestId)))
    .limit(1);
  return row ?? null;
}

/**
 * Every partner deposit address this business holds that is not revoked,
 * verified or still waiting for its test deposit. Money to any of them goes
 * only through the withdrawal or supplier payout route (the instruction to
 * the partner first, v2 §4.4/§4.5), never as a plain wallet payment.
 */
export async function partnerDepositAddressesOf(db: DrizzleDb, orgId: string): Promise<string[]> {
  const rows = await db
    .select({ address: partnerDepositAddresses.address })
    .from(partnerDepositAddresses)
    .where(and(eq(partnerDepositAddresses.orgId, orgId), sql`${partnerDepositAddresses.status} <> 'revoked'`));
  return rows.map((r) => r.address);
}

/** This business's verified deposit address with each partner. */
export async function verifiedDepositAddressesByPartner(db: DrizzleDb, orgId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({ partner: partnerDepositAddresses.partner, address: partnerDepositAddresses.address })
    .from(partnerDepositAddresses)
    .where(and(eq(partnerDepositAddresses.orgId, orgId), eq(partnerDepositAddresses.status, 'verified')));
  return new Map(rows.map((r) => [r.partner, r.address]));
}

/** This business's partner deposit addresses that passed their test deposit. */
export async function verifiedDepositAddresses(db: DrizzleDb, orgId: string): Promise<string[]> {
  const rows = await db
    .select({ address: partnerDepositAddresses.address })
    .from(partnerDepositAddresses)
    .where(and(eq(partnerDepositAddresses.orgId, orgId), eq(partnerDepositAddresses.status, 'verified')));
  return rows.map((r) => r.address);
}

/**
 * Whether `address` is another business's wallet as Splash knows it (the
 * deposit watcher's wallets, and the wallets withdrawals were sent from).
 * A partner must never hand one business another's wallet as a deposit address.
 */
export async function isAnotherBusinessWallet(db: DrizzleDb, orgId: string, address: string): Promise<boolean> {
  const synced = await db.select({ orgId: walletDepositSync.orgId }).from(walletDepositSync).where(eq(walletDepositSync.walletAddress, address));
  if (synced.some((r) => r.orgId !== orgId)) return true;
  const sent = await db.select({ orgId: withdrawals.orgId }).from(withdrawals).where(eq(withdrawals.walletAddress, address));
  return sent.some((r) => r.orgId !== orgId);
}

/** For the sweep, across every org: test deposits whose signing request may have closed. */
export async function testRequestedDepositAddressesForStaff(db: DrizzleDb): Promise<DepositAddressRow[]> {
  return db.select().from(partnerDepositAddresses).where(eq(partnerDepositAddresses.status, 'test_requested'));
}

/** For a partner webhook: the live address the partner's account ref names, with its org. */
export async function depositAddressForWebhook(db: DrizzleDb, partner: string, accountRef: string): Promise<DepositAddressRow | null> {
  const [row] = await db
    .select()
    .from(partnerDepositAddresses)
    .where(and(eq(partnerDepositAddresses.partner, partner), eq(partnerDepositAddresses.accountRef, accountRef), sql`${partnerDepositAddresses.status} <> 'revoked'`))
    .limit(1);
  return row ?? null;
}

// ─── Withdrawals ────────────────────────────────────────────────────────────

/** A withdrawal to the business's own bank, or a payout to a supplier's bank (0042). */
export type PayoutRowKind = 'withdrawal' | 'supplier_payout';

export async function listWithdrawalRows(db: DrizzleDb, orgId: string, kind: PayoutRowKind = 'withdrawal'): Promise<WithdrawalRow[]> {
  return db.select().from(withdrawals).where(and(eq(withdrawals.orgId, orgId), eq(withdrawals.kind, kind))).orderBy(desc(withdrawals.createdAt));
}

export async function getWithdrawalRow(db: DrizzleDb, orgId: string, id: string): Promise<WithdrawalRow | null> {
  const [row] = await db.select().from(withdrawals).where(and(eq(withdrawals.orgId, orgId), eq(withdrawals.id, id))).limit(1);
  return row ?? null;
}

export async function withdrawalByClientKey(db: DrizzleDb, orgId: string, clientKey: string): Promise<WithdrawalRow | null> {
  const [row] = await db.select().from(withdrawals).where(and(eq(withdrawals.orgId, orgId), eq(withdrawals.clientKey, clientKey))).limit(1);
  return row ?? null;
}

export async function withdrawalBySigningRequest(db: DrizzleDb, orgId: string, requestId: string): Promise<WithdrawalRow | null> {
  const [row] = await db.select().from(withdrawals).where(and(eq(withdrawals.orgId, orgId), eq(withdrawals.signingRequestId, requestId))).limit(1);
  return row ?? null;
}

/** Insert once per client key; null when the key is already taken (the caller reads that row). */
export async function insertWithdrawal(db: DrizzleDb, row: typeof withdrawals.$inferInsert): Promise<WithdrawalRow | null> {
  const [inserted] = await db.insert(withdrawals).values(row).onConflictDoNothing().returning();
  return inserted ?? null;
}

/** Move a withdrawal on, only from one of `from` (compare-and-set). */
export async function moveWithdrawal(
  db: DrizzleDb,
  orgId: string,
  id: string,
  from: WithdrawalStatus[],
  set: Partial<typeof withdrawals.$inferInsert> & { status: WithdrawalStatus; updatedAt: Date },
): Promise<WithdrawalRow | null> {
  const [row] = await db
    .update(withdrawals)
    .set(set)
    .where(and(eq(withdrawals.orgId, orgId), eq(withdrawals.id, id), inArray(withdrawals.status, from)))
    .returning();
  return row ?? null;
}

/** Set fields without moving the status (a partner reference, a posted digest). */
export async function patchWithdrawal(db: DrizzleDb, orgId: string, id: string, set: Partial<typeof withdrawals.$inferInsert> & { updatedAt: Date }): Promise<WithdrawalRow | null> {
  const [row] = await db.update(withdrawals).set(set).where(and(eq(withdrawals.orgId, orgId), eq(withdrawals.id, id))).returning();
  return row ?? null;
}

/** For a partner webhook: the withdrawal its intent id names, with its org. */
export async function withdrawalForWebhook(db: DrizzleDb, partner: string, intentId: string): Promise<WithdrawalRow | null> {
  const [row] = await db.select().from(withdrawals).where(and(eq(withdrawals.partner, partner), eq(withdrawals.intentId, intentId))).limit(1);
  return row ?? null;
}

/** The withdrawal a return digest already closed, if any (one return, one withdrawal). */
export async function withdrawalByReturnDigest(db: DrizzleDb, digest: string): Promise<WithdrawalRow | null> {
  const [row] = await db.select().from(withdrawals).where(eq(withdrawals.returnDigest, digest)).limit(1);
  return row ?? null;
}

export type ReturnClaim = { digest: string; withdrawalId: string; orgId: string; creditedMinor: bigint; checkpoint: bigint; eventId: string; at: Date };

/**
 * Claim a return digest for one payout. `claimed` when this call took it;
 * otherwise the payout that holds it (this one, on a replay, or another).
 */
export async function claimReturn(db: DrizzleDb, c: ReturnClaim): Promise<{ claimed: true } | { claimed: false; heldBy: string }> {
  const [row] = await db
    .insert(withdrawalReturns)
    .values({ digest: c.digest, withdrawalId: c.withdrawalId, orgId: c.orgId, creditedMinor: c.creditedMinor, checkpoint: c.checkpoint, eventId: c.eventId, createdAt: c.at })
    .onConflictDoNothing()
    .returning();
  if (row) return { claimed: true };
  const [held] = await db.select({ withdrawalId: withdrawalReturns.withdrawalId }).from(withdrawalReturns).where(eq(withdrawalReturns.digest, c.digest)).limit(1);
  return { claimed: false, heldBy: held?.withdrawalId ?? '' };
}

/** Give a claim back (the sum would have passed what the payout sent). */
export async function releaseReturn(db: DrizzleDb, orgId: string, withdrawalId: string, digest: string): Promise<void> {
  await db.delete(withdrawalReturns).where(and(eq(withdrawalReturns.orgId, orgId), eq(withdrawalReturns.withdrawalId, withdrawalId), eq(withdrawalReturns.digest, digest)));
}

/** What every counted return of one payout put back in the wallet. */
export async function returnedTotal(db: DrizzleDb, orgId: string, withdrawalId: string): Promise<bigint> {
  const rows = await db
    .select({ credited: withdrawalReturns.creditedMinor })
    .from(withdrawalReturns)
    .where(and(eq(withdrawalReturns.orgId, orgId), eq(withdrawalReturns.withdrawalId, withdrawalId)));
  return rows.reduce((sum, r) => sum + r.credited, 0n);
}

/**
 * For the sweep, across every org: withdrawals waiting on their owners'
 * request, and withdrawals sent and not held, whose digest is still to be
 * posted or whose partner has not reported a final status yet.
 */
export async function withdrawalsToReconcileForStaff(db: DrizzleDb): Promise<WithdrawalRow[]> {
  return db
    .select()
    .from(withdrawals)
    .where(
      sql`(${withdrawals.status} = 'awaiting_signatures' and ${withdrawals.signingRequestId} is not null)
        or (${withdrawals.status} in ('sent', 'partner_received') and ${withdrawals.suiDigest} is not null and ${withdrawals.settlementHold} is null)`,
    );
}

/**
 * Failed payouts (withdrawals and supplier payouts, every org) whose USDC the
 * partner has not yet agreed to send back: the sweep asks again.
 */
export async function returnsOwedForStaff(db: DrizzleDb): Promise<WithdrawalRow[]> {
  return db
    .select()
    .from(withdrawals)
    .where(sql`${withdrawals.status} = 'failed' and ${withdrawals.returnAcceptedAt} is null and ${withdrawals.partnerRef} is not null`);
}

/** The bank's reference on a payout already paid out without one; a kept reference is never replaced. */
export async function patchBankRefIfMissing(db: DrizzleDb, orgId: string, id: string, bankRef: string, at: Date): Promise<WithdrawalRow | null> {
  const [row] = await db
    .update(withdrawals)
    .set({ bankRef, updatedAt: at })
    .where(and(eq(withdrawals.orgId, orgId), eq(withdrawals.id, id), eq(withdrawals.status, 'paid_out'), sql`${withdrawals.bankRef} is null`))
    .returning();
  return row ?? null;
}

/** One ask for a failed payout's USDC back: counted, and when accepted, the time kept. */
export async function recordReturnAsk(db: DrizzleDb, orgId: string, id: string, accepted: boolean, at: Date): Promise<WithdrawalRow | null> {
  const [row] = await db
    .update(withdrawals)
    .set({ returnAsks: sql`${withdrawals.returnAsks} + 1`, returnAskedAt: at, ...(accepted ? { returnAcceptedAt: at } : {}), updatedAt: at })
    .where(and(eq(withdrawals.orgId, orgId), eq(withdrawals.id, id)))
    .returning();
  return row ?? null;
}

/** Withdrawals sent whose digest the partner has not been told yet. */
export async function unpostedSettlements(db: DrizzleDb, orgId: string): Promise<WithdrawalRow[]> {
  return db
    .select()
    .from(withdrawals)
    .where(and(eq(withdrawals.orgId, orgId), inArray(withdrawals.status, ['sent', 'partner_received']), sql`${withdrawals.suiDigest} is not null`, sql`${withdrawals.settlementPostedAt} is null`));
}

// ─── The trail and the webhook ledger ───────────────────────────────────────

export async function recordWithdrawalEvent(
  db: DrizzleDb,
  e: { orgId: string; subject: 'destination' | 'deposit_address' | 'withdrawal'; subjectId: string | null; actor: string; action: string; detail?: Record<string, unknown>; at: Date },
): Promise<void> {
  await db.insert(withdrawalEvents).values({
    id: `wde_${randomUUID()}`,
    orgId: e.orgId,
    subject: e.subject,
    subjectId: e.subjectId,
    actor: e.actor,
    action: e.action,
    detail: e.detail ?? {},
    createdAt: e.at,
  });
}

export async function listWithdrawalEvents(db: DrizzleDb, orgId: string, subjectId?: string) {
  const where = [eq(withdrawalEvents.orgId, orgId)];
  if (subjectId) where.push(eq(withdrawalEvents.subjectId, subjectId));
  return db.select().from(withdrawalEvents).where(and(...where)).orderBy(withdrawalEvents.seq);
}

/** Count a partner event once. False when it was already counted. */
export async function claimPartnerEvent(db: DrizzleDb, e: { partner: string; eventId: string; orgId: string | null; subjectId: string | null; status: string; at: Date }): Promise<boolean> {
  const [row] = await db
    .insert(payoutPartnerEvents)
    .values({ partner: e.partner, eventId: e.eventId, orgId: e.orgId, subjectId: e.subjectId, status: e.status, receivedAt: e.at })
    .onConflictDoNothing()
    .returning();
  return Boolean(row);
}

/**
 * A signed event Splash does not know, kept for ops (one row per event,
 * however often it is delivered). Returns whether this is its first delivery.
 */
export async function recordUnknownPartnerEvent(db: DrizzleDb, e: { partner: string; eventKey: string; eventId: string | null; eventType: string; eventStatus: string; at: Date }): Promise<boolean> {
  const [row] = await db
    .insert(payoutPartnerUnknownEvents)
    .values({ partner: e.partner, eventKey: e.eventKey, eventId: e.eventId, eventType: e.eventType, eventStatus: e.eventStatus, deliveries: 1, firstReceivedAt: e.at, lastReceivedAt: e.at })
    .onConflictDoUpdate({ target: [payoutPartnerUnknownEvents.partner, payoutPartnerUnknownEvents.eventKey], set: { deliveries: sql`${payoutPartnerUnknownEvents.deliveries} + 1`, lastReceivedAt: e.at } })
    .returning();
  return (row?.deliveries ?? 0) === 1;
}

/** Give an event back (it could not be acted on yet, so the partner's retry must count). */
export async function releasePartnerEvent(db: DrizzleDb, partner: string, eventId: string): Promise<void> {
  await db.delete(payoutPartnerEvents).where(and(eq(payoutPartnerEvents.partner, partner), eq(payoutPartnerEvents.eventId, eventId)));
}
