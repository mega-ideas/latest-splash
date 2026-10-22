import { NextResponse } from 'next/server';

import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { readJsonBody } from '@/lib/server/http';
import { requireSessionAccount } from '@/lib/server/session-account';
import { readSupportTicket, updateSupportTicket } from '@/lib/server/support';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;
  // Scoped to the session's workspace: another tenant's ticket id reads as
  // missing, the same 404 an id that never existed gets.
  const accountCheck = await requireSessionAccount(auth.session);
  if (accountCheck.response) return accountCheck.response;

  const { id } = await params;
  const ticket = readSupportTicket(accountCheck.account.orgId, id);

  if (!ticket) {
    return NextResponse.json({ error: 'Support ticket not found' }, { status: 404 });
  }

  return NextResponse.json({ ticket });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;
  const accountCheck = await requireSessionAccount(auth.session);
  if (accountCheck.response) return accountCheck.response;

  const { id } = await params;
  const body = await readJsonBody(request);
  const message = String(body.message ?? '').trim();
  // Who replied is the session, not a name the request supplies.
  const actor = auth.session.email;

  if (!message) {
    return NextResponse.json({ error: 'Message is required' }, { status: 400 });
  }

  const ticket = updateSupportTicket(accountCheck.account.orgId, id, {
    status: 'OPEN',
    actor,
    actorType: 'customer',
    replyMessage: message,
  });

  if (!ticket) {
    return NextResponse.json({ error: 'Support ticket not found' }, { status: 404 });
  }

  return NextResponse.json({ ticket });
}
