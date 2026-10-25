import { NextResponse } from 'next/server';

import { requireCustomerRequest } from '@/lib/server/customer-auth';
import {
  custodyPhaseResponse,
  deliveryTierAllowed,
  sweepAccountDisabledResponse,
  sweepAccountEnabled,
} from '@/lib/server/custody-phase';
import { readJsonBody } from '@/lib/server/http';
import { refuseOutsideLaunchScope } from '@/lib/server/launch-scope';
import { RATE_LIMITS, enforceRateLimit } from '@/lib/server/rate-limit';
import { buildRecipient, type RecipientRecord, type RecipientTier } from '@/lib/server/operations';
import { listRecipientsFor, persistRecipient } from '@/lib/server/recipients-store';
import { requireSessionAccount } from '@/lib/server/session-account';
import { requireTermsAccepted } from '@/lib/server/onboarding';
import { createWalletRecipient, legacyWalletBody } from '@/lib/server/wallet-recipients';
import { NO_STORE, recipientRoute, walletRecipientDeps } from '@/lib/server/wallet-recipients-deps';

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

  // ── Wallet recipients (v2 §4.7): an exchange account, a wallet the
  // supplier holds (paid once proven), or USDC on another chain over CCTP.
  // Owners and staff; checked, screened, and saved only if not blocked.
  if (body.deliveryKind !== undefined && body.deliveryKind !== 'BANK') {
    const route = await recipientRoute(request);
    if (!route.ok) return route.response;
    const result = await createWalletRecipient(walletRecipientDeps(route.db, route.orgId), { body, requestedBy: route.authority.userId, requestedRole: route.authority.role });
    if (!result.ok) return NextResponse.json({ error: result.error, code: result.code }, { status: result.status, headers: NO_STORE });
    return NextResponse.json({ ...result.recipient, screening: result.screening }, { status: 201, headers: NO_STORE });
  }

  const name = String(body.name ?? '').trim();

  // Phase 0 pays out: a recipient may not be set up for a fund-holding
  // delivery until the custody package exists. An unknown tier is refused
  // too — it used to pass straight through to the store. Checked before the
  // bank/wallet split so no path can save first and gate later.
  const tier = typeof body.tier === 'string' && body.tier ? body.tier : 'PAYOUT_ONLY';
  if (!deliveryTierAllowed(tier)) return custodyPhaseResponse();
  // And a sweep recipient needs the sweep switch, the same as a sweep transfer.
  if (tier === 'SWEEP_ACCOUNT' && !sweepAccountEnabled()) return sweepAccountDisabledResponse();

  // A bank recipient exists to be paid in local currency, which this launch
  // does not do (lib/launch-scope-rules.ts). Refused before anything is saved.
  if (body.payoutMethod !== 'WALLET') {
    const outOfScope = refuseOutsideLaunchScope();
    if (outOfScope) return outOfScope;
  }

  // ── The older wallet body (payoutMethod WALLET): a wallet the supplier
  // holds, saved exactly as every wallet recipient is (v2 §4.7): owners and
  // staff only, the supplier's business details required, one address one
  // recipient, screened by the server's provider before it is saved, and
  // payable only once proven and approved by an owner. There is no second,
  // weaker save and no attestation in place of a screening.
  if (body.payoutMethod === 'WALLET') {
    if (tier !== 'PAYOUT_ONLY') {
      return NextResponse.json({ error: 'A wallet recipient is paid directly. It has no sweep account or Splash balance.' }, { status: 400 });
    }
    const route = await recipientRoute(request);
    if (!route.ok) return route.response;
    const result = await createWalletRecipient(walletRecipientDeps(route.db, route.orgId), { body: legacyWalletBody(body), requestedBy: route.authority.userId, requestedRole: route.authority.role });
    if (!result.ok) return NextResponse.json({ error: result.error, code: result.code }, { status: result.status, headers: NO_STORE });
    return NextResponse.json({ ...result.recipient, payoutMethod: 'WALLET', screening: result.screening, screeningVerdict: result.screening.verdict }, { status: 201, headers: NO_STORE });
  }

  const account = String(body.account ?? '').trim();

  if (!name || !account) {
    return NextResponse.json({ error: 'Name and account number are required' }, { status: 400 });
  }

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
