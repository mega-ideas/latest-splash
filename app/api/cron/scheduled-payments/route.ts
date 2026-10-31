/**
 * Scheduled batches (v2 Phase 3): what falls due, and what to follow.
 *
 * For every active schedule due within a day, makes its run and sends the
 * automatic one's day-before notice; for every open run, starts it when its
 * time has come ("Ask me first" prepares the batch and asks the owners;
 * "Pay automatically" pays inside the owners' allowance after every check),
 * follows a prepared batch to its end (paid, lapsed, declined) and settles an
 * automatic run from its payments (lib/server/scheduled-runner.ts).
 *
 * Each business is worked on with its OWN context (scheduleDepsForOrg), never
 * another's. Idempotent: a run is made once per schedule and due date, claimed
 * with a lease, and every step is a compare-and-set, so running it twice, or
 * two at once, is running it once. Safe to call every few minutes.
 *
 * Fails closed. Without CRON_SECRET nobody is authorised; without a database it
 * answers 502; a business that could not be worked on makes it answer 502 so
 * the scheduler's failure alerting sees it. Without the scheduled payer's KMS
 * key (SCHEDULED_PAYER_KMS_KEY_ID) nothing is paid automatically: every run is
 * handed back to “ask me first”.
 */
import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

import { scheduleDepsForOrg } from '@/lib/server/scheduled-payments-deps';
import { publicRunnerResult, runScheduledPayments } from '@/lib/server/scheduled-runner';

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
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ success: false, error: 'DATABASE_URL is not configured, so there are no schedules to run.' }, { status: 502 });
  }
  try {
    const { getDb } = await import('@/lib/db/client');
    const result = await runScheduledPayments({
      db: getDb() as unknown as Parameters<typeof runScheduledPayments>[0]['db'],
      now: () => new Date(),
      depsFor: (orgId) => scheduleDepsForOrg(orgId),
    });
    if (result.errors.length > 0) {
      // Named by business and id only: an error's own text can carry a query and its values.
      console.error('[cron/scheduled-payments] some work could not be done:', result.errors.map((e) => `${e.orgId}/${e.id}`).join(', '));
      return NextResponse.json({ success: false, ...publicRunnerResult(result), error: `${result.errors.length} item(s) could not be worked on` }, { status: 502 });
    }
    return NextResponse.json({ success: true, ...publicRunnerResult(result) });
  } catch (error) {
    console.error('[cron/scheduled-payments] the runner did not run:', error instanceof Error ? error.message : error);
    return NextResponse.json({ success: false, error: 'the runner did not run' }, { status: 502 });
  }
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
