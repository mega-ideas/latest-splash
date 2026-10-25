import { NextResponse } from 'next/server';

import { resolveAuthorityForSession } from '@/lib/auth/authority';
import { ComplianceProviderUnavailable, kybProviderFromEnv } from '@/lib/compliance/sumsub';
import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { readJsonBody } from '@/lib/server/http';
import { attachSumsubApplicant, readKybCase } from '@/lib/server/kyb';
import { requireSessionAccount } from '@/lib/server/session-account';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

/**
 * Open the business's verification session with the KYB provider (v2 §4.6).
 *
 * The case is this org's own, read by the org from the SESSION
 * (requireSessionAccount, WS2), and the business name and registration
 * number sent to the provider are the case's, never the request's: a case id
 * from another business reads as absent. The applicant is the business
 * (`externalUserId = org:<orgId>`), which is how the provider's verdict
 * finds its way back to this org and no other.
 *
 * Production without the provider's credentials refuses (503); outside
 * production a labelled sandbox session is returned, which decides nothing.
 */
export async function POST(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;
  const accountCheck = await requireSessionAccount(auth.session);
  if (accountCheck.response) return accountCheck.response;
  const orgId = accountCheck.account.orgId;
  // Attaching the business's applicant is an owner's act.
  let authority;
  try {
    authority = await resolveAuthorityForSession(auth.session);
  } catch {
    return NextResponse.json({ error: 'Only an owner opens the verification.' }, { status: 403, headers: NO_STORE });
  }
  if (authority.orgId !== orgId || authority.role !== 'OWNER') return NextResponse.json({ error: 'Only an owner opens the verification.' }, { status: 403, headers: NO_STORE });

  const body = await readJsonBody(request);
  const kybCaseId = typeof body.kybCaseId === 'string' ? body.kybCaseId.trim() : '';
  if (!kybCaseId) return NextResponse.json({ error: 'KYB case ID is required' }, { status: 400, headers: NO_STORE });

  const kybCase = await readKybCase(orgId, kybCaseId);
  if (!kybCase) return NextResponse.json({ error: 'No such KYB case' }, { status: 404, headers: NO_STORE });

  try {
    const provider = kybProviderFromEnv();
    const session = await provider.createSession({
      orgId,
      kybCaseId: kybCase.id,
      businessName: kybCase.businessName,
      registrationNumber: kybCase.registrationNumber,
    });
    if (session.applicantId) await attachSumsubApplicant(kybCase.id, session.applicantId);
    return NextResponse.json({ configured: true, ...session }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ComplianceProviderUnavailable) {
      return NextResponse.json({ configured: error.code !== 'kyb_not_configured', error: error.message, code: error.code }, { status: error.status, headers: NO_STORE });
    }
    console.error('[kyb] the verification session could not be opened');
    return NextResponse.json({ configured: true, error: 'The verification session could not be opened.' }, { status: 502, headers: NO_STORE });
  }
}
