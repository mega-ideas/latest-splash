/**
 * The wallet signature sweep and reconcile (v2 §4.1). Cross-tenant by
 * design, and it can only close requests:
 *
 *   1. every request still collecting past its expiry is closed as expired,
 *      its partial signatures cleared in the same statement;
 *   2. every request still submitting past the lease, and every request
 *      whose outcome is unknown, is read on chain by its digest: executed or
 *      failed there, it closes (an executed one runs its follow-up step, in
 *      its own org); not seen and past its ValidDuring window, it closes as
 *      failed, since those bytes can never land; otherwise it stays unknown
 *      and keeps its dedupe key.
 *
 * Health: it answers 502 if any partial signature is still held for a
 * request that is no longer open, or any request is still submitting past
 * the lease after reconciling. Run it every few minutes; an expired request
 * already refuses signatures on its own.
 */
import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

import { continueWalletSteps } from '@/lib/server/business-wallet';
import { liveChain, liveWalletContext } from '@/lib/server/wallet-deps';
import { reconcileSigningRequestsForStaff, SUBMISSION_LEASE_MS } from '@/lib/server/wallet-signing';
import {
  countLingeringSignaturesForStaff,
  countStuckSubmissionsForStaff,
  expireSigningRequestsForStaff,
  type DrizzleDb,
} from '@/lib/server/wallet-signing-store';

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
  const { getDb } = await import('@/lib/db/client');
  const db = getDb() as unknown as DrizzleDb;
  const now = new Date();
  const expired = await expireSigningRequestsForStaff(db, now);
  const reconciled = await reconcileSigningRequestsForStaff({
    db,
    chain: liveChain(),
    now: () => now,
    // The follow-up runs with the request's OWN org's context, never another's.
    onExecuted: async (executed) => {
      const live = await liveWalletContext(executed.orgId);
      if (live.ok) await continueWalletSteps(live.ctx, executed);
    },
  });
  const lingering = await countLingeringSignaturesForStaff(db);
  const stuck = await countStuckSubmissionsForStaff(db, new Date(now.getTime() - SUBMISSION_LEASE_MS));
  if (lingering > 0 || stuck > 0 || reconciled.errors > 0) {
    return NextResponse.json(
      { success: false, expired, reconciled, error: `${lingering} partial signatures held for closed requests, ${stuck} submissions stuck past the lease, ${reconciled.errors} chain reads failed` },
      { status: 502 },
    );
  }
  return NextResponse.json({ success: true, expired, reconciled });
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
