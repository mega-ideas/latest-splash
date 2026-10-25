/**
 * The withdrawal sweep (v2 §4.4). Cross-tenant by design; each row is acted
 * on within its own org:
 *
 *   1. a withdrawal whose owners' request executed is marked sent, the
 *      executed transaction is read and, only when its IntentCreated event
 *      names the intent id the partner was instructed for, the digest is
 *      posted to the partner (a mismatch is held for ops, never posted);
 *   2. a withdrawal whose request expired, was cancelled or failed has its
 *      instruction reversed at the partner and is cancelled;
 *   3. a digest the partner was not told yet (the partner was down) is
 *      posted again;
 *   4. a partner test deposit whose request executed is recorded, and one
 *      whose request lapsed is freed for the owners to ask again.
 *
 * The API's reads never call the partner; this does, once per row per run.
 * Run it every five minutes, after /api/cron/wallet-signing. A 502 (a row
 * that could not be settled) is an alert in itself.
 */
import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

import { reconcileWithdrawals } from '@/lib/server/withdrawals';
import { withdrawalSettlementDeps } from '@/lib/server/withdrawals-deps';
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
  const { getDb } = await import('@/lib/db/client');
  const deps = withdrawalSettlementDeps(getDb() as unknown as DrizzleDb);
  if (!deps) return NextResponse.json({ success: false, error: "splash_core's original package id is not set (SPLASH_CORE_ORIGINAL_PACKAGE_ID)" }, { status: 502 });
  const swept = await reconcileWithdrawals(deps);
  if (swept.errors > 0) return NextResponse.json({ success: false, swept, error: `${swept.errors} withdrawals could not be settled` }, { status: 502 });
  return NextResponse.json({ success: true, swept });
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
