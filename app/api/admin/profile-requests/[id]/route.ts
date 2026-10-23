import { NextResponse } from 'next/server';

import { getAdminSession } from '@/lib/server/admin-auth';
import { readJsonBody } from '@/lib/server/http';
import { decideProfileRequestForStaff } from '@/lib/server/customer-profile';

export const dynamic = 'force-dynamic';

/** Approve or reject a customer profile change request (checker side). */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();

  if (!session) {
    return NextResponse.json({ error: 'Staff authentication required' }, { status: 401 });
  }

  const { id } = await params;
  const body = await readJsonBody(request);
  const action = String(body.action ?? '');

  if (action !== 'approve' && action !== 'reject') {
    return NextResponse.json({ error: 'Action must be "approve" or "reject".' }, { status: 400 });
  }

  try {
    const decided = decideProfileRequestForStaff(id, {
      action,
      actor: session.email,
      reason: typeof body.reason === 'string' ? body.reason : undefined,
    });
    return NextResponse.json({ request: decided });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unable to decide the change request.' },
      { status: 400 },
    );
  }
}
