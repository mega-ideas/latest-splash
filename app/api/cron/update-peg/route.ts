import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';

import { resolvePegAttestation } from '@/lib/server/peg-attestation';
import { refreshPegOnSui } from '@/lib/server/sui-settlement';
import { refuseOutsideLaunchScope } from '@/lib/server/launch-scope';

export const dynamic = 'force-dynamic';
export const maxDuration = 10;

/**
 * This endpoint mutates protocol state (the on-chain peg monitor) and spends
 * sponsored gas, so it must only ever be driven by the scheduler. We require a
 * shared bearer secret (CRON_SECRET) — the same header Vercel Cron sends when
 * CRON_SECRET is configured — and fail closed if it is unset or mismatched.
 */
function isAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false; // fail closed: no secret configured → no access

  const header = request.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const provided = Buffer.from(token);
  const expected = Buffer.from(secret);
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

async function handlePegUpdate(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ success: false, error: 'unauthorized' }, { status: 401 });
  }
  const outOfScope = refuseOutsideLaunchScope();
  if (outOfScope) return outOfScope;

  try {
    // Never push a price nobody measured. The on-chain monitor wants each
    // coin's distance from the dollar, and Splash has no dollar price source
    // (lib/server/peg-attestation.ts), so outside mock mode nothing is pushed:
    // PegState goes stale and `assert_pegged` refuses settlement, which is
    // the breaker working.
    const attestation = await resolvePegAttestation();
    if (!attestation.push) {
      console.warn('[cron/update-peg] nothing pushed:', attestation.reason);
      return NextResponse.json({ success: false, error: 'no dollar price to attest', reason: attestation.reason }, { status: 503 });
    }
    const result = await refreshPegOnSui({
      usdcDeviationPpm: attestation.usdcDeviationPpm,
      usdtDeviationPpm: attestation.usdtDeviationPpm,
    });

    return NextResponse.json({
      success: true,
      source: attestation.primary,
      usdc_deviation_ppm: result.usdcDeviationPpm,
      usdt_deviation_ppm: result.usdtDeviationPpm,
      tx_digest: result.digest,
    });
  } catch (error) {
    // Log full detail server-side only; never reflect internal error strings
    // (object IDs, RPC/sponsor messages) back to the caller.
    console.error('[cron/update-peg] peg update failed:', error);
    return NextResponse.json({ success: false, error: 'peg update failed' }, { status: 500 });
  }
}

export async function GET(request: Request) {
  return handlePegUpdate(request);
}

export async function POST(request: Request) {
  return handlePegUpdate(request);
}
