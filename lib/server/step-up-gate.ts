import { NextResponse } from 'next/server';

import { resolveAuthorityForSession } from '@/lib/auth/authority';
import type { CustomerSession } from '@/lib/auth/customer-session';
import { consumeStepUp, mainAdmin, releaseStepUp, type StepUpPurpose } from '@/lib/server/step-up';
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

/** Give back an approval `consumeActionApproval` spent, when the action it was
 *  spent on was refused and nothing happened. */
export async function releaseActionApproval(input: {
  session: CustomerSession;
  orgId: string;
  purpose: PayloadPurpose;
  payload: Record<string, unknown>;
}): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  const authority = await resolveAuthorityForSession(input.session);
  const subject = payloadSubject(input.purpose, { orgId: input.orgId, userId: authority.userId }, input.payload);
  const { getDb } = await import('@/lib/db/client');
  await releaseStepUp(getDb(), { orgId: input.orgId, purpose: input.purpose, subjectId: subject.subjectId });
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
 * give. `when: 'approve'` asks the same of a workspace already switched on
 * (the admin may since have removed their passkey), worded for that.
 */
export async function whatsappApprovalsReady(
  orgId: string,
  when: 'enable' | 'approve' = 'enable',
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!process.env.DATABASE_URL) return { ok: false, reason: 'WhatsApp approvals need the database.' };
  // No delivery, no codes. Outside production a code goes to the server log
  // (lib/server/whatsapp.ts), so local work can proceed; in production an
  // unconfigured (or dropped) Twilio would lock every payment and every
  // settings save — switching this back off included — behind a code that
  // can never arrive. Refused before anything else.
  const { whatsappDeliveryMissing } = await import('@/lib/server/whatsapp');
  if (whatsappDeliveryMissing()) {
    return {
      ok: false,
      reason: when === 'enable'
        ? 'WhatsApp delivery is not set up on this server, so WhatsApp approvals cannot be switched on. Payments are approved by click until it is.'
        : 'WhatsApp delivery is not set up on this server, so no approval code can be sent. Ask Splash support to switch this workspace to click approvals.',
    };
  }
  const tail = when === 'enable'
    ? ' before WhatsApp approvals can be switched on.'
    : ' — until then, no payment here can be approved.';
  const { getDb } = await import('@/lib/db/client');
  const db = getDb();
  const admin = await mainAdmin(db, orgId);
  if (!admin) return { ok: false, reason: 'This workspace has no admin.' };
  if (!admin.e164) {
    return { ok: false, reason: `${admin.name}, the main admin, must verify a WhatsApp number (Settings → Approvals)${tail}` };
  }
  const { findCredential, relyingPartyId } = await import('@/lib/auth/passkey');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const credential = await findCredential(db as any, { userId: admin.userId, rpId: relyingPartyId() });
  if (!credential) {
    return { ok: false, reason: `${admin.name}, the main admin, must create or restore a passkey (Settings → Security)${tail}` };
  }
  return { ok: true };
}
