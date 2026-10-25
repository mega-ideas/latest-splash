/**
 * Treasury orders: a swap (USDC to USDY) or a redemption (USDY to USDC) from
 * the business's own wallet, handed to the wallet's signers (v2 D9, brief
 * 5.7; migration 0055).
 *
 * Splash signs nothing and holds nothing here. An order is the request the
 * owners sign in their wallet; the swap itself runs in a transaction their
 * passkeys sign.
 *
 * Idempotency: the intent id is the client's key, unique per org. Sent again
 * with the same direction and amount it returns the order already made;
 * with a different direction or amount it is refused, because that is a
 * different order under a reused key, not a retry.
 *
 * Binding (migration 0056): every order names the business wallet, resolved
 * on the server, as both its source and its only recipient, with both coin
 * types. The database keeps the recipient equal to the source.
 *
 * Status: `awaiting_signatures` until it closes as executed, failed, expired
 * or cancelled. A closed order never reopens and never changes to another
 * closed state: every transition is a guarded UPDATE on the open status.
 *
 * Scope (WS2): every read and write takes the org, and a row of another org
 * is not found. With no DATABASE_URL there is no fallback: the routes refuse.
 */
import { createHash, randomUUID } from 'node:crypto';

import { and, desc, eq } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';

import { treasuryWalletOrders } from '../db/schema.ts';
import type * as schemaModule from '../db/schema.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DrizzleDb = PgDatabase<any, typeof schemaModule, any>;

export type TreasuryDirection = 'swap' | 'redeem';
export type TreasuryOrderStatus = 'awaiting_signatures' | 'executed' | 'failed' | 'expired' | 'cancelled';
const CLOSED: readonly TreasuryOrderStatus[] = ['executed', 'failed', 'expired', 'cancelled'];

/** How long the signers have before an order lapses. A quote older than this is not one to sign. */
export const ORDER_TTL_MS = 30 * 60 * 1000;

/** A client idempotency key: a UUID, nothing longer or stranger. */
export const INTENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type TreasuryOrder = {
  id: string;
  orgId: string;
  intentId: string;
  direction: TreasuryDirection;
  amountInMinor: bigint;
  minOutMinor: bigint;
  quotedOutMinor: bigint;
  priceMicros: bigint;
  status: TreasuryOrderStatus;
  sandbox: boolean;
  providerRef: string | null;
  txDigest: string | null;
  requestedBy: string;
  /** The business wallet: where the coin comes from, and the only place the output goes. */
  sourceAddress: string;
  recipientAddress: string;
  inCoinType: string;
  outCoinType: string;
  expiresAt: Date;
  closedAt: Date | null;
  createdAt: Date;
};

/** What makes two requests the same order: direction and amount in. */
export function orderRequestHash(input: { direction: TreasuryDirection; amountInMinor: bigint }): string {
  return createHash('sha256').update(`treasury-order:v1|${input.direction}|${input.amountInMinor.toString()}`).digest('hex');
}

function toOrder(row: typeof treasuryWalletOrders.$inferSelect): TreasuryOrder {
  return {
    id: row.id,
    orgId: row.orgId,
    intentId: row.intentId,
    direction: row.direction as TreasuryDirection,
    amountInMinor: BigInt(row.amountInMinor),
    minOutMinor: BigInt(row.minOutMinor),
    quotedOutMinor: BigInt(row.quotedOutMinor),
    priceMicros: BigInt(row.priceMicros),
    status: row.status as TreasuryOrderStatus,
    sandbox: row.sandbox,
    providerRef: row.providerRef,
    txDigest: row.txDigest,
    requestedBy: row.requestedBy,
    sourceAddress: row.sourceAddress,
    recipientAddress: row.recipientAddress,
    inCoinType: row.inCoinType,
    outCoinType: row.outCoinType,
    expiresAt: row.expiresAt,
    closedAt: row.closedAt,
    createdAt: row.createdAt,
  };
}

export async function readTreasuryOrderByIntent(db: DrizzleDb, orgId: string, intentId: string): Promise<TreasuryOrder | null> {
  const [row] = await db
    .select()
    .from(treasuryWalletOrders)
    .where(and(eq(treasuryWalletOrders.orgId, orgId), eq(treasuryWalletOrders.intentId, intentId)))
    .limit(1);
  return row ? toOrder(row) : null;
}

export type CreateOrderResult =
  | { ok: true; order: TreasuryOrder; replayed: boolean }
  | { ok: false; code: 'intent_reused' | 'in_progress'; order: TreasuryOrder };

/**
 * An open order with no provider reference is one another request has
 * claimed and is still handing to the signers. It is not an answer yet: it may
 * still fail and be removed, so a replay that meets it is told to wait, never
 * that it was sent.
 */
export function orderInProgress(order: TreasuryOrder): boolean {
  return order.status === 'awaiting_signatures' && order.providerRef === null;
}

/**
 * Record an order, once per (org, intent id). `prepare` runs only for a new
 * order, after the row is claimed, so a retried request never asks the swap
 * route twice; if it fails, the claim is removed and the error rethrown.
 */
export async function createTreasuryOrder(
  db: DrizzleDb,
  input: {
    orgId: string;
    intentId: string;
    direction: TreasuryDirection;
    amountInMinor: bigint;
    minOutMinor: bigint;
    quotedOutMinor: bigint;
    priceMicros: bigint;
    sandbox: boolean;
    requestedBy: string;
    /** The business wallet, resolved on the server. It is the source and the recipient. */
    walletAddress: string;
    inCoinType: string;
    outCoinType: string;
    now?: Date;
  },
  prepare: (order: TreasuryOrder) => Promise<{ providerRef: string }>,
): Promise<CreateOrderResult> {
  const now = input.now ?? new Date();
  const requestHash = orderRequestHash(input);
  const id = `tro_${randomUUID()}`;
  const inserted = await db
    .insert(treasuryWalletOrders)
    .values({
      id,
      orgId: input.orgId,
      intentId: input.intentId,
      direction: input.direction,
      amountInMinor: input.amountInMinor,
      minOutMinor: input.minOutMinor,
      quotedOutMinor: input.quotedOutMinor,
      priceMicros: input.priceMicros,
      requestHash,
      status: 'awaiting_signatures',
      sandbox: input.sandbox,
      requestedBy: input.requestedBy,
      sourceAddress: input.walletAddress,
      recipientAddress: input.walletAddress,
      inCoinType: input.inCoinType,
      outCoinType: input.outCoinType,
      expiresAt: new Date(now.getTime() + ORDER_TTL_MS),
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [treasuryWalletOrders.orgId, treasuryWalletOrders.intentId] })
    .returning();

  if (inserted.length === 0) {
    const existing = await readTreasuryOrderByIntent(db, input.orgId, input.intentId);
    if (!existing) throw new Error('A treasury order with this intent id could not be read back.');
    const [row] = await db
      .select({ requestHash: treasuryWalletOrders.requestHash })
      .from(treasuryWalletOrders)
      .where(eq(treasuryWalletOrders.id, existing.id))
      .limit(1);
    if (row?.requestHash !== requestHash) return { ok: false, code: 'intent_reused', order: existing };
    if (orderInProgress(existing)) return { ok: false, code: 'in_progress', order: existing };
    return { ok: true, order: existing, replayed: true };
  }

  const order = toOrder(inserted[0]);
  let prepared: { providerRef: string };
  try {
    prepared = await prepare(order);
  } catch (error) {
    await db.delete(treasuryWalletOrders).where(and(eq(treasuryWalletOrders.id, order.id), eq(treasuryWalletOrders.orgId, input.orgId)));
    throw error;
  }
  const [updated] = await db
    .update(treasuryWalletOrders)
    .set({ providerRef: prepared.providerRef, updatedAt: now })
    .where(and(eq(treasuryWalletOrders.id, order.id), eq(treasuryWalletOrders.orgId, input.orgId)))
    .returning();
  return { ok: true, order: toOrder(updated), replayed: false };
}

/** This org's orders, newest first. An open order past its expiry reads as expired. */
export async function listTreasuryOrders(db: DrizzleDb, orgId: string, limit = 20, now = new Date()): Promise<TreasuryOrder[]> {
  const rows = await db
    .select()
    .from(treasuryWalletOrders)
    .where(eq(treasuryWalletOrders.orgId, orgId))
    .orderBy(desc(treasuryWalletOrders.createdAt))
    .limit(Math.max(1, Math.min(limit, 100)));
  return rows.map(toOrder).map((o) => (o.status === 'awaiting_signatures' && o.expiresAt <= now ? { ...o, status: 'expired' as const } : o));
}

/**
 * Close an open order. Only `awaiting_signatures` moves, and only to a closed
 * state: an executed order cannot be marked failed by a late or replayed
 * report, and nothing reopens. Returns null when nothing moved.
 */
export async function closeTreasuryOrder(
  db: DrizzleDb,
  orgId: string,
  id: string,
  to: Exclude<TreasuryOrderStatus, 'awaiting_signatures'>,
  details: { txDigest?: string; now?: Date } = {},
): Promise<TreasuryOrder | null> {
  if (!CLOSED.includes(to)) throw new RangeError(`not a closed status: ${to}`);
  const now = details.now ?? new Date();
  const [row] = await db
    .update(treasuryWalletOrders)
    .set({ status: to, txDigest: details.txDigest ?? null, closedAt: now, updatedAt: now })
    .where(and(eq(treasuryWalletOrders.id, id), eq(treasuryWalletOrders.orgId, orgId), eq(treasuryWalletOrders.status, 'awaiting_signatures')))
    .returning();
  return row ? toOrder(row) : null;
}

/** The order as the API returns it: bigints as strings. */
export function orderView(order: TreasuryOrder) {
  return {
    id: order.id,
    intentId: order.intentId,
    direction: order.direction,
    amountInMinor: order.amountInMinor.toString(),
    minOutMinor: order.minOutMinor.toString(),
    quotedOutMinor: order.quotedOutMinor.toString(),
    status: order.status,
    sandbox: order.sandbox,
    sourceAddress: order.sourceAddress,
    recipientAddress: order.recipientAddress,
    inCoinType: order.inCoinType,
    outCoinType: order.outCoinType,
    txDigest: order.txDigest,
    expiresAt: order.expiresAt.toISOString(),
    createdAt: order.createdAt.toISOString(),
  };
}
