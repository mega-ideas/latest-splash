/**
 * Postgres access for funding sessions, the source-transaction registry and
 * the last-used funding source.
 *
 * Same shape as the other repositories: this module knows the tables, the
 * store above it (`lib/server/funding-sessions.ts`) knows the rules, and the
 * record comes back in the shape the in-memory store always handed out.
 *
 * ─── Money ──────────────────────────────────────────────────────────────────
 *
 * Every amount is a bigint column of micro units. The record keeps the JS
 * `number` it has always had — routes return it as JSON — so the conversion
 * happens here and refuses anything that is not a safe integer.
 *
 * ─── The registry is a primary key ──────────────────────────────────────────
 *
 * `registerSourceTransaction` stops one on-chain deposit being credited to two
 * sessions. In a `Map` that guarded only the instance holding the map. Here the
 * transaction digest is the primary key of its own table: the first session to
 * claim a digest owns it, and a second claim — from any instance, at any time,
 * or at the same moment — reads the owner back instead of writing over it.
 */
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';

import { fundingLastUsedSources, fundingSessions, fundingSourceTransactions } from '../../db/schema.ts';
import type * as schemaModule from '../../db/schema.ts';
import type { FundingSourceId } from '../../funding/registry.ts';
import type { FundingSession } from '../funding-sessions.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DrizzleDb = PgDatabase<any, typeof schemaModule, any>;

type SessionSelect = typeof fundingSessions.$inferSelect;
type SessionInsert = typeof fundingSessions.$inferInsert;

function toMicro(value: number | undefined): bigint | null {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Funding amounts are integer micro units, got ${value}`);
  }
  return BigInt(value);
}

function fromMicro(value: bigint | null): number | undefined {
  if (value === null) return undefined;
  const asNumber = Number(value);
  if (!Number.isSafeInteger(asNumber)) {
    throw new Error(`Funding amount ${value} is beyond what this record can carry exactly`);
  }
  return asNumber;
}

const opt = <T>(value: T | null): T | undefined => (value === null ? undefined : value);

function toSession(row: SessionSelect): FundingSession {
  return {
    id: row.id,
    orgId: row.orgId,
    businessAccountId: row.businessAccountId,
    selection: row.selection as FundingSession['selection'],
    feeTier: row.feeTier as FundingSession['feeTier'],
    amountExpectedMicro: fromMicro(row.amountExpectedMicro)!,
    depositAddress: opt(row.depositAddress),
    depositUri: opt(row.depositUri),
    status: row.status as FundingSession['status'],
    sourceType: opt(row.sourceType) as FundingSession['sourceType'],
    kytPolicy: opt(row.kytPolicy) as FundingSession['kytPolicy'],
    kytReasons: opt(row.kytReasons) as string[] | undefined,
    sourceTxDigest: opt(row.sourceTxDigest),
    receivedCoinType: opt(row.receivedCoinType),
    receivedAmountMicro: fromMicro(row.receivedAmountMicro),
    nativeSuiUsdc: opt(row.nativeSuiUsdc),
    normalizedAmountUsdcMicro: fromMicro(row.normalizedAmountUsdcMicro),
    normalizeVenue: opt(row.normalizeVenue) as FundingSession['normalizeVenue'],
    effectiveSlippageBps: opt(row.effectiveSlippageBps),
    transferIntentId: opt(row.transferIntentId),
    adminFlag: opt(row.adminFlag),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The mutable columns of a patch. `undefined` in a patch CLEARS the field,
 *  as `Object.assign` did on the in-memory record; an absent key leaves it. */
function patchColumns(patch: Partial<FundingSession>): Partial<SessionInsert> {
  const set: Partial<SessionInsert> = {};
  const has = (key: keyof FundingSession) => Object.prototype.hasOwnProperty.call(patch, key);
  if (has('status')) set.status = patch.status;
  if (has('depositAddress')) set.depositAddress = patch.depositAddress ?? null;
  if (has('depositUri')) set.depositUri = patch.depositUri ?? null;
  if (has('sourceType')) set.sourceType = patch.sourceType ?? null;
  if (has('kytPolicy')) set.kytPolicy = patch.kytPolicy ?? null;
  if (has('kytReasons')) set.kytReasons = patch.kytReasons ?? null;
  if (has('sourceTxDigest')) set.sourceTxDigest = patch.sourceTxDigest ?? null;
  if (has('receivedCoinType')) set.receivedCoinType = patch.receivedCoinType ?? null;
  if (has('receivedAmountMicro')) set.receivedAmountMicro = toMicro(patch.receivedAmountMicro);
  if (has('nativeSuiUsdc')) set.nativeSuiUsdc = patch.nativeSuiUsdc ?? null;
  if (has('normalizedAmountUsdcMicro')) set.normalizedAmountUsdcMicro = toMicro(patch.normalizedAmountUsdcMicro);
  if (has('normalizeVenue')) set.normalizeVenue = patch.normalizeVenue ?? null;
  if (has('effectiveSlippageBps')) set.effectiveSlippageBps = patch.effectiveSlippageBps ?? null;
  if (has('transferIntentId')) set.transferIntentId = patch.transferIntentId ?? null;
  if (has('adminFlag')) set.adminFlag = patch.adminFlag ?? null;
  return set;
}

export async function insertSession(db: DrizzleDb, session: FundingSession): Promise<FundingSession> {
  const [row] = await db
    .insert(fundingSessions)
    .values({
      id: session.id,
      orgId: session.orgId,
      businessAccountId: session.businessAccountId,
      selection: session.selection,
      feeTier: session.feeTier,
      amountExpectedMicro: toMicro(session.amountExpectedMicro)!,
      status: session.status,
      createdAt: new Date(session.createdAt),
      updatedAt: new Date(session.updatedAt),
      ...patchColumns(session),
    })
    .returning();
  return toSession(row);
}

export async function getSession(db: DrizzleDb, sessionId: string): Promise<FundingSession | null> {
  const rows = await db.select().from(fundingSessions).where(eq(fundingSessions.id, sessionId)).limit(1);
  return rows.length > 0 ? toSession(rows[0]) : null;
}

/** The row, locked for the rest of the caller's transaction. */
export async function getSessionForUpdate(db: DrizzleDb, sessionId: string): Promise<FundingSession | null> {
  const rows = await db
    .select()
    .from(fundingSessions)
    .where(eq(fundingSessions.id, sessionId))
    .limit(1)
    .for('update');
  return rows.length > 0 ? toSession(rows[0]) : null;
}

export async function listSessions(db: DrizzleDb, limit = 500): Promise<FundingSession[]> {
  const rows = await db.select().from(fundingSessions).orderBy(desc(fundingSessions.createdAt)).limit(limit);
  return rows.map(toSession);
}

/**
 * Apply a patch. CREDITED is terminal for the status: a patch that would move
 * a credited session back (a second webhook's KYT verdict, landing after the
 * first webhook credited) matches nothing and returns null, rather than
 * reopening a session the ledger has already paid.
 */
export async function patchSession(
  db: DrizzleDb,
  sessionId: string,
  patch: Partial<FundingSession>,
): Promise<FundingSession | null> {
  const reopens = patch.status !== undefined && patch.status !== 'CREDITED';
  const rows = await db
    .update(fundingSessions)
    .set({ ...patchColumns(patch), updatedAt: new Date() })
    .where(
      reopens
        ? and(eq(fundingSessions.id, sessionId), ne(fundingSessions.status, 'CREDITED'))
        : eq(fundingSessions.id, sessionId),
    )
    .returning();
  return rows.length > 0 ? toSession(rows[0]) : null;
}

/**
 * Claim `txDigest` for `sessionId`, or learn who already holds it.
 *
 * Insert-and-let-the-key-decide rather than read-then-write: two webhooks for
 * the same deposit arriving together would both read nothing and both write.
 */
export async function claimSourceTransaction(
  db: DrizzleDb,
  input: { txDigest: string; sessionId: string; orgId: string },
): Promise<string> {
  await db
    .insert(fundingSourceTransactions)
    .values({ txDigest: input.txDigest, sessionId: input.sessionId, orgId: input.orgId })
    .onConflictDoNothing({ target: fundingSourceTransactions.txDigest });
  const [owner] = await db
    .select({ sessionId: fundingSourceTransactions.sessionId })
    .from(fundingSourceTransactions)
    .where(eq(fundingSourceTransactions.txDigest, input.txDigest))
    .limit(1);
  return owner.sessionId;
}

export async function readLastUsedSource(
  db: DrizzleDb,
  orgId: string,
  businessAccountId: string,
): Promise<FundingSourceId | null> {
  const rows = await db
    .select({ source: fundingLastUsedSources.source })
    .from(fundingLastUsedSources)
    .where(and(eq(fundingLastUsedSources.orgId, orgId), eq(fundingLastUsedSources.businessAccountId, businessAccountId)))
    .limit(1);
  return rows.length > 0 ? (rows[0].source as FundingSourceId) : null;
}

export async function writeLastUsedSource(
  db: DrizzleDb,
  input: { orgId: string; businessAccountId: string; source: FundingSourceId },
): Promise<void> {
  await db
    .insert(fundingLastUsedSources)
    .values({ ...input, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [fundingLastUsedSources.orgId, fundingLastUsedSources.businessAccountId],
      set: { source: input.source, updatedAt: sql`now()` },
    });
}
