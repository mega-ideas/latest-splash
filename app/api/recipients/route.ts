import { NextResponse } from 'next/server';

import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { custodyPhaseResponse, deliveryTierAllowed } from '@/lib/server/custody-phase';
import { readJsonBody } from '@/lib/server/http';
import { RATE_LIMITS, enforceRateLimit } from '@/lib/server/rate-limit';
import { buildRecipient, type RecipientRecord, type RecipientTier } from '@/lib/server/operations';
import { listRecipientsFor, persistRecipient } from '@/lib/server/recipients-store';
import { requireSessionAccount } from '@/lib/server/session-account';
import { requireTermsAccepted } from '@/lib/server/onboarding';

export async function GET(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;

  // This returned EVERY tenant's beneficiaries — names, banks, SWIFT codes,
  // account numbers — to any authenticated caller. Not one record at a time:
  // the whole list, which is the entire PII payload a travel-rule record
  // exists to protect.
  const accountCheck = await requireSessionAccount(auth.session);
  if (accountCheck.response) return accountCheck.response;

  return NextResponse.json(await listRecipientsFor(accountCheck.account.orgId));
}

export async function POST(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;

  // A store write: bounded per user.
  const limited = await enforceRateLimit({ rule: RATE_LIMITS.recipientCreateUser, key: auth.session.email });
  if (limited) return limited;
  const accountCheck = await requireSessionAccount(auth.session);
  if (accountCheck.response) return accountCheck.response;

  // Onboarding: the terms are a fact on file before anything spends or a
  // record is created (lib/server/onboarding.ts). Sits BESIDE the KYB gate,
  // never instead of it.
  const termsGate = await requireTermsAccepted(accountCheck.account.orgId);
  if (termsGate) return termsGate;

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

  const record = await persistRecipient(buildRecipient({
    // From the SESSION, never the request. This is the field that decides whose
    // beneficiary it is and therefore who can read it back.
    orgId: accountCheck.account.orgId,
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
  }));

  return NextResponse.json(record, { status: 201 });
}
