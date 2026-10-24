/**
 * The wallet signature sweep (v2 §4.1): every request still collecting past
 * its expiry is closed as expired, and every partial signature it held is
 * cleared in the same statement. Cross-tenant by design, and it can only
 * close. Hourly is enough: an expired request already refuses signatures on
 * its own; the sweep is what makes "partial signatures are never stored
 * longer than needed" true for requests nobody touched again.
 */
import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

import { countLingeringSignaturesForStaff, expireSigningRequestsForStaff, type DrizzleDb } from '@/lib/server/wallet-signing-store';

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
  const expired = await expireSigningRequestsForStaff(db, new Date());
  const lingering = await countLingeringSignaturesForStaff(db);
  if (lingering > 0) {
    return NextResponse.json({ success: false, expired, error: `${lingering} partial signatures are held for closed requests` }, { status: 502 });
  }
  return NextResponse.json({ success: true, expired });
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
