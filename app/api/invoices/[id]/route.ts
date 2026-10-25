import { NextResponse } from 'next/server';
import { z } from 'zod';

import { invoiceDeliveryTier } from '@/lib/server/custody-phase';
import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { readJsonBody } from '@/lib/server/http';
import { ISSUER_SETTABLE, canMoveInvoice } from '@/lib/invoices/status';
import { patchInvoice, readInvoice } from '@/lib/server/invoices-store';
import { requireSessionAccount } from '@/lib/server/session-account';

const patchSchema = z.object({
  // The business moves its own invoice forward only (lib/invoices/status.ts).
  // "reported" is the payer's, from the pay link, and "viewed" the page's.
  status: z.enum(ISSUER_SETTABLE as [string, ...string[]]).optional(),
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
  // The transfer page prefills its delivery step from recommendedDeliveryTier.
  // It is a client component and cannot read the custody phase, so the server
  // decides — with the same gate the authorize step enforces.
  return invoice
    ? NextResponse.json({ ...invoice, recommendedDeliveryTier: invoiceDeliveryTier(invoice.targetCurrency) })
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
  const current = await readInvoice(accountCheck.account.orgId, id);
  if (!current) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
  const next = parsed.data.status as typeof current.status | undefined;
  // Forward only: a settled invoice never goes back to draft, a paid one
  // never back to sent.
  if (next && !canMoveInvoice(current.status, next)) {
    return NextResponse.json({ error: `A ${current.status} invoice cannot be marked ${next}.`, code: 'status' }, { status: 409 });
  }
  // Marked paid by hand means a bank payment the business has seen: it says
  // which, by its reference, unless the payer or Sui already did.
  if (next === 'paid' && current.status !== 'paid' && !current.usdcTxDigest && !(parsed.data.paymentReference ?? current.paymentReference)) {
    return NextResponse.json({ error: 'Add the payment reference you received.', code: 'reference' }, { status: 422 });
  }
  // The transfer an invoice binds to is set once.
  if (parsed.data.transferIntentId && current.transferIntentId && parsed.data.transferIntentId !== current.transferIntentId) {
    return NextResponse.json({ error: 'This invoice is already bound to a transfer.', code: 'transfer' }, { status: 409 });
  }
  const { status: _ignored, ...rest } = parsed.data;
  void _ignored;
  const invoice = await patchInvoice(accountCheck.account.orgId, id, next ? { ...rest, status: next } : rest);
  return invoice
    ? NextResponse.json(invoice)
    : NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
}
