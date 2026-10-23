/**
 * Governance alert monitor (v2, brief 3.5).
 *
 * Reads the recent upgrade, owner-change and registry-addition events, keeps
 * only those from the canonical wrapper and the canonical compliance config,
 * records each once, and tells every business owner in the app, by email, and
 * on WhatsApp where they have a verified number. The rule lives in
 * lib/server/governance-events.ts; the I/O in
 * lib/server/governance-alert-monitor.ts; this route is the schedule's entry
 * point. Every fifteen minutes is the intended cadence: the notice is 24 hours,
 * and owners need most of it.
 *
 * Fails closed. Unconfigured canonical ids, an unreadable indexer or database,
 * or a genuine wrapper event naming a core package the configuration does not
 * list all answer 502, so the scheduler's own failure alerting sees it. A
 * monitor that quietly stopped telling owners is the failure this route must
 * not have.
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
  const body = {
    scanned: result.scanned,
    alerts: result.report.alerts.map((a) => ({ digest: a.digest, eventSeq: a.eventSeq, kind: a.kind })),
    ignored: result.report.ignored.map((i) => ({ digest: i.digest, eventSeq: i.eventSeq, reason: i.reason })),
    recorded: result.recorded,
    active: result.active,
    owners: result.owners,
    deliveries: result.deliveries,
    drift: result.drift.map((d) => ({ digest: d.digest, eventSeq: d.eventSeq, note: d.note ?? null })),
  };
  if (result.drift.length > 0) {
    const error =
      'the canonical upgrade wrapper emitted an event naming a core package other than the configured one, so owners were not told about it; ' +
      "set SPLASH_CORE_PACKAGE_ID to core's original id, the one the wrapper records";
    console.error('[cron/governance-alerts]', error, body.drift);
    return NextResponse.json({ success: false, error, ...body }, { status: 502 });
  }
  return NextResponse.json({ success: true, ...body });
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
