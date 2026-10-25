/**
 * The cross-chain sweep (v2 §4.7, review B7). Cross-tenant by design; each
 * row is acted on within its own org: every burned CCTP payment is asked of
 * Circle's attestation service again, so a lost refresh does not leave it
 * burned forever, and a payment burned but not minted six hours after its
 * burn is reported (an ALERT log line, and `stuck` in the body) for ops to
 * relay its mint from the message and attestation on its receipt.
 *
 * Reads Circle and writes forward only: nothing is signed or sent. In
 * production it needs CCTP_IRIS_API_URL (502 without). Run it every ten
 * minutes. A stuck payment makes a 502, which is an alert in itself.
 */
import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

import { CctpUnavailable, irisClientFromEnv, sweepCrossChainTransfers } from '@/lib/server/cross-chain-transfers';
import type { DrizzleDb } from '@/lib/server/wallet-signing-store';

export const dynamic = 'force-dynamic';

function isAuthorized(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const token = (request.headers.get('authorization') ?? '').replace(/^Bearer /, '');
  const provided = Buffer.from(token);
  const expected = Buffer.from(secret);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

async function handle(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ success: false, error: 'unauthorized' }, { status: 401 });
  if (!process.env.DATABASE_URL) return NextResponse.json({ success: false, error: 'DATABASE_URL is not set' }, { status: 502 });
  let iris;
  try {
    iris = irisClientFromEnv();
  } catch (error) {
    if (error instanceof CctpUnavailable) return NextResponse.json({ success: false, error: error.message }, { status: 502 });
    throw error;
  }
  const { getDb } = await import('@/lib/db/client');
  const swept = await sweepCrossChainTransfers({ db: getDb() as unknown as DrizzleDb, now: () => new Date(), iris });
  if (swept.stuck.length > 0 || swept.errors > 0) {
    return NextResponse.json({ success: false, swept, error: `${swept.stuck.length} cross-chain payments are not minted, ${swept.errors} could not be asked` }, { status: 502 });
  }
  return NextResponse.json({ success: true, swept });
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
