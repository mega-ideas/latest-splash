import { NextResponse } from 'next/server';

import { resolveAuthorityForSession } from '@/lib/auth/authority';
import type { CustomerSession } from '@/lib/auth/customer-session';
import { consumeStepUp, mainAdmin, type StepUpPurpose } from '@/lib/server/step-up';
import { payloadSubject } from '@/lib/server/step-up-subjects';

/**
 * Where an approval is USED. The route that saves the settings, submits the
 * profile change or authorizes the payout recomputes the subject from what it
 * is about to do, and spends a matching approval — or refuses.
 */

type PayloadPurpose = Exclude<StepUpPurpose, 'STABLECOIN_TRANSFER'>;

export async function consumeActionApproval(input: {
  session: CustomerSession;
  orgId: string;
  purpose: PayloadPurpose;
  payload: Record<string, unknown>;
}): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false;
  const authority = await resolveAuthorityForSession(input.session);
  const subject = payloadSubject(input.purpose, { orgId: input.orgId, userId: authority.userId }, input.payload);
  const { getDb } = await import('@/lib/db/client');
  return consumeStepUp(getDb(), {
    orgId: input.orgId,
    purpose: input.purpose,
    subjectId: subject.subjectId,
    subject: subject.subject,
  });
}

export function approvalRequiredResponse(purpose: StepUpPurpose): NextResponse {
  return NextResponse.json(
    {
      error:
        'This needs approval first: request a WhatsApp code, enter it, and confirm with your passkey. ' +
        'The approval must be for exactly what you are saving — change anything and it needs a new one.',
      code: 'approval_required',
      purpose,
    },
    { status: 428, headers: { 'Cache-Control': 'no-store' } },
  );
}

/**
 * Can this workspace switch WhatsApp approvals ON? Only if the main admin —
 * who receives every payment code — has a verified number AND a passkey.
 * Otherwise the switch would lock every payment behind an approval nobody can
 * give.
 */
export async function whatsappApprovalsReady(orgId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!process.env.DATABASE_URL) return { ok: false, reason: 'WhatsApp approvals need the database.' };
  const { getDb } = await import('@/lib/db/client');
  const db = getDb();
  const admin = await mainAdmin(db, orgId);
  if (!admin) return { ok: false, reason: 'This workspace has no admin.' };
  if (!admin.e164) {
    return { ok: false, reason: `${admin.name}, the main admin, must verify a WhatsApp number (Settings → Approvals) before WhatsApp approvals can be switched on.` };
  }
  const { findCredential, relyingPartyId } = await import('@/lib/auth/passkey');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const credential = await findCredential(db as any, { userId: admin.userId, rpId: relyingPartyId() });
  if (!credential) {
    return { ok: false, reason: `${admin.name}, the main admin, must create a passkey (Settings → Security) before WhatsApp approvals can be switched on.` };
  }
  return { ok: true };
}
