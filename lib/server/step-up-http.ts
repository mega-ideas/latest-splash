import { NextResponse } from 'next/server';

import { resolveAuthorityForSession, UnauthorizedError } from '@/lib/auth/authority';
import { assertCleanBody, ProvenanceViolationError, provenanceViolationResponse } from '@/lib/auth/provenance-guard';
import type { CustomerSession } from '@/lib/auth/customer-session';
import { readOrgSettings } from '@/lib/server/org-settings';
import { readRecipient } from '@/lib/server/recipients-store';
import { readOutflow } from '@/lib/server/stablecoin-outflows';
import {
  approvalStyleOf,
  enrolledPasskeyVerifier,
  stepUpKey,
  type ApprovalStyle,
  type StepUpDeps,
  type StepUpPurpose,
} from '@/lib/server/step-up';
import { payloadSubject, stablecoinTransferSubject, type StepUpSubject } from '@/lib/server/step-up-subjects';
import { sendWhatsAppCode } from '@/lib/server/whatsapp';

/**
 * The shared half of the /api/step-up routes: who is asking, which style the
 * workspace uses, and what exactly is being approved — built here, on the
 * server, from the record or the payload that will be saved.
 */

const PURPOSES: ReadonlySet<string> = new Set(['STABLECOIN_TRANSFER', 'FIAT_TRANSFER', 'BATCH_PAYOUT', 'SETTINGS_CHANGE', 'PROFILE_CHANGE']);

/** DB membership role for a proposal-domain role (the mapping authority.ts inverts). */
const DB_ROLE: Record<string, string> = { OWNER: 'admin', APPROVER: 'checker', MAKER: 'maker' };

export interface StepUpContext {
  deps: StepUpDeps;
  orgId: string;
  userId: string;
  userName: string;
  dbRole: string;
  style: ApprovalStyle;
  settings: Awaited<ReturnType<typeof readOrgSettings>>;
  purpose: StepUpPurpose;
  subject: StepUpSubject;
  /** Who asked for the thing being approved. */
  requesterUserId: string;
  /** For a stablecoin transfer: its principal in USD (USDC is 1:1), for the
   *  dual-approval threshold. */
  amountUsd: number;
}

export async function stepUpContext(
  session: CustomerSession,
  body: Record<string, unknown>,
  route: string,
): Promise<{ ctx: StepUpContext } | { response: Response }> {
  try {
    assertCleanBody(body, route);
    if (body.payload && typeof body.payload === 'object') assertCleanBody(body.payload, `${route}.payload`);
  } catch (error) {
    if (error instanceof ProvenanceViolationError) return { response: provenanceViolationResponse(error) };
    throw error;
  }
  if (!process.env.DATABASE_URL) {
    return { response: NextResponse.json({ error: 'Approvals need the database.', code: 'ledger_unavailable' }, { status: 503 }) };
  }

  let authority;
  try {
    authority = await resolveAuthorityForSession(session);
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return { response: NextResponse.json({ error: 'This account has no workspace membership yet.', code: 'no_membership' }, { status: 403 }) };
    }
    throw error;
  }

  const purpose = String(body.purpose ?? '');
  if (!PURPOSES.has(purpose)) {
    return { response: NextResponse.json({ error: 'Unknown approval purpose.', code: 'bad_purpose' }, { status: 400 }) };
  }

  const { getDb } = await import('@/lib/db/client');
  const db = getDb();
  const { users } = await import('@/lib/db/schema');
  const { eq } = await import('drizzle-orm');
  const [me] = await db.select({ name: users.name }).from(users).where(eq(users.id, authority.userId)).limit(1);
  const settings = await readOrgSettings(authority.orgId);

  let subject: StepUpSubject;
  let requesterUserId = authority.userId;
  let amountUsd = 0;
  if (purpose === 'STABLECOIN_TRANSFER') {
    const row = await readOutflow(db, authority.orgId, String(body.subjectId ?? ''));
    if (!row || (row.kind !== 'TRANSFER' && row.kind !== 'X402')) {
      return { response: NextResponse.json({ error: 'Transfer not found.', code: 'not_found' }, { status: 404 }) };
    }
    if (row.status !== 'PENDING') {
      return { response: NextResponse.json({ error: `This transfer is ${String(row.status).toLowerCase()}; there is nothing to approve.`, code: 'closed' }, { status: 409 }) };
    }
    const recipient = row.supplierId ? await readRecipient(authority.orgId, row.supplierId) : null;
    subject = stablecoinTransferSubject(row, recipient?.name ?? 'the recipient');
    requesterUserId = row.requestedBy ?? authority.userId;
    amountUsd = Number(BigInt(row.principalMinor) / 1_000_000n);
  } else {
    const payload = body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload)
      ? (body.payload as Record<string, unknown>)
      : null;
    if (!payload) {
      return { response: NextResponse.json({ error: 'The change to approve is required.', code: 'no_payload' }, { status: 400 }) };
    }
    subject = payloadSubject(purpose as Exclude<StepUpPurpose, 'STABLECOIN_TRANSFER'>, { orgId: authority.orgId, userId: authority.userId }, payload);
  }

  return {
    ctx: {
      deps: {
        db,
        key: stepUpKey(),
        send: (to, message) => sendWhatsAppCode(to, message),
        verifyPasskey: enrolledPasskeyVerifier(db),
      },
      orgId: authority.orgId,
      userId: authority.userId,
      userName: me?.name ?? authority.userId,
      dbRole: DB_ROLE[authority.role] ?? 'viewer',
      style: approvalStyleOf(settings),
      settings,
      purpose: purpose as StepUpPurpose,
      subject,
      requesterUserId,
      amountUsd,
    },
  };
}

/**
 * For the approver's side — entering a code, confirming with a passkey,
 * listing what waits on them. They act on an approval by its id and need no
 * payload: what they approve is the stored summary, and the digest is
 * enforced where the approval is used.
 */
export async function approverContext(
  session: CustomerSession,
  body: Record<string, unknown>,
  route: string,
): Promise<{ ctx: { deps: StepUpDeps; orgId: string; userId: string } } | { response: Response }> {
  try {
    assertCleanBody(body, route);
  } catch (error) {
    if (error instanceof ProvenanceViolationError) return { response: provenanceViolationResponse(error) };
    throw error;
  }
  if (!process.env.DATABASE_URL) {
    return { response: NextResponse.json({ error: 'Approvals need the database.', code: 'ledger_unavailable' }, { status: 503 }) };
  }
  let authority;
  try {
    authority = await resolveAuthorityForSession(session);
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return { response: NextResponse.json({ error: 'This account has no workspace membership yet.', code: 'no_membership' }, { status: 403 }) };
    }
    throw error;
  }
  const { getDb } = await import('@/lib/db/client');
  const db = getDb();
  return {
    ctx: {
      deps: { db, key: stepUpKey(), send: (to, message) => sendWhatsAppCode(to, message), verifyPasskey: enrolledPasskeyVerifier(db) },
      orgId: authority.orgId,
      userId: authority.userId,
    },
  };
}

export function stepUpResult(result: { ok: boolean; status?: number } & Record<string, unknown>, okStatus = 200) {
  if (!result.ok) {
    const { status, ...rest } = result;
    return NextResponse.json(rest, { status: status ?? 400, headers: { 'Cache-Control': 'no-store' } });
  }
  return NextResponse.json(result, { status: okStatus, headers: { 'Cache-Control': 'no-store' } });
}
