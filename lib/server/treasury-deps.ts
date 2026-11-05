/**
 * The real outside reads behind lib/server/treasury-wallet.ts: the USDY
 * price, the org's verification state and country, the Sui DEX route finder
 * (read-only), and the business wallet (resolved on the server from the org's
 * own BusinessAccount, never from the request). The routes build these;
 * tests inject their own.
 */
import { eq } from 'drizzle-orm';

import type { KybLifecycleState } from '@/lib/compliance/kyb-state';
import { organizations } from '@/lib/db/schema';
import { getEnv } from '@/lib/env';
import { STABLECOIN_NETWORK, SUI_USDC_COIN_TYPE } from '@/lib/payments/stablecoin-lane';
import { USDY_COIN_TYPE_SUI } from '@/lib/payments/treasury-usdy';
import { labelFor } from '@/lib/server/signed-partners';
import { readTreasuryWalletBalance, resolveTreasuryWallet } from '@/lib/server/treasury-business-wallet';
import { fundReferralUrl, resolveFundHoldingSource, resolveTreasurySwapRoute, treasuryFlags } from '@/lib/server/treasury-providers';
import type { FundDeps, OrderDeps, OverviewDeps, QuoteDeps } from '@/lib/server/treasury-wallet';
import { listTreasuryOrders } from '@/lib/server/treasury-wallet-orders';
import { getUsdyNetApyPct, getUsdyRedemptionPrice } from '@/lib/server/usdy';
import { quoteUsdcToUsdyOnSui, quoteUsdyToUsdcOnSui } from '@/lib/server/usdy-liquidity';

async function readNav() {
  const nav = await getUsdyRedemptionPrice();
  return { status: nav.status, priceMicros: nav.priceMicros, asOf: nav.asOf, source: nav.source };
}

export function liveQuoteDeps(): QuoteDeps {
  return {
    readNav,
    apyPct: () => getUsdyNetApyPct(),
    readOrg: async (orgId: string) => {
      if (!process.env.DATABASE_URL) return { kyb: 'REGISTERED' as KybLifecycleState, country: null };
      const { getDb } = await import('@/lib/db/client');
      const [org] = await getDb()
        .select({ kyb: organizations.kybLifecycle, country: organizations.addressCountry })
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .limit(1);
      return { kyb: (org?.kyb ?? 'REGISTERED') as KybLifecycleState, country: org?.country ?? null };
    },
    marketIn: (usdc) => quoteUsdcToUsdyOnSui(usdc),
    marketOut: (usdy) => quoteUsdyToUsdcOnSui(usdy),
    issuerEligibilityConfirmed: treasuryFlags().issuerEligibilityConfirmed,
    // One setting, validated and capped in lib/env.ts (MAX_SWAP_SLIPPAGE_BPS).
    slippageBps: getEnv().USDY_SWAP_SLIPPAGE_BPS,
  };
}

export function liveOrderDeps(): OrderDeps {
  return {
    ...liveQuoteDeps(),
    resolveRoute: () => resolveTreasurySwapRoute(),
    resolveWallet: (orgId) => resolveTreasuryWallet(orgId),
    readWalletBalance: (address, coinType) => readTreasuryWalletBalance(address, coinType),
  };
}

export function liveOverviewDeps(): OverviewDeps {
  return {
    resolveRoute: () => resolveTreasurySwapRoute(),
    flags: treasuryFlags(),
    issuer: labelFor('ondo'),
    fundManager: labelFor('halogen'),
    readNav,
    apyPct: () => getUsdyNetApyPct(),
    resolveWallet: (orgId) => resolveTreasuryWallet(orgId),
    readBalances: async (address) => {
      const [usdcMinor, usdyMinor] = await Promise.all([
        readTreasuryWalletBalance(address, SUI_USDC_COIN_TYPE[STABLECOIN_NETWORK]),
        readTreasuryWalletBalance(address, USDY_COIN_TYPE_SUI),
      ]);
      return { usdcMinor, usdyMinor };
    },
    listOrders: async (orgId) => {
      if (!process.env.DATABASE_URL) return null;
      const { getDb } = await import('@/lib/db/client');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return listTreasuryOrders(getDb() as any, orgId);
    },
  };
}

export function liveFundDeps(): FundDeps {
  return {
    enabled: treasuryFlags().fundReferral,
    label: labelFor('halogen'),
    referralUrl: fundReferralUrl(),
    resolveHolding: () => resolveFundHoldingSource(),
  };
}
