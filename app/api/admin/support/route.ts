import { NextResponse } from 'next/server';

import { getAdminSession } from '@/lib/server/admin-auth';
import { listSupportTicketsForStaff } from '@/lib/server/support';

export async function GET() {
  const session = await getAdminSession();

  if (!session) {
    return NextResponse.json({ error: 'Staff authentication required' }, { status: 401 });
  }

  return NextResponse.json({ tickets: listSupportTicketsForStaff() });
}
