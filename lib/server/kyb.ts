import * as repo from './repository/kyb-cases.ts';

/**
 * The one way to read or write a KYB review case.
 *
 * ─── What this replaces, and why it mattered ────────────────────────────────
 *
 * Cases lived in a `globalThis` Map seeded with two invented companies. Two
 * things followed from that, and the second is the serious one.
 *
 * They did not survive a restart, so a business that uploaded documents could
 * come back to find no record of having done so.
 *
 * And every customer-facing read was authenticated but not SCOPED.
 * `GET /api/kyb/cases/[id]` returned any case to any signed-in user, and
 * `GET /api/kyb/cases/latest` took a business name from the QUERY STRING and
 * searched every case in the process — so one customer could enumerate another
 * company's KYB case by guessing their name. What came back was the
 * registration number, the name and SHA-256 of every document they uploaded,
 * the reviewer's notes and the reason they were rejected. That is precisely the
 * material a KYB file exists to protect.
 *
 * So: `orgId` on every customer read, not optional, and the two staff-wide
 * reads spelled `*ForStaff` so reaching across tenants is visible at the call
 * site rather than implied by an absent argument.
 *
 * ─── Two backends, like every other store here ──────────────────────────────
 *
 * Postgres when `DATABASE_URL` is set; the in-process map only when it is not,
 * because `npm run dev` has to work without a database. The seeded demo
 * companies stay on the memory path ONLY — a fixture in a real database is a
 * fake compliance record, and the admin console cannot tell it from a customer.
 */

export type KybReviewState = 'SUBMITTED' | 'IN_REVIEW' | 'NEEDS_INFORMATION' | 'APPROVED' | 'REJECTED';

export type KybDocumentRecord = {
  name: string;
  kind: 'COMPANY_DOCUMENT' | 'DIRECTOR_ID';
  type: string;
  size: number;
  sha256: string;
  storageKey: string;
  virusScanResult: 'PENDING' | 'PASSED' | 'FAILED';
  uploadedAt: string;
};

export type KybAuditEvent = {
  id: string;
  actor: string;
  action: string;
  note: string | null;
  createdAt: string;
};

export type KybCaseRecord = {
  id: string;
  /** Owning organization. Wallet spec §3 — the KYB lifecycle is assessed at org
   *  level, and the on-chain verify must target THAT org's BusinessAccount. */
  orgId: string;
  businessName: string;
  registrationNumber: string;
  state: KybReviewState;
  riskTier: 'UNASSIGNED' | 'TIER_1' | 'TIER_2' | 'RESTRICTED';
  corridorAccess: 'LOCKED' | 'LIMITED' | 'FULL';
  submittedAt: string;
  updatedAt: string;
  assignedTo: string | null;
  sumsubApplicantId: string | null;
  documents: KybDocumentRecord[];
  reviewNotes: string | null;
  decisionReason: string | null;
  auditTrail: KybAuditEvent[];
};

type KybStore = { cases: Map<string, KybCaseRecord> };

const globalStore = globalThis as typeof globalThis & { splashKybStore?: KybStore };

let announced = false;

function usingPostgres(): boolean {
  if (process.env.DATABASE_URL) return true;
  if (!announced) {
    announced = true;
    console.warn(
      '[kyb] DATABASE_URL is not set, so KYB cases live in this process and ' +
        'disappear when it restarts. Local development only.',
    );
  }
  return false;
}

async function db() {
  const { getDb } = await import('../db/client.ts');
  return getDb() as never;
}

function id(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function event(actor: string, action: string, note?: string | null): KybAuditEvent {
  return { id: id('audit'), actor, action, note: note ?? null, createdAt: new Date().toISOString() };
}

function sampleDocument(caseId: string, name: string, kind: KybDocumentRecord['kind']): KybDocumentRecord {
  return {
    name,
    kind,
    type: 'application/pdf',
    size: kind === 'DIRECTOR_ID' ? 384221 : 791205,
    sha256: `${caseId}_${kind}`.padEnd(64, '0').slice(0, 64),
    storageKey: `encrypted/kyb/${caseId}/${name}`,
    virusScanResult: 'PASSED',
    uploadedAt: new Date(Date.now() - 1000 * 60 * 42).toISOString(),
  };
}

/**
 * Demo cases for the memory backend only.
 *
 * These are two companies that do not exist. They are useful for looking at the
 * admin console without a database and actively harmful in one: a reviewer
 * cannot tell a fixture from a real applicant, and "Acme Trading Sdn Bhd,
 * SUBMITTED" in a production queue is a business waiting on a decision that
 * nobody will ever make.
 */
function seededCases() {
  const firstSubmittedAt = new Date(Date.now() - 1000 * 60 * 92).toISOString();
  const secondSubmittedAt = new Date(Date.now() - 1000 * 60 * 240).toISOString();
  const firstCaseId = 'kyb_demo_acme_sdn_bhd';
  const secondCaseId = 'kyb_demo_nusantara_exports';

  return new Map<string, KybCaseRecord>([
    [
      firstCaseId,
      {
        id: firstCaseId,
        orgId: 'demo-business',
        businessName: 'Acme Trading Sdn Bhd',
        registrationNumber: '202401012345',
        state: 'SUBMITTED',
        riskTier: 'UNASSIGNED',
        corridorAccess: 'LOCKED',
        submittedAt: firstSubmittedAt,
        updatedAt: firstSubmittedAt,
        assignedTo: null,
        sumsubApplicantId: 'sumsub_acme_01',
        documents: [
          sampleDocument(firstCaseId, 'form-9-acme.pdf', 'COMPANY_DOCUMENT'),
          sampleDocument(firstCaseId, 'director-id-acme.pdf', 'DIRECTOR_ID'),
        ],
        reviewNotes: null,
        decisionReason: null,
        auditTrail: [event('system', 'kyb.submitted', 'Documents uploaded and Sumsub applicant created')],
      },
    ],
    [
      secondCaseId,
      {
        id: secondCaseId,
        orgId: 'demo-business',
        businessName: 'Nusantara Export House Sdn Bhd',
        registrationNumber: '202301998877',
        state: 'NEEDS_INFORMATION',
        riskTier: 'UNASSIGNED',
        corridorAccess: 'LOCKED',
        submittedAt: secondSubmittedAt,
        updatedAt: new Date(Date.now() - 1000 * 60 * 55).toISOString(),
        assignedTo: 'compliance@splash.finance',
        sumsubApplicantId: 'sumsub_nusantara_02',
        documents: [
          sampleDocument(secondCaseId, 'company-profile.pdf', 'COMPANY_DOCUMENT'),
          sampleDocument(secondCaseId, 'director-passport.pdf', 'DIRECTOR_ID'),
        ],
        reviewNotes: 'Request latest SSM profile and UBO ownership chart before approval.',
        decisionReason: 'Missing UBO evidence',
        auditTrail: [
          event('system', 'kyb.submitted', 'Documents uploaded and Sumsub applicant created'),
          event('compliance@splash.finance', 'kyb.needs_information', 'Missing UBO evidence'),
        ],
      },
    ],
  ]);
}

/** The memory backend. Private to this module — see scripts/check-store-access.mjs. */
const memory: KybStore = (globalStore.splashKybStore ??= { cases: seededCases() });

function toRecord(row: repo.KybCaseRow): KybCaseRecord {
  return {
    id: row.id,
    orgId: row.orgId,
    businessName: row.businessName,
    registrationNumber: row.registrationNumber,
    state: row.state as KybReviewState,
    riskTier: row.riskTier as KybCaseRecord['riskTier'],
    corridorAccess: row.corridorAccess as KybCaseRecord['corridorAccess'],
    submittedAt: row.submittedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    assignedTo: row.assignedTo,
    sumsubApplicantId: row.sumsubApplicantId,
    documents: Array.isArray(row.documents) ? (row.documents as KybDocumentRecord[]) : [],
    reviewNotes: row.reviewNotes,
    decisionReason: row.decisionReason,
    auditTrail: Array.isArray(row.auditTrail) ? (row.auditTrail as KybAuditEvent[]) : [],
  };
}

function byRecency(a: KybCaseRecord, b: KybCaseRecord) {
  return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
}

async function persist(record: KybCaseRecord): Promise<KybCaseRecord> {
  if (!usingPostgres()) {
    memory.cases.set(record.id, record);
    return record;
  }
  await repo.insertOrUpdate(await db(), {
    id: record.id,
    orgId: record.orgId,
    businessName: record.businessName,
    registrationNumber: record.registrationNumber,
    state: record.state,
    riskTier: record.riskTier,
    corridorAccess: record.corridorAccess,
    assignedTo: record.assignedTo,
    sumsubApplicantId: record.sumsubApplicantId,
    documents: record.documents,
    reviewNotes: record.reviewNotes,
    decisionReason: record.decisionReason,
    auditTrail: record.auditTrail,
    submittedAt: new Date(record.submittedAt),
    updatedAt: new Date(record.updatedAt),
  });
  return record;
}

// ── Customer-facing reads. `orgId` is required, every time. ─────────────────

/** This organisation's cases, newest first. */
export async function listKybCases(orgId: string): Promise<KybCaseRecord[]> {
  if (!usingPostgres()) {
    return Array.from(memory.cases.values())
      .filter((record) => record.orgId === orgId)
      .sort(byRecency);
  }
  return (await repo.listForOrg(await db(), orgId)).map(toRecord);
}

/** One case, and only if this organisation owns it. */
export async function readKybCase(orgId: string, caseId: string): Promise<KybCaseRecord | null> {
  if (!usingPostgres()) {
    const record = memory.cases.get(caseId) ?? null;
    return record && record.orgId === orgId ? record : null;
  }
  const row = await repo.findForOrg(await db(), orgId, caseId);
  return row ? toRecord(row) : null;
}

/**
 * This organisation's most recent case.
 *
 * It no longer takes a business name or a registration number. Those came from
 * the query string and were matched against every case in the process, which
 * made "which case is mine" answerable as "which case is anyone's". An
 * organisation has one KYB history and the session already says which
 * organisation is asking, so there is nothing left for the caller to supply.
 */
export async function findLatestKybCase(orgId: string): Promise<KybCaseRecord | null> {
  const cases = await listKybCases(orgId);
  return cases[0] ?? null;
}

// ── Staff reads. Cross-tenant by design, and named for it. ──────────────────

export async function listKybCasesForStaff(): Promise<KybCaseRecord[]> {
  if (!usingPostgres()) return Array.from(memory.cases.values()).sort(byRecency);
  return (await repo.listAllForStaff(await db())).map(toRecord);
}

export async function readKybCaseForStaff(caseId: string): Promise<KybCaseRecord | null> {
  if (!usingPostgres()) return memory.cases.get(caseId) ?? null;
  const row = await repo.findForStaff(await db(), caseId);
  return row ? toRecord(row) : null;
}

// ── Writes ─────────────────────────────────────────────────────────────────

export async function recordKybSubmission(input: {
  caseId: string;
  orgId: string;
  businessName: string;
  registrationNumber: string;
  documents: KybDocumentRecord[];
  sumsubApplicantId?: string | null;
}): Promise<KybCaseRecord> {
  const now = new Date().toISOString();
  // Read as staff: a resubmission is the same case, and scoping the lookup to
  // the submitting org would be right but pointless — the org is written below
  // either way, and a case id collision across orgs is not a thing we want to
  // resolve by silently creating a second row.
  const existing = await readKybCaseForStaff(input.caseId);

  const record: KybCaseRecord = {
    id: input.caseId,
    orgId: input.orgId,
    businessName: input.businessName,
    registrationNumber: input.registrationNumber,
    state: 'SUBMITTED',
    riskTier: 'UNASSIGNED',
    corridorAccess: 'LOCKED',
    submittedAt: existing?.submittedAt ?? now,
    updatedAt: now,
    assignedTo: existing?.assignedTo ?? null,
    sumsubApplicantId: input.sumsubApplicantId ?? existing?.sumsubApplicantId ?? null,
    documents: input.documents,
    reviewNotes: existing?.reviewNotes ?? null,
    decisionReason: existing?.decisionReason ?? null,
    auditTrail: [
      ...(existing?.auditTrail ?? []),
      event('system', 'kyb.submitted', 'Merchant submitted KYB documents'),
    ],
  };

  return persist(record);
}

export async function attachSumsubApplicant(
  caseId: string,
  applicantId: string | null,
): Promise<KybCaseRecord | null> {
  const record = await readKybCaseForStaff(caseId);
  if (!record || !applicantId) return record ?? null;

  return persist({
    ...record,
    sumsubApplicantId: applicantId,
    updatedAt: new Date().toISOString(),
    auditTrail: [...record.auditTrail, event('system', 'kyb.sumsub_linked', `Applicant ${applicantId}`)],
  });
}

export async function reviewKybCase(
  caseId: string,
  input: { state: KybReviewState; actor: string; note?: string; assignedTo?: string | null },
): Promise<KybCaseRecord | null> {
  const record = await readKybCaseForStaff(caseId);
  if (!record) return null;

  const note = input.note?.trim() || null;
  return persist({
    ...record,
    state: input.state,
    updatedAt: new Date().toISOString(),
    assignedTo: input.assignedTo === undefined ? record.assignedTo : input.assignedTo,
    reviewNotes: note ?? record.reviewNotes,
    decisionReason: input.state === 'APPROVED' ? null : note ?? record.decisionReason,
    riskTier:
      input.state === 'APPROVED' ? 'TIER_1' : input.state === 'REJECTED' ? 'RESTRICTED' : record.riskTier,
    corridorAccess:
      input.state === 'APPROVED' ? 'FULL' : input.state === 'REJECTED' ? 'LOCKED' : record.corridorAccess,
    auditTrail: [
      ...record.auditTrail,
      event(input.actor, `kyb.${String(input.state ?? 'unknown').toLowerCase()}`, note),
    ],
  });
}
