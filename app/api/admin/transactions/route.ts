import { NextResponse } from 'next/server';

import { getAdminSession } from '@/lib/server/admin-auth';
import { analyticsSummary } from '@/lib/server/operations';
import { listTransfersForStaff } from '@/lib/server/transfers-store';
import { listFundingSessions } from '@/lib/server/funding-sessions';

export async function GET(request: Request) {
  const session = await getAdminSession();

  if (!session) {
    return NextResponse.json({ error: 'Staff authentication required' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const page = Math.max(1, Number.parseInt(searchParams.get('page') ?? '1', 10));
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(searchParams.get('pageSize') ?? '25', 10)));
  const transfers = await listTransfersForStaff();
  const fundingSessions = listFundingSessions();
  const start = (page - 1) * pageSize;
  const paginated = transfers.slice(start, start + pageSize);

  return NextResponse.json({
    transfers: paginated,
    fundingSessions,
    pagination: {
      page,
      pageSize,
      total: transfers.length,
      totalPages: Math.ceil(transfers.length / pageSize),
    },
    summary: {
      analytics: analyticsSummary(),
    },
  });
}
