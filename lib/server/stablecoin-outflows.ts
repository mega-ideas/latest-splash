import { randomUUID } from 'node:crypto';

import { and, eq, gt, inArray, or, sql } from 'drizzle-orm';

import { organizations, stablecoinOutflows } from '@/lib/db/schema';
import type { KybLifecycleState } from '@/lib/compliance/kyb-state';
import {
  checkStablecoinAllowance,
  laneAccess,
  STABLECOIN_NETWORK,
  STABLECOIN_WINDOW_MS,
  type AllowanceCheck,
} from '@/lib/payments/stablecoin-lane';

/**
 * The stablecoin outflow ledger — reservations, confirmations, and the
 * allowance they feed.
 *
 * A quote RESERVES its principal against the 30-day allowance before the
 * business is shown anything to sign. The check and the insert run in one
 * transaction that locks the organisation row first, so two quotes for the
 * same business are serialised: the second one reads the first one's
 * reservation. Without that lock the cap is a suggestion — two tabs, two
 * quotes, both "within limit", both signed.
 *
 * A reservation that is never signed lapses at `reservedUntil` and stops
 * counting. A reservation that IS signed becomes CONFIRMED only once the
 * executed transaction has been read back from the chain and matched
 * (lib/server/stablecoin-verify.ts).
 */

/** Long enough to open a wallet, read it, and sign; short enough that an
 *  abandoned quote does not hold a business's allowance hostage for long. */
export const RESERVATION_MS = 15 * 60 * 1000;

// Structural, not nominal: node-postgres in the app, PGlite in the tests.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

export interface ReserveInput {
  orgId: string;
  kind: 'TRANSFER' | 'X402';
  supplierId: string | null;
  coinType: string;
  principalMinor: bigint;
  feeMinor: bigint;
  senderAddress: string;
  recipientAddress: string;
  feeAddress: string | null;
  resource?: string | null;
  /** Who asked — maker-checker refuses them as the second approver. */
  requestedBy?: string | null;
  nowMs?: number;
}

export type ReserveResult =
  | { ok: true; id: string; network: typeof STABLECOIN_NETWORK; reservedUntil: Date; allowance: AllowanceCheck }
  | { ok: false; reason: string; allowance: AllowanceCheck | null };

/** Rows that count against the window at `nowMs`. */
function countingRows(orgId: string, nowMs: number) {
  const windowStart = new Date(nowMs - STABLECOIN_WINDOW_MS);
  const now = new Date(nowMs);
  return and(
    eq(stablecoinOutflows.orgId, orgId),
    gt(stablecoinOutflows.createdAt, windowStart),
    or(
      eq(stablecoinOutflows.status, 'CONFIRMED'),
      and(eq(stablecoinOutflows.status, 'PENDING'), gt(stablecoinOutflows.reservedUntil, now)),
    ),
  );
}

export async function readAllowance(d: Db, orgId: string, nowMs = Date.now()): Promise<{
  state: KybLifecycleState;
  network: typeof STABLECOIN_NETWORK;
  allowance: AllowanceCheck;
}> {
  const [org] = await d
    .select({ kyb: organizations.kybLifecycle })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!org) throw new Error(`organization ${orgId} not found`);
  const state = org.kyb as KybLifecycleState;
  const rows = await d
    .select({ principal: stablecoinOutflows.principalMinor, createdAt: stablecoinOutflows.createdAt })
    .from(stablecoinOutflows)
    .where(countingRows(orgId, nowMs));
  // A 1-micro probe: the allowance as it stands, without spending any of it.
  const allowance = checkStablecoinAllowance({
    state,
    principalMinor: 1n,
    prior: rows.map((r: { principal: bigint; createdAt: Date }) => ({ principalMinor: BigInt(r.principal), atMs: new Date(r.createdAt).getTime() })),
    nowMs,
  });
  return { state, network: STABLECOIN_NETWORK, allowance };
}

export async function reserveOutflow(d: Db, input: ReserveInput): Promise<ReserveResult> {
  const nowMs = input.nowMs ?? Date.now();
  return d.transaction(async (tx: Db) => {
    // Serialise every quote for this business behind one row lock.
    const [org] = await tx
      .select({ kyb: organizations.kybLifecycle })
      .from(organizations)
      .where(eq(organizations.id, input.orgId))
      .for('update')
      .limit(1);
    if (!org) return { ok: false as const, reason: 'Workspace not found.', allowance: null };
    const state = org.kyb as KybLifecycleState;
    const lane = laneAccess(state, input.kind === 'X402' ? 'X402' : 'STABLECOIN_WALLET');
    if (!lane.allowed) return { ok: false as const, reason: lane.reason, allowance: null };

    const rows = await tx
      .select({ principal: stablecoinOutflows.principalMinor, createdAt: stablecoinOutflows.createdAt })
      .from(stablecoinOutflows)
      .where(countingRows(input.orgId, nowMs));
    const allowance = checkStablecoinAllowance({
      state,
      principalMinor: input.principalMinor,
      prior: rows.map((r: { principal: bigint; createdAt: Date }) => ({ principalMinor: BigInt(r.principal), atMs: new Date(r.createdAt).getTime() })),
      nowMs,
    });
    if (!allowance.ok) return { ok: false as const, reason: allowance.reason, allowance };

    const network = STABLECOIN_NETWORK;
    const id = `sco_${randomUUID()}`;
    const reservedUntil = new Date(nowMs + RESERVATION_MS);
    await tx.insert(stablecoinOutflows).values({
      id,
      orgId: input.orgId,
      kind: input.kind,
      supplierId: input.supplierId,
      network,
      coinType: input.coinType,
      principalMinor: input.principalMinor,
      feeMinor: input.feeMinor,
      senderAddress: input.senderAddress,
      recipientAddress: input.recipientAddress,
      feeAddress: input.feeAddress,
      status: 'PENDING',
      reservedUntil,
      // Recorded now, anchored once Splash's contracts are on mainnet.
      anchorStatus: 'PENDING_MAINNET_PUBLISH',
      resource: input.resource ?? null,
      requestedBy: input.requestedBy ?? null,
      createdAt: new Date(nowMs),
      updatedAt: new Date(nowMs),
    });
    return { ok: true as const, id, network, reservedUntil, allowance };
  });
}

export async function readOutflow(d: Db, orgId: string, id: string) {
  const [row] = await d
    .select()
    .from(stablecoinOutflows)
    .where(and(eq(stablecoinOutflows.id, id), eq(stablecoinOutflows.orgId, orgId)))
    .limit(1);
  return row ?? null;
}

/** PENDING → CONFIRMED, only for a still-pending row and a digest never seen
 *  before. The audit hash is required: the table refuses a CONFIRMED row
 *  without one (migration 0021). */
export async function confirmOutflow(d: Db, input: { orgId: string; id: string; txDigest: string; auditHash: string; nowMs?: number }) {
  const now = new Date(input.nowMs ?? Date.now());
  const updated = await d
    .update(stablecoinOutflows)
    .set({ status: 'CONFIRMED', txDigest: input.txDigest, auditHash: input.auditHash, confirmedAt: now, updatedAt: now })
    .where(and(
      eq(stablecoinOutflows.id, input.id),
      eq(stablecoinOutflows.orgId, input.orgId),
      eq(stablecoinOutflows.status, 'PENDING'),
    ))
    .returning({ id: stablecoinOutflows.id });
  return updated.length === 1;
}

/**
 * Bind a still-pending quote to the ONE signed transaction that has left
 * Splash (submitted to the chain, or handed to an x402 seller). After this,
 * only that digest can settle the quote: a second, differently-signed
 * transaction for the same payment is refused while the first may still land
 * — otherwise a dropped connection plus a re-sign pays twice and records once.
 */
export async function bindOutflowDigest(d: Db, input: { orgId: string; id: string; txDigest: string }): Promise<boolean> {
  const bound = await d
    .update(stablecoinOutflows)
    .set({ txDigest: input.txDigest, updatedAt: new Date() })
    .where(and(
      eq(stablecoinOutflows.id, input.id),
      eq(stablecoinOutflows.orgId, input.orgId),
      eq(stablecoinOutflows.status, 'PENDING'),
      or(sql`${stablecoinOutflows.txDigest} IS NULL`, eq(stablecoinOutflows.txDigest, input.txDigest)),
    ))
    .returning({ id: stablecoinOutflows.id });
  return bound.length === 1;
}

/** PENDING → FAILED | MISMATCH | EXPIRED, releasing the reservation. A digest
 *  given here is recorded; a digest already bound is kept, so a lapsed quote
 *  still says which transaction was signed for it. */
export async function closeOutflow(d: Db, input: {
  orgId: string;
  id: string;
  status: 'FAILED' | 'MISMATCH' | 'EXPIRED';
  reason: string;
  txDigest?: string | null;
}) {
  const now = new Date();
  await d
    .update(stablecoinOutflows)
    .set({ status: input.status, failureReason: input.reason, ...(input.txDigest ? { txDigest: input.txDigest } : {}), updatedAt: now })
    .where(and(
      eq(stablecoinOutflows.id, input.id),
      eq(stablecoinOutflows.orgId, input.orgId),
      inArray(stablecoinOutflows.status, ['PENDING']),
    ));
}

/** Recent outflows for the screen. */
export async function listOutflows(d: Db, orgId: string, limit = 50) {
  return d
    .select()
    .from(stablecoinOutflows)
    .where(eq(stablecoinOutflows.orgId, orgId))
    .orderBy(sql`${stablecoinOutflows.createdAt} desc`)
    .limit(limit);
}
