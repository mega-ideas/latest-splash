/**
 * The live wiring for the §4.6 compliance routes, for ONE org: the wallet
 * route's gate (signed-in customer, org from the SESSION via
 * requireSessionAccount, own membership; lib/server/wallet-route.ts), the
 * screening provider, the Travel Rule provider, this org's saved recipients
 * and the chain reader. Nothing here reads an org from the request.
 */
import 'server-only';

import { normalizeSuiAddress } from '@mysten/sui/utils';
import { NextResponse } from 'next/server';

import { ComplianceProviderUnavailable, travelRuleProviderFromEnv, type TravelRuleProvider } from '@/lib/compliance/sumsub';
import { kytProviderFromEnv } from '@/lib/compliance/kyt';
import { parseSignedPartners } from '@/lib/partners/signed-partners';
import { corePackageOriginalIdFor } from '@/lib/payouts/withdrawal-rules';
import type { EvidenceDeps } from '@/lib/server/controls-evidence';
import type { ExchangePaymentDeps, SavedRecipient } from '@/lib/server/exchange-payment-compliance';
import type { ScreenDeps } from '@/lib/server/kyt-screenings';
import { listRecipientsFor } from '@/lib/server/recipients-store';
import { NO_STORE, type WalletRoute } from '@/lib/server/wallet-route';
import { readWithdrawalTransaction } from '@/lib/server/withdrawals-deps';

/** This org's ONE saved WALLET recipient at an address, with its Travel Rule half; two at one address is ambiguous. */
export async function savedRecipientAt(orgId: string, address: string): Promise<SavedRecipient | { ambiguous: true } | null> {
  const list = await listRecipientsFor(orgId);
  const matches = list.filter((r) => {
    if (r.payoutMethod !== 'WALLET' || !r.walletAddress) return false;
    try {
      return normalizeSuiAddress(r.walletAddress) === address;
    } catch {
      return false;
    }
  });
  if (matches.length > 1) return { ambiguous: true };
  const match = matches[0];
  if (!match) return null;
  const t = match.travelRule ?? {};
  return {
    name: match.name,
    country: (t.addressCountry ?? match.country ?? '').toUpperCase(),
    legalName: t.legalName ?? null,
    registrationNumber: t.registrationNumber ?? null,
    town: t.addressCity ?? null,
    street: t.addressLine1 ?? null,
    postCode: t.addressPostalCode ?? null,
  };
}

export function evidenceDepsFor(route: WalletRoute, env: NodeJS.ProcessEnv = process.env): EvidenceDeps {
  return { db: route.db, orgId: route.orgId, now: () => new Date(), readTransaction: readWithdrawalTransaction, corePackageOriginalId: corePackageOriginalIdFor(env) };
}

export function screenDepsFor(route: Pick<WalletRoute, 'db' | 'orgId'>, env: NodeJS.ProcessEnv = process.env): ScreenDeps {
  return { db: route.db, orgId: route.orgId, kyt: kytProviderFromEnv(env), now: () => new Date() };
}

export function exchangePaymentDepsFor(route: WalletRoute, env: NodeJS.ProcessEnv = process.env): ExchangePaymentDeps & { signedPartners: ReturnType<typeof parseSignedPartners> } {
  return { db: route.db, orgId: route.orgId, now: () => new Date(), recipientAt: savedRecipientAt, signedPartners: parseSignedPartners(env.SIGNED_PARTNERS) };
}

/** The Travel Rule provider, or the refusal a route returns (production without Sumsub's Travel Rule). */
export function travelRuleProviderOrRefusal(env: NodeJS.ProcessEnv = process.env): { provider: TravelRuleProvider; response: null } | { provider: null; response: Response } {
  try {
    return { provider: travelRuleProviderFromEnv(env), response: null };
  } catch (error) {
    if (error instanceof ComplianceProviderUnavailable) {
      return { provider: null, response: NextResponse.json({ error: error.message, code: error.code }, { status: error.status, headers: NO_STORE }) };
    }
    throw error;
  }
}

export function complianceResponse(result: { ok: boolean } & Record<string, unknown>, okStatus = 200): Response {
  if (result.ok) {
    const { ok: _ok, ...rest } = result;
    void _ok;
    return NextResponse.json(rest, { status: okStatus, headers: NO_STORE });
  }
  const { status, code, error } = result as unknown as { status: number; code: string; error: string };
  return NextResponse.json({ error, code }, { status, headers: NO_STORE });
}
