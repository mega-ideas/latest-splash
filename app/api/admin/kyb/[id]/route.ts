import { NextResponse } from 'next/server';

import { getAdminSession } from '@/lib/server/admin-auth';
import { readJsonBody } from '@/lib/server/http';
import { readKybCaseForStaff, reviewKybCase, type KybReviewState } from '@/lib/server/kyb';
import { approveOrgKybOnChain, setOrgKybState } from '@/lib/compliance/org-kyb';

const allowedStates = new Set<KybReviewState>(['SUBMITTED', 'IN_REVIEW', 'NEEDS_INFORMATION', 'APPROVED', 'REJECTED']);

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();

  if (!session) {
    return NextResponse.json({ error: 'Staff authentication required' }, { status: 401 });
  }

  const { id } = await params;
  const record = await readKybCaseForStaff(id);

  if (!record) {
    return NextResponse.json({ error: 'KYB case not found' }, { status: 404 });
  }

  return NextResponse.json({ case: record });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();

  if (!session) {
    return NextResponse.json({ error: 'Staff authentication required' }, { status: 401 });
  }

  const { id } = await params;
  const body = await readJsonBody(request);
  const state = String(body.state ?? '') as KybReviewState;

  if (!allowedStates.has(state)) {
    return NextResponse.json({ error: 'Unsupported KYB state' }, { status: 400 });
  }

  const existing = await readKybCaseForStaff(id);
  if (!existing) {
    return NextResponse.json({ error: 'KYB case not found' }, { status: 404 });
  }

  const record = await reviewKybCase(id, {
    state,
    actor: session.email,
    note: typeof body.note === 'string' ? body.note : undefined,
    assignedTo: typeof body.assignedTo === 'string' ? body.assignedTo : undefined,
  });

  if (!record) {
    return NextResponse.json({ error: 'KYB case not found' }, { status: 404 });
  }

  // Wallet spec §3.3 — the accountable human decision is the ONLY thing that
  // touches the chain. The Sumsub webhook can never reach this path; it only
  // advances the off-chain state to KYB_PROVIDER_APPROVED.
  if (state === 'APPROVED') {
    try {
      const result = await approveOrgKybOnChain({
        orgId: record.orgId,
        riskScore: record.riskTier === 'TIER_1' ? 1 : record.riskTier === 'TIER_2' ? 2 : 3,
      });
      return NextResponse.json({ case: record, onChain: result });
    } catch (error) {
      // The case stays APPROVED off-chain but the org is NOT activated — better
      // to report a half-finished approval than to claim a verification that
      // never reached the chain.
      const message = error instanceof Error ? error.message : 'On-chain verification failed';
      console.error('[admin-kyb] on-chain verify failed', { caseId: id, orgId: record.orgId, message });
      return NextResponse.json(
        { case: record, error: `Approved off-chain, but on-chain verification failed: ${message}`, code: 'onchain_verify_failed' },
        { status: 502 },
      );
    }
  }

  if (state === 'REJECTED') {
    await setOrgKybState(record.orgId, 'REJECTED', 'ADMIN').catch((error: unknown) => {
      console.error('[admin-kyb] lifecycle REJECTED transition failed', error);
    });
  }

  return NextResponse.json({ case: record });
}
