/**
 * Postgres access for Business Splash Wallet signature collection (migration
 * 0033). The rules live in lib/server/wallet-signing.ts; this file only
 * reads and writes, and every read and write a customer can reach takes the
 * caller's `orgId` (WS2). The one cross-tenant write, the expiry sweep, says
 * so in its name (`*ForStaff`) and only ever closes requests.
 *
 * Partial signatures: written once per signer (the UPDATE's own WHERE clause
 * makes it single-use, so two submissions racing cannot both land), read
 * only to combine, and cleared, every one, in the same statement that closes
 * a request, whatever closes it. A SHA-256 of each stays as evidence.
 */
import { createHash } from 'node:crypto';

import { and, eq, gt, inArray, isNull, lte, sql } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';

import { walletSigningRequests, walletSigningSigners } from '../db/schema.ts';
import type * as schemaModule from '../db/schema.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DrizzleDb = PgDatabase<any, typeof schemaModule, any>;

export type SigningPurpose =
  | 'nominate_wallet'
  | 'register_wallet'
  | 'rotate_wallet'
  | 'confirm_wallet_rotation'
  | 'cancel_wallet_rotation'
  | 'wallet_membership'
  | 'wallet_payment'
  | 'migration_transfer';

export type SigningStatus = 'collecting' | 'submitting' | 'executed' | 'failed' | 'expired' | 'cancelled';

export type StoredSigner = {
  userId: string;
  address: string;
  publicKey: string;
  weight: number;
  signedAt: Date | null;
  /** Present only while the request is open. */
  signature: string | null;
};

export type StoredRequest = {
  id: string;
  orgId: string;
  purpose: SigningPurpose;
  dedupeKey: string;
  senderAddress: string;
  signerKind: 'single' | 'multisig';
  multisigPublicKey: string | null;
  threshold: number;
  gasMode: 'sponsored' | 'gasless';
  txBytes: string;
  txDigest: string;
  bytesHash: string;
  summary: unknown;
  nextStep: unknown;
  status: SigningStatus;
  requestedBy: string;
  expiresAt: Date;
  executedDigest: string | null;
  error: string | null;
  createdAt: Date;
  signers: StoredSigner[];
};

export class OpenRequestExists extends Error {
  constructor() {
    super('a request like this is already waiting for signatures');
    this.name = 'OpenRequestExists';
  }
}

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string }; message?: string };
  return e?.code === '23505' || e?.cause?.code === '23505' || /unique|duplicate key/i.test(e?.message ?? '');
}

export async function insertSigningRequest(
  db: DrizzleDb,
  request: Omit<StoredRequest, 'status' | 'executedDigest' | 'error' | 'createdAt' | 'signers'>,
  signers: Array<Pick<StoredSigner, 'userId' | 'address' | 'publicKey' | 'weight'>>,
): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await tx.insert(walletSigningRequests).values({
        ...request,
        status: 'collecting',
        summary: request.summary as object,
        nextStep: (request.nextStep ?? null) as object | null,
      });
      await tx.insert(walletSigningSigners).values(
        signers.map((s) => ({ requestId: request.id, orgId: request.orgId, userId: s.userId, address: s.address, publicKey: s.publicKey, weight: s.weight })),
      );
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new OpenRequestExists();
    throw error;
  }
}

async function signersOf(db: DrizzleDb, requestId: string): Promise<StoredSigner[]> {
  const rows = await db.select().from(walletSigningSigners).where(eq(walletSigningSigners.requestId, requestId));
  return rows.map((r) => ({ userId: r.userId, address: r.address, publicKey: r.publicKey, weight: r.weight, signedAt: r.signedAt, signature: r.signature }));
}

function toRequest(row: typeof walletSigningRequests.$inferSelect, signers: StoredSigner[]): StoredRequest {
  return {
    id: row.id,
    orgId: row.orgId,
    purpose: row.purpose as SigningPurpose,
    dedupeKey: row.dedupeKey,
    senderAddress: row.senderAddress,
    signerKind: row.signerKind as 'single' | 'multisig',
    multisigPublicKey: row.multisigPublicKey,
    threshold: row.threshold,
    gasMode: row.gasMode as 'sponsored' | 'gasless',
    txBytes: row.txBytes,
    txDigest: row.txDigest,
    bytesHash: row.bytesHash,
    summary: row.summary,
    nextStep: row.nextStep,
    status: row.status as SigningStatus,
    requestedBy: row.requestedBy,
    expiresAt: row.expiresAt,
    executedDigest: row.executedDigest,
    error: row.error,
    createdAt: row.createdAt,
    signers,
  };
}

/** One request of this org, or null. Another org's id reads as absent. */
export async function readSigningRequest(db: DrizzleDb, orgId: string, id: string): Promise<StoredRequest | null> {
  const rows = await db
    .select()
    .from(walletSigningRequests)
    .where(and(eq(walletSigningRequests.id, id), eq(walletSigningRequests.orgId, orgId)))
    .limit(1);
  if (rows.length === 0) return null;
  return toRequest(rows[0], await signersOf(db, id));
}

/** This org's requests, newest first. */
export async function listSigningRequests(db: DrizzleDb, orgId: string, statuses?: SigningStatus[]): Promise<StoredRequest[]> {
  const where = statuses?.length
    ? and(eq(walletSigningRequests.orgId, orgId), inArray(walletSigningRequests.status, statuses))
    : eq(walletSigningRequests.orgId, orgId);
  const rows = await db.select().from(walletSigningRequests).where(where).orderBy(sql`${walletSigningRequests.createdAt} desc`).limit(100);
  return Promise.all(rows.map(async (row) => toRequest(row, await signersOf(db, row.id))));
}

/** Requests in this org waiting on this person's signature. */
export async function listInboxForSigner(db: DrizzleDb, orgId: string, userId: string, now: Date): Promise<StoredRequest[]> {
  const rows = await db
    .select({ id: walletSigningRequests.id })
    .from(walletSigningRequests)
    .innerJoin(walletSigningSigners, eq(walletSigningSigners.requestId, walletSigningRequests.id))
    .where(
      and(
        eq(walletSigningRequests.orgId, orgId),
        eq(walletSigningSigners.orgId, orgId),
        eq(walletSigningSigners.userId, userId),
        isNull(walletSigningSigners.signedAt),
        eq(walletSigningRequests.status, 'collecting'),
        gt(walletSigningRequests.expiresAt, now),
      ),
    );
  const out: StoredRequest[] = [];
  for (const { id } of rows) {
    const request = await readSigningRequest(db, orgId, id);
    if (request) out.push(request);
  }
  return out.sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime());
}

/**
 * Store one signer's partial signature. Single-use: true only if this call
 * wrote it, the signer had not signed, and the request is still collecting
 * and unexpired at `now`.
 */
export async function recordPartialSignature(
  db: DrizzleDb,
  input: { orgId: string; requestId: string; userId: string; signature: string; now: Date },
): Promise<boolean> {
  const rows = await db
    .update(walletSigningSigners)
    .set({ signature: input.signature, signatureSha256: sha256(input.signature), signedAt: input.now, updatedAt: input.now })
    .where(
      and(
        eq(walletSigningSigners.requestId, input.requestId),
        eq(walletSigningSigners.orgId, input.orgId),
        eq(walletSigningSigners.userId, input.userId),
        isNull(walletSigningSigners.signedAt),
        sql`exists (select 1 from ${walletSigningRequests} r where r.id = ${input.requestId} and r.org_id = ${input.orgId} and r.status = 'collecting' and r.expires_at > ${input.now.toISOString()}::timestamptz)`,
      ),
    )
    .returning({ userId: walletSigningSigners.userId });
  return rows.length === 1;
}

/** Move a collecting request to submitting. Only one caller wins. */
export async function claimSubmission(db: DrizzleDb, orgId: string, id: string, now: Date): Promise<boolean> {
  const rows = await db
    .update(walletSigningRequests)
    .set({ status: 'submitting', updatedAt: now })
    .where(and(eq(walletSigningRequests.id, id), eq(walletSigningRequests.orgId, orgId), eq(walletSigningRequests.status, 'collecting'), gt(walletSigningRequests.expiresAt, now)))
    .returning({ id: walletSigningRequests.id });
  return rows.length === 1;
}

/** Close a request and clear every partial signature with it. */
export async function closeSigningRequest(
  db: DrizzleDb,
  input: { orgId: string; id: string; status: Exclude<SigningStatus, 'collecting' | 'submitting'>; from: SigningStatus[]; executedDigest?: string | null; error?: string | null; now: Date },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(walletSigningRequests)
      .set({ status: input.status, executedDigest: input.executedDigest ?? null, error: input.error ?? null, closedAt: input.now, updatedAt: input.now })
      .where(and(eq(walletSigningRequests.id, input.id), eq(walletSigningRequests.orgId, input.orgId), inArray(walletSigningRequests.status, input.from)))
      .returning({ id: walletSigningRequests.id });
    if (rows.length !== 1) return false;
    await tx
      .update(walletSigningSigners)
      .set({ signature: null, updatedAt: input.now })
      .where(and(eq(walletSigningSigners.requestId, input.id), eq(walletSigningSigners.orgId, input.orgId)));
    return true;
  });
}

/** Note that a signer was told. */
export async function markNotified(db: DrizzleDb, input: { orgId: string; requestId: string; userId: string; channel: string; now: Date }): Promise<void> {
  await db
    .update(walletSigningSigners)
    .set({ notifiedAt: input.now, notifiedBy: input.channel, updatedAt: input.now })
    .where(and(eq(walletSigningSigners.requestId, input.requestId), eq(walletSigningSigners.orgId, input.orgId), eq(walletSigningSigners.userId, input.userId)));
}

/**
 * The sweep: every collecting request past its expiry, in every org, is
 * closed as expired and its partial signatures cleared. Returns how many.
 * Cross-tenant by design (a cron), and it can only close.
 */
export async function expireSigningRequestsForStaff(db: DrizzleDb, now: Date): Promise<number> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(walletSigningRequests)
      .set({ status: 'expired', closedAt: now, updatedAt: now })
      .where(and(eq(walletSigningRequests.status, 'collecting'), lte(walletSigningRequests.expiresAt, now)))
      .returning({ id: walletSigningRequests.id });
    if (rows.length === 0) return 0;
    await tx
      .update(walletSigningSigners)
      .set({ signature: null, updatedAt: now })
      .where(inArray(walletSigningSigners.requestId, rows.map((r) => r.id)));
    return rows.length;
  });
}

/** Signatures still held for requests that are no longer open: must be zero. */
export async function countLingeringSignaturesForStaff(db: DrizzleDb): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(walletSigningSigners)
    .innerJoin(walletSigningRequests, eq(walletSigningRequests.id, walletSigningSigners.requestId))
    .where(and(sql`${walletSigningSigners.signature} is not null`, sql`${walletSigningRequests.status} not in ('collecting', 'submitting')`));
  return Number(rows[0]?.n ?? 0);
}
