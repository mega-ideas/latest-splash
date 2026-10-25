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
import { payoutPartner } from '@/lib/payouts/registry';
import { currentWalletMembers } from '@/lib/server/business-wallet';
import { stablecoinOnly } from '@/lib/server/launch-scope';
import { NO_STORE, walletRoute, type WalletRoute } from '@/lib/server/wallet-route';
import type { WithdrawalChainTx, WithdrawalDeps } from '@/lib/server/withdrawals';

/** A Sui transaction's sender and balance changes, read from the fullnode. Null when the chain has not seen it. */
export async function readWithdrawalTransaction(digest: string): Promise<WithdrawalChainTx | null> {
  const { suiClient } = await import('@/lib/sui');
  let result;
  try {
    result = await suiClient.core.getTransaction({ digest, include: { effects: true, balanceChanges: true, transaction: true } });
  } catch (error) {
    if (/not ?found|does not exist|unknown/i.test(error instanceof Error ? error.message : '')) return null;
    throw error;
  }
  const t = (result.$kind === 'Transaction' ? result.Transaction : result.FailedTransaction) as unknown as {
    digest?: string;
    status: { success: boolean };
    balanceChanges?: Array<{ coinType: string; address: string; amount: string }>;
    transaction?: { sender?: string | null };
  };
  return { digest: t.digest ?? digest, success: t.status.success, sender: t.transaction?.sender ?? null, balanceChanges: t.balanceChanges ?? [] };
}

export function withdrawalDepsFor(route: WalletRoute, env: NodeJS.ProcessEnv = process.env): WithdrawalDeps {
  const { orgId, ctx, db } = route;
  const splash = [env.OPERATOR_SUI_ADDRESS, env.TREASURY_ADDRESS, env.SPLASH_TEST_RECIPIENT_ADDRESS, ctx.signing.sponsor?.address]
    .filter((a): a is string => typeof a === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(a.trim()))
    .map((a) => normalizeSuiAddress(a.trim()));
  const original = (env.SPLASH_CORE_ORIGINAL_PACKAGE_ID ?? '').trim() || (env.SPLASH_CORE_PACKAGE_ID ?? '').trim();
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
    // The registered (legal) name only: a trading name is not who a bank account is held by.
    companyName: async () => {
      const [org] = await db.select({ legalName: organizations.legalName }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
      return (org?.legalName ?? '').trim() || null;
    },
    splashAddresses: splash,
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
  };
}

/** The front of every /api/wallet/withdrawals route. */
export async function withdrawalRoute(request: Request): Promise<{ route: WalletRoute; deps: WithdrawalDeps; response: null } | { route: null; deps: null; response: Response }> {
  const gate = await walletRoute(request);
  if (gate.response) return { route: null, deps: null, response: gate.response };
  if (!/^0x[0-9a-fA-F]{64}$/.test((process.env.SPLASH_CORE_ORIGINAL_PACKAGE_ID ?? '').trim() || (process.env.SPLASH_CORE_PACKAGE_ID ?? '').trim())) {
    return { route: null, deps: null, response: NextResponse.json({ error: 'withdrawals need splash_core\'s package id', code: 'no_core_package' }, { status: 503, headers: NO_STORE }) };
  }
  return { route: gate.route, deps: withdrawalDepsFor(gate.route), response: null };
}

/** A service result as a response: a refusal keeps its extra fields (a changed quote, say). */
export function withdrawalResponse(result: { ok: boolean } & Record<string, unknown>, okStatus = 200): Response {
  const { ok, status, ...rest } = result as { ok: boolean; status?: number } & Record<string, unknown>;
  if (!ok) return NextResponse.json(rest, { status: typeof status === 'number' ? status : 400, headers: NO_STORE });
  return NextResponse.json(rest, { status: okStatus, headers: NO_STORE });
}
