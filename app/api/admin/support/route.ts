import { NextResponse } from 'next/server';

import { getAdminSession } from '@/lib/server/admin-auth';
import { listSupportTicketsForStaff } from '@/lib/server/support';

export async function GET() {
  const session = await getAdminSession();

  if (!session) {
    return NextResponse.json({ error: 'Staff authentication required' }, { status: 401 });
  }

  // Awaited: a Promise handed to NextResponse.json serialises as `{}`, and
  // tsc does not notice, because `json` takes anything.
  return NextResponse.json({ tickets: await listSupportTicketsForStaff() });
}
