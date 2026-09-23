import { NextResponse } from 'next/server';

import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { readJsonBody } from '@/lib/server/http';
import { RATE_LIMITS, enforceRateLimit } from '@/lib/server/rate-limit';
import { createRecipient, listRecipients, type RecipientRecord, type RecipientTier } from '@/lib/server/operations';

export async function GET(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;

  return NextResponse.json(listRecipients());
}

export async function POST(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;

  // A store write: bounded per user.
  const limited = await enforceRateLimit({ rule: RATE_LIMITS.recipientCreateUser, key: auth.session.email });
  if (limited) return limited;

  const body = await readJsonBody(request);
  const name = String(body.name ?? '').trim();
  const account = String(body.account ?? '').trim();

  if (!name || !account) {
    return NextResponse.json({ error: 'Name and account number are required' }, { status: 400 });
  }

  const record = createRecipient({
    name,
    country: String(body.country ?? 'PH'),
    bank: String(body.bank ?? ''),
    swift: String(body.swift ?? ''),
    account,
    tier: body.tier as RecipientTier | undefined,
    kybStatus: body.kybStatus as RecipientRecord['kybStatus'] | undefined,
    orgEmail: typeof body.orgEmail === 'string' ? body.orgEmail : undefined,
    createdVia: body.createdVia as RecipientRecord['createdVia'] | undefined,
    sweepConfig: body.sweepConfig as RecipientRecord['sweepConfig'] | undefined,
  });

  return NextResponse.json(record, { status: 201 });
}
