import { NextResponse } from 'next/server';

import { resolveAuthorityForSession, UnauthorizedError } from '@/lib/auth/authority';
import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { findLatestKybCase, type KybCaseRecord } from '@/lib/server/kyb';

export const dynamic = 'force-dynamic';

function toPublicCase(record: KybCaseRecord) {
  return {
    id: record.id,
    businessName: record.businessName,
    registrationNumber: record.registrationNumber,
    state: record.state,
    riskTier: record.riskTier,
    corridorAccess: record.corridorAccess,
    submittedAt: record.submittedAt,
    updatedAt: record.updatedAt,
    sumsubApplicantId: record.sumsubApplicantId,
    reviewNotes: record.reviewNotes,
    decisionReason: record.decisionReason,
    documents: record.documents.map((document) => ({
      name: document.name,
      kind: document.kind,
      type: document.type,
      size: document.size,
      sha256: document.sha256,
      virusScanResult: document.virusScanResult,
      uploadedAt: document.uploadedAt,
    })),
  };
}

export async function GET(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;

  // The business name and registration number used to come from the QUERY
  // STRING and were matched against every case in the process. That made
  // "which case is mine" answerable as "which case is anyone's": pass a
  // competitor's name and receive their KYB file.
  //
  // An organisation has one KYB history and the session already says which
  // organisation is asking, so the caller supplies nothing.
  let orgId: string;
  try {
    orgId = (await resolveAuthorityForSession(auth.session)).orgId;
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      // A brand-new sign-up with no membership has no case yet. That is an
      // answer, not a failure.
      return NextResponse.json({ case: null });
    }
    throw error;
  }

  const record = await findLatestKybCase(orgId);

  if (!record) {
    return NextResponse.json({ case: null });
  }

  return NextResponse.json({ case: toPublicCase(record) });
}
