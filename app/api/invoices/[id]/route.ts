import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { readJsonBody } from '@/lib/server/http';
import { patchInvoice, readInvoice } from '@/lib/server/invoices-store';
import { requireSessionAccount } from '@/lib/server/session-account';

const patchSchema = z.object({
  status: z.enum(['draft', 'sent', 'viewed', 'paid', 'settled', 'overdue']).optional(),
  paymentReference: z.string().trim().optional(),
  transferIntentId: z.string().trim().optional(),
});

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;

  const accountCheck = await requireSessionAccount(auth.session);
  if (accountCheck.response) return accountCheck.response;

  const { id } = await params;
  const invoice = await readInvoice(accountCheck.account.orgId, id);
  // 404 for both "does not exist" and "not yours".
  return invoice
    ? NextResponse.json(invoice)
    : NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;

  // The sharper half: this MODIFIED any tenant's invoice by id — its status,
  // its payment reference, the transfer it binds to. A write across the
  // tenant boundary, not merely a read.
  const accountCheck = await requireSessionAccount(auth.session);
  if (accountCheck.response) return accountCheck.response;

  const { id } = await params;
  const parsed = patchSchema.safeParse(await readJsonBody(request));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid invoice update' }, { status: 400 });
  const invoice = await patchInvoice(accountCheck.account.orgId, id, parsed.data);
  return invoice
    ? NextResponse.json(invoice)
    : NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
}
