import { NextResponse } from 'next/server';

import { getAdminSession } from '@/lib/server/admin-auth';
import { listAccessRequestsForStaff } from '@/lib/server/access-requests';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The pilot access requests, for staff (v2 brief D16). The public
 * /api/access-requests route only writes; this is the read, behind the
 * staff session, for the console page and for export.
 */
export async function GET() {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ error: 'Staff authentication required' }, { status: 401 });
  }
  // Awaited: a Promise handed to NextResponse.json serialises as `{}`.
  return NextResponse.json({ requests: await listAccessRequestsForStaff() }, { headers: { 'Cache-Control': 'no-store' } });
}
