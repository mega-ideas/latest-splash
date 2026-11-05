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
 * 3. the decision records (who signed, who declined, v2 Phase 3) that could not be sealed when they were made are sealed now.
 *
 * 4. every request still waiting for people who can approve it is told the step it is due (at 0, 10 minutes, 1 hour and 4
 *    hours), and every request that ran out with nobody approving it is told as lapsed: "Nobody approved in time. Nothing was
 *    paid. Ask again." (lib/server/approval-wait.ts). Each step is one row, so running this twice sends nothing twice. It
 *    approves nothing and moves no money. An error there, or an e-mail half that is not working (every try failed lately, or no sender in production), answers 502, so the scheduler's own alerting sees it.
 *
 * Health: it answers 502 if any partial signature is still held for a
 * request that is no longer open, or any request is still submitting past
 * the lease after reconciling. Run it every few minutes; an expired request
 * already refuses signatures on its own.
 */
import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

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
    // The follow-up runs with the request's OWN org's context, never
    // another's: the same steps as when it executes on a signer's request
    // (the next wallet step, the approval ask it answered, the spending
    // rules it changed).
    onExecuted: async (executed) => {
      const live = await liveWalletContext(executed.orgId);
      if (live.ok && live.ctx.signing.onExecuted) await live.ctx.signing.onExecuted(executed);
    },
  });
  // A failure to seal never fails the sweep: the decisions are on record, and the next run tries again.
  const { sweepDecisionRecords } = await import('@/lib/server/payment-trail-deps');
  const decisions = await sweepDecisionRecords(db).catch(() => ({ sealed: 0, failed: 0 }));
  // 4. the ladder for requests nobody has answered (v2 Phase 3): the reminders at 10 minutes, 1 hour and 4 hours, and the
  //    plain "Nobody approved in time. Nothing was paid. Ask again." for each request that ran out. Each step is one row, so
  //    this running twice sends nothing twice. It approves nothing and moves no money.
  const { sweepApprovalWaitsForStaff } = await import('@/lib/server/approval-wait');
  const waits = await sweepApprovalWaitsForStaff(db, { now: () => now }).catch(() => ({ steps: [], lapsed: 0, emails: { sent: 0, failed: 0, skipped: 0 }, errors: 1, emailTrouble: 0 }));
  const lingering = await countLingeringSignaturesForStaff(db);
  const stuck = await countStuckSubmissionsForStaff(db, new Date(now.getTime() - SUBMISSION_LEASE_MS));
  if (lingering > 0 || stuck > 0 || reconciled.errors > 0 || waits.errors > 0 || waits.emailTrouble > 0) {
    return NextResponse.json(
      { success: false, expired, reconciled, waits, error: `${lingering} partial signatures held for closed requests, ${stuck} submissions stuck past the lease, ${reconciled.errors} chain reads failed, ${waits.errors} waiting requests could not be told, ${waits.emailTrouble} approval e-mails could not go out` },
      { status: 502 },
    );
  }
  return NextResponse.json({ success: true, expired, reconciled, decisions, waits });
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
