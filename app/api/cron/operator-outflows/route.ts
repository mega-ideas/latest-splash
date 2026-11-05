/**
 * Operator outflow monitor (WS4).
 *
 * Reads the transactions the operator address sent in the look-back window
 * and alerts on any that moved value other than through the v2 executor path
 * (`splash_spend::pay_intent`, its receipt anchored by
 * `audit_anchor::anchor`) to an approved beneficiary, a registered partner
 * deposit address or business wallet, or Splash's fee recipient. The rule
 * lives in lib/server/operator-outflows.ts; this route is the schedule's
 * entry point. Run it at least as often as the window (default two hours) —
 * every fifteen minutes is the intended cadence.
 *
 * Not refused outside the launch scope or in Phase 0: the operator key signs
 * in every scope (a business's verification is recorded on Sui with it), so
 * it is watched in every scope. A monitor that cannot read its inputs answers
 * 502, so the scheduler's own failure alerting sees it — a watchman who
 * quietly stopped looking is the failure this route must not have.
 */
import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

import { runOperatorOutflowMonitor } from '@/lib/server/operator-outflow-monitor';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function isAuthorized(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const token = (request.headers.get('authorization') ?? '').replace(/^Bearer /, '');
  const provided = Buffer.from(token);
  const expected = Buffer.from(secret);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

async function handle(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ success: false, error: 'unauthorized' }, { status: 401 });
  }
  const result = await runOperatorOutflowMonitor();
  if (!result.ok) {
    console.error('[cron/operator-outflows] monitor did not run:', result.reason);
    return NextResponse.json({ success: false, error: result.reason }, { status: 502 });
  }
  return NextResponse.json({
    success: true,
    operator: result.operator,
    scanned: result.scanned,
    approved: result.report.approved.length,
    notOutflows: result.report.notOutflows.length,
    flagged: result.report.flagged.map((f) => ({ digest: f.digest, reason: f.reason })),
    alerted: result.alerted,
  });
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
