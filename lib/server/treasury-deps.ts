/**
 * The real outside reads behind lib/server/treasury-wallet.ts: the USDY
 * price, the org's verification state and country, and the Sui DEX route
 * finder (read-only). The routes build these; tests inject their own.
 */
import { eq } from 'drizzle-orm';

import type { KybLifecycleState } from '@/lib/compliance/kyb-state';
import { organizations } from '@/lib/db/schema';
import { labelFor } from '@/lib/server/signed-partners';
import { fundReferralUrl, resolveFundHoldingSource, treasuryFlags } from '@/lib/server/treasury-providers';
import type { FundDeps, QuoteDeps } from '@/lib/server/treasury-wallet';
import { getUsdyNetApyPct, getUsdyRedemptionPrice } from '@/lib/server/usdy';
import { quoteUsdcToUsdyOnSui, quoteUsdyToUsdcOnSui } from '@/lib/server/usdy-liquidity';

export function liveQuoteDeps(): QuoteDeps {
  const raw = process.env.USDY_SWAP_SLIPPAGE_BPS?.trim();
  const slippage = raw ? Number(raw) : Number.NaN;
  return {
    readNav: async () => {
      const nav = await getUsdyRedemptionPrice();
      return { status: nav.status, priceMicros: nav.priceMicros, asOf: nav.asOf, source: nav.source };
    },
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
    slippageBps: Number.isInteger(slippage) && slippage >= 0 && slippage <= 1000 ? slippage : 50,
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
