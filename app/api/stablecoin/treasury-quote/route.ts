import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';

import type { KybLifecycleState } from '@/lib/compliance/kyb-state';
import { organizations } from '@/lib/db/schema';
import { parseUsdcMinor, StablecoinLaneError } from '@/lib/payments/stablecoin-lane';
import { treasuryQuote } from '@/lib/payments/treasury-usdy';
import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { readJsonBody } from '@/lib/server/http';
import { requireSessionAccount } from '@/lib/server/session-account';
import { getUsdyNetApyPct, getUsdyRedemptionPrice } from '@/lib/server/usdy';

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
  const q = treasuryQuote({
    state: (org?.kyb ?? 'REGISTERED') as KybLifecycleState,
    country: org?.country ?? null,
    usdcInMinor,
    nav: { status: nav.status, priceMicros: nav.priceMicros, asOf: nav.asOf },
    apyPct,
    slippageBps: typeof body.slippageBps === 'number' ? body.slippageBps : undefined,
    ondoEligibilityConfirmed: process.env.USDY_ONDO_ELIGIBILITY_CONFIRMED === 'true',
  });
  return NextResponse.json({
    ...q,
    usdcInMinor: q.usdcInMinor.toString(),
    priceMicros: q.priceMicros?.toString() ?? null,
    priceAsOf: nav.asOf,
    priceSource: nav.source,
    usdyOutMinor: q.usdyOutMinor?.toString() ?? null,
    minUsdyOutMinor: q.minUsdyOutMinor?.toString() ?? null,
    apyLabel: `modeled at ${apyPct}% APY — variable, not promised`,
    projections: q.projections.map((p) => ({ days: p.days, valueMinor: p.valueMinor.toString(), yieldMinor: p.yieldMinor.toString() })),
  }, { headers: { 'Cache-Control': 'no-store' } });
}
