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

import { partnerDepositAddresses, payoutPartnerEvents, withdrawalDestinations, withdrawalEvents, withdrawals } from '../db/schema.ts';
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

export async function listWithdrawalRows(db: DrizzleDb, orgId: string): Promise<WithdrawalRow[]> {
  return db.select().from(withdrawals).where(eq(withdrawals.orgId, orgId)).orderBy(desc(withdrawals.createdAt));
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

/** Give an event back (it could not be acted on yet, so the partner's retry must count). */
export async function releasePartnerEvent(db: DrizzleDb, partner: string, eventId: string): Promise<void> {
  await db.delete(payoutPartnerEvents).where(and(eq(payoutPartnerEvents.partner, partner), eq(payoutPartnerEvents.eventId, eventId)));
}
