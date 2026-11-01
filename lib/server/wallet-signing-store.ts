/**
 * Postgres access for Business Splash Wallet signature collection
 * (migrations 0033 and 0034). The rules live in lib/server/wallet-signing.ts;
 * this file only reads and writes, and every read and write a customer can
 * reach takes the caller's `orgId` (WS2). The cross-tenant reads and writes,
 * the cron's, say so in their names (`*ForStaff`) and only ever close or
 * reconcile requests.
 *
 * Partial signatures: written once per signer (the UPDATE's own WHERE clause
 * makes it single-use, so two submissions racing cannot both land), read
 * only to combine, and cleared, every one, in the same statement that closes
 * a request or marks its outcome unknown, whatever does it. A SHA-256 of
 * each stays as evidence.
 *
 * Lifecycle: collecting -> submitting -> executed | failed | unknown, and
 * unknown -> executed | failed once the chain answers. A request that is
 * submitting or unknown keeps its dedupe key (the open-request index covers
 * all three in-flight states), so nothing like it can be asked for while
 * its outcome is not known.
 */
import { createHash } from 'node:crypto';

import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';

import { paymentScheduleRunPayments, users, walletApprovalAsks, walletSigningRequests, walletSigningSigners, walletSingleSignerConsents } from '../db/schema.ts';
import { cleanDecliners, plainName, type Decliners } from '../team/declined-by.ts';
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
  /** v2 §5.6: every payment of a batch in one transaction, signed once by the owners. */
  | 'wallet_batch'
  | 'migration_transfer'
  | 'rotation_transfer'
  /** v2 §4.2: the wallet creates its SpendPolicy for the current wallet generation. */
  | 'spend_policy'
  /** v2 §4.2: the wallet gives, changes or takes back spending rules, or changes its policy. */
  | 'spend_rule'
  /** v2 §4.2: one owner's second approval (`splash_spend::approve_payout`). */
  | 'spend_approval'
  /** v2 §4.2, decision D2: a staff member pays alone under their own rule (`splash_spend::pay_intent`), signed by their own passkey. */
  | 'staff_rule_payment'
  /** v2 §4.4: a bank payout to the business's own account, through its partner deposit address. */
  | 'withdrawal'
  /** v2 §4.4: the small plain transfer that verifies a partner deposit address. */
  | 'partner_test_deposit'
  /** v2 §4.5: a bank payout to a supplier's account, through the business's partner deposit address. */
  | 'partner_payout'
  /** A1 §6 (FEATURE_SUBSCRIPTION_BILLING, off): the wallet grants, changes or revokes the billing allowance. */
  | 'subscription';

export type SigningStatus = 'collecting' | 'submitting' | 'unknown' | 'executed' | 'failed' | 'expired' | 'cancelled';

/**
 * What a request closed as `cancelled` records when enough signers declined it; a request its sender
 * withdrew records nothing. History tells the two apart by it ("declined" and "withdrawn", both a
 * person's own no) so neither reads as a failure.
 */
export const DECLINED_BY_SIGNERS = 'enough signers declined that it can no longer be signed';

/** How a request that people closed ended: the owners declined it, or its sender took it back. */
export const endedByPeople = (error: string | null | undefined): 'declined' | 'withdrawn' => (error === DECLINED_BY_SIGNERS ? 'declined' : 'withdrawn');

/**
 * Who declined each of these requests of this business, by the request's own record (a signer's
 * `declined_at`), in the order they declined. Names are read through the business's own signers
 * only, so another business's request, or its people, read as absent. A request with no decline
 * on record has no entry. Names are cleaned to plain words here (lib/team/declined-by.ts); a
 * decliner whose name leaves nothing is counted, not named.
 */
export async function declinersOfRequests(db: DrizzleDb, orgId: string, requestIds: string[]): Promise<Map<string, Decliners>> {
  const out = new Map<string, Decliners>();
  const ids = [...new Set(requestIds)];
  if (ids.length === 0) return out;
  const rows = await db
    .select({ requestId: walletSigningSigners.requestId, name: users.name })
    .from(walletSigningSigners)
    .innerJoin(walletSigningRequests, and(eq(walletSigningRequests.id, walletSigningSigners.requestId), eq(walletSigningRequests.orgId, orgId)))
    .leftJoin(users, eq(users.id, walletSigningSigners.userId))
    .where(and(eq(walletSigningSigners.orgId, orgId), inArray(walletSigningSigners.requestId, ids), isNotNull(walletSigningSigners.declinedAt)))
    .orderBy(asc(walletSigningSigners.declinedAt), asc(walletSigningSigners.userId));
  for (const r of rows) {
    const entry = out.get(r.requestId) ?? { names: [], unnamed: 0 };
    const name = plainName(r.name);
    if (name) entry.names.push(name);
    else entry.unnamed += 1;
    out.set(r.requestId, entry);
  }
  return out;
}

/** The owner who declined this approval ask of this business, or null when the ask is not declined here or names no one. */
export async function askDeclinerOf(db: DrizzleDb, orgId: string, askId: string): Promise<Decliners | null> {
  const [row] = await db
    .select({ name: users.name, decidedBy: walletApprovalAsks.decidedBy, status: walletApprovalAsks.status })
    .from(walletApprovalAsks)
    .leftJoin(users, eq(users.id, walletApprovalAsks.decidedBy))
    .where(and(eq(walletApprovalAsks.orgId, orgId), eq(walletApprovalAsks.id, askId)))
    .limit(1);
  if (!row || row.status !== 'declined') return null;
  return cleanDecliners({ names: [row.name], unnamed: 0 });
}

/** Requests whose dedupe key is held: open, or sent with no final answer. */
export const IN_FLIGHT: readonly SigningStatus[] = ['collecting', 'submitting', 'unknown'];

export type StoredSigner = {
  userId: string;
  address: string;
  publicKey: string;
  weight: number;
  signedAt: Date | null;
  declinedAt: Date | null;
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
  claimedAt: Date | null;
  executedDigest: string | null;
  error: string | null;
  createdAt: Date;
  signers: StoredSigner[];
};

export class OpenRequestExists extends Error {
  constructor() {
    super('a request like this is already waiting for signatures, or for the network to confirm it');
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
  request: Omit<StoredRequest, 'status' | 'executedDigest' | 'error' | 'createdAt' | 'signers' | 'claimedAt'> & { /** The request's own clock (the sponsor's 24-hour window reads it), not the database's. */ createdAt?: Date },
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
  return rows.map((r) => ({
    userId: r.userId,
    address: r.address,
    publicKey: r.publicKey,
    weight: r.weight,
    signedAt: r.signedAt,
    declinedAt: r.declinedAt,
    signature: r.signature,
  }));
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
    claimedAt: row.claimedAt,
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

/** Requests in this org waiting on this person's signature (not declined). */
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
        isNull(walletSigningSigners.declinedAt),
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
 * wrote it, the signer had neither signed nor declined, and the request is
 * still collecting and unexpired at `now`.
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
        isNull(walletSigningSigners.declinedAt),
        sql`exists (select 1 from ${walletSigningRequests} r where r.id = ${input.requestId} and r.org_id = ${input.orgId} and r.status = 'collecting' and r.expires_at > ${input.now.toISOString()}::timestamptz)`,
      ),
    )
    .returning({ userId: walletSigningSigners.userId });
  return rows.length === 1;
}

/** One signer declines. True only if this call recorded it. */
export async function recordDecline(db: DrizzleDb, input: { orgId: string; requestId: string; userId: string; now: Date }): Promise<boolean> {
  const rows = await db
    .update(walletSigningSigners)
    .set({ declinedAt: input.now, updatedAt: input.now })
    .where(
      and(
        eq(walletSigningSigners.requestId, input.requestId),
        eq(walletSigningSigners.orgId, input.orgId),
        eq(walletSigningSigners.userId, input.userId),
        isNull(walletSigningSigners.signedAt),
        isNull(walletSigningSigners.declinedAt),
        sql`exists (select 1 from ${walletSigningRequests} r where r.id = ${input.requestId} and r.org_id = ${input.orgId} and r.status = 'collecting')`,
      ),
    )
    .returning({ userId: walletSigningSigners.userId });
  return rows.length === 1;
}

/** Move a collecting request to submitting, and say when. Only one caller wins. */
export async function claimSubmission(db: DrizzleDb, orgId: string, id: string, now: Date): Promise<boolean> {
  const rows = await db
    .update(walletSigningRequests)
    .set({ status: 'submitting', claimedAt: now, updatedAt: now })
    .where(and(eq(walletSigningRequests.id, id), eq(walletSigningRequests.orgId, orgId), eq(walletSigningRequests.status, 'collecting'), gt(walletSigningRequests.expiresAt, now)))
    .returning({ id: walletSigningRequests.id });
  return rows.length === 1;
}

async function clearSignatures(tx: Parameters<Parameters<DrizzleDb['transaction']>[0]>[0], ids: string[], now: Date) {
  if (ids.length === 0) return;
  await tx.update(walletSigningSigners).set({ signature: null, updatedAt: now }).where(inArray(walletSigningSigners.requestId, ids));
}

/** Close a request and clear every partial signature with it. */
export async function closeSigningRequest(
  db: DrizzleDb,
  input: { orgId: string; id: string; status: Exclude<SigningStatus, 'collecting' | 'submitting' | 'unknown'>; from: SigningStatus[]; executedDigest?: string | null; error?: string | null; now: Date },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(walletSigningRequests)
      .set({ status: input.status, executedDigest: input.executedDigest ?? null, error: input.error ?? null, closedAt: input.now, updatedAt: input.now })
      .where(and(eq(walletSigningRequests.id, input.id), eq(walletSigningRequests.orgId, input.orgId), inArray(walletSigningRequests.status, input.from)))
      .returning({ id: walletSigningRequests.id });
    if (rows.length !== 1) return false;
    await clearSignatures(tx, [input.id], input.now);
    return true;
  });
}

/**
 * The transaction went to the network and nobody knows yet whether it
 * landed. The request keeps its digest and its dedupe key; the partial
 * signatures are cleared (the combined signature was already sent, and
 * they are not needed to learn the outcome).
 */
export async function markOutcomeUnknown(
  db: DrizzleDb,
  input: { orgId: string; id: string; from: SigningStatus[]; error: string; now: Date },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(walletSigningRequests)
      .set({ status: 'unknown', executedDigest: sql`${walletSigningRequests.txDigest}`, error: input.error, updatedAt: input.now })
      .where(and(eq(walletSigningRequests.id, input.id), eq(walletSigningRequests.orgId, input.orgId), inArray(walletSigningRequests.status, input.from)))
      .returning({ id: walletSigningRequests.id });
    if (rows.length !== 1) return false;
    await clearSignatures(tx, [input.id], input.now);
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
 * Gas budget, in MIST, of the sponsored requests this org opened since
 * `since`: what the sponsor has agreed to pay for at most. Read from the
 * server's own decoding of the bytes (`summary.description.gas.budget`).
 */
export async function sponsoredBudgetSince(db: DrizzleDb, orgId: string, since: Date, purpose?: SigningPurpose): Promise<bigint> {
  const rows = await db
    .select({ total: sql<string>`coalesce(sum((${walletSigningRequests.summary}->'description'->'gas'->>'budget')::numeric), 0)::text` })
    .from(walletSigningRequests)
    .where(and(eq(walletSigningRequests.orgId, orgId), eq(walletSigningRequests.gasMode, 'sponsored'), gte(walletSigningRequests.createdAt, since), ...(purpose ? [eq(walletSigningRequests.purpose, purpose)] : [])));
  const requests = BigInt(String(rows[0]?.total ?? '0').split('.')[0]);
  if (purpose) return requests;
  // The payments an automatic scheduled run sent are sponsored too (migration 0069), and share the same 24-hour allowance.
  const scheduled = await db
    .select({ total: sql<string>`coalesce(sum(${paymentScheduleRunPayments.gasBudgetMist}), 0)::text` })
    .from(paymentScheduleRunPayments)
    .where(and(eq(paymentScheduleRunPayments.orgId, orgId), gte(paymentScheduleRunPayments.attemptedAt, since)));
  return requests + BigInt(String(scheduled[0]?.total ?? '0').split('.')[0]);
}

// ─── Single-signer consents (D1) ────────────────────────────────────────────

export async function recordSingleSignerConsent(db: DrizzleDb, input: { orgId: string; userId: string; walletAddress: string }): Promise<void> {
  await db.insert(walletSingleSignerConsents).values(input).onConflictDoNothing();
}

/** Who in this org agreed to this single-signer wallet address. */
export async function singleSignerConsents(db: DrizzleDb, orgId: string, walletAddress: string): Promise<string[]> {
  const rows = await db
    .select({ userId: walletSingleSignerConsents.userId })
    .from(walletSingleSignerConsents)
    .where(and(eq(walletSingleSignerConsents.orgId, orgId), eq(walletSingleSignerConsents.walletAddress, walletAddress)));
  return rows.map((r) => r.userId);
}

// ─── The cron (cross-tenant, close and reconcile only) ──────────────────────

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
    await clearSignatures(tx, rows.map((r) => r.id), now);
    return rows.length;
  });
}

/**
 * Requests whose outcome the cron must find out: submitting for longer than
 * the lease (the process that claimed them may be gone), and every unknown.
 */
export async function listInFlightForStaff(db: DrizzleDb, leaseCutoff: Date): Promise<StoredRequest[]> {
  const rows = await db
    .select()
    .from(walletSigningRequests)
    .where(
      or(
        and(eq(walletSigningRequests.status, 'submitting'), or(isNull(walletSigningRequests.claimedAt), lte(walletSigningRequests.claimedAt, leaseCutoff))),
        eq(walletSigningRequests.status, 'unknown'),
      ),
    )
    .limit(200);
  return Promise.all(rows.map(async (row) => toRequest(row, await signersOf(db, row.id))));
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

/** Requests still submitting past the lease after reconciling: must be zero. */
export async function countStuckSubmissionsForStaff(db: DrizzleDb, leaseCutoff: Date): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(walletSigningRequests)
    .where(and(eq(walletSigningRequests.status, 'submitting'), or(isNull(walletSigningRequests.claimedAt), lte(walletSigningRequests.claimedAt, leaseCutoff))));
  return Number(rows[0]?.n ?? 0);
}
