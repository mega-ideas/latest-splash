import { NextResponse } from 'next/server';

import { subscriptionBillingEnabled } from '@/lib/billing/subscription';
import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { listPlans } from '@/lib/server/subscription-billing';
import type { DrizzleDb } from '@/lib/server/wallet-signing-store';

export const dynamic = 'force-dynamic';

/**
 * The plans a business can subscribe to (Amendment A1 §6), each with its
 * Settings line. Behind FEATURE_SUBSCRIPTION_BILLING, which is OFF: while
 * off this answers 404 before it reads anything.
 */
export async function GET(request: Request) {
  if (!subscriptionBillingEnabled()) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;
  if (!process.env.DATABASE_URL) return NextResponse.json({ error: 'plans need the database, and DATABASE_URL is not set' }, { status: 503 });
  const { getDb } = await import('@/lib/db/client');
  const result = await listPlans({ db: getDb() as unknown as DrizzleDb });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ plans: result.plans }, { headers: { 'Cache-Control': 'no-store' } });
}
