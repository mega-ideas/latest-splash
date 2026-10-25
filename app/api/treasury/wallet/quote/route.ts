import { readJsonBody } from '@/lib/server/http';
import { RATE_LIMITS, enforceRateLimit } from '@/lib/server/rate-limit';
import { liveQuoteDeps } from '@/lib/server/treasury-deps';
import { answer, treasuryCaller } from '@/lib/server/treasury-route';
import { handleTreasuryQuote } from '@/lib/server/treasury-wallet';

export const dynamic = 'force-dynamic';

/**
 * POST { direction: 'swap' | 'redeem', amount }
 *
 * What a swap (USDC to USDY) or a redemption (USDY to USDC) from the business
 * wallet would return: at the redemption rate, and on Sui right now. A quote
 * moves nothing.
 */
export async function POST(request: Request) {
  const gate = await treasuryCaller(request);
  if (gate.response) return gate.response;
  // Each quote makes an outside call (the Sui DEX route finder).
  const limited = await enforceRateLimit({ rule: RATE_LIMITS.treasuryQuoteUser, key: gate.session.email });
  if (limited) return limited;
  return answer(await handleTreasuryQuote(gate.caller, await readJsonBody(request), liveQuoteDeps()));
}
