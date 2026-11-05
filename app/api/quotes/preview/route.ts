import { NextResponse } from 'next/server';

import { QUOTABLE_ROUTES, isQuotable, quotableRoute } from '@/lib/landing/routes';
import { parseMinor } from '@/lib/money';
import { payoutPartner } from '@/lib/payouts/registry';
import { LandingQuoteRouteError, landingQuote } from '@/lib/server/landing-quote';
import { RATE_LIMITS, clientIp, enforceRateLimit } from '@/lib/server/rate-limit';
import { isDemoRuntime } from '@/lib/server/runtime-mode';
import { labelFor } from '@/lib/server/signed-partners';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The landing calculator's bank quote (v2 brief section 6): for a USDC amount
 * to PHP or IDR, the payout partner's rate and fee, and what the supplier
 * receives. Public, so it needs no session, and rate limited by network.
 * Splash's own fee is rendered on the page from the published schedule; this
 * answers only what the partner quotes, and nothing when it cannot
 * (lib/server/landing-quote.ts).
 *
 *   GET /api/quotes/preview?currency=PHP&amount=5000.00
 */
const MAX_USDC_MINOR = 10_000_000n * 1_000_000n; // ten million USDC: a landing estimate, not a limit

export async function GET(request: Request) {
  const limited = await enforceRateLimit({ rule: RATE_LIMITS.quotePreviewIp, key: clientIp(request), message: 'Too many quotes from this network. Try again in a few minutes.' });
  if (limited) return limited;

  const url = new URL(request.url);
  const currency = (url.searchParams.get('currency') ?? '').toUpperCase();
  if (!isQuotable(currency)) {
    return NextResponse.json(
      { error: `Quotes cover ${QUOTABLE_ROUTES.map((r) => r.currency).join(' and ')}. Other routes are under pilot access.`, code: 'route_not_quoted' },
      { status: 400 },
    );
  }

  let amountMinor: bigint;
  try {
    amountMinor = parseMinor((url.searchParams.get('amount') ?? '').trim(), 6, 'floor');
  } catch {
    return NextResponse.json({ error: 'Enter a USDC amount, like 5000 or 2500.50.', code: 'bad_amount' }, { status: 400 });
  }
  if (amountMinor <= 0n || amountMinor > MAX_USDC_MINOR) {
    return NextResponse.json({ error: 'Enter an amount above zero and up to ten million USDC.', code: 'bad_amount' }, { status: 400 });
  }

  const route = quotableRoute(currency);
  try {
    const quote = await landingQuote(
      { currency, amountMinor },
      // The payout-partner registry decides: a sandbox outside production, the
      // live adapter (which refuses until it is wired) in production.
      { partner: () => payoutPartner(route.partner), sandboxAllowed: isDemoRuntime(), partnerLabel: labelFor(route.partner) },
    );
    return NextResponse.json(quote, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof LandingQuoteRouteError) return NextResponse.json({ error: error.message, code: 'route_not_quoted' }, { status: 400 });
    throw error;
  }
}
