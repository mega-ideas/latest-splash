/**
 * The month's billing pulls waiting for the finance multisig's signers (A1
 * §6), behind FEATURE_SUBSCRIPTION_BILLING, which is OFF: while off this
 * answers 404 before it reads a session or the database.
 *
 * GET  each pull's stored bytes and digest, and what the bytes do, read from
 *      the bytes (describeBillingPull): who draws, from which business
 *      wallet, under which allowance, how much, to whom. Each finance signer
 *      checks that and signs on their own device; the server never signs.
 *
 * Operations staff only; cross-tenant, through the *ForStaff reader.
 */
import { NextResponse } from 'next/server';

import { subscriptionBillingEnabled } from '@/lib/billing/subscription';
import { getAdminSession } from '@/lib/server/admin-auth';
import { listPullsAwaitingSignatureForStaff } from '@/lib/server/subscription-billing';
import type { DrizzleDb } from '@/lib/server/wallet-signing-store';

export const dynamic = 'force-dynamic';

export async function GET() {
  if (!subscriptionBillingEnabled()) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const session = await getAdminSession();
  if (!session) return NextResponse.json({ error: 'Staff authentication required' }, { status: 401 });
  if (session.role !== 'operations') return NextResponse.json({ error: 'Billing is for operations staff' }, { status: 403 });
  if (!process.env.DATABASE_URL) return NextResponse.json({ error: 'DATABASE_URL is not set' }, { status: 503 });
  const [{ getDb }, { walletUsdcType }] = await Promise.all([import('@/lib/db/client'), import('@/lib/server/wallet-deps')]);
  const result = await listPullsAwaitingSignatureForStaff({ db: getDb() as unknown as DrizzleDb, usdcType: walletUsdcType() });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ pulls: result.pulls }, { headers: { 'Cache-Control': 'no-store' } });
}
