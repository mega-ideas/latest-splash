import { randomUUID } from 'node:crypto';

import { and, eq, gt, inArray, or, sql } from 'drizzle-orm';

import { organizations, stablecoinOutflows } from '@/lib/db/schema';
import type { KybLifecycleState } from '@/lib/compliance/kyb-state';
import {
  checkStablecoinAllowance,
  laneAccess,
  STABLECOIN_WINDOW_MS,
  type AllowanceCheck,
  type SuiNetwork,
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
  nowMs?: number;
}

export type ReserveResult =
  | { ok: true; id: string; network: SuiNetwork; reservedUntil: Date; allowance: AllowanceCheck }
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
  network: SuiNetwork;
  allowance: AllowanceCheck;
}> {
  const [org] = await d
    .select({ kyb: organizations.kybLifecycle, network: organizations.stablecoinNetwork })
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
  return { state, network: org.network as SuiNetwork, allowance };
}

export async function reserveOutflow(d: Db, input: ReserveInput): Promise<ReserveResult> {
  const nowMs = input.nowMs ?? Date.now();
  return d.transaction(async (tx: Db) => {
    // Serialise every quote for this business behind one row lock.
    const [org] = await tx
      .select({ kyb: organizations.kybLifecycle, network: organizations.stablecoinNetwork })
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

    const network = org.network as SuiNetwork;
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
      anchorStatus: network === 'mainnet' ? 'PENDING_MAINNET_PUBLISH' : 'NOT_REQUIRED',
      resource: input.resource ?? null,
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

/** PENDING → CONFIRMED, only for a still-pending row and a digest never seen before. */
export async function confirmOutflow(d: Db, input: { orgId: string; id: string; txDigest: string; nowMs?: number }) {
  const now = new Date(input.nowMs ?? Date.now());
  const updated = await d
    .update(stablecoinOutflows)
    .set({ status: 'CONFIRMED', txDigest: input.txDigest, confirmedAt: now, updatedAt: now })
    .where(and(
      eq(stablecoinOutflows.id, input.id),
      eq(stablecoinOutflows.orgId, input.orgId),
      eq(stablecoinOutflows.status, 'PENDING'),
    ))
    .returning({ id: stablecoinOutflows.id });
  return updated.length === 1;
}

/** PENDING → FAILED | MISMATCH, releasing the reservation. A MISMATCH keeps
 *  the digest so an operator can see what was actually signed. */
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
    .set({ status: input.status, failureReason: input.reason, txDigest: input.txDigest ?? null, updatedAt: now })
    .where(and(
      eq(stablecoinOutflows.id, input.id),
      eq(stablecoinOutflows.orgId, input.orgId),
      inArray(stablecoinOutflows.status, ['PENDING']),
    ));
}

/**
 * Which Sui network this workspace settles on. Without a database (the
 * in-memory demo) it is testnet: nothing reachable that way may touch mainnet.
 */
export async function orgStablecoinNetwork(orgId: string): Promise<SuiNetwork> {
  if (!process.env.DATABASE_URL) return 'testnet';
  const { getDb } = await import('../db/client.ts');
  const [org] = await getDb()
    .select({ network: organizations.stablecoinNetwork })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  return org?.network === 'mainnet' ? 'mainnet' : 'testnet';
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
