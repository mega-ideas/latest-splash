import { NextResponse } from 'next/server';

import { resolveAuthorityForSession, UnauthorizedError } from '@/lib/auth/authority';
import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { readKybCase } from '@/lib/server/kyb';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;

  const { id } = await params;

  // Authenticated is not the same as entitled. This read used to be scoped to
  // "any signed-in user", so one customer could fetch another company's case by
  // id and receive their registration number, the SHA-256 of every document
  // they uploaded, the reviewer's notes and the reason they were rejected.
  let orgId: string;
  try {
    orgId = (await resolveAuthorityForSession(auth.session)).orgId;
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json(
        { error: 'This account has no workspace membership yet.', code: 'no_membership' },
        { status: 403 },
      );
    }
    throw error;
  }

  const record = await readKybCase(orgId, id);

  // 404 rather than 403 for a case belonging to someone else: the difference
  // would confirm that a guessed id exists, which is the enumeration this fixes.
  if (!record) {
    return NextResponse.json({ error: 'KYB case not found' }, { status: 404 });
  }

  return NextResponse.json({
    case: {
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
    },
  });
}
