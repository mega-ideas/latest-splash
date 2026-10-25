/**
 * The fund-manager referral for one business (v2 D9, brief 5.7; migration
 * 0055): the eligibility answers an owner gave, what they mean, when the
 * referral link was opened, and the business's account reference at the
 * fund manager once linked.
 *
 * One row per org, and every read and write takes the org (WS2). A linked
 * reference is unique across businesses, so no business can link, and then
 * read, a holding that another business already linked. Once linked, the
 * answers are kept: a later reassessment is refused rather than allowed to
 * leave a "not eligible" business holding a linked account.
 */
import { and, eq, isNull } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';

import { treasuryFundReferrals } from '../db/schema.ts';
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
  };
}

export async function readFundReferral(db: DrizzleDb, orgId: string): Promise<FundReferral | null> {
  const [row] = await db.select().from(treasuryFundReferrals).where(eq(treasuryFundReferrals.orgId, orgId)).limit(1);
  return row ? toReferral(row) : null;
}

/** Record the answers and their meaning. Refused once the business has linked an account. */
export async function recordFundAssessment(
  db: DrizzleDb,
  input: { orgId: string; answers: FundAnswers; eligibility: FundEligibility; assessedBy: string; now?: Date },
): Promise<{ ok: true; referral: FundReferral } | { ok: false; code: 'already_linked' }> {
  const now = input.now ?? new Date();
  const values = {
    answers: input.answers,
    outcome: input.eligibility.outcome,
    category: input.eligibility.category,
    assessedBy: input.assessedBy,
    assessedAt: now,
    updatedAt: now,
  };
  const [row] = await db
    .insert(treasuryFundReferrals)
    .values({ orgId: input.orgId, ...values, createdAt: now })
    .onConflictDoUpdate({
      target: treasuryFundReferrals.orgId,
      set: { ...values, referralOpenedAt: null },
      setWhere: isNull(treasuryFundReferrals.linkedReference),
    })
    .returning();
  if (!row) return { ok: false, code: 'already_linked' };
  return { ok: true, referral: toReferral(row) };
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

/**
 * Link the business's account at the fund manager, once. Only an eligible
 * business links; a reference another business holds is refused.
 */
export async function linkFundAccount(
  db: DrizzleDb,
  input: { orgId: string; reference: string; linkedBy: string; now?: Date },
): Promise<LinkResult> {
  const reference = input.reference.trim();
  if (!FUND_REFERENCE.test(reference)) return { ok: false, code: 'bad_reference' };
  const current = await readFundReferral(db, input.orgId);
  if (!current || current.outcome !== 'eligible') return { ok: false, code: 'not_eligible' };
  if (current.linkedReference) return { ok: false, code: 'already_linked' };
  const now = input.now ?? new Date();
  try {
    const [row] = await db
      .update(treasuryFundReferrals)
      .set({ linkedReference: reference, linkedBy: input.linkedBy, linkedAt: now, updatedAt: now })
      .where(and(
        eq(treasuryFundReferrals.orgId, input.orgId),
        eq(treasuryFundReferrals.outcome, 'eligible'),
        isNull(treasuryFundReferrals.linkedReference),
      ))
      .returning();
    if (!row) return { ok: false, code: 'already_linked' };
    return { ok: true, referral: toReferral(row) };
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, code: 'reference_taken' };
    throw error;
  }
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
