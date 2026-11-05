/**
 * The live wiring for withdrawals to the business's own bank (v2 §4.4), for
 * ONE org: the wallet route's gate (signed-in customer, org from the SESSION
 * via requireSessionAccount, own membership, the live wallet context for
 * that org only; lib/server/wallet-route.ts), then the payout partner, the
 * business's registered name, Splash's live bank-payout fee and the chain.
 * Nothing here reads an org, an account, a wallet, an address or a fee from
 * the request.
 */
import 'server-only';

import { eq } from 'drizzle-orm';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { NextResponse } from 'next/server';

import { organizations } from '@/lib/db/schema';
import { parseSignedPartners } from '@/lib/partners/signed-partners';
import { debtorFromProfile } from '@/lib/payments/iso20022';
import { payoutPartner } from '@/lib/payouts/registry';
import { corePackageOriginalIdFor, splashControlledAddresses } from '@/lib/payouts/withdrawal-rules';
import { currentWalletMembers } from '@/lib/server/business-wallet';
import { stablecoinOnly } from '@/lib/server/launch-scope';
import { NO_STORE, walletRoute, type WalletRoute } from '@/lib/server/wallet-route';
import { verifiedLegalName, type SettlementDeps, type WithdrawalChainTx, type WithdrawalDeps } from '@/lib/server/withdrawals';
import { isAnotherBusinessWallet } from '@/lib/server/withdrawals-store';

/** A Sui transaction's sender and balance changes, read from the fullnode. Null when the chain has not seen it. */
export async function readWithdrawalTransaction(digest: string): Promise<WithdrawalChainTx | null> {
  const { suiClient } = await import('@/lib/sui');
  let result;
  try {
    result = await suiClient.core.getTransaction({ digest, include: { effects: true, balanceChanges: true, transaction: true, events: true } });
  } catch (error) {
    if (/not ?found|does not exist|unknown/i.test(error instanceof Error ? error.message : '')) return null;
    throw error;
  }
  const t = (result.$kind === 'Transaction' ? result.Transaction : result.FailedTransaction) as unknown as {
    digest?: string;
    status: { success: boolean };
    balanceChanges?: Array<{ coinType: string; address: string; amount: string }>;
    transaction?: { sender?: string | null };
    events?: Array<{ packageId: string; eventType: string; json: Record<string, unknown> | null }>;
    checkpoint?: string | null;
  };
  return {
    digest: t.digest ?? digest,
    success: t.status.success,
    sender: t.transaction?.sender ?? null,
    checkpoint: t.checkpoint ?? null,
    balanceChanges: t.balanceChanges ?? [],
    events: (t.events ?? []).map((e) => ({ packageId: e.packageId, eventType: e.eventType, json: e.json })),
  };
}

/** What settling a withdrawal needs, for the signing hook and the sweep (no org: each row acts within its own). */
export function withdrawalSettlementDeps(db: SettlementDeps['db'], env: NodeJS.ProcessEnv = process.env): SettlementDeps | null {
  const corePackageOriginalId = corePackageOriginalIdFor(env);
  if (!corePackageOriginalId) return null;
  return { db, now: () => new Date(), partner: (id) => payoutPartner(id, env), readTransaction: readWithdrawalTransaction, corePackageOriginalId };
}

export function withdrawalDepsFor(route: WalletRoute, env: NodeJS.ProcessEnv = process.env): WithdrawalDeps {
  const { orgId, ctx, db } = route;
  const original = corePackageOriginalIdFor(env) ?? '';
  return {
    db,
    orgId,
    env,
    now: () => new Date(),
    ctx,
    walletMembers: async () => {
      const current = await currentWalletMembers(ctx, db, orgId);
      return current.ok ? { ok: true, address: current.address, members: current.members } : { ok: false, status: current.status, code: current.code, error: current.error };
    },
    partner: (id) => payoutPartner(id, env),
    // The registered (legal) name only, and only as KYB verified it: a trading
    // name is not who a bank account is held by, and a name nobody verified
    // is only what someone typed.
    companyName: async () => {
      const [org] = await db.select({ legalName: organizations.legalName, kybStatus: organizations.kybStatus }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
      return org ? verifiedLegalName(org) : null;
    },
    // Read live each time: FeeConfig's recipient can change (24h notice).
    splashAddresses: async () => {
      const { getFeeConfig } = await import('@/lib/fees/fee-config');
      const feeConfig = await getFeeConfig();
      const { splashCrossChainAddresses } = await import('@/lib/server/splash-addresses');
      return splashControlledAddresses({ env, sponsor: ctx.signing.sponsor?.address ?? null, feeConfig, extra: splashCrossChainAddresses(env) });
    },
    isBusinessWallet: (address) => isAnotherBusinessWallet(db, orgId, normalizeSuiAddress(address)),
    bankPayoutFee: async (principalMinor) => {
      const { currentSplashFee } = await import('@/lib/fees/fee-config');
      const { FEE_KIND } = await import('@/lib/fees/schedule');
      const fee = await currentSplashFee({ businessId: normalizeSuiAddress(ctx.account.objectId), kind: FEE_KIND.BANK_PAYOUT, principalMinor });
      return { feeMinor: fee.feeMinor, feesOn: fee.feesOn };
    },
    readTransaction: readWithdrawalTransaction,
    corePackageOriginalId: original,
    fiatOutOpen: () => !stablecoinOnly(),
    signedPartners: parseSignedPartners(env.SIGNED_PARTNERS),
    // The paying business as an ISO 20022 party, from its KYB profile (the
    // columns lib/server/originator.ts reads), and only once KYB verified the name.
    debtorParty: async () => {
      const [org] = await db
        .select({
          legalName: organizations.legalName,
          kybStatus: organizations.kybStatus,
          registrationNumber: organizations.registrationNumber,
          addressLine1: organizations.addressLine1,
          addressLine2: organizations.addressLine2,
          addressCity: organizations.addressCity,
          addressState: organizations.addressState,
          addressPostalCode: organizations.addressPostalCode,
          addressCountry: organizations.addressCountry,
        })
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .limit(1);
      if (!org) return { party: null, missing: ['profile'] };
      return debtorFromProfile({ ...org, legalName: verifiedLegalName(org) });
    },
  };
}

/** The front of every /api/wallet/withdrawals route. */
export async function withdrawalRoute(request: Request): Promise<{ route: WalletRoute; deps: WithdrawalDeps; response: null } | { route: null; deps: null; response: Response }> {
  const gate = await walletRoute(request);
  if (gate.response) return { route: null, deps: null, response: gate.response };
  // Production names splash_core's original package id explicitly: the intent
  // id the partner is keyed by is derived under it, and the current id would
  // give one the chain never creates once core has been upgraded.
  if (!corePackageOriginalIdFor(process.env)) {
    return { route: null, deps: null, response: NextResponse.json({ error: "withdrawals need splash_core's original package id (SPLASH_CORE_ORIGINAL_PACKAGE_ID)", code: 'no_core_package' }, { status: 503, headers: NO_STORE }) };
  }
  return { route: gate.route, deps: withdrawalDepsFor(gate.route), response: null };
}

/** A service result as a response: a refusal keeps its extra fields (a changed quote, say). */
export function withdrawalResponse(result: { ok: boolean } & Record<string, unknown>, okStatus = 200): Response {
  const { ok, status, ...rest } = result as { ok: boolean; status?: number } & Record<string, unknown>;
  if (!ok) return NextResponse.json(rest, { status: typeof status === 'number' ? status : 400, headers: NO_STORE });
  return NextResponse.json(rest, { status: okStatus, headers: NO_STORE });
}
