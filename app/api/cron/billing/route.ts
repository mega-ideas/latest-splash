/**
 * Subscription billing (Amendment A1 §6), behind FEATURE_SUBSCRIPTION_BILLING,
 * which is OFF. While off this answers 404 and does nothing: leave it
 * unscheduled.
 *
 * When on: settles what each submitted pull did on chain (a receipt, or a
 * grace period and a notice to the owners), ends plans at their term, marks
 * as cancelled any plan whose allowance the wallet revoked, lapses one whose
 * grace ran out, and once per business per calendar month (UTC) builds the
 * month's pull and its invoice for the finance multisig to sign. It signs
 * nothing itself. Daily is enough. 502 when a subscription could not be
 * handled.
 */
import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

import { subscriptionBillingEnabled } from '@/lib/billing/subscription';
import { runBillingCycleForStaff } from '@/lib/server/subscription-billing';
import { liveCycleDeps } from '@/lib/server/subscription-billing-deps';
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
  if (!subscriptionBillingEnabled()) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!isAuthorized(request)) return NextResponse.json({ success: false, error: 'unauthorized' }, { status: 401 });
  if (!process.env.DATABASE_URL) return NextResponse.json({ success: false, error: 'DATABASE_URL is not set' }, { status: 502 });
  const { getDb } = await import('@/lib/db/client');
  const result = await runBillingCycleForStaff(await liveCycleDeps(getDb() as unknown as DrizzleDb));
  if (!result.ok) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (result.errors.length) return NextResponse.json({ success: false, ...result }, { status: 502 });
  return NextResponse.json({ success: true, ...result });
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
