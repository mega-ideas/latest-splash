/**
 * Smart Treasury ledger API — the two-bucket balances + moves, backed by the
 * off-chain ledger in lib/server/treasury.ts (omnibus + per-user accounting).
 *
 *   GET  → { available, treasuryPrincipal, treasuryYield, rate, notices }
 *   POST { action: 'move' | 'withdraw', amountUsd }
 *          move     → Available (USDC) → Smart Treasury (USDY), instant
 *          withdraw → Smart Treasury → Available, T+1–T+3 notice
 *
 * Amounts are USD (2dp) at the API boundary; the ledger stores micro-USD.
 */

import { NextResponse } from 'next/server';

import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { assertCleanBody, ProvenanceViolationError, provenanceViolationResponse } from '@/lib/auth/provenance-guard';
import { requireActiveOrg } from '@/lib/server/kyb-gate';
import { readJsonBody } from '@/lib/server/http';
import { emitEvent } from '@/lib/server/events';
import { resolveSessionAccount } from '@/lib/server/session-account';
import {
  cancelTreasuryWithdrawal,
  getLedger,
  listNotices,
  moveToTreasury,
  noticeWindowDays,
  noticeWindowLabel,
  requestTreasuryWithdrawal,
} from '@/lib/server/treasury';
import { getTreasuryRate } from '@/lib/server/usdy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const toUsd = (micro: number) => Math.round(micro / 10_000) / 100;

function snapshot(accountId: string) {
  const ledger = getLedger(accountId);
  const rate = getTreasuryRate();
  return {
    available: toUsd(ledger.availableMicro),
    treasuryPrincipal: toUsd(ledger.treasuryPrincipalMicro),
    treasuryYield: toUsd(ledger.treasuryYieldMicro),
    executionEnabled: process.env.TREASURY_EXECUTION_ENABLED === 'true',
    rate: { apy: rate.netApyPct, label: rate.label, introductory: rate.introductory },
    withdrawalWindowDays: noticeWindowDays(),
    withdrawalWindowLabel: noticeWindowLabel(),
    notices: listNotices(ledger.userId)
      .filter((n) => n.state === 'PENDING')
      .map((n) => ({
        id: n.id,
        amount: toUsd(n.amountMicro),
        availableAt: n.availableAt,
        state: n.state,
      })),
  };
}

export async function GET(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;

  const { accountId } = await resolveSessionAccount(auth.session);
  return NextResponse.json(snapshot(accountId));
}

export async function POST(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;

  if (process.env.TREASURY_EXECUTION_ENABLED !== 'true') {
    return NextResponse.json(
      { error: 'Projection only - execution disabled pending regulatory approval.' },
      { status: 403 },
    );
  }
  const body = await readJsonBody(request);
  try {
    assertCleanBody(body, 'treasury');
  } catch (error) {
    if (error instanceof ProvenanceViolationError) return provenanceViolationResponse(error);
    throw error;
  }
  const gate = await requireActiveOrg(auth.session);
  if (gate.response) return gate.response;

  // Scoped to the caller's org. `getLedger()` with no argument defaults to a
  // single shared demo ledger, so every tenant read and mutated the same object.
  const { accountId } = await resolveSessionAccount(auth.session);
  const ledger = getLedger(accountId);

  // Cancel a still-pending withdrawal — returns reserved funds to Treasury.
  if (body.action === 'cancel') {
    const noticeId = typeof body.noticeId === 'string' ? body.noticeId : '';
    if (!noticeId) return NextResponse.json({ error: 'noticeId is required to cancel a withdrawal' }, { status: 400 });
    try {
      cancelTreasuryWithdrawal(noticeId, ledger.userId);
    } catch (error) {
      return NextResponse.json({ error: (error as Error).message }, { status: 400 });
    }
    return NextResponse.json(snapshot(accountId));
  }

  const amountUsd = Number(body.amountUsd);
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    return NextResponse.json({ error: 'amountUsd must be a positive number' }, { status: 400 });
  }
  const amountMicro = Math.round(amountUsd * 1_000_000);

  try {
    if (body.action === 'move') {
      await moveToTreasury(ledger.userId, amountMicro);
      void emitEvent({
        name: 'sweep_approved',
        orgId: auth.session.orgId ?? auth.session.email,
        actorId: auth.session.email,
        subjectId: accountId,
        amountMinor: amountMicro,
        currency: 'USD_MICRO',
        props: { action: 'move', destination: 'SMART_TREASURY' },
      });
    } else if (body.action === 'withdraw') {
      requestTreasuryWithdrawal(ledger.userId, amountMicro);
    } else {
      return NextResponse.json({ error: "action must be 'move', 'withdraw', or 'cancel'" }, { status: 400 });
    }
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }

  return NextResponse.json(snapshot(accountId));
}
