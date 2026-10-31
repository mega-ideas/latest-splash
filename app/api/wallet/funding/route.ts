import { fundingOptions } from '@/lib/server/wallet-funding';
import { fundingResponse, fundingRoute } from '@/lib/server/wallet-funding-route';

export const dynamic = 'force-dynamic';

/**
 * "Add funds" for the signed-in person's business (v2 §4.3).
 *
 * GET  every way to fund the business wallet here: funding partners (named
 *      only when signed), any Sui wallet (USDC, and USDT / USDsui converted
 *      on arrival), CCTP V2 from other chains, swap routes for other tokens;
 *      the business's funding sources; and how much is on hold. The wallet is
 *      the one the business account names on chain.
 *
 * Transfer's step 3 "Top up and continue" uses these same routes:
 *   POST /api/wallet/funding/quotes            the quote, first
 *   POST /api/wallet/funding/intents           the top-up (Idempotency-Key)
 *   GET  /api/wallet/funding/intents/:id       its status
 *   POST /api/wallet/funding/deposits          record an arrival by digest
 */
export async function GET(request: Request) {
  const gate = await fundingRoute(request);
  if (gate.response) return gate.response;
  return fundingResponse(await fundingOptions(gate.funding.deps));
}
