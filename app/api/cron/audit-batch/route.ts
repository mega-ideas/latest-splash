import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

import { buildDailyAuditBatch } from '@/lib/server/audit-batches';
import { refuseOutsideLaunchScope } from '@/lib/server/launch-scope';

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
  const outOfScope = refuseOutsideLaunchScope();
  if (outOfScope) return outOfScope;
  try {
    const url = new URL(request.url);
    const batch = await buildDailyAuditBatch(url.searchParams.get('date') ?? undefined);
    return NextResponse.json({ success: true, batch });
  } catch (error) {
    console.error('[cron/audit-batch] failed:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'daily audit batch failed' },
      { status: 400 },
    );
  }
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
