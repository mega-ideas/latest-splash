import 'server-only';

import { and, desc, eq } from 'drizzle-orm';

import { kybCases } from '@/lib/db/schema';

/**
 * Postgres access for KYB review cases.
 *
 * Same shape as the other repositories: this module knows the table, the store
 * above it knows the rules, and nothing else touches either. Every read that a
 * customer can reach takes an `orgId`; the two that deliberately cross tenants
 * are named `*ForStaff` so a call site cannot use one by accident.
 */

export type KybCaseRow = {
  id: string;
  orgId: string;
  businessName: string;
  registrationNumber: string;
  state: string;
  riskTier: string;
  corridorAccess: string;
  assignedTo: string | null;
  sumsubApplicantId: string | null;
  documents: unknown;
  reviewNotes: string | null;
  decisionReason: string | null;
  auditTrail: unknown;
  submittedAt: Date;
  updatedAt: Date;
};

type Db = {
  select: (...args: never[]) => never;
  insert: (...args: never[]) => never;
  update: (...args: never[]) => never;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyDb = any;

export async function insertOrUpdate(db: Db, row: {
  id: string;
  orgId: string;
  businessName: string;
  registrationNumber: string;
  state: string;
  riskTier: string;
  corridorAccess: string;
  assignedTo: string | null;
  sumsubApplicantId: string | null;
  documents: unknown;
  reviewNotes: string | null;
  decisionReason: string | null;
  auditTrail: unknown;
  submittedAt: Date;
  updatedAt: Date;
}): Promise<void> {
  await (db as AnyDb)
    .insert(kybCases)
    .values(row)
    .onConflictDoUpdate({
      target: kybCases.id,
      set: {
        businessName: row.businessName,
        registrationNumber: row.registrationNumber,
        state: row.state,
        riskTier: row.riskTier,
        corridorAccess: row.corridorAccess,
        assignedTo: row.assignedTo,
        sumsubApplicantId: row.sumsubApplicantId,
        documents: row.documents,
        reviewNotes: row.reviewNotes,
        decisionReason: row.decisionReason,
        auditTrail: row.auditTrail,
        updatedAt: row.updatedAt,
      },
    });
}

/** One case, only if it belongs to this org. */
export async function findForOrg(db: Db, orgId: string, id: string): Promise<KybCaseRow | null> {
  const rows = await (db as AnyDb)
    .select()
    .from(kybCases)
    .where(and(eq(kybCases.id, id), eq(kybCases.orgId, orgId)))
    .limit(1);
  return (rows[0] as KybCaseRow) ?? null;
}

/** This org's cases, newest first. */
export async function listForOrg(db: Db, orgId: string): Promise<KybCaseRow[]> {
  return (await (db as AnyDb)
    .select()
    .from(kybCases)
    .where(eq(kybCases.orgId, orgId))
    .orderBy(desc(kybCases.updatedAt))) as KybCaseRow[];
}

/** Compliance staff review every tenant's cases; that is the job. */
export async function listAllForStaff(db: Db, limit = 500): Promise<KybCaseRow[]> {
  return (await (db as AnyDb)
    .select()
    .from(kybCases)
    .orderBy(desc(kybCases.updatedAt))
    .limit(limit)) as KybCaseRow[];
}

export async function findForStaff(db: Db, id: string): Promise<KybCaseRow | null> {
  const rows = await (db as AnyDb).select().from(kybCases).where(eq(kybCases.id, id)).limit(1);
  return (rows[0] as KybCaseRow) ?? null;
}
