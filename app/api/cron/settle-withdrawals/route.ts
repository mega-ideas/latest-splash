/**
 * Smart Treasury withdrawal settlement.
 *
 * Settles every PENDING withdrawal notice whose T+N business-day window has
 * elapsed: swap USDY→USDC (guarded) and credit the user's Available balance.
 * A scheduler hits this daily; without it, requested withdrawals stay reserved
 * and never land back in Available.
 *
 * `force` (demo only) settles all pending notices regardless of date — used to
 * fast-forward the notice window when demoing, mirroring the deposit simulator.
 */

import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

import { custodyPhaseEnabled, custodyPhaseResponse } from '@/lib/server/custody-phase';
import { readJsonBody } from '@/lib/server/http';
import { settleDueWithdrawals } from '@/lib/server/treasury';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

function isAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const header = request.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const provided = Buffer.from(token);
  const expected = Buffer.from(secret);
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

function demoModeEnabled(): boolean {
  return process.env.NODE_ENV !== 'production'
    || process.env.USE_MOCK_APIS === 'true'
    || process.env.NEXT_PUBLIC_DEMO_MODE === 'true';
}

async function handleSettlement(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ success: false, error: 'unauthorized' }, { status: 401 });
  }
  // Phase 0: no treasury, so no withdrawal notices to settle.
  if (!custodyPhaseEnabled()) return custodyPhaseResponse();

  const body = (request.method === 'POST' ? await readJsonBody(request).catch(() => ({})) : {}) as { force?: boolean };
  // Force is honoured only in demo/non-prod — never fast-forwards real money.
  const force = body?.force === true && demoModeEnabled();

  try {
    const settled = await settleDueWithdrawals({ force });
    return NextResponse.json({
      success: true,
      forced: force,
      settledCount: settled.length,
      settled: settled.map((n) => ({
        id: n.id,
        userId: n.userId,
        amountUsd: Math.round(n.amountMicro / 10_000) / 100,
        requestedAt: n.requestedAt,
        availableAt: n.availableAt,
        state: n.state,
      })),
    });
  } catch (error) {
    console.error('[cron/settle-withdrawals] settlement failed:', error);
    return NextResponse.json({ success: false, error: 'withdrawal settlement failed' }, { status: 500 });
  }
}

export async function GET(request: Request) {
  return handleSettlement(request);
}

export async function POST(request: Request) {
  return handleSettlement(request);
}
