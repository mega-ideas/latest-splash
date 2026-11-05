import { NextResponse } from 'next/server';
import { z } from 'zod';

import { UnauthorizedError, resolveAuthorityForSession } from '@/lib/auth/authority';
import { withoutCreateKey } from '@/lib/invoices/create-once';
import { checkInvoicePatch } from '@/lib/invoices/patch-rules';
import { ISSUER_SETTABLE } from '@/lib/invoices/status';
import { invoiceDeliveryTier } from '@/lib/server/custody-phase';
import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { readJsonBody } from '@/lib/server/http';
import { patchInvoice, readInvoice } from '@/lib/server/invoices-store';
import { requireSessionAccount } from '@/lib/server/session-account';
import { readTransfer } from '@/lib/server/transfers-store';

const patchSchema = z.object({
  // The business moves its own invoice forward only (lib/invoices/status.ts).
  // "reported" is the payer's, from the pay link, and "viewed" the page's.
  status: z.enum(ISSUER_SETTABLE as [string, ...string[]]).optional(),
  paymentReference: z.string().trim().max(200).optional(),
  transferIntentId: z.string().trim().max(120).optional(),
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
    ? NextResponse.json({ ...withoutCreateKey(invoice), recommendedDeliveryTier: invoiceDeliveryTier(invoice.targetCurrency) })
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
  // The role is the membership row's, never the request's; with no
  // membership readable, nothing is changed.
  let role: string;
  try {
    const authority = await resolveAuthorityForSession(auth.session);
    if (authority.orgId !== accountCheck.account.orgId) {
      return NextResponse.json({ error: 'The session and its membership disagree about the business.' }, { status: 403 });
    }
    role = authority.role;
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'No workspace membership yet.', code: 'no_membership' }, { status: 403 });
    }
    throw error;
  }
  const current = await readInvoice(accountCheck.account.orgId, id);
  if (!current) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
  const next = parsed.data.status as typeof current.status | undefined;
  // Forward only; paid by hand needs the reference the business received
  // (the one on file and the payer's report are not evidence), given once
  // with "paid" and never rewritten after; a transfer is the business's own
  // and bound once (lib/invoices/patch-rules.ts).
  const transferOwned = parsed.data.transferIntentId
    ? (await readTransfer(accountCheck.account.orgId, parsed.data.transferIntentId)) !== null
    : false;
  const refusal = checkInvoicePatch({ role, current, patch: parsed.data, transferOwned });
  if (refusal) return NextResponse.json({ error: refusal.error, code: refusal.code }, { status: refusal.status });
  // The reference the business received is kept as its own (receivedReference),
  // beside the one the payer was asked to quote, which stays as it was.
  const { status: _ignored, paymentReference, ...rest } = parsed.data;
  void _ignored;
  const patch = {
    ...rest,
    ...(next ? { status: next } : {}),
    ...(paymentReference !== undefined ? { receivedReference: paymentReference } : {}),
  };
  // Guarded on the status read: a USDC sync that settled the invoice in
  // between is not overwritten with an older status.
  const invoice = await patchInvoice(accountCheck.account.orgId, id, patch, { status: current.status });
  if (invoice) return NextResponse.json(withoutCreateKey(invoice));
  const now = await readInvoice(accountCheck.account.orgId, id);
  return now
    ? NextResponse.json({ error: `The invoice changed while it was being updated; it is ${now.status} now. Check it again.`, code: 'changed' }, { status: 409 })
    : NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
}
