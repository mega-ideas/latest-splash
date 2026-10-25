/**
 * Postgres for funding the Business Splash Wallet (v2 §4.3, migration 0038).
 *
 * Every read and write takes the org: a row of another org reads as absent
 * (WS2). The only lookups without an org are the two a partner webhook needs
 * before it knows whose order it is (`intentForWebhook`, the event ledger),
 * and both return the row's own org for the caller to act within.
 */
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';

import { fundingIntents, fundingProviderEvents, fundingSourceChallenges, fundingSources, walletDeposits } from '../db/schema.ts';
import type { DepositStatus, FundingChannel, FundingSourceKind, HoldReason, IntentStatus, SourceStatus } from '../funding/wallet-funding.ts';
import type { KytScreening } from '../compliance/kyt.ts';
import type { DrizzleDb } from './wallet-signing-store.ts';

export type SourceRow = typeof fundingSources.$inferSelect;
export type IntentRow = typeof fundingIntents.$inferSelect;
export type DepositRow = typeof walletDeposits.$inferSelect;
export type ChallengeRow = typeof fundingSourceChallenges.$inferSelect;

// ─── Sources ────────────────────────────────────────────────────────────────

export async function listSources(db: DrizzleDb, orgId: string): Promise<SourceRow[]> {
  return db.select().from(fundingSources).where(eq(fundingSources.orgId, orgId)).orderBy(desc(fundingSources.createdAt));
}

export async function getSource(db: DrizzleDb, orgId: string, id: string): Promise<SourceRow | null> {
  const [row] = await db.select().from(fundingSources).where(and(eq(fundingSources.orgId, orgId), eq(fundingSources.id, id))).limit(1);
  return row ?? null;
}

export async function sourceByFingerprint(db: DrizzleDb, orgId: string, kind: FundingSourceKind, fingerprint: string): Promise<SourceRow | null> {
  const [row] = await db
    .select()
    .from(fundingSources)
    .where(and(eq(fundingSources.orgId, orgId), eq(fundingSources.kind, kind), eq(fundingSources.fingerprint, fingerprint)))
    .limit(1);
  return row ?? null;
}

/** Insert a source once; the existing row when it is already there. */
export async function insertSource(db: DrizzleDb, row: typeof fundingSources.$inferInsert): Promise<{ row: SourceRow; created: boolean }> {
  const [inserted] = await db.insert(fundingSources).values(row).onConflictDoNothing().returning();
  if (inserted) return { row: inserted, created: true };
  const existing = await sourceByFingerprint(db, row.orgId, row.kind as FundingSourceKind, row.fingerprint);
  if (!existing) throw new Error('the funding source could not be stored');
  return { row: existing, created: false };
}

export async function updateSource(
  db: DrizzleDb,
  orgId: string,
  id: string,
  patch: Partial<typeof fundingSources.$inferInsert>,
  onlyFrom?: SourceStatus[],
): Promise<SourceRow | null> {
  const where = [eq(fundingSources.orgId, orgId), eq(fundingSources.id, id)];
  if (onlyFrom) where.push(inArray(fundingSources.status, onlyFrom));
  const [row] = await db.update(fundingSources).set({ ...patch, updatedAt: new Date() }).where(and(...where)).returning();
  return row ?? null;
}

/** Record a source's first-use check, once: a second call changes nothing. */
export async function recordFirstUse(
  db: DrizzleDb,
  orgId: string,
  id: string,
  input: { result: 'passed' | 'failed'; detail: string; at: Date; promote: boolean },
): Promise<SourceRow | null> {
  const [row] = await db
    .update(fundingSources)
    .set({
      firstUseAt: input.at,
      firstUseResult: input.result,
      firstUseDetail: input.detail,
      ...(input.promote ? { status: 'verified', method: 'first_use', verifiedAt: input.at } : {}),
      updatedAt: input.at,
    })
    .where(and(eq(fundingSources.orgId, orgId), eq(fundingSources.id, id), isNull(fundingSources.firstUseAt)))
    .returning();
  return row ?? (await getSource(db, orgId, id));
}

// ─── Wallet-ownership challenges ────────────────────────────────────────────

export async function insertChallenge(db: DrizzleDb, row: typeof fundingSourceChallenges.$inferInsert): Promise<ChallengeRow> {
  const [inserted] = await db.insert(fundingSourceChallenges).values(row).returning();
  return inserted;
}

/** Spend a challenge: true for exactly one caller, and only while it is unexpired. */
export async function useChallenge(db: DrizzleDb, input: { orgId: string; id: string; sourceId: string; now: Date }): Promise<ChallengeRow | null> {
  const [row] = await db
    .update(fundingSourceChallenges)
    .set({ usedAt: input.now })
    .where(
      and(
        eq(fundingSourceChallenges.orgId, input.orgId),
        eq(fundingSourceChallenges.id, input.id),
        eq(fundingSourceChallenges.sourceId, input.sourceId),
        isNull(fundingSourceChallenges.usedAt),
        sql`${fundingSourceChallenges.expiresAt} > ${input.now}`,
      ),
    )
    .returning();
  return row ?? null;
}

// ─── Intents ────────────────────────────────────────────────────────────────

export async function intentByClientKey(db: DrizzleDb, orgId: string, clientKey: string): Promise<IntentRow | null> {
  const [row] = await db.select().from(fundingIntents).where(and(eq(fundingIntents.orgId, orgId), eq(fundingIntents.clientKey, clientKey))).limit(1);
  return row ?? null;
}

/** Insert an intent once per client key; the existing one when the key was used. */
export async function insertIntent(db: DrizzleDb, row: typeof fundingIntents.$inferInsert): Promise<{ row: IntentRow; created: boolean }> {
  const [inserted] = await db.insert(fundingIntents).values(row).onConflictDoNothing().returning();
  if (inserted) return { row: inserted, created: true };
  const existing = await intentByClientKey(db, row.orgId, row.clientKey);
  if (!existing) throw new Error('the top-up could not be stored');
  return { row: existing, created: false };
}

export async function getIntent(db: DrizzleDb, orgId: string, id: string): Promise<IntentRow | null> {
  const [row] = await db.select().from(fundingIntents).where(and(eq(fundingIntents.orgId, orgId), eq(fundingIntents.id, id))).limit(1);
  return row ?? null;
}

export async function listIntents(db: DrizzleDb, orgId: string, limit = 50): Promise<IntentRow[]> {
  return db.select().from(fundingIntents).where(eq(fundingIntents.orgId, orgId)).orderBy(desc(fundingIntents.createdAt)).limit(limit);
}

/** A partner webhook names an intent id; this is the one lookup that returns another org's row, for its org to be acted within. */
export async function intentForWebhook(db: DrizzleDb, id: string): Promise<IntentRow | null> {
  const [row] = await db.select().from(fundingIntents).where(eq(fundingIntents.id, id)).limit(1);
  return row ?? null;
}

/**
 * Move an intent to `to` only from the statuses that may precede it, so a
 * late or replayed event cannot move it backwards.
 */
export async function advanceIntent(
  db: DrizzleDb,
  input: { orgId: string; id: string; from: IntentStatus[]; to: IntentStatus; patch?: Partial<typeof fundingIntents.$inferInsert>; now: Date },
): Promise<IntentRow | null> {
  if (input.from.length === 0) return null;
  const [row] = await db
    .update(fundingIntents)
    .set({ ...(input.patch ?? {}), status: input.to, updatedAt: input.now })
    .where(and(eq(fundingIntents.orgId, input.orgId), eq(fundingIntents.id, input.id), inArray(fundingIntents.status, input.from)))
    .returning();
  return row ?? null;
}

export async function patchIntent(db: DrizzleDb, orgId: string, id: string, patch: Partial<typeof fundingIntents.$inferInsert>): Promise<IntentRow | null> {
  const [row] = await db.update(fundingIntents).set({ ...patch, updatedAt: new Date() }).where(and(eq(fundingIntents.orgId, orgId), eq(fundingIntents.id, id))).returning();
  return row ?? null;
}

// ─── Deposits ───────────────────────────────────────────────────────────────

export type NewDeposit = {
  id: string;
  orgId: string;
  walletAddress: string;
  suiDigest: string;
  coinType: string;
  asset: 'USDC' | 'USDT' | 'USDSUI';
  amountMinor: bigint;
  channel: FundingChannel;
  intentId: string | null;
  sourceId: string | null;
  sender: string | null;
  originChain: string | null;
  originAddress: string | null;
  status: DepositStatus;
  holdReasons: HoldReason[];
  screening: KytScreening;
  firstUse: boolean;
  arrivedAt: Date | null;
};

/** Record a deposit once per (digest, wallet, coin type); the existing row on a repeat. */
export async function insertDeposit(db: DrizzleDb, row: NewDeposit): Promise<{ row: DepositRow; created: boolean }> {
  const [inserted] = await db.insert(walletDeposits).values(row).onConflictDoNothing().returning();
  if (inserted) return { row: inserted, created: true };
  const [existing] = await db
    .select()
    .from(walletDeposits)
    .where(and(eq(walletDeposits.suiDigest, row.suiDigest), eq(walletDeposits.walletAddress, row.walletAddress), eq(walletDeposits.coinType, row.coinType)))
    .limit(1);
  if (!existing) throw new Error('the deposit could not be stored');
  if (existing.orgId !== row.orgId) throw new Error('that deposit belongs to another business');
  return { row: existing, created: false };
}

export async function getDeposit(db: DrizzleDb, orgId: string, id: string): Promise<DepositRow | null> {
  const [row] = await db.select().from(walletDeposits).where(and(eq(walletDeposits.orgId, orgId), eq(walletDeposits.id, id))).limit(1);
  return row ?? null;
}

export async function listDeposits(db: DrizzleDb, orgId: string, limit = 100): Promise<DepositRow[]> {
  return db.select().from(walletDeposits).where(eq(walletDeposits.orgId, orgId)).orderBy(desc(walletDeposits.createdAt)).limit(limit);
}

export async function heldDepositsFromSource(db: DrizzleDb, orgId: string, sourceId: string): Promise<DepositRow[]> {
  return db.select().from(walletDeposits).where(and(eq(walletDeposits.orgId, orgId), eq(walletDeposits.sourceId, sourceId), eq(walletDeposits.status, 'held')));
}

export async function moveDeposit(
  db: DrizzleDb,
  input: { orgId: string; id: string; from: DepositStatus[]; to: DepositStatus; holdReasons: HoldReason[]; screening: KytScreening; sourceId: string | null; now: Date },
): Promise<DepositRow | null> {
  const [row] = await db
    .update(walletDeposits)
    .set({ status: input.to, holdReasons: input.holdReasons, screening: input.screening, sourceId: input.sourceId, updatedAt: input.now })
    .where(and(eq(walletDeposits.orgId, input.orgId), eq(walletDeposits.id, input.id), inArray(walletDeposits.status, input.from)))
    .returning();
  return row ?? null;
}

/** A held deposit re-read with a partner's verified facts (who paid, for which top-up). Held rows only. */
export async function reattributeDeposit(
  db: DrizzleDb,
  input: { orgId: string; id: string; channel: FundingChannel; intentId: string; sourceId: string | null; status: DepositStatus; holdReasons: HoldReason[]; screening: KytScreening; firstUse: boolean; now: Date },
): Promise<DepositRow | null> {
  const [row] = await db
    .update(walletDeposits)
    .set({ channel: input.channel, intentId: input.intentId, sourceId: input.sourceId, status: input.status, holdReasons: input.holdReasons, screening: input.screening, firstUse: input.firstUse, updatedAt: input.now })
    .where(and(eq(walletDeposits.orgId, input.orgId), eq(walletDeposits.id, input.id), eq(walletDeposits.status, 'held')))
    .returning();
  return row ?? null;
}

/** USDC in held or blocked deposits still counted against this wallet. */
export async function heldUsdcMinor(db: DrizzleDb, input: { orgId: string; walletAddress: string; usdcType: string }): Promise<bigint> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${walletDeposits.amountMinor}), 0)::text` })
    .from(walletDeposits)
    .where(
      and(
        eq(walletDeposits.orgId, input.orgId),
        eq(walletDeposits.walletAddress, input.walletAddress),
        eq(walletDeposits.coinType, input.usdcType),
        inArray(walletDeposits.status, ['held', 'blocked']),
      ),
    );
  return BigInt(row?.total ?? '0');
}

// ─── Partner webhooks, once each ────────────────────────────────────────────

export async function providerEventSeen(db: DrizzleDb, provider: string, eventId: string): Promise<boolean> {
  const [row] = await db.select({ id: fundingProviderEvents.eventId }).from(fundingProviderEvents).where(and(eq(fundingProviderEvents.provider, provider), eq(fundingProviderEvents.eventId, eventId))).limit(1);
  return Boolean(row);
}

export async function recordProviderEvent(db: DrizzleDb, row: typeof fundingProviderEvents.$inferInsert): Promise<boolean> {
  const inserted = await db.insert(fundingProviderEvents).values(row).onConflictDoNothing().returning({ id: fundingProviderEvents.eventId });
  return inserted.length > 0;
}
