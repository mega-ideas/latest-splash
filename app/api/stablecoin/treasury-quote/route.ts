import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';

import type { KybLifecycleState } from '@/lib/compliance/kyb-state';
import { organizations } from '@/lib/db/schema';
import { laneAccess, parseUsdcMinor, StablecoinLaneError } from '@/lib/payments/stablecoin-lane';
import { treasuryQuote, type MarketInput } from '@/lib/payments/treasury-usdy';
import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { readJsonBody } from '@/lib/server/http';
import { requireSessionAccount } from '@/lib/server/session-account';
import { getUsdyNetApyPct, getUsdyRedemptionPrice } from '@/lib/server/usdy';
import { quoteUsdcToUsdyOnSui } from '@/lib/server/usdy-liquidity';

export const dynamic = 'force-dynamic';

/**
 * What swapping USDC for Ondo USDY in the business's own wallet would give,
 * and what it might grow to. A quote — Splash swaps nothing here, and until
 * Ondo eligibility is confirmed it is explicitly a preview.
 */
export async function POST(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;
  const accountCheck = await requireSessionAccount(auth.session);
  if (accountCheck.response) return accountCheck.response;
  if (!process.env.DATABASE_URL) return NextResponse.json({ error: 'Treasury quotes need the database.' }, { status: 503 });

  const body = await readJsonBody(request);
  let usdcInMinor: bigint;
  try {
    usdcInMinor = parseUsdcMinor(String(body.amount ?? '').trim() || '0');
  } catch (error) {
    return NextResponse.json({ error: error instanceof StablecoinLaneError || error instanceof Error ? error.message : 'Invalid amount.' }, { status: 400 });
  }

  const { getDb } = await import('@/lib/db/client');
  const [org] = await getDb()
    .select({ kyb: organizations.kybLifecycle, country: organizations.addressCountry })
    .from(organizations)
    .where(eq(organizations.id, accountCheck.account.orgId))
    .limit(1);
  const nav = await getUsdyRedemptionPrice();
  const apyPct = getUsdyNetApyPct();
  const state = (org?.kyb ?? 'REGISTERED') as KybLifecycleState;
  // What Sui can actually fill for this amount — asked only when the
  // business could be quoted at all, so a locked lane makes no outside call.
  let market: MarketInput | null = null;
  if (laneAccess(state, 'TREASURY').allowed && usdcInMinor > 0n && (org?.country ?? '').toUpperCase() !== 'US') {
    const live = await quoteUsdcToUsdyOnSui(usdcInMinor);
    market = live.available
      ? { usdyOutMinor: live.usdyOutMinor, providers: live.providers, asOf: live.asOf }
      : { unavailable: live.reason };
  }
  const q = treasuryQuote({
    state,
    country: org?.country ?? null,
    usdcInMinor,
    nav: { status: nav.status, priceMicros: nav.priceMicros, asOf: nav.asOf },
    apyPct,
    slippageBps: typeof body.slippageBps === 'number' ? body.slippageBps : undefined,
    ondoEligibilityConfirmed: process.env.USDY_ONDO_ELIGIBILITY_CONFIRMED === 'true',
    market,
  });
  return NextResponse.json({
    ...q,
    usdcInMinor: q.usdcInMinor.toString(),
    priceMicros: q.priceMicros?.toString() ?? null,
    priceAsOf: nav.asOf,
    priceSource: nav.source,
    usdyOutMinor: q.usdyOutMinor?.toString() ?? null,
    minUsdyOutMinor: q.minUsdyOutMinor?.toString() ?? null,
    market: q.market
      ? {
          usdyOutMinor: q.market.usdyOutMinor.toString(),
          valueMinor: q.market.valueMinor?.toString() ?? null,
          shortfallBps: q.market.shortfallBps,
          providers: q.market.providers,
          asOf: q.market.asOf,
          source: 'Cetus aggregator (read-only quote)',
        }
      : null,
    fillable: q.fillable,
    apyLabel: `modeled at ${apyPct}% APY — variable, not promised`,
    projections: q.projections.map((p) => ({ days: p.days, valueMinor: p.valueMinor.toString(), yieldMinor: p.yieldMinor.toString() })),
  }, { headers: { 'Cache-Control': 'no-store' } });
}
