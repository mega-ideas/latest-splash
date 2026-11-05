/**
 * Governance alert monitor (v2, brief 3.5).
 *
 * Reads the state of the canonical upgrade wrapper and the canonical
 * compliance config on chain (a pending upgrade, a pending owner change,
 * pending registry additions, and what took effect since the last run),
 * records each alert once, and tells every business owner in the app, by
 * email, and on WhatsApp where they have a verified number. The rule lives in
 * lib/server/governance-events.ts; the I/O in
 * lib/server/governance-alert-monitor.ts; this route is the schedule's entry
 * point. Every fifteen minutes is the intended cadence: every change it warns
 * about sits on chain for at least 24 hours before it can take effect, and
 * owners need most of that.
 *
 * Fails closed. Unconfigured canonical ids, an id that is not the canonical
 * object of the canonical type on chain, a read of the chain that is not
 * complete, or an unreadable database all answer 502, so the scheduler's own
 * failure alerting sees it (a configured id that does not check out also
 * pages a person). A monitor that quietly stopped telling owners is the
 * failure this route must not have.
 */
import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

import { runGovernanceAlertMonitor } from '@/lib/server/governance-alert-monitor';

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
  const result = await runGovernanceAlertMonitor();
  if (!result.ok) {
    console.error('[cron/governance-alerts] monitor did not run:', result.reason);
    return NextResponse.json({ success: false, error: result.reason }, { status: 502 });
  }
  return NextResponse.json({
    success: true,
    observed: result.observed,
    alerts: result.alerts.map((a) => ({ kind: a.kind, key: a.key })),
    recorded: result.recorded,
    active: result.active,
    owners: result.owners,
    deliveries: result.deliveries,
  });
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
