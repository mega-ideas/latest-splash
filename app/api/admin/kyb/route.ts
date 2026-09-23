import { NextResponse } from 'next/server';

import { getAdminSession } from '@/lib/server/admin-auth';
import { listKybCasesForStaff } from '@/lib/server/kyb';

export async function GET() {
  const session = await getAdminSession();

  if (!session) {
    return NextResponse.json({ error: 'Staff authentication required' }, { status: 401 });
  }

  // Cross-tenant by design, behind a staff session — spelled `ForStaff` so
  // that is visible here rather than implied by an absent argument.
  return NextResponse.json({ cases: await listKybCasesForStaff() });
}
