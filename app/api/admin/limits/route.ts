import { NextResponse } from 'next/server';

import { getAdminSession } from '@/lib/server/admin-auth';
import { listLimitRequestsForStaff } from '@/lib/server/business-limits';
import type { DrizzleDb } from '@/lib/server/wallet-signing-store';

export const dynamic = 'force-dynamic';

/**
 * The queue of owners' requests for higher limits, for Splash staff:
 * compliance and operations (support is refused). Cross-tenant by nature,
 * through the *ForStaff service function.
 */
export async function GET() {
  const session = await getAdminSession();
  if (!session) return NextResponse.json({ error: 'Staff authentication required' }, { status: 401 });
  if (!process.env.DATABASE_URL) return NextResponse.json({ error: 'DATABASE_URL is not set' }, { status: 503 });
  const { getDb } = await import('@/lib/db/client');
  const result = await listLimitRequestsForStaff(getDb() as unknown as DrizzleDb, { email: session.email, role: session.role });
  if (!result.ok) return NextResponse.json({ error: result.error, code: result.code }, { status: result.status });
  return NextResponse.json({ open: result.open, recent: result.recent });
}
