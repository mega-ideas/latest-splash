/**
 * Limit changes (v2 Phase 3): starts every approved higher limit whose
 * 24 hour notice has passed, and tells the owners what is due (approved, declined,
 * started) once each. Idempotent: the limit changes in the one statement that
 * moves a request to `applied`, and each notice is claimed before it is sent.
 *
 * Every read of a limit also starts what is due (currentLimits), so a limit is
 * never late because this did not run; the cron is what tells the owners that it
 * started. Fails closed: without CRON_SECRET nobody is authorised; without a
 * database it answers 503. Every 15 minutes is enough.
 */
import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

import { runLimitChangesForCron } from '@/lib/server/business-limits';
import { tellOwners } from '@/lib/server/owners-notifier';
import type { DrizzleDb } from '@/lib/server/wallet-signing-store';

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
  if (!isAuthorized(request)) return NextResponse.json({ success: false, error: 'unauthorized' }, { status: 401 });
  if (!process.env.DATABASE_URL) return NextResponse.json({ success: false, error: 'DATABASE_URL is not set' }, { status: 503 });
  const { getDb } = await import('@/lib/db/client');
  const db = getDb() as unknown as DrizzleDb;
  const result = await runLimitChangesForCron(db, {
    notify: (orgId, notice) => tellOwners(db, orgId, { subject: notice.subject, text: notice.text, path: notice.path, emailLead: 'Open Settings, Limits:', whatsappTail: 'Open Splash, Settings, Limits.' }),
  });
  return NextResponse.json({ success: true, ...result });
}

export const GET = handle;
export const POST = handle;
