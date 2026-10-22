import { NextResponse } from 'next/server';

import { getAdminSession } from '@/lib/server/admin-auth';
import { readJsonBody } from '@/lib/server/http';
import { readSupportTicketForStaff, updateSupportTicketForStaff, type SupportTicketStatus } from '@/lib/server/support';

const allowedStatuses = new Set<SupportTicketStatus>(['OPEN', 'IN_REVIEW', 'REPLIED', 'CLOSED']);

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();

  if (!session) {
    return NextResponse.json({ error: 'Staff authentication required' }, { status: 401 });
  }

  const { id } = await params;
  const record = readSupportTicketForStaff(id);

  if (!record) {
    return NextResponse.json({ error: 'Support ticket not found' }, { status: 404 });
  }

  return NextResponse.json({ ticket: record });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();

  if (!session) {
    return NextResponse.json({ error: 'Staff authentication required' }, { status: 401 });
  }

  const { id } = await params;
  const body = await readJsonBody(request);
  const status = body.status ? String(body.status) as SupportTicketStatus : undefined;

  if (status && !allowedStatuses.has(status)) {
    return NextResponse.json({ error: 'Unsupported ticket status' }, { status: 400 });
  }

  const record = updateSupportTicketForStaff(id, {
    status,
    actor: session.email,
    replyMessage: typeof body.replyMessage === 'string' ? body.replyMessage : undefined,
    assignedTo: typeof body.assignedTo === 'string' ? body.assignedTo : undefined,
  });

  if (!record) {
    return NextResponse.json({ error: 'Support ticket not found' }, { status: 404 });
  }

  return NextResponse.json({ ticket: record });
}
