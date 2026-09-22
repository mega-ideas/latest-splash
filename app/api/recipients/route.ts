import { NextResponse } from 'next/server';

import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { custodyPhaseResponse, deliveryTierAllowed } from '@/lib/server/custody-phase';
import { readJsonBody } from '@/lib/server/http';
import { createRecipient, listRecipients, type RecipientRecord, type RecipientTier } from '@/lib/server/operations';

export async function GET(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;

  return NextResponse.json(listRecipients());
}

export async function POST(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;

  const body = await readJsonBody(request);
  const name = String(body.name ?? '').trim();
  const account = String(body.account ?? '').trim();

  if (!name || !account) {
    return NextResponse.json({ error: 'Name and account number are required' }, { status: 400 });
  }

  // Phase 0 pays out: a recipient may not be set up for a fund-holding
  // delivery until the custody package exists. An unknown tier is refused
  // too — it used to pass straight through to the store.
  const tier = typeof body.tier === 'string' && body.tier ? body.tier : 'PAYOUT_ONLY';
  if (!deliveryTierAllowed(tier)) return custodyPhaseResponse();

  const record = createRecipient({
    name,
    country: String(body.country ?? 'PH'),
    bank: String(body.bank ?? ''),
    swift: String(body.swift ?? ''),
    account,
    tier: tier as RecipientTier,
    kybStatus: body.kybStatus as RecipientRecord['kybStatus'] | undefined,
    orgEmail: typeof body.orgEmail === 'string' ? body.orgEmail : undefined,
    createdVia: body.createdVia as RecipientRecord['createdVia'] | undefined,
    sweepConfig: body.sweepConfig as RecipientRecord['sweepConfig'] | undefined,
  });

  return NextResponse.json(record, { status: 201 });
}
