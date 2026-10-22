import { NextResponse } from 'next/server';

import { getAdminSession } from '@/lib/server/admin-auth';
import { listProfileRequestsForStaff } from '@/lib/server/customer-profile';

export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await getAdminSession();

  if (!session) {
    return NextResponse.json({ error: 'Staff authentication required' }, { status: 401 });
  }

  return NextResponse.json({ requests: listProfileRequestsForStaff() });
}
