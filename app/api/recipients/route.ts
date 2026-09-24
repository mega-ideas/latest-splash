import { NextResponse } from 'next/server';

import { requireCustomerRequest } from '@/lib/server/customer-auth';
import {
  custodyPhaseResponse,
  deliveryTierAllowed,
  sweepAccountDisabledResponse,
  sweepAccountEnabled,
} from '@/lib/server/custody-phase';
import { readJsonBody } from '@/lib/server/http';
import { RATE_LIMITS, enforceRateLimit } from '@/lib/server/rate-limit';
import { buildRecipient, type RecipientRecord, type RecipientTier } from '@/lib/server/operations';
import { listRecipientsFor, persistRecipient, recordRecipientScreening } from '@/lib/server/recipients-store';
import { requireSessionAccount } from '@/lib/server/session-account';
import { requireTermsAccepted } from '@/lib/server/onboarding';
import { resolveAuthorityForSession } from '@/lib/auth/authority';
import { normaliseSuiAddress, StablecoinLaneError, WALLET_PROVIDERS } from '@/lib/payments/stablecoin-lane';
import { attestation, screenWalletAddress } from '@/lib/server/wallet-screening';

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

  // Phase 0 pays out: a recipient may not be set up for a fund-holding
  // delivery until the custody package exists. An unknown tier is refused
  // too — it used to pass straight through to the store. Checked before the
  // bank/wallet split so no path can save first and gate later.
  const tier = typeof body.tier === 'string' && body.tier ? body.tier : 'PAYOUT_ONLY';
  if (!deliveryTierAllowed(tier)) return custodyPhaseResponse();
  // And a sweep recipient needs the sweep switch, the same as a sweep transfer.
  if (tier === 'SWEEP_ACCOUNT' && !sweepAccountEnabled()) return sweepAccountDisabledResponse();

  // ── Wallet recipients: USDC on Sui, the lane an unverified business may use.
  if (body.payoutMethod === 'WALLET') {
    if (!name) return NextResponse.json({ error: 'Name is required' }, { status: 400 });
    if (tier !== 'PAYOUT_ONLY') {
      return NextResponse.json({ error: 'A wallet recipient is paid directly. It has no sweep account or Splash balance.' }, { status: 400 });
    }
    const country = String(body.country ?? '').trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(country)) {
      return NextResponse.json({ error: 'Country is required (two letters, e.g. PH)' }, { status: 400 });
    }
    let walletAddress: string;
    try {
      walletAddress = normaliseSuiAddress(String(body.walletAddress ?? ''));
    } catch (error) {
      if (error instanceof StablecoinLaneError) return NextResponse.json({ error: error.message }, { status: 400 });
      throw error;
    }
    const walletProvider = String(body.walletProvider ?? '');
    if (!(WALLET_PROVIDERS as readonly string[]).includes(walletProvider)) {
      return NextResponse.json({ error: 'Wallet must be Slush, or MetaMask with the Sui Snap' }, { status: 400 });
    }

    // Screen BEFORE saving: a listed address never enters the recipient list,
    // which is what Zeke and the send screen read from.
    let screening = await screenWalletAddress(walletAddress);
    if (screening.verdict === 'BLOCK') {
      return NextResponse.json({ error: 'This wallet is on a sanctions list. Splash will not add it as a recipient.' }, { status: 403 });
    }
    if (screening.verdict === null && body.attestKnownRecipient === true) {
      const ctx = await resolveAuthorityForSession(auth.session);
      if (ctx.role !== 'OWNER' && ctx.role !== 'FINANCE_ADMIN') {
        return NextResponse.json({ error: 'Only an admin can attest to an unscreened recipient' }, { status: 403 });
      }
      screening = attestation(ctx.userId);
    }

    const walletRecord = await persistRecipient(buildRecipient({
      orgId: accountCheck.account.orgId,
      name,
      country,
      tier: 'PAYOUT_ONLY',
      payoutMethod: 'WALLET',
      walletAddress,
      walletProvider,
      createdVia: 'manual',
    }));
    await recordRecipientScreening(accountCheck.account.orgId, walletRecord.id, screening);
    return NextResponse.json({ ...walletRecord, screeningVerdict: screening.verdict, screeningDetail: screening.detail }, { status: 201 });
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
