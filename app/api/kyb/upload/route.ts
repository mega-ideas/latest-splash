import { createHash, randomBytes } from 'crypto';
import { NextResponse } from 'next/server';

import { resolveAuthorityForSession, UnauthorizedError } from '@/lib/auth/authority';
import { ensureWorkspaceForEmail } from '@/lib/auth/signup-org';
import { setOrgKybState } from '@/lib/compliance/org-kyb';
import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { recordKybSubmission, type KybDocumentRecord } from '@/lib/server/kyb';

export const dynamic = 'force-dynamic';

const ALLOWED_DOC_KINDS = new Set<KybDocumentRecord['kind']>(['COMPANY_DOCUMENT', 'DIRECTOR_ID']);

export async function POST(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;

  const formData = await request.formData();
  const files = formData.getAll('documents').filter((item): item is File => item instanceof File);
  const legalName = String(formData.get('businessName') ?? '');
  const registrationNumber = String(formData.get('ssmNumber') ?? '');
  // Optional explicit per-file classification (same order as `documents`).
  // Preferred over the filename heuristic so a reviewer's "director ID present"
  // signal can't be gamed by simply naming a file "director.pdf".
  const declaredKinds = formData.getAll('documentKinds').map((value) => String(value));

  if (files.length === 0) {
    return NextResponse.json({ error: 'No KYB documents provided' }, { status: 400 });
  }

  if (!legalName || !registrationNumber) {
    return NextResponse.json({ error: 'Business name and registration number are required' }, { status: 400 });
  }

  // Unguessable case id: do NOT derive it from public business attributes
  // (legal name / SSM number), which would let anyone recompute it.
  const kybCaseId = `kyb_${Date.now().toString(36)}_${randomBytes(12).toString('hex')}`;
  const documents: KybDocumentRecord[] = await Promise.all(
    files.map(async (file, index) => {
      const bytes = Buffer.from(await file.arrayBuffer());
      const hash = createHash('sha256').update(bytes).digest('hex');

      const declared = declaredKinds[index] as KybDocumentRecord['kind'] | undefined;
      const kind: KybDocumentRecord['kind'] = declared && ALLOWED_DOC_KINDS.has(declared)
        ? declared
        : file.name.toLowerCase().includes('director')
          ? 'DIRECTOR_ID'
          : 'COMPANY_DOCUMENT';

      return {
        name: file.name,
        kind,
        type: file.type || 'application/octet-stream',
        size: file.size,
        sha256: hash,
        storageKey: `kyb/${kybCaseId}/${hash}-${file.name}`,
        virusScanResult: 'PENDING',
        uploadedAt: new Date().toISOString(),
      };
    }),
  );
  // Which organisation this case belongs to — resolved BEFORE the case is
  // written, because it is now stored on the row.
  //
  // A membership-less session is what a brand-new sign-up IS: password sign-up
  // deliberately grants no membership, and refusing their documents would make
  // onboarding impossible for the only people who need it. Previously that case
  // was filed under `orgId: 'demo-business'` — the literal demo workspace — so
  // every new business's KYB documents landed in a namespace shared with the
  // sample data and with each other.
  //
  // They get their own workspace instead, created in REGISTERED, which is the
  // state that can do nothing. Submitting KYB documents is precisely the moment
  // a business declares itself, so it is the right moment to create one.
  let orgId: string;
  try {
    orgId = (await resolveAuthorityForSession(auth.session)).orgId;
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) throw error;
    orgId = (await ensureWorkspaceForEmail(auth.session.email)).orgId;
  }

  const kybCase = await recordKybSubmission({
    caseId: kybCaseId,
    orgId,
    businessName: legalName,
    registrationNumber,
    documents,
  });

  // Advance the ORG, not just the case.
  //
  // Nothing anywhere called `setOrgKybState` with KYB_SUBMITTED, so the
  // lifecycle could never leave REGISTERED however many documents were
  // uploaded. An onboarding flow whose first step does not change the state
  // it exists to change is a form that files paperwork into a drawer.
  //
  // SYSTEM is the only actor permitted to make this transition: a provider
  // cannot declare a business submitted, and an admin signing it off is a
  // later, separate step. That separation is the point of the machine.
  let lifecycle: string | null = null;
  try {
    const moved = await setOrgKybState(orgId, 'KYB_SUBMITTED', 'SYSTEM');
    lifecycle = moved.to;
  } catch (error) {
    console.error('[kyb] documents recorded but the org state did not advance', error);
  }

  return NextResponse.json({
    kybCaseId,
    state: kybCase.state,
    lifecycle,
    documents,
  });
}
