/**
 * The fund-manager referral for one business (v2 D9, brief 5.7; migrations
 * 0055 and 0056): the eligibility answers an owner gave, what they mean,
 * when the referral link was opened, and the business's account reference at
 * the fund manager once the fund manager has confirmed it.
 *
 * One current row per org, and every read and write takes the org (WS2);
 * cross-tenant reads are spelled `*ForStaff`.
 *
 * Nothing is overwritten without a trace. Every assessment, every confirmed
 * link and every release by support is appended to
 * `treasury_fund_referral_history`, and the current row points at the latest
 * assessment, so a business that first declared it did not qualify still
 * shows that declaration after it answers again (the 5.7 review).
 *
 * A linked reference is stored only after the fund manager confirmed it
 * belongs to this business (by its registration number), so a business
 * cannot claim another's reference by typing it first. It stays unique across
 * businesses. Once linked, the answers are kept: a later reassessment is
 * refused rather than allowed to leave a "not eligible" business holding a
 * linked account. Support can release a link, with a reason.
 */
import { randomUUID } from 'node:crypto';

import { and, asc, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';

import { organizations, treasuryFundReferralHistory, treasuryFundReferrals } from '../db/schema.ts';
import type * as schemaModule from '../db/schema.ts';
import type { FundAnswers, FundCategory, FundEligibility } from '../treasury/fund-eligibility.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DrizzleDb = PgDatabase<any, typeof schemaModule, any>;

export type FundReferral = {
  orgId: string;
  answers: FundAnswers;
  outcome: 'eligible' | 'not_eligible';
  category: FundCategory | null;
  assessedAt: Date;
  referralOpenedAt: Date | null;
  linkedReference: string | null;
  linkedAt: Date | null;
  linkConfirmedAt: Date | null;
};

export type FundHistoryEntry = {
  id: string;
  kind: 'assessed' | 'linked' | 'released';
  actor: string;
  at: Date;
  answers: FundAnswers | null;
  outcome: 'eligible' | 'not_eligible' | null;
  category: FundCategory | null;
  reference: string | null;
  reason: string | null;
};

/** An account reference at the fund manager: short, plain characters. */
export const FUND_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9-]{3,39}$/;

function toReferral(row: typeof treasuryFundReferrals.$inferSelect): FundReferral {
  return {
    orgId: row.orgId,
    answers: row.answers as FundAnswers,
    outcome: row.outcome as FundReferral['outcome'],
    category: (row.category as FundCategory | null) ?? null,
    assessedAt: row.assessedAt,
    referralOpenedAt: row.referralOpenedAt,
    linkedReference: row.linkedReference,
    linkedAt: row.linkedAt,
    linkConfirmedAt: row.linkConfirmedAt,
  };
}

function toHistory(row: typeof treasuryFundReferralHistory.$inferSelect): FundHistoryEntry {
  return {
    id: row.id,
    kind: row.kind as FundHistoryEntry['kind'],
    actor: row.actor,
    at: row.at,
    answers: (row.answers as FundAnswers | null) ?? null,
    outcome: (row.outcome as FundHistoryEntry['outcome']) ?? null,
    category: (row.category as FundCategory | null) ?? null,
    reference: row.reference,
    reason: row.reason,
  };
}

const historyId = () => `tfh_${randomUUID()}`;

export async function readFundReferral(db: DrizzleDb, orgId: string): Promise<FundReferral | null> {
  const [row] = await db.select().from(treasuryFundReferrals).where(eq(treasuryFundReferrals.orgId, orgId)).limit(1);
  return row ? toReferral(row) : null;
}

/** The business's registration number, which the fund manager confirms a reference against. */
export async function readOrgRegistrationNumber(db: DrizzleDb, orgId: string): Promise<string | null> {
  const [row] = await db.select({ registrationNumber: organizations.registrationNumber }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  const value = (row?.registrationNumber ?? '').trim();
  return value || null;
}

/** This business's own assessments, newest first. */
export async function listFundAssessments(db: DrizzleDb, orgId: string): Promise<FundHistoryEntry[]> {
  const rows = await db
    .select()
    .from(treasuryFundReferralHistory)
    .where(and(eq(treasuryFundReferralHistory.orgId, orgId), eq(treasuryFundReferralHistory.kind, 'assessed')))
    .orderBy(desc(treasuryFundReferralHistory.seq))
    .limit(50);
  return rows.map(toHistory);
}

class AlreadyLinked extends Error {}

/**
 * Record the answers and their meaning, appended to the history; the current
 * row points at it. Refused (and nothing appended) once the business has
 * linked an account.
 */
export async function recordFundAssessment(
  db: DrizzleDb,
  input: { orgId: string; answers: FundAnswers; eligibility: FundEligibility; assessedBy: string; now?: Date },
): Promise<{ ok: true; referral: FundReferral } | { ok: false; code: 'already_linked' }> {
  const now = input.now ?? new Date();
  const id = historyId();
  try {
    return await db.transaction(async (tx) => {
      await tx.insert(treasuryFundReferralHistory).values({
        id,
        orgId: input.orgId,
        kind: 'assessed',
        actor: input.assessedBy,
        at: now,
        answers: input.answers,
        outcome: input.eligibility.outcome,
        category: input.eligibility.category,
      });
      const values = {
        answers: input.answers,
        outcome: input.eligibility.outcome,
        category: input.eligibility.category,
        assessedBy: input.assessedBy,
        assessedAt: now,
        latestAssessmentId: id,
        updatedAt: now,
      };
      const [row] = await tx
        .insert(treasuryFundReferrals)
        .values({ orgId: input.orgId, ...values, createdAt: now })
        .onConflictDoUpdate({
          target: treasuryFundReferrals.orgId,
          set: { ...values, referralOpenedAt: null },
          setWhere: isNull(treasuryFundReferrals.linkedReference),
        })
        .returning();
      if (!row) throw new AlreadyLinked();
      return { ok: true as const, referral: toReferral(row) };
    });
  } catch (error) {
    if (error instanceof AlreadyLinked) return { ok: false, code: 'already_linked' };
    throw error;
  }
}

/** Note that an eligible business opened the referral link. */
export async function markReferralOpened(db: DrizzleDb, orgId: string, now = new Date()): Promise<boolean> {
  const rows = await db
    .update(treasuryFundReferrals)
    .set({ referralOpenedAt: now, updatedAt: now })
    .where(and(eq(treasuryFundReferrals.orgId, orgId), eq(treasuryFundReferrals.outcome, 'eligible')))
    .returning({ orgId: treasuryFundReferrals.orgId });
  return rows.length === 1;
}

export type LinkResult =
  | { ok: true; referral: FundReferral }
  | { ok: false; code: 'not_eligible' | 'already_linked' | 'reference_taken' | 'bad_reference' };

/** Whether a reference is well formed and this business may link one now. Nothing is written. */
export async function checkFundLink(db: DrizzleDb, orgId: string, reference: string): Promise<{ ok: true; reference: string } | { ok: false; code: 'not_eligible' | 'already_linked' | 'bad_reference' }> {
  const trimmed = reference.trim();
  if (!FUND_REFERENCE.test(trimmed)) return { ok: false, code: 'bad_reference' };
  const current = await readFundReferral(db, orgId);
  if (!current || current.outcome !== 'eligible') return { ok: false, code: 'not_eligible' };
  if (current.linkedReference) return { ok: false, code: 'already_linked' };
  return { ok: true, reference: trimmed };
}

/**
 * Link the business's account at the fund manager, once, after the fund
 * manager has confirmed the reference is this business's (`confirmedAt`; the
 * caller asks it). Only an eligible business links; a reference another
 * business holds is refused. The link is appended to the history.
 */
export async function linkFundAccount(
  db: DrizzleDb,
  input: { orgId: string; reference: string; linkedBy: string; confirmedAt: Date; now?: Date },
): Promise<LinkResult> {
  const checked = await checkFundLink(db, input.orgId, input.reference);
  if (!checked.ok) return checked;
  const reference = checked.reference;
  const now = input.now ?? new Date();
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .update(treasuryFundReferrals)
        .set({ linkedReference: reference, linkedBy: input.linkedBy, linkedAt: now, linkConfirmedAt: input.confirmedAt, updatedAt: now })
        .where(and(
          eq(treasuryFundReferrals.orgId, input.orgId),
          eq(treasuryFundReferrals.outcome, 'eligible'),
          isNull(treasuryFundReferrals.linkedReference),
        ))
        .returning();
      if (!row) return { ok: false as const, code: 'already_linked' as const };
      await tx.insert(treasuryFundReferralHistory).values({ id: historyId(), orgId: input.orgId, kind: 'linked', actor: input.linkedBy, at: now, reference });
      return { ok: true as const, referral: toReferral(row) };
    });
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, code: 'reference_taken' };
    throw error;
  }
}

/* ── Support ───────────────────────────────────────────────────────────── */

/**
 * Release a business's linked reference: support's answer to a link made to
 * the wrong account. Needs a reason, and is appended to the history with who
 * released it. The answers stay; the business links again.
 */
export async function releaseFundLinkForStaff(
  db: DrizzleDb,
  input: { orgId: string; releasedBy: string; reason: string; now?: Date },
): Promise<{ ok: true } | { ok: false; code: 'reason_required' | 'not_linked' }> {
  const reason = input.reason.trim();
  if (!reason) return { ok: false, code: 'reason_required' };
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ reference: treasuryFundReferrals.linkedReference })
      .from(treasuryFundReferrals)
      .where(and(eq(treasuryFundReferrals.orgId, input.orgId), isNotNull(treasuryFundReferrals.linkedReference)))
      .limit(1);
    if (!current?.reference) return { ok: false as const, code: 'not_linked' as const };
    await tx
      .update(treasuryFundReferrals)
      .set({ linkedReference: null, linkedBy: null, linkedAt: null, linkConfirmedAt: null, updatedAt: now })
      .where(eq(treasuryFundReferrals.orgId, input.orgId));
    await tx.insert(treasuryFundReferralHistory).values({
      id: historyId(), orgId: input.orgId, kind: 'released', actor: input.releasedBy, at: now, reference: current.reference, reason,
    });
    return { ok: true as const };
  });
}

/** One business's referral history, oldest first: for staff and the controls record. */
export async function listFundReferralHistoryForStaff(db: DrizzleDb, orgId: string): Promise<FundHistoryEntry[]> {
  const rows = await db
    .select()
    .from(treasuryFundReferralHistory)
    .where(eq(treasuryFundReferralHistory.orgId, orgId))
    .orderBy(asc(treasuryFundReferralHistory.seq));
  return rows.map(toHistory);
}

/** Every business's current referral, newest change first. Cross-tenant by design, behind a staff session. */
export async function listFundReferralsForStaff(db: DrizzleDb, limit = 200): Promise<FundReferral[]> {
  const rows = await db.select().from(treasuryFundReferrals).orderBy(desc(treasuryFundReferrals.updatedAt)).limit(Math.max(1, Math.min(limit, 500)));
  return rows.map(toReferral);
}

function isUniqueViolation(error: unknown): boolean {
  let e: unknown = error;
  for (let i = 0; i < 4 && e; i += 1) {
    const code = (e as { code?: unknown }).code;
    if (code === '23505') return true;
    if (/duplicate key|unique constraint/i.test(String((e as { message?: unknown }).message ?? ''))) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}
