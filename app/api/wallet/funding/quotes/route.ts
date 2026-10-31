import { readJsonBody } from '@/lib/server/http';
import { quoteFunding } from '@/lib/server/wallet-funding';
import { quoteInputFrom } from '@/lib/server/wallet-funding-input';
import { fundingResponse, fundingRoute, limitFunding } from '@/lib/server/wallet-funding-route';
import { refusal, requireFundsAccess } from '@/lib/server/wallet-route';

export const dynamic = 'force-dynamic';

/**
 * POST { channel, amount, provider?, method?, asset?, sourceChain?, speed?,
 *        fromToken?, fromDecimals?, amountIn?, route?, slippageBps? }
 *
 * The quote, shown before anything is made: what reaches the business
 * wallet at least, each partner's, route's or Circle's own fee as its own
 * line, and when the rate lapses. USDT and USDsui are quoted only while on
 * their peg. Nothing is stored.
 */
export async function POST(request: Request) {
  const gate = await fundingRoute(request);
  if (gate.response) return gate.response;
  const f = gate.funding;
  const noAccess = await requireFundsAccess(f.route, 'add_funds', 'add funds');
  if (noAccess) return noAccess;
  const limited = await limitFunding(f);
  if (limited) return limited;
  const input = quoteInputFrom(await readJsonBody(request));
  if (!input) return refusal(400, 'Choose how to add funds.', 'bad_channel');
  return fundingResponse(await quoteFunding(f.deps, input));
}
