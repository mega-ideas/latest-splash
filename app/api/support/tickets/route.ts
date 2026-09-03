import { NextResponse } from 'next/server';

import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { readJsonBody } from '@/lib/server/http';
import { emitEvent } from '@/lib/server/events';
import { createSupportTicket, type SupportTicketType } from '@/lib/server/support';

export const dynamic = 'force-dynamic';

const allowedTypes = new Set<SupportTicketType>(['bug', 'feature', 'complaint', 'other']);

export async function POST(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;

  const body = await readJsonBody(request);
  const type = String(body.type ?? 'other') as SupportTicketType;
  const subject = String(body.subject ?? '').trim();
  const message = String(body.message ?? '').trim();
  const email = String(body.email ?? '').trim();

  if (!allowedTypes.has(type)) {
    return NextResponse.json({ error: 'Unsupported ticket type' }, { status: 400 });
  }

  if (!subject || !message) {
    return NextResponse.json({ error: 'Subject and message are required' }, { status: 400 });
  }

  const ticket = createSupportTicket({ type, subject, message, email });
  void emitEvent({
    name: 'support_ticket_opened',
    orgId: auth.session.orgId ?? auth.session.email,
    actorId: auth.session.email,
    subjectId: ticket.id,
    props: { type, priority: ticket.priority },
  });

  return NextResponse.json({ ticket }, { status: 201 });
}
