import { NextResponse } from 'next/server';

import { createSumsubKybSession, getSumsubConfig } from '@/lib/compliance/sumsub';
import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { readJsonBody } from '@/lib/server/http';
import { attachSumsubApplicant } from '@/lib/server/kyb';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;

  const body = await readJsonBody(request);
  const kybCaseId = String(body.kybCaseId ?? '');
  const businessName = String(body.businessName ?? '');
  const registrationNumber = String(body.registrationNumber ?? '');

  if (!kybCaseId || !businessName || !registrationNumber) {
    return NextResponse.json({ error: 'KYB case ID, business name, and registration number are required' }, { status: 400 });
  }

  if (!getSumsubConfig()) {
    return NextResponse.json({ configured: false, error: 'Sumsub environment variables are not configured' }, { status: 200 });
  }

  try {
    const session = await createSumsubKybSession({ kybCaseId, businessName, registrationNumber });
    await attachSumsubApplicant(kybCaseId, session.applicantId);

    return NextResponse.json({ configured: true, ...session });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Sumsub KYB session failed';

    return NextResponse.json({ configured: true, error: message }, { status: 502 });
  }
}
