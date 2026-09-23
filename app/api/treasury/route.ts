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
 *
 * Phase 0 (no custody package configured): every handler answers the
 * licence-named 403 from lib/server/custody-phase.ts before the ledger is
 * touched. The treasury holds customer funds, and that is a Phase 2
 * capability. The seeded demo ledger is never served as a balance.
 */

import { NextResponse } from 'next/server';

import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { assertCleanBody, ProvenanceViolationError, provenanceViolationResponse } from '@/lib/auth/provenance-guard';
import { requireActiveOrg } from '@/lib/server/kyb-gate';
import { custodyPhaseEnabled, custodyPhaseResponse } from '@/lib/server/custody-phase';
import { readJsonBody } from '@/lib/server/http';
import { requireSessionAccount } from '@/lib/server/session-account';
import { readOrgSettings } from '@/lib/server/org-settings';
import { verifyPayoutTotp } from '@/lib/auth/totp';
import { readComplianceControls } from '@/lib/server/sui-settlement';
import { checkAuthorizationLimits, startOfUtcDay } from '@/lib/policy/authorization-limits';
import { listMovementsSince } from '@/lib/server/ledger-store';
import { proposeForApproval } from '@/lib/server/dual-approval';
import { resolveApprovalClaim } from '@/lib/server/approved-proposal';
import { resolveAuthorityForSession } from '@/lib/auth/authority';
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

/** Keyed by ORG. Keyed by accountId, every tenant read the same demo ledger.
 *  See lib/server/treasury.ts for why that fell through. */
async function snapshot(orgId: string) {
  const ledger = await getLedger(orgId);
  const pending = (await listNotices(orgId)).filter((n) => n.state === 'PENDING');
  const rate = getTreasuryRate();
  return {
    available: toUsd(ledger.availableMicro),
    treasuryPrincipal: toUsd(ledger.treasuryPrincipalMicro),
    treasuryYield: toUsd(ledger.treasuryYieldMicro),
    executionEnabled: process.env.TREASURY_EXECUTION_ENABLED === 'true',
    rate: { apy: rate.netApyPct, label: rate.label, introductory: rate.introductory },
    withdrawalWindowDays: noticeWindowDays(),
    withdrawalWindowLabel: noticeWindowLabel(),
    notices: pending
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
  if (!custodyPhaseEnabled()) return custodyPhaseResponse();

  const accountCheck = await requireSessionAccount(auth.session);
  if (accountCheck.response) return accountCheck.response;
  return NextResponse.json(snapshot(accountCheck.account.orgId));
}

export async function POST(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;
  if (!custodyPhaseEnabled()) return custodyPhaseResponse();

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
  const gate = await requireActiveOrg(auth.session, { lane: 'TREASURY' });
  if (gate.response) return gate.response;

  // Scoped to the caller's org. `getLedger()` with no argument defaults to a
  // single shared demo ledger, so every tenant read and mutated the same object.
  const accountCheck = await requireSessionAccount(auth.session);
  if (accountCheck.response) return accountCheck.response;
  const { accountId, orgId } = accountCheck.account;
  // The ledger belongs to the ORG. Keyed by accountId it fell through to a
  // single shared demo ledger for every tenant — see lib/server/treasury.ts.
  const ledger = await getLedger(orgId);
  const settings = await readOrgSettings(orgId);

  // Cancel a still-pending withdrawal — returns reserved funds to Treasury.
  if (body.action === 'cancel') {
    const noticeId = typeof body.noticeId === 'string' ? body.noticeId : '';
    if (!noticeId) return NextResponse.json({ error: 'noticeId is required to cancel a withdrawal' }, { status: 400 });
    try {
      await cancelTreasuryWithdrawal(noticeId, ledger.userId);
    } catch (error) {
      return NextResponse.json({ error: (error as Error).message }, { status: 400 });
    }
    return NextResponse.json(await snapshot(orgId));
  }

  const amountUsd = Number(body.amountUsd);
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    return NextResponse.json({ error: 'amountUsd must be a positive number' }, { status: 400 });
  }
  const amountMicro = Math.round(amountUsd * 1_000_000);

  // Everything below this line was missing.
  //
  // This route moved value with NO payout controls at all: no second factor,
  // no per-transfer or daily ceiling, no compliance pause, no approval. Any
  // authenticated member could move or withdraw any amount, and the ceilings
  // an operator had configured in Settings simply did not apply here. Moving
  // principal into and out of a yield-bearing treasury is a money movement;
  // it was the only one on the product that nothing governed.

  const totpVerdict = verifyPayoutTotp({
    code: String(body.totp ?? ''),
    accountId,
    requireTotp: settings.requireTotp,
  });
  if (!totpVerdict.ok) {
    return NextResponse.json(
      { error: totpVerdict.message, code: `totp_${totpVerdict.code}` },
      { status: 400 },
    );
  }

  // The chain-side pause governs settlement; a treasury allocation that
  // moves customer principal while compliance has stopped the desk should
  // stop with it.
  const controls = await readComplianceControls();
  if (controls.paused) {
    return NextResponse.json(
      { error: 'Settlement is paused by the compliance operator.', code: 'settlement_paused' },
      { status: 503 },
    );
  }

  // The same ceilings and the same durable ledger the payment paths use, so
  // a daily cap cannot be walked around by routing the money through the
  // treasury instead.
  const todaysMovements = await listMovementsSince(orgId, startOfUtcDay(Date.now()));
  const limits = checkAuthorizationLimits({
    amountUsd,
    settings,
    ledger: todaysMovements.map((line) => ({
      direction: line.direction,
      amountUsdcMicro: Number(line.amountMinor),
      createdAt: line.createdAt,
    })),
  });
  if (!limits.ok) {
    return NextResponse.json(
      { error: limits.message, code: limits.code, limitUsd: limits.limitUsd },
      { status: 400 },
    );
  }

  const approvalClaim = await resolveApprovalClaim(request, orgId);
  if (limits.requiresSecondApproval && !approvalClaim.approved) {
    const maker = await resolveAuthorityForSession(auth.session);
    const proposal = await proposeForApproval({
      orgId,
      createdBy: maker.userId,
      kind: 'PAYMENT',
      amountUsd: amountUsd.toFixed(2),
      targetCurrency: 'USD',
      recommendation:
        `${body.action === 'withdraw' ? 'Withdraw' : 'Allocate'} ${amountUsd.toFixed(2)} USD ` +
        `${body.action === 'withdraw' ? 'from' : 'to'} Smart Treasury. Above the ` +
        `${settings.approvalThresholdUsd} USD dual-approval threshold.`,
      passedChecks: [
        { source: 'COMPLIANCE', ref: 'KYB org state is ACTIVE, settlement not paused' },
        { source: 'BALANCE', ref: `Ceilings, ${limits.spentTodayUsd} USD spent today` },
        { source: 'TREASURY', ref: `Smart Treasury ${String(body.action)}` },
      ],
      payload: { action: body.action, amountUsd: body.amountUsd, totp: body.totp },
      idempotencyKey: `treasury:${orgId}:${String(body.action)}:${amountUsd.toFixed(2)}`,
      approvalThresholdUsd: settings.approvalThresholdUsd,
    });
    return NextResponse.json(
      {
        error:
          `${amountUsd.toFixed(2)} USD is at or above the ${settings.approvalThresholdUsd} approval ` +
          (proposal
            ? 'threshold. It is now in the approval queue and needs a second approver.'
            : 'threshold. The approval queue could not be reached — try again.'),
        code: 'requires_second_approval',
        approvalThresholdUsd: settings.approvalThresholdUsd,
        proposalId: proposal?.id ?? null,
        queueUrl: proposal ? '/queue' : null,
      },
      { status: 409 },
    );
  }

  try {
    if (body.action === 'move') {
      await moveToTreasury(ledger.userId, amountMicro);
    } else if (body.action === 'withdraw') {
      await requestTreasuryWithdrawal(ledger.userId, amountMicro);
    } else {
      return NextResponse.json({ error: "action must be 'move', 'withdraw', or 'cancel'" }, { status: 400 });
    }
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }

  return NextResponse.json(await snapshot(orgId));
}
